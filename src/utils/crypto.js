// crypto.js — הצפנת סיסמאות (scrypt) וטוקני התחברות (JWT מינימלי בעצמנו).
// הכל מבוסס על מודול ה-crypto המובנה של Node.js — אין צורך ב-bcrypt/jsonwebtoken חיצוניים.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// סוד חתימת הטוקנים. אם לא הוגדר JWT_SECRET ב-env — במקום ברירת מחדל קבועה שחשופה בקוד (שאיפשרה
// לכל מי שרואה את המקור לזייף טוקני התחברות של מנהל) — יוצרים סוד אקראי חזק פעם אחת ושומרים אותו
// לדיסק הקבוע (ליד מסד הנתונים), כך שהטוקנים שורדים הפעלה-מחדש. אם אי אפשר לכתוב לדיסק — נופלים
// לסוד אקראי בזיכרון (טוקנים לא ישרדו ריסטארט, אבל עדיף בהרבה על סוד צפוי).
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const dir = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, "..", "..", "data");
  const file = path.join(dir, ".jwt-secret");
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
    fs.mkdirSync(dir, { recursive: true });
    const secret = crypto.randomBytes(48).toString("hex");
    fs.writeFileSync(file, secret, { mode: 0o600 });
    console.warn("[אבטחה] לא הוגדר JWT_SECRET — נוצר סוד אקראי קבוע ונשמר לדיסק. מומלץ להגדיר JWT_SECRET ב-env.");
    return secret;
  } catch (e) {
    console.warn("[אבטחה] לא ניתן לשמור JWT_SECRET לדיסק (" + e.message + ") — נוצר סוד זמני בזיכרון.");
    return crypto.randomBytes(48).toString("hex");
  }
}

const JWT_SECRET = resolveJwtSecret();

// ---------- סיסמאות (scrypt + salt, שקול ל-bcrypt מבחינת אבטחה) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

// ---------- JWT מינימלי (HS256) ----------
function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString();
}

function signToken(payload, expiresInSeconds = 60 * 60 * 24 * 30) {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const headerPart = base64url(JSON.stringify(header));
  const payloadPart = base64url(JSON.stringify(fullPayload));
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${headerPart}.${payloadPart}.${signature}`;
}

function verifyToken(token) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signature] = parts;
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${headerPart}.${payloadPart}`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(base64urlDecode(payloadPart));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null; // פג תוקף
    return payload;
  } catch {
    return null;
  }
}

// ---------- קוד חד-פעמי לשחזור סיסמה (4 ספרות) ----------
function generateOtpCode() {
  // 0000–9999 (כולל) = 10,000 אפשרויות. randomInt עם מקסימום בלעדי, לכן 10000, ו-padStart כדי
  // שגם קוד כמו "0042" יהיה בן 4 ספרות תקני (קודם 9999 לא נוצר כלל, והטווח היה קטן יותר).
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}
function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// ---------- סיסמה = קוד PIN בן 4 ספרות בדיוק ----------
// החלטה מכוונת: כל סיסמה בכל המערכת (בין אם נבחרה באתר או הוקשה בטלפון) חייבת להיות בדיוק 4 ספרות.
// זה מה שמאפשר "הדדיות" מלאה - סיסמה שנבחרה באתר עובדת גם כקוד PIN בטלפון, וקוד PIN שהוקש בטלפון
// (ר' routes/ivr.js, signup_pin) עובד גם כסיסמה להתחברות באתר - זו בדיוק אותה מחרוזת, אותו hash,
// בלי שדה נפרד. הבחירה בדיוק 4 ספרות (ולא יותר) היא כי בטלפון אפשר רק להקיש ספרות במקלדת - סיסמה
// ארוכה/עם אותיות פשוט לא ניתנת להזנה אמינה בערוץ הזה. משתמשים קיימים עם סיסמה "ישנה" (לא 4 ספרות,
// מלפני השינוי הזה) ממשיכים להתחבר כרגיל - האכיפה חלה רק על סיסמה חדשה שנקבעת מעכשיו והלאה.
function isValidPin(value) {
  return /^\d{4}$/.test(String(value || "").trim());
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, generateOtpCode, hashCode, isValidPin };
