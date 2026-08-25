// routes/auth.js — התחברות (מנהלים ועובדים כאחד, מבדילים לפי role בטוקן).
"use strict";
const db = require("../db");
const { json } = require("../router");
const { verifyPassword, hashPassword, signToken, isValidPin, generateOtpCode, hashCode } = require("../utils/crypto");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { sendEmail } = require("../services/email");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function register(router) {
  // הרשמה עצמית - פתוחה לכולם, אבל מצליחה רק אם מנהל כבר אישר את המייל מראש (ר' /api/invites).
  // "כל אחד יכול להירשם, אבל אם לא הכנסתי את המייל כמנהל הם לא יכולים" - משוב המשתמש.
  router.post("/api/register", async (ctx) => {
    const { email, fullName, username, pin, phone } = ctx.body;
    if (!email || !fullName || !username || !pin) return json(ctx.res, 400, { error: "חסרים שדות חובה" });
    if (!isValidPin(pin)) return json(ctx.res, 400, { error: "הקוד חייב להיות בדיוק 4 ספרות" });

    const normalizedEmail = normalizeEmail(email);
    const invite = db.prepare("SELECT * FROM signup_invites WHERE email = ? AND used_at IS NULL").get(normalizedEmail);
    if (!invite) {
      return json(ctx.res, 403, { error: "המייל הזה עדיין לא אושר ע\"י מנהל. בקשו מהמנהל להוסיף אתכם לרשימת המורשים." });
    }

    let userId;
    try {
      const info = db.prepare(
        "INSERT INTO users (full_name, username, password_hash, role, phone, email) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(fullName.trim(), username.trim(), hashPassword(String(pin)), invite.role, phone || null, normalizedEmail);
      userId = Number(info.lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return json(ctx.res, 409, { error: "שם המשתמש כבר תפוס" });
      throw e;
    }
    db.prepare("UPDATE signup_invites SET used_at = datetime('now'), used_by_user_id = ? WHERE id = ?").run(userId, invite.id);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
    const token = signToken({ userId: user.id, username: user.username, role: user.role, fullName: user.full_name });
    return json(ctx.res, 201, {
      token,
      user: { id: user.id, fullName: user.full_name, username: user.username, role: user.role },
    });
  });

  // ניהול רשימת המיילים המורשים להרשמה עצמית (מנהלים בלבד).
  router.get("/api/invites", requireAdmin(async (ctx) => {
    const rows = db.prepare(
      `SELECT si.*, u.full_name AS used_by_name FROM signup_invites si
       LEFT JOIN users u ON u.id = si.used_by_user_id ORDER BY si.created_at DESC`
    ).all();
    return json(ctx.res, 200, { invites: rows });
  }));

  router.post("/api/invites", requireAdmin(async (ctx) => {
    const { email, role } = ctx.body;
    if (!email || !["admin", "worker"].includes(role)) return json(ctx.res, 400, { error: "חסר מייל, או role לא תקין" });
    try {
      const info = db.prepare(
        "INSERT INTO signup_invites (email, role, created_by) VALUES (?, ?, ?)"
      ).run(normalizeEmail(email), role, ctx.user.userId);
      return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return json(ctx.res, 409, { error: "המייל הזה כבר ברשימה" });
      throw e;
    }
  }));

  router.delete("/api/invites/:id", requireAdmin(async (ctx) => {
    db.prepare("DELETE FROM signup_invites WHERE id = ? AND used_at IS NULL").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));

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

  // שכחתי סיסמה - שלב 1: מבקשים קוד. תשובה גנרית תמיד (גם אם שם המשתמש לא קיים) כדי לא לחשוף
  // אילו שמות משתמש קיימים במערכת. הקוד עצמו נשלח רק אם יש למשתמש כתובת מייל רשומה.
  router.post("/api/forgot-password/request", async (ctx) => {
    const { username } = ctx.body;
    const genericMsg = "אם שם המשתמש קיים ויש לו כתובת מייל רשומה, קוד נשלח אליה.";
    if (!username) return json(ctx.res, 400, { error: "יש להזין שם משתמש" });
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username.trim());
    if (user && user.email) {
      const code = generateOtpCode();
      db.prepare("UPDATE users SET reset_code_hash = ?, reset_code_expires_at = datetime('now', '+15 minutes') WHERE id = ?")
        .run(hashCode(code), user.id);
      sendEmail({
        to: user.email,
        subject: "קוד לאיפוס סיסמה - שולחן עבודה",
        body: `שלום ${user.full_name},\n\nקוד לאיפוס הסיסמה שלכם: ${code}\n\nהקוד בתוקף ל-15 דקות. אם לא ביקשתם זאת, התעלמו מהודעה זו.`,
      }).catch((e) => console.error("שליחת מייל איפוס סיסמה נכשלה:", e.message));
    }
    return json(ctx.res, 200, { message: genericMsg });
  });

  // שכחתי סיסמה - שלב 2: הזנת הקוד + סיסמה חדשה.
  router.post("/api/forgot-password/confirm", async (ctx) => {
    const { username, code, newPin } = ctx.body;
    if (!username || !code || !newPin) return json(ctx.res, 400, { error: "חסרים שדות חובה" });
    if (!isValidPin(newPin)) return json(ctx.res, 400, { error: "הקוד החדש חייב להיות בדיוק 4 ספרות" });
    const user = db.prepare("SELECT * FROM users WHERE username = ? AND active = 1").get(username.trim());
    if (!user || !user.reset_code_hash || !user.reset_code_expires_at) {
      return json(ctx.res, 400, { error: "לא נמצאה בקשת איפוס פעילה עבור המשתמש הזה" });
    }
    // SQLite datetime() מחזיר "YYYY-MM-DD HH:MM:SS" (רווח, לא T) - צריך להמיר לפורמט ISO תקני לפני
    // שDate() בג'אווהסקריפט יודע לפרש את זה נכון בכל הסביבות (במיוחד חשוב בשרת, לא רק בדפדפן).
    const expiresAtIso = user.reset_code_expires_at.replace(" ", "T") + "Z";
    if (new Date(expiresAtIso) < new Date()) {
      return json(ctx.res, 400, { error: "הקוד פג תוקף - בקשו קוד חדש" });
    }
    if (hashCode(String(code).trim()) !== user.reset_code_hash) {
      return json(ctx.res, 400, { error: "קוד שגוי" });
    }
    db.prepare("UPDATE users SET password_hash = ?, reset_code_hash = NULL, reset_code_expires_at = NULL WHERE id = ?")
      .run(hashPassword(String(newPin)), user.id);
    return json(ctx.res, 200, { ok: true });
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
