// transactions.js — הכנסות/הוצאות של העסק. מנהלים בלבד (מידע כספי חסוי).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAdmin } = require("../middleware/auth");

function register(router) {
  router.get("/api/transactions", requireAdmin(async (ctx) => {
    const rows = db.prepare(
      `SELECT t.*, b.name AS branch_name FROM transactions t LEFT JOIN branches b ON b.id = t.branch_id
       ORDER BY occurred_at DESC, t.id DESC LIMIT 1000`
    ).all();

    const income = rows.filter(r => r.type === "income").reduce((s, r) => s + r.amount, 0);
    const expense = rows.filter(r => r.type === "expense").reduce((s, r) => s + r.amount, 0);

    const byCategory = {};
    for (const r of rows) {
      if (r.type !== "expense") continue;
      const cat = r.category || "אחר";
      byCategory[cat] = (byCategory[cat] || 0) + r.amount;
    }

    return json(ctx.res, 200, {
      transactions: rows,
      summary: { income, expense, balance: income - expense },
      byCategory,
    });
  }));

  router.post("/api/transactions", requireAdmin(async (ctx) => {
    const { type, amount, category, note, branchId } = ctx.body;
    if (!["income", "expense"].includes(type)) {
      return json(ctx.res, 400, { error: "סוג תנועה חייב להיות income או expense" });
    }
    const numAmount = Number(amount);
    if (!numAmount || numAmount <= 0) return json(ctx.res, 400, { error: "יש להזין סכום תקין" });

    const info = db.prepare(
      "INSERT INTO transactions (branch_id, type, amount, category, note, source, created_by) VALUES (?, ?, ?, ?, ?, 'web', ?)"
    ).run(branchId || null, type, numAmount, category || null, note || null, ctx.user.userId);

    const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(info.lastInsertRowid);
    return json(ctx.res, 201, { transaction: row });
  }));

  router.delete("/api/transactions/:id", requireAdmin(async (ctx) => {
    const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(ctx.params.id);
    if (!row) return json(ctx.res, 404, { error: "תנועה לא נמצאה" });
    db.prepare("DELETE FROM transactions WHERE id = ?").run(row.id);
    return json(ctx.res, 200, { message: "התנועה נמחקה" });
  }));

  // מגמה חודשית (12 חודשים אחרונים) — לגרף
  router.get("/api/transactions/trend", requireAdmin(async (ctx) => {
    const rows = db.prepare(
      `SELECT strftime('%Y-%m', occurred_at) AS month,
              SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense
       FROM transactions GROUP BY month ORDER BY month DESC LIMIT 12`
    ).all();
    return json(ctx.res, 200, { trend: rows.reverse() });
  }));
}

module.exports = { register };
