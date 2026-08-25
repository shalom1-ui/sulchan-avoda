// routes/auth.js — התחברות (מנהלים ועובדים כאחד, מבדילים לפי role בטוקן).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { verifyPassword, signToken, isValidPin } = require("../utils/crypto");
const { requireAuth, requireAdmin } = require("../middleware/auth");

function register(router) {
  router.post("/api/login", async (ctx) => {
    const { username, pin } = ctx.body;
    if (!username || !pin) return json(ctx.res, 400, { error: "יש להזין שם משתמש וקוד" });
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username.trim());
    if (!user || !verifyPassword(String(pin), user.password_hash)) {
      return json(ctx.res, 401, { error: "שם משתמש או קוד שגויים" });
    }
    const token = signToken({ userId: user.id, username: user.username, role: user.role, fullName: user.full_name });
    return json(ctx.res, 200, {
      token,
      user: { id: user.id, fullName: user.full_name, username: user.username, role: user.role },
    });
  });

  router.get("/api/me", requireAuth(async (ctx) => {
    const user = db.prepare("SELECT id, full_name, username, role, phone, email FROM users WHERE id = ?").get(ctx.user.userId);
    if (!user) return json(ctx.res, 404, { error: "משתמש לא נמצא" });
    // מיישרים ל-camelCase (fullName) - זהה לצורת התשובה של POST /api/login, כדי שהאתר (public/app.html)
    // יוכל להשתמש ב-ME.fullName באופן עקבי בין השניים (הבאג היה: אחרי טעינה מחדש/כניסה עם טוקן קיים,
    // boot() קורא ל-/api/me, וה-fullName יצא undefined כי כאן הוחזר full_name בלבד).
    return json(ctx.res, 200, { user: { ...user, fullName: user.full_name } });
  }));

  // ניהול משתמשים (מנהלים בלבד) - יצירת עובד/מנהל חדש, עדכון קוד, השבתה.
  router.get("/api/users", requireAdmin(async (ctx) => {
    const rows = db.prepare("SELECT id, full_name, username, role, phone, email, active FROM users ORDER BY role, full_name").all();
    return json(ctx.res, 200, { users: rows });
  }));

  router.post("/api/users", requireAdmin(async (ctx) => {
    const { fullName, username, pin, role, phone, email } = ctx.body;
    if (!fullName || !username || !pin || !role) return json(ctx.res, 400, { error: "חסרים שדות חובה" });
    if (!["admin", "worker"].includes(role)) return json(ctx.res, 400, { error: "role לא תקין" });
    if (!isValidPin(pin)) return json(ctx.res, 400, { error: "הקוד חייב להיות בדיוק 4 ספרות" });
    const { hashPassword } = require("../utils/crypto");
    try {
      const info = db.prepare(
        "INSERT INTO users (full_name, username, password_hash, role, phone, email) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(fullName, username.trim(), hashPassword(String(pin)), role, phone || null, email || null);
      return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return json(ctx.res, 409, { error: "שם המשתמש כבר תפוס" });
      throw e;
    }
  }));

  router.put("/api/users/:id", requireAdmin(async (ctx) => {
    const { fullName, pin, phone, email, active } = ctx.body;
    const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.params.id);
    if (!existing) return json(ctx.res, 404, { error: "לא נמצא" });
    const { hashPassword } = require("../utils/crypto");
    db.prepare(
      "UPDATE users SET full_name = ?, phone = ?, email = ?, active = ?, password_hash = ? WHERE id = ?"
    ).run(
      fullName ?? existing.full_name,
      phone ?? existing.phone,
      email ?? existing.email,
      active === undefined ? existing.active : (active ? 1 : 0),
      pin ? (isValidPin(pin) ? hashPassword(String(pin)) : existing.password_hash) : existing.password_hash,
      ctx.params.id
    );
    return json(ctx.res, 200, { ok: true });
  }));

  // עובד: לאיזה סניפים הוא משויך
  router.get("/api/users/:id/branches", requireAuth(async (ctx) => {
    if (ctx.user.role !== "admin" && Number(ctx.user.userId) !== Number(ctx.params.id)) {
      return json(ctx.res, 403, { error: "אין הרשאה" });
    }
    const rows = db.prepare(
      `SELECT b.* FROM branches b
       JOIN worker_branches wb ON wb.branch_id = b.id
       WHERE wb.worker_user_id = ? ORDER BY b.name`
    ).all(ctx.params.id);
    return json(ctx.res, 200, { branches: rows });
  }));

  router.post("/api/users/:id/branches", requireAdmin(async (ctx) => {
    const { branchId } = ctx.body;
    try {
      db.prepare("INSERT INTO worker_branches (worker_user_id, branch_id) VALUES (?, ?)").run(ctx.params.id, branchId);
    } catch (e) {
      if (!/UNIQUE/.test(e.message)) throw e;
    }
    return json(ctx.res, 201, { ok: true });
  }));

  router.delete("/api/users/:id/branches/:branchId", requireAdmin(async (ctx) => {
    db.prepare("DELETE FROM worker_branches WHERE worker_user_id = ? AND branch_id = ?").run(ctx.params.id, ctx.params.branchId);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
