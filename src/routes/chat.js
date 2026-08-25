// routes/chat.js — צ'אט פנימי בין מנהלים לעובד, לפי סניף. כל השיחה עם עובד מסוים על סניף מסוים
// היא שרשור אחד; כל מנהל יכול לראות ולהשיב בכל שרשור.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth } = require("../middleware/auth");
const { createNotification } = require("../lib/notify");
const { sendEmail } = require("../services/email");

function register(router) {
  // רשימת שרשורים (למנהל: כולם; לעובד: רק שלו)
  router.get("/api/chat/threads", requireAuth(async (ctx) => {
    const where = ctx.user.role === "admin" ? "" : "WHERE cm.worker_user_id = ?";
    const params = ctx.user.role === "admin" ? [] : [ctx.user.userId];
    const rows = db.prepare(
      `SELECT cm.branch_id, cm.worker_user_id, b.name AS branch_name, u.full_name AS worker_name,
              MAX(cm.created_at) AS last_message_at,
              SUM(CASE WHEN cm.read_at IS NULL AND cm.sender_user_id != ? THEN 1 ELSE 0 END) AS unread_count
       FROM chat_messages cm
       JOIN branches b ON b.id = cm.branch_id
       JOIN users u ON u.id = cm.worker_user_id
       ${where}
       GROUP BY cm.branch_id, cm.worker_user_id
       ORDER BY last_message_at DESC`
    ).all(ctx.user.userId, ...params);
    return json(ctx.res, 200, { threads: rows });
  }));

  router.get("/api/chat/:branchId/:workerId", requireAuth(async (ctx) => {
    if (ctx.user.role !== "admin" && Number(ctx.user.userId) !== Number(ctx.params.workerId)) {
      return json(ctx.res, 403, { error: "אין הרשאה" });
    }
    const rows = db.prepare(
      `SELECT cm.*, u.full_name AS sender_name, u.role AS sender_role
       FROM chat_messages cm JOIN users u ON u.id = cm.sender_user_id
       WHERE cm.branch_id = ? AND cm.worker_user_id = ? ORDER BY cm.created_at ASC`
    ).all(ctx.params.branchId, ctx.params.workerId);
    db.prepare(
      "UPDATE chat_messages SET read_at = datetime('now') WHERE branch_id = ? AND worker_user_id = ? AND sender_user_id != ? AND read_at IS NULL"
    ).run(ctx.params.branchId, ctx.params.workerId, ctx.user.userId);
    return json(ctx.res, 200, { messages: rows });
  }));

  router.post("/api/chat/:branchId/:workerId", requireAuth(async (ctx) => {
    if (ctx.user.role !== "admin" && Number(ctx.user.userId) !== Number(ctx.params.workerId)) {
      return json(ctx.res, 403, { error: "אין הרשאה" });
    }
    const { text } = ctx.body;
    if (!text || !text.trim()) return json(ctx.res, 400, { error: "הודעה ריקה" });
    const info = db.prepare(
      "INSERT INTO chat_messages (branch_id, worker_user_id, sender_user_id, text) VALUES (?, ?, ?, ?)"
    ).run(ctx.params.branchId, ctx.params.workerId, ctx.user.userId, text.trim());

    const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(ctx.params.branchId);
    const worker = db.prepare("SELECT full_name, email FROM users WHERE id = ?").get(ctx.params.workerId);

    // כל הודעת צ'אט, מכל כיוון, מגיעה גם למייל של הצד השני - בנוסף להתראה הפנימית באתר (ר' משוב
    // המשתמש: "כל הודעה מכל כיוון מגיעה לצד השני"). התראת "טלפון" לעובד ר' /yemot/instructions
    // (הודעות לא-נקראות מוזכרות שם בקצרה כשהוא מתקשר) - למנהל אין ערוץ טלפון מקביל (הוא לא מתקשר
    // לשלוחה), כך שעבורו רק אתר+מייל.
    if (ctx.user.role === "worker") {
      createNotification("new_chat_message", Number(info.lastInsertRowid), `הודעה חדשה מ-${worker.full_name} (${branch.name})`);
      const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND active = 1").all();
      for (const admin of admins) {
        sendEmail({ to: admin.email, subject: `הודעת צ'אט חדשה - ${branch.name}`, body: `${worker.full_name} כתב/ה ב-${branch.name}:\n\n${text.trim()}` })
          .catch((e) => console.error("שליחת מייל צ'אט (עובד->מנהל) נכשלה:", e.message));
      }
    } else if (worker.email) {
      sendEmail({ to: worker.email, subject: `הודעה חדשה - ${branch.name}`, body: `הודעה חדשה מהמנהל לגבי ${branch.name}:\n\n${text.trim()}` })
        .catch((e) => console.error("שליחת מייל צ'אט (מנהל->עובד) נכשלה:", e.message));
    }
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));
}

module.exports = { register };
