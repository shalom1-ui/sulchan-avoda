// routes/beneficiaries.js — מוטבים למשכורות: מי מקבל תשלום על כל סניף. מנהלים בלבד לכתיבה,
// גם עובד המשויך לסניף יכול לצפות ברשימת המוטב שלו (לא בשל אחרים).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAuth, requireAdmin } = require("../middleware/auth");

function register(router) {
  // רשימה שטוחה של כל המוטבים בכל הסניפים יחד, עם שם הסניף כעמודה - כדי שסכומים זהים בין סניפים
  // שונים לא יתבלבלו (ר' משוב המשתמש: "אם יש סכומים זהים שאוכל לראות מיד לאיזה סניף זה משויך").
  router.get("/api/beneficiaries", requireAdmin(async (ctx) => {
    const rows = db.prepare(
      `SELECT ben.*, b.name AS branch_name FROM beneficiaries ben JOIN branches b ON b.id = ben.branch_id
       WHERE ben.active = 1 ORDER BY ben.monthly_amount DESC, b.name`
    ).all();
    return json(ctx.res, 200, { beneficiaries: rows });
  }));

  router.get("/api/branches/:branchId/beneficiaries", requireAuth(async (ctx) => {
    const rows = db.prepare("SELECT * FROM beneficiaries WHERE branch_id = ? AND active = 1 ORDER BY name")
      .all(ctx.params.branchId);
    return json(ctx.res, 200, { beneficiaries: rows });
  }));

  const VALID_CATEGORIES = new Set(["salary", "electricity", "property_tax"]);

  router.post("/api/branches/:branchId/beneficiaries", requireAdmin(async (ctx) => {
    const { name, phone, paymentDetails, monthlyAmount, category } = ctx.body;
    if (!name) return json(ctx.res, 400, { error: "חסר שם מוטב" });
    const cat = VALID_CATEGORIES.has(category) ? category : "salary";
    const info = db.prepare(
      "INSERT INTO beneficiaries (branch_id, category, name, phone, payment_details, monthly_amount) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(ctx.params.branchId, cat, name.trim(), phone || null, paymentDetails || null, monthlyAmount || null);
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));

  // עדכון מוטב קיים - בעיקר לשינוי סכום חודשי כשהוא משתנה ("שבחודש הבא ישאר הסכום, ואם יהיה שינוי
  // שאוכל לשנות" - ר' משוב המשתמש). הסכום עצמו הוא שדה יחיד שממשיך "לחיות" בין חודשים, לא נרשם
  // מחדש כל חודש - פשוט עורכים אותו כשהוא באמת משתנה.
  router.put("/api/beneficiaries/:id", requireAdmin(async (ctx) => {
    const existing = db.prepare("SELECT * FROM beneficiaries WHERE id = ?").get(ctx.params.id);
    if (!existing) return json(ctx.res, 404, { error: "לא נמצא" });
    const { name, phone, paymentDetails, monthlyAmount, active, category } = ctx.body;
    db.prepare(
      "UPDATE beneficiaries SET name = ?, phone = ?, payment_details = ?, monthly_amount = ?, active = ?, category = ? WHERE id = ?"
    ).run(
      name ?? existing.name,
      phone ?? existing.phone,
      paymentDetails ?? existing.payment_details,
      monthlyAmount ?? existing.monthly_amount,
      active === undefined ? existing.active : (active ? 1 : 0),
      VALID_CATEGORIES.has(category) ? category : existing.category,
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
