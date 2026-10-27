// utils/rateLimit.js — מגביל קצב פשוט בזיכרון, להגנה מפני ניסיונות ניחוש/הצפה (brute-force)
// על נתיבים רגישים כמו התחברות ואיפוס סיסמה. אין תלות חיצונית; מתאפס אוטומטית בחלון זמן.
"use strict";

const hits = new Map(); // key -> { count, resetAt }

// מחזיר { ok, remaining, retryAfterSec }. ok=false כשחרגו מהמכסה בחלון הנוכחי.
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let rec = hits.get(key);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + windowMs };
    hits.set(key, rec);
  }
  rec.count++;
  return {
    ok: rec.count <= max,
    remaining: Math.max(0, max - rec.count),
    retryAfterSec: Math.max(1, Math.ceil((rec.resetAt - now) / 1000)),
  };
}

// ניקוי תקופתי של רשומות שפג תוקפן, כדי שה-Map לא יגדל ללא גבול. unref() כדי שלא יחזיק את התהליך חי.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
}, 60_000);
if (sweep.unref) sweep.unref();

// כתובת ה-IP של הפונה. ב-Render/פרוקסי הכתובת האמיתית מגיעה ב-X-Forwarded-For (הראשון ברשימה).
function clientIp(req) {
  const xff = req.headers && req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

module.exports = { rateLimit, clientIp };
