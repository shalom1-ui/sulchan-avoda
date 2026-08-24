"use strict";
const { verifyToken } = require("../utils/crypto");
const { json } = require("../router");

// מחזיר את המשתמש המחובר מתוך כותרת Authorization: Bearer <token>, או null אם אין/לא תקין
function getAuthUser(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  return verifyToken(token); // { userId, username, role, iat, exp } | null
}

// עוטף handler ומחייב התחברות (כל תפקיד); מזריק ctx.user
function requireAuth(handler) {
  return async (ctx) => {
    const user = getAuthUser(ctx.req);
    if (!user) return json(ctx.res, 401, { error: "נדרשת התחברות" });
    ctx.user = user;
    return handler(ctx);
  };
}

// עוטף handler ומחייב תפקיד מנהל בלבד (כספים/מוטבים/ניהול סניפים/עובדים)
function requireAdmin(handler) {
  return requireAuth(async (ctx) => {
    if (ctx.user.role !== "admin") return json(ctx.res, 403, { error: "פעולה זו למנהלים בלבד" });
    return handler(ctx);
  });
}

module.exports = { getAuthUser, requireAuth, requireAdmin };
