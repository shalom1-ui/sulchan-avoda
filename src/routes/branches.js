// routes/branches.js — ניהול סניפים (= חדרי מחשבים). קריאה לכולם, כתיבה למנהלים בלבד.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth, requireAdmin } = require("../middleware/auth");

function register(router) {
  router.get("/api/branches", requireAuth(async (ctx) => {
    const rows = db.prepare("SELECT * FROM branches WHERE active = 1 ORDER BY name").all();
    return json(ctx.res, 200, { branches: rows });
  }));

  router.post("/api/branches", requireAdmin(async (ctx) => {
    const { name, address } = ctx.body;
    if (!name) return json(ctx.res, 400, { error: "חסר שם סניף" });
    const info = db.prepare("INSERT INTO branches (name, address) VALUES (?, ?)").run(name.trim(), address || null);
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));

  router.put("/api/branches/:id", requireAdmin(async (ctx) => {
    const existing = db.prepare("SELECT * FROM branches WHERE id = ?").get(ctx.params.id);
    if (!existing) return json(ctx.res, 404, { error: "לא נמצא" });
    const { name, address, active } = ctx.body;
    db.prepare("UPDATE branches SET name = ?, address = ?, active = ? WHERE id = ?").run(
      name ?? existing.name,
      address ?? existing.address,
      active === undefined ? existing.active : (active ? 1 : 0),
      ctx.params.id
    );
    return json(ctx.res, 200, { ok: true });
  }));

  router.delete("/api/branches/:id", requireAdmin(async (ctx) => {
    // מחיקה רכה (active=0) כדי לא לאבד היסטוריית הוראות/דיווחים/תנועות שמצביעות לסניף הזה
    db.prepare("UPDATE branches SET active = 0 WHERE id = ?").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
