// routes/reports.js — דיווחי עובדים (תגובה להוראה, או דיווח יזום). על כל דיווח: התראה פנימית
// באתר (פעמון) + מייל לכל המנהלים בעלי כתובת מייל.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { sendEmail } = require("../services/email");
const { createNotification } = require("../lib/notify");

const STATUS_LABELS = {
  done: "בוצע",
  not_done: "לא בוצע",
  issue: "יש בעיה / צריך חלקים",
  other: "אחר",
};

function register(router) {
  router.get("/api/reports", requireAuth(async (ctx) => {
    if (ctx.user.role === "admin") {
      const rows = db.prepare(
        `SELECT r.*, b.name AS branch_name, u.full_name AS worker_name, i.text AS instruction_text
         FROM reports r JOIN branches b ON b.id = r.branch_id JOIN users u ON u.id = r.worker_user_id
         LEFT JOIN instructions i ON i.id = r.instruction_id
         ORDER BY r.created_at DESC LIMIT 300`
      ).all();
      return json(ctx.res, 200, { reports: rows });
    }
    const rows = db.prepare(
      `SELECT r.*, b.name AS branch_name, i.text AS instruction_text
       FROM reports r JOIN branches b ON b.id = r.branch_id
       LEFT JOIN instructions i ON i.id = r.instruction_id
       WHERE r.worker_user_id = ? ORDER BY r.created_at DESC LIMIT 100`
    ).all(ctx.user.userId);
    return json(ctx.res, 200, { reports: rows });
  }));

  router.post("/api/reports", requireAuth(async (ctx) => {
    const { branchId, instructionId, statusCode, noteText } = ctx.body;
    if (!branchId || !statusCode) return json(ctx.res, 400, { error: "חסרים שדות חובה" });
    if (!STATUS_LABELS[statusCode]) return json(ctx.res, 400, { error: "statusCode לא תקין" });

    const workerUserId = ctx.user.role === "admin" ? ctx.body.workerUserId : ctx.user.userId;
    if (!workerUserId) return json(ctx.res, 400, { error: "חסר workerUserId" });

    const info = db.prepare(
      `INSERT INTO reports (instruction_id, worker_user_id, branch_id, status_code, note_text, source)
       VALUES (?, ?, ?, ?, ?, 'web')`
    ).run(instructionId || null, workerUserId, branchId, statusCode, noteText || null);
    const reportId = Number(info.lastInsertRowid);

    if (instructionId) db.prepare("UPDATE instructions SET status = 'done' WHERE id = ?").run(instructionId);

    const worker = db.prepare("SELECT full_name FROM users WHERE id = ?").get(workerUserId);
    const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId);
    const summary = `${worker.full_name} דיווח על ${branch.name}: ${STATUS_LABELS[statusCode]}`;
    createNotification("new_report", reportId, summary);

    const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND active = 1").all();
    for (const admin of admins) {
      sendEmail({
        to: admin.email,
        subject: `דיווח חדש - ${branch.name}`,
        body: `${summary}${noteText ? `\n\nהערה: ${noteText}` : ""}`,
      }).catch((e) => console.error("שליחת מייל דיווח נכשלה:", e.message));
    }

    return json(ctx.res, 201, { id: reportId });
  }));

  router.put("/api/reports/:id/read", requireAdmin(async (ctx) => {
    db.prepare("UPDATE reports SET read_by_admin = 1 WHERE id = ?").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register, STATUS_LABELS };
