// routes/instructions.js — הוראות שמנהל שולח לעובד לגבי סניף. נשלחות במייל (אם יש לעובד כתובת),
// ומחכות בשלוחת הטלפון (routes/yemot.js מקריא הוראות pending כשהעובד מתקשר ומזהה את עצמו).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { sendEmail } = require("../services/email");

function register(router) {
  // מנהל: כל ההוראות (אפשר לסנן לפי סניף/עובד). עובד: רק ההוראות שלו.
  router.get("/api/instructions", requireAuth(async (ctx) => {
    if (ctx.user.role === "admin") {
      const rows = db.prepare(
        `SELECT i.*, b.name AS branch_name, u.full_name AS worker_name
         FROM instructions i JOIN branches b ON b.id = i.branch_id JOIN users u ON u.id = i.worker_user_id
         ORDER BY i.created_at DESC LIMIT 200`
      ).all();
      return json(ctx.res, 200, { instructions: rows });
    }
    const rows = db.prepare(
      `SELECT i.*, b.name AS branch_name FROM instructions i JOIN branches b ON b.id = i.branch_id
       WHERE i.worker_user_id = ? ORDER BY i.created_at DESC LIMIT 100`
    ).all(ctx.user.userId);
    return json(ctx.res, 200, { instructions: rows });
  }));

  // יוצר רשומת הוראה בודדת (סניף אחד + עובד אחד) במסד הנתונים + מוסיף לשרשור הצ'אט - בלי לשלוח מייל
  // (המייל נשלח מרוכז לכל העובד אחרי שכל ההוראות שלו נוצרו - ר' POST /api/instructions למטה).
  function createOneInstruction(branchId, worker, text, createdByUserId) {
    const info = db.prepare(
      "INSERT INTO instructions (branch_id, worker_user_id, created_by, text) VALUES (?, ?, ?, ?)"
    ).run(branchId, worker.id, createdByUserId, text);
    const instructionId = Number(info.lastInsertRowid);

    // ההוראה מופיעה גם בשרשור הצ'אט של אותו (סניף, עובד) - כדי שהמנהל והעובד יראו הכל במקום אחד
    // (ר' משוב המשתמש: "מה שיש בהוראות יהיה גם בצ'אט"). לא שולחת מייל/התראה כפולה - זו רק תצוגה.
    db.prepare(
      "INSERT INTO chat_messages (branch_id, worker_user_id, sender_user_id, text) VALUES (?, ?, ?, ?)"
    ).run(branchId, worker.id, createdByUserId, `📋 הוראה: ${text}`);

    return instructionId;
  }

  // תומך גם בהוראה בודדת (branchId+workerUserId, כמו קודם) וגם ב"לכולם"/"כל הסניפים": שולחים
  // branchIds[] ו/או workerUserIds[] - נוצרת רשומת הוראה נפרדת לכל צירוף (עובד × סניף) לצורך מעקב
  // סטטוס/הקראה בטלפון, אבל לכל עובד נשלח **מייל אחד מרוכז** שמפרט את כל הסניפים ברשימה - לא מייל
  // נפרד לכל סניף (ר' משוב המשתמש: "מייל אחד ושיהיה כתוב רשימה של הסניפים").
  router.post("/api/instructions", requireAdmin(async (ctx) => {
    const { branchId, workerUserId, branchIds, workerUserIds, text } = ctx.body;
    const branchIdList = Array.isArray(branchIds) && branchIds.length ? branchIds : (branchId ? [branchId] : []);
    const workerIdList = Array.isArray(workerUserIds) && workerUserIds.length ? workerUserIds : (workerUserId ? [workerUserId] : []);
    if (!branchIdList.length || !workerIdList.length || !text || !text.trim()) {
      return json(ctx.res, 400, { error: "חסרים שדות חובה (סניף/סניפים, עובד/עובדים, תוכן ההוראה)" });
    }
    if (branchIdList.length * workerIdList.length > 200) {
      return json(ctx.res, 400, { error: "יותר מדי צירופי עובד/סניף בבת אחת (הגבלה 200)" });
    }

    const trimmedText = text.trim();
    let createdCount = 0;
    let emailsSent = 0;
    let firstInstructionId = null;

    for (const wId of workerIdList) {
      const worker = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'worker'").get(wId);
      if (!worker) continue;

      const instructionIds = [];
      const branchNames = [];
      for (const bId of branchIdList) {
        const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(bId);
        if (!branch) continue;
        const instructionId = createOneInstruction(bId, worker, trimmedText, ctx.user.userId);
        instructionIds.push(instructionId);
        branchNames.push(branch.name);
        createdCount++;
        if (firstInstructionId === null) firstInstructionId = instructionId;
      }
      if (!instructionIds.length) continue;

      if (worker.email) {
        try {
          const branchList = branchNames.map((n) => `- ${n}`).join("\n");
          await sendEmail({
            to: worker.email,
            subject: branchNames.length === 1 ? `הוראה חדשה - ${branchNames[0]}` : `הוראה חדשה - ${branchNames.length} סניפים`,
            body: `שלום ${worker.full_name},\n\nהוראה חדשה עבור ${branchNames.length === 1 ? "הסניף הבא" : "הסניפים הבאים"}:\n${branchList}\n\nתוכן ההוראה:\n${trimmedText}\n\nניתן גם לשמוע את ההוראה ולדווח דרך שלוחת הטלפון, או להתחבר לאתר.`,
          });
          db.prepare(`UPDATE instructions SET email_sent = 1 WHERE id IN (${instructionIds.map(() => "?").join(",")})`).run(...instructionIds);
          emailsSent += instructionIds.length;
        } catch (e) {
          console.error("שליחת מייל הוראה מרוכז נכשלה:", e.message);
        }
      }
    }
    if (!createdCount) return json(ctx.res, 404, { error: "לא נמצאו עובדים/סניפים תקינים" });

    return json(ctx.res, 201, {
      id: firstInstructionId, emailSent: emailsSent > 0, // תאימות לאחור לגרסה הישנה (הוראה בודדת)
      created: createdCount, emailsSent,
    });
  }));

  router.put("/api/instructions/:id/status", requireAuth(async (ctx) => {
    const instr = db.prepare("SELECT * FROM instructions WHERE id = ?").get(ctx.params.id);
    if (!instr) return json(ctx.res, 404, { error: "לא נמצא" });
    if (ctx.user.role !== "admin" && Number(ctx.user.userId) !== instr.worker_user_id) {
      return json(ctx.res, 403, { error: "אין הרשאה" });
    }
    const { status } = ctx.body;
    if (!["pending", "heard_phone", "read_web", "done"].includes(status)) {
      return json(ctx.res, 400, { error: "status לא תקין" });
    }
    db.prepare("UPDATE instructions SET status = ? WHERE id = ?").run(status, ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
