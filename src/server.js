// server.js — נקודת הכניסה לשרת. http המובנה + הראוטר שלנו (בלי Express), בדיוק כמו "הפנקס שלי".
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Router, json, html } = require("./router");

const router = new Router();

router.get("/api/health", async (ctx) => {
  return json(ctx.res, 200, { status: "ok", service: "שולחן עבודה - ניהול", time: new Date().toISOString() });
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
require("./routes/notifications").register(router);
require("./routes/transactions").register(router);
require("./routes/importTransactions").register(router);
require("./routes/yemot").register(router);

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => router.handle(req, res));

server.listen(PORT, () => {
  console.log(`🚀 שרת "שולחן עבודה - ניהול" פועל על פורט ${PORT}`);
  console.log(`   בדיקת חיים: http://localhost:${PORT}/api/health`);
});

module.exports = server;
