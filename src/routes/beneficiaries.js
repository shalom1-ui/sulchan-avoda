// routes/beneficiaries.js — מוטבים למשכורות: מי מקבל תשלום על כל סניף. מנהלים בלבד לכתיבה,
// גם עובד המשויך לסניף יכול לצפות ברשימת המוטב שלו (לא בשל אחרים).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth, requireAdmin } = require("../middleware/auth");

function register(router) {
  router.get("/api/branches/:branchId/beneficiaries", requireAuth(async (ctx) => {
    const rows = db.prepare("SELECT * FROM beneficiaries WHERE branch_id = ? AND active = 1 ORDER BY name")
      .all(ctx.params.branchId);
    return json(ctx.res, 200, { beneficiaries: rows });
  }));

  router.post("/api/branches/:branchId/beneficiaries", requireAdmin(async (ctx) => {
    const { name, phone, paymentDetails, monthlyAmount } = ctx.body;
    if (!name) return json(ctx.res, 400, { error: "חסר שם מוטב" });
    const info = db.prepare(
      "INSERT INTO beneficiaries (branch_id, name, phone, payment_details, monthly_amount) VALUES (?, ?, ?, ?, ?)"
    ).run(ctx.params.branchId, name.trim(), phone || null, paymentDetails || null, monthlyAmount || null);
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));

  router.put("/api/beneficiaries/:id", requireAdmin(async (ctx) => {
    const existing = db.prepare("SELECT * FROM beneficiaries WHERE id = ?").get(ctx.params.id);
    if (!existing) return json(ctx.res, 404, { error: "לא נמצא" });
    const { name, phone, paymentDetails, monthlyAmount, active } = ctx.body;
    db.prepare(
      "UPDATE beneficiaries SET name = ?, phone = ?, payment_details = ?, monthly_amount = ?, active = ? WHERE id = ?"
    ).run(
      name ?? existing.name,
      phone ?? existing.phone,
      paymentDetails ?? existing.payment_details,
      monthlyAmount ?? existing.monthly_amount,
      active === undefined ? existing.active : (active ? 1 : 0),
      ctx.params.id
    );
    return json(ctx.res, 200, { ok: true });
  }));

  router.delete("/api/beneficiaries/:id", requireAdmin(async (ctx) => {
    db.prepare("UPDATE beneficiaries SET active = 0 WHERE id = ?").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
