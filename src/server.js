// server.js — נקודת הכניסה לשרת. http המובנה + הראוטר שלנו (בלי Express), בדיוק כמו "הפנקס שלי".
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Router, json, html } = require("./router");
const debugLog = require("./debugLog");

// עוטפים את console.log/console.error כדי לתפוס אוטומטית שורות אבחון רלוונטיות (מייל, ימות, שגיאות
// ראוטר) לתוך debugLog - כדי שאפשר יהיה לשלוף אותן דרך /api/debug/recent-logs בלי לחפש ב-Logs של
// Render ידנית. לא משנה את ההתנהגות הרגילה (עדיין מודפס כרגיל ל-Logs). אותו דפוס כמו "הפנקס שלי".
const DEBUG_PATTERN = /מייל|\[YEMOT\]|\[ROUTER\]|שגיאה|נכשל/;
const originalConsoleLog = console.log;
console.log = (...args) => {
  const line = args.map(String).join(" ");
  if (DEBUG_PATTERN.test(line)) debugLog.push(line);
  originalConsoleLog(...args);
};
const originalConsoleError = console.error;
console.error = (...args) => {
  const line = args.map(String).join(" ");
  debugLog.push(`[ERROR] ${line}`);
  originalConsoleError(...args);
};

const router = new Router();

router.get("/api/health", async (ctx) => {
  return json(ctx.res, 200, { status: "ok", service: "שולחן עבודה - ניהול", time: new Date().toISOString() });
});

// כלי אבחון זמני: שליפת שורות הלוג האחרונות (מייל/ימות/שגיאות) בלי לדפדף ב-Render Logs. מוגן
// במילת-מעבר קבועה בכתובת (לא הרשאה אמיתית - זה כלי זמני לפיתוח, לא לחשוף בפרודקשן לטווח ארוך).
router.get("/api/debug/recent-logs", async (ctx) => {
  if (ctx.query.key !== "sulchan-diag-7429") return json(ctx.res, 403, { error: "לא מורשה" });
  return json(ctx.res, 200, { lines: debugLog.getAll() });
});

const APP_HTML_PATH = path.join(__dirname, "..", "public", "app.html");
router.get("/", async (ctx) => {
  try {
    return html(ctx.res, 200, fs.readFileSync(APP_HTML_PATH, "utf8"));
  } catch (e) {
    return json(ctx.res, 500, { error: "לא נמצא קובץ הממשק (public/app.html)" });
  }
});

// "ממיר דקות" - כלי עצמאי (client-side בלבד, בלי שרת/מסד נתונים משלו) שהוגש בעבר כאתר סטטי נפרד -
// עכשיו גם מוגש כאן בטאב בתוך "שולחן עבודה" (ר' טאב "ממיר דקות" ב-public/app.html, שטוען אותו
// בתוך iframe). מוגש בנתיב סטטי נפרד מ-"/" כדי שלא יתנגש עם ה-SPA הראשי.
const MINUTES_CONVERTER_PATH = path.join(__dirname, "..", "public", "minutes-converter.html");
router.get("/minutes-converter.html", async (ctx) => {
  try {
    return html(ctx.res, 200, fs.readFileSync(MINUTES_CONVERTER_PATH, "utf8"));
  } catch (e) {
    return json(ctx.res, 500, { error: "לא נמצא קובץ ממיר הדקות" });
  }
});

require("./routes/auth").register(router);
require("./routes/branches").register(router);
require("./routes/beneficiaries").register(router);
require("./routes/instructions").register(router);
require("./routes/reports").register(router);
require("./routes/chat").register(router);
require("./routes/adminChat").register(router);
require("./routes/notifications").register(router);
require("./routes/transactions").register(router);
require("./routes/importTransactions").register(router);
require("./routes/documents").register(router);
require("./routes/yemot").register(router);

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => router.handle(req, res));

server.listen(PORT, () => {
  console.log(`🚀 שרת "שולחן עבודה - ניהול" פועל על פורט ${PORT}`);
  console.log(`   בדיקת חיים: http://localhost:${PORT}/api/health`);
});

module.exports = server;
