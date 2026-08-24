// routes/notifications.js — פעמון/באדג' התראות למנהלים.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAdmin } = require("../middleware/auth");

function register(router) {
  router.get("/api/notifications", requireAdmin(async (ctx) => {
    const rows = db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50").all();
    const unreadCount = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL").get().c;
    return json(ctx.res, 200, { notifications: rows, unreadCount });
  }));

  router.put("/api/notifications/:id/read", requireAdmin(async (ctx) => {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ?").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));

  router.put("/api/notifications/read-all", requireAdmin(async (ctx) => {
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE read_at IS NULL").run();
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
