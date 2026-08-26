// routes/stations.js — עמדות מחשב בתוך סניף (מספר עמדה + קבוצה/אגף אופציונלי). קריאה לכולם,
// כתיבה למנהלים בלבד. אותו דפוס בדיוק כמו routes/beneficiaries.js.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth, requireAdmin } = require("../middleware/auth");

function register(router) {
  router.get("/api/branches/:branchId/stations", requireAuth(async (ctx) => {
    const rows = db.prepare("SELECT * FROM stations WHERE branch_id = ? AND active = 1 ORDER BY id")
      .all(ctx.params.branchId);
    return json(ctx.res, 200, { stations: rows });
  }));

  router.post("/api/branches/:branchId/stations", requireAdmin(async (ctx) => {
    const { number, groupLabel } = ctx.body;
    if (!number || !String(number).trim()) return json(ctx.res, 400, { error: "חסר מספר עמדה" });
    const info = db.prepare("INSERT INTO stations (branch_id, number, group_label) VALUES (?, ?, ?)")
      .run(ctx.params.branchId, String(number).trim(), groupLabel ? String(groupLabel).trim() : null);
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));

  router.put("/api/stations/:id", requireAdmin(async (ctx) => {
    const existing = db.prepare("SELECT * FROM stations WHERE id = ?").get(ctx.params.id);
    if (!existing) return json(ctx.res, 404, { error: "לא נמצא" });
    const { number, groupLabel, active } = ctx.body;
    db.prepare("UPDATE stations SET number = ?, group_label = ?, active = ? WHERE id = ?").run(
      number ?? existing.number,
      groupLabel === undefined ? existing.group_label : (groupLabel || null),
      active === undefined ? existing.active : (active ? 1 : 0),
      ctx.params.id
    );
    return json(ctx.res, 200, { ok: true });
  }));

  router.delete("/api/stations/:id", requireAdmin(async (ctx) => {
    // מחיקה רכה, אותו טעם כמו סניפים/מוטבים - לא לאבד הפניות היסטוריות מהוראות שכבר נשלחו.
    db.prepare("UPDATE stations SET active = 0 WHERE id = ?").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
