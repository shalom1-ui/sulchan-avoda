// routes/tablets.js — טאבלטים (ציוד נפרד מעמדות המחשב, בד"כ אחד לסניף). מנהלים בלבד, אותו דפוס
// כמו routes/stations.js, רק שהשיוך לסניף אופציונלי (branch_id יכול להיות NULL).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAdmin } = require("../middleware/auth");

function register(router) {
  router.get("/api/tablets", requireAdmin(async (ctx) => {
    const rows = db.prepare(
      `SELECT t.*, b.name AS branch_name FROM tablets t LEFT JOIN branches b ON b.id = t.branch_id
       WHERE t.active = 1 ORDER BY b.name, t.label`
    ).all();
    return json(ctx.res, 200, { tablets: rows });
  }));

  router.post("/api/tablets", requireAdmin(async (ctx) => {
    const { label, branchId } = ctx.body;
    if (!label || !String(label).trim()) return json(ctx.res, 400, { error: "חסרה תווית לטאבלט" });
    const info = db.prepare("INSERT INTO tablets (branch_id, label) VALUES (?, ?)")
      .run(branchId || null, String(label).trim());
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));

  router.put("/api/tablets/:id", requireAdmin(async (ctx) => {
    const existing = db.prepare("SELECT * FROM tablets WHERE id = ?").get(ctx.params.id);
    if (!existing) return json(ctx.res, 404, { error: "לא נמצא" });
    const { label, branchId, active } = ctx.body;
    db.prepare("UPDATE tablets SET label = ?, branch_id = ?, active = ? WHERE id = ?").run(
      label ?? existing.label,
      branchId === undefined ? existing.branch_id : (branchId || null),
      active === undefined ? existing.active : (active ? 1 : 0),
      ctx.params.id
    );
    return json(ctx.res, 200, { ok: true });
  }));

  router.delete("/api/tablets/:id", requireAdmin(async (ctx) => {
    db.prepare("UPDATE tablets SET active = 0 WHERE id = ?").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
