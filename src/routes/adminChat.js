// routes/adminChat.js — צ'אט בין מנהלים (נפרד מ-routes/chat.js, שהוא תמיד לפי סניף+עובד). שיחה
// חופשית פשוטה בין שני משתמשים מסוג admin, בלי הקשר סניף. כל הודעה נשלחת גם במייל לצד השני
// (אותו דפוס כמו chat.js - ר' משוב המשתמש: "כל הודעה מכל כיוון מגיעה לצד השני").
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAdmin } = require("../middleware/auth");
const { createNotification } = require("../lib/notify");
const { sendEmail } = require("../services/email");

function register(router) {
  // רשימת מנהלים אחרים שאפשר לדבר איתם (לתפריט "התחלת שיחה")
  router.get("/api/admin-chat/peers", requireAdmin(async (ctx) => {
    const rows = db.prepare("SELECT id, full_name FROM users WHERE role = 'admin' AND active = 1 AND id != ? ORDER BY full_name").all(ctx.user.userId);
    return json(ctx.res, 200, { peers: rows });
  }));

  router.get("/api/admin-chat/threads", requireAdmin(async (ctx) => {
    const rows = db.prepare(
      `SELECT CASE WHEN m.sender_user_id = ? THEN m.recipient_user_id ELSE m.sender_user_id END AS peer_id,
              u.full_name AS peer_name,
              MAX(m.created_at) AS last_message_at,
              SUM(CASE WHEN m.read_at IS NULL AND m.recipient_user_id = ? THEN 1 ELSE 0 END) AS unread_count
       FROM admin_chat_messages m
       JOIN users u ON u.id = (CASE WHEN m.sender_user_id = ? THEN m.recipient_user_id ELSE m.sender_user_id END)
       WHERE m.sender_user_id = ? OR m.recipient_user_id = ?
       GROUP BY peer_id ORDER BY last_message_at DESC`
    ).all(ctx.user.userId, ctx.user.userId, ctx.user.userId, ctx.user.userId, ctx.user.userId);
    return json(ctx.res, 200, { threads: rows });
  }));

  router.get("/api/admin-chat/:peerId", requireAdmin(async (ctx) => {
    const rows = db.prepare(
      `SELECT m.*, u.full_name AS sender_name FROM admin_chat_messages m JOIN users u ON u.id = m.sender_user_id
       WHERE (sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?)
       ORDER BY m.created_at ASC`
    ).all(ctx.user.userId, ctx.params.peerId, ctx.params.peerId, ctx.user.userId);
    db.prepare(
      "UPDATE admin_chat_messages SET read_at = datetime('now') WHERE sender_user_id = ? AND recipient_user_id = ? AND read_at IS NULL"
    ).run(ctx.params.peerId, ctx.user.userId);
    return json(ctx.res, 200, { messages: rows });
  }));

  router.post("/api/admin-chat/:peerId", requireAdmin(async (ctx) => {
    const peer = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin' AND active = 1").get(ctx.params.peerId);
    if (!peer) return json(ctx.res, 404, { error: "מנהל לא נמצא" });
    const { text } = ctx.body;
    if (!text || !text.trim()) return json(ctx.res, 400, { error: "הודעה ריקה" });
    const info = db.prepare(
      "INSERT INTO admin_chat_messages (sender_user_id, recipient_user_id, text) VALUES (?, ?, ?)"
    ).run(ctx.user.userId, peer.id, text.trim());

    const sender = db.prepare("SELECT full_name FROM users WHERE id = ?").get(ctx.user.userId);
    createNotification("new_admin_chat_message", Number(info.lastInsertRowid), `הודעה חדשה מ-${sender.full_name} (מנהל)`);
    if (peer.email) {
      sendEmail({ to: peer.email, subject: `הודעה חדשה מ-${sender.full_name}`, body: text.trim() })
        .catch((e) => console.error("שליחת מייל צ'אט מנהלים נכשלה:", e.message));
    }
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));
}

module.exports = { register };
