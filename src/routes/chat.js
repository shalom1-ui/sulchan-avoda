// routes/chat.js — צ'אט פנימי בין מנהלים לעובד, לפי סניף. כל השיחה עם עובד מסוים על סניף מסוים
// היא שרשור אחד; כל מנהל יכול לראות ולהשיב בכל שרשור.
"use strict";
const db = require("../db");
const { json, raw } = require("../router");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { createNotification } = require("../lib/notify");
const { sendEmail } = require("../services/email");

// גודל מקסימלי לקובץ מצורף (תמונה/וידאו) - 12MB לפני base64 (מתנפח לכ-16MB מקודד, מתחת למגבלת
// גוף הבקשה הכוללת של 20MB, ר' router.js). מספיק בנוחות לתמונת טלפון; וידאו ארוך לא יעבור.
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

function decodeAttachment(attachment) {
  if (!attachment || !attachment.data_base64) return null;
  const base64Only = String(attachment.data_base64).includes(",")
    ? String(attachment.data_base64).split(",").pop()
    : attachment.data_base64;
  const buffer = Buffer.from(base64Only, "base64");
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    const err = new Error(`הקובץ גדול מדי (מקסימום ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)`);
    err.isAttachmentTooLarge = true;
    throw err;
  }
  return { data: buffer, mime: attachment.mime_type || "application/octet-stream", filename: attachment.filename || "קובץ" };
}

// יוצר רשומת הודעת צ'אט בודדת בשרשור (סניף, עובד), עם צירוף אופציונלי (תמונה/וידאו) - בלי לשלוח
// מייל (המייל, כשצריך, נשלח בנפרד ע"י הקורא - ר' POST /api/chat/:branchId/:workerId למטה ו-POST
// /api/chat/bulk).
function insertChatMessage(branchId, workerId, senderUserId, text, attachment = null) {
  const info = db.prepare(
    "INSERT INTO chat_messages (branch_id, worker_user_id, sender_user_id, text, attachment_data, attachment_mime, attachment_filename) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(branchId, workerId, senderUserId, text, attachment ? attachment.data : null, attachment ? attachment.mime : null, attachment ? attachment.filename : null);
  return Number(info.lastInsertRowid);
}

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
    // לא שולפים את attachment_data (ה-BLOB) כאן - היה מנפח כל תגובה עם כל התמונות/סרטונים של כל
    // ההיסטוריה. attachment_mime/attachment_filename מספיקים לתצוגה; הבייטים עצמם נטענים בנפרד
    // ורק לפי דרישה דרך GET /api/chat/message/:id/attachment (ר' openChat/loadChatAttachments).
    const rows = db.prepare(
      `SELECT cm.id, cm.branch_id, cm.worker_user_id, cm.sender_user_id, cm.text, cm.read_at, cm.created_at,
              cm.attachment_mime, cm.attachment_filename, (cm.attachment_data IS NOT NULL) AS has_attachment,
              u.full_name AS sender_name, u.role AS sender_role
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
    const { text, attachment: attachmentInput } = ctx.body;
    let attachment;
    try {
      attachment = decodeAttachment(attachmentInput);
    } catch (e) {
      return json(ctx.res, e.isAttachmentTooLarge ? 413 : 400, { error: e.message });
    }
    const trimmedText = text ? text.trim() : "";
    if (!trimmedText && !attachment) return json(ctx.res, 400, { error: "הודעה ריקה" });
    const newId = insertChatMessage(ctx.params.branchId, ctx.params.workerId, ctx.user.userId, trimmedText, attachment);
    const info = { lastInsertRowid: newId };

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
        sendEmail({ to: admin.email, subject: `הודעת צ'אט חדשה - ${branch.name}`, body: `${worker.full_name} כתב/ה ב-${branch.name}:\n\n${trimmedText || "(צורף קובץ בלי טקסט)"}` })
          .catch((e) => console.error("שליחת מייל צ'אט (עובד->מנהל) נכשלה:", e.message));
      }
    } else if (worker.email) {
      sendEmail({ to: worker.email, subject: `הודעה חדשה - ${branch.name}`, body: `הודעה חדשה מהמנהל לגבי ${branch.name}:\n\n${trimmedText || "(צורף קובץ בלי טקסט)"}` })
        .catch((e) => console.error("שליחת מייל צ'אט (מנהל->עובד) נכשלה:", e.message));
    }
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));

  // שליחת הודעה חדשה לכמה עובדים/סניפים בבת אחת (מנהל בלבד) - "בחר הכל" בדיוק כמו בהוראות
  // (ר' routes/instructions.js): נכתבת הודעת צ'אט נפרדת בכל שרשור (עובד, סניף) שנבחר, אבל לכל עובד
  // נשלח מייל אחד מרוכז שמפרט את כל הסניפים ברשימה - לא מייל נפרד לכל סניף.
  router.post("/api/chat/bulk", requireAdmin(async (ctx) => {
    const { branchIds, workerUserIds, text } = ctx.body;
    const branchIdList = Array.isArray(branchIds) ? branchIds : [];
    const workerIdList = Array.isArray(workerUserIds) ? workerUserIds : [];
    if (!branchIdList.length || !workerIdList.length || !text || !text.trim()) {
      return json(ctx.res, 400, { error: "חסרים שדות חובה (סניף/סניפים, עובד/עובדים, תוכן ההודעה)" });
    }
    if (branchIdList.length * workerIdList.length > 200) {
      return json(ctx.res, 400, { error: "יותר מדי צירופי עובד/סניף בבת אחת (הגבלה 200)" });
    }

    const trimmedText = text.trim();
    let createdCount = 0;
    let emailsSent = 0;

    for (const wId of workerIdList) {
      const worker = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'worker'").get(wId);
      if (!worker) continue;

      const branchNames = [];
      for (const bId of branchIdList) {
        const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(bId);
        if (!branch) continue;
        insertChatMessage(bId, worker.id, ctx.user.userId, trimmedText);
        branchNames.push(branch.name);
        createdCount++;
      }
      if (!branchNames.length) continue;

      if (worker.email) {
        try {
          const branchList = branchNames.map((n) => `- ${n}`).join("\n");
          await sendEmail({
            to: worker.email,
            subject: branchNames.length === 1 ? `הודעה חדשה - ${branchNames[0]}` : `הודעה חדשה - ${branchNames.length} סניפים`,
            body: `הודעה חדשה מהמנהל עבור ${branchNames.length === 1 ? "הסניף הבא" : "הסניפים הבאים"}:\n${branchList}\n\n${trimmedText}`,
          });
          emailsSent++;
        } catch (e) {
          console.error("שליחת מייל צ'אט מרוכז נכשלה:", e.message);
        }
      }
    }
    if (!createdCount) return json(ctx.res, 404, { error: "לא נמצאו עובדים/סניפים תקינים" });
    return json(ctx.res, 201, { created: createdCount, emailsSent });
  }));

  // הורדת/הצגת קובץ מצורף להודעת צ'אט - אותה הרשאה כמו קריאת השרשור עצמו (מנהל, או העובד שהשרשור
  // שלו). ה-frontend קורא לזה כדי לבנות blob URL לתצוגה מוטמעת (ר' openChat / loadChatAttachments).
  router.get("/api/chat/message/:id/attachment", requireAuth(async (ctx) => {
    const msg = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(ctx.params.id);
    if (!msg || !msg.attachment_data) return json(ctx.res, 404, { error: "אין קובץ מצורף" });
    if (ctx.user.role !== "admin" && Number(ctx.user.userId) !== msg.worker_user_id) {
      return json(ctx.res, 403, { error: "אין הרשאה" });
    }
    return raw(ctx.res, 200, msg.attachment_data, { contentType: msg.attachment_mime || "application/octet-stream", filename: msg.attachment_filename });
  }));

  // סימון שרשור כ"ממתין לטיפול המשך" - מחזיר את ההודעה האחרונה מהעובד למצב לא-נקרא (read_at=NULL),
  // כדי שהתג האדום יופיע שוב ברשימת השרשורים, גם אחרי שהמנהל כבר פתח וקרא את השרשור (ר' משוב
  // המשתמש: "אפשרות להשאיר במצב ממתין לטיפול המשך כאילו לא נקרא"). לא מוחק כלום, רק "מבטל קריאה".
  router.put("/api/chat/:branchId/:workerId/mark-pending", requireAdmin(async (ctx) => {
    const lastFromWorker = db.prepare(
      `SELECT id FROM chat_messages WHERE branch_id = ? AND worker_user_id = ? AND sender_user_id = ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(ctx.params.branchId, ctx.params.workerId, ctx.params.workerId);
    if (!lastFromWorker) return json(ctx.res, 404, { error: "אין הודעה מהעובד בשרשור הזה לסמן כממתינה" });
    db.prepare("UPDATE chat_messages SET read_at = NULL WHERE id = ?").run(lastFromWorker.id);
    return json(ctx.res, 200, { ok: true });
  }));

  // מחיקת הודעת צ'אט - מנהל יכול למחוק כל הודעה בשרשור; עובד יכול למחוק רק הודעה ששלח בעצמו.
  router.delete("/api/chat/message/:id", requireAuth(async (ctx) => {
    const msg = db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(ctx.params.id);
    if (!msg) return json(ctx.res, 404, { error: "הודעה לא נמצאה" });
    if (ctx.user.role !== "admin" && Number(ctx.user.userId) !== msg.sender_user_id) {
      return json(ctx.res, 403, { error: "אין הרשאה למחוק הודעה זו" });
    }
    db.prepare("DELETE FROM chat_messages WHERE id = ?").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
