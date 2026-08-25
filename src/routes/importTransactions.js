// importTransactions.js — ייבוא דפי בנק/אשראי (Excel/CSV/PDF) להכנסות/הוצאות של העסק. אותה ספרייה
// מוכחת בדיוק כמו "הפנקס שלי" (src/lib/*Parser.js, importMapping.js - הועתקו כמו שהם). מנהלים בלבד.
// שני שלבים: /parse (תצוגה מקדימה בלבד) ואז /commit (שמירה בפועל של מה שהמנהל אישר/ערך).
"use strict";
const crypto = require("crypto");
const db = require("../db");
const { json } = require("../router");
const { requireAdmin } = require("../middleware/auth");
const { parseXlsx } = require("../lib/xlsxParser");
const { parseCsv } = require("../lib/csvParser");
const { looksLikeHtml, looksLikeLegacyBinaryXls, parseHtmlTable } = require("../lib/htmlTableParser");
const { parsePdf } = require("../lib/pdfParser");
const { rowsToTransactions } = require("../lib/importMapping");

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ROWS_PER_IMPORT = 2000;

function decodeBase64File(data_base64) {
  const base64Only = String(data_base64 || "").includes(",") ? String(data_base64).split(",").pop() : data_base64;
  return Buffer.from(base64Only, "base64");
}

function importHash(t) {
  return crypto.createHash("sha256").update(`${t.date}|${t.amount}|${t.type}|${t.description || ""}`).digest("hex");
}

function isXlsxFilename(name) { return /\.xlsx$/i.test(String(name || "")); }
function isCsvFilename(name) { return /\.csv$/i.test(String(name || "")); }

function register(router) {
  router.post("/api/transactions/import/parse", requireAdmin(async (ctx) => {
    const { data_base64, filename, source_type } = ctx.body;
    if (!data_base64) return json(ctx.res, 400, { error: "לא התקבל תוכן קובץ (data_base64)" });
    const sourceType = source_type === "card" ? "card" : "bank";

    let buffer;
    try {
      buffer = decodeBase64File(data_base64);
    } catch (e) {
      return json(ctx.res, 400, { error: "תוכן הקובץ אינו base64 תקין" });
    }
    if (!buffer.length) return json(ctx.res, 400, { error: "הקובץ ריק" });
    if (buffer.length > MAX_FILE_BYTES) return json(ctx.res, 400, { error: "הקובץ גדול מדי (מעל 15MB)" });

    let rows;
    try {
      if (buffer.length >= 5 && buffer.toString("latin1", 0, 5) === "%PDF-") {
        rows = parsePdf(buffer).rows;
      } else if (looksLikeHtml(buffer)) {
        rows = parseHtmlTable(buffer.toString("utf8"));
      } else if (looksLikeLegacyBinaryXls(buffer)) {
        return json(ctx.res, 400, {
          error: "זהו קובץ .xls ישן (בפורמט בינארי של Excel 97-2003) שלא נתמך כרגע. פתחו אותו ב-Excel ושמרו מחדש כ-.xlsx או כ-.csv, ונסו שוב.",
        });
      } else {
        const looksLikeZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
        const isXlsx = isXlsxFilename(filename) || (!isCsvFilename(filename) && looksLikeZip);
        rows = isXlsx ? parseXlsx(buffer) : parseCsv(buffer.toString("utf8"));
      }
    } catch (e) {
      return json(ctx.res, 400, { error: `לא ניתן לקרוא את הקובץ: ${e.message}` });
    }
    if (!rows.length) return json(ctx.res, 400, { error: "לא נמצאו שורות נתונים בקובץ" });
    if (rows.length > MAX_ROWS_PER_IMPORT) {
      return json(ctx.res, 400, { error: `הקובץ מכיל יותר מדי שורות (${rows.length}) - הגבלה של ${MAX_ROWS_PER_IMPORT} שורות לייבוא אחד` });
    }

    const result = rowsToTransactions(rows, sourceType);
    if (result.error) return json(ctx.res, 400, { error: result.error });
    if (!result.transactions.length) {
      return json(ctx.res, 400, { error: "זוהו כותרות עמודות, אבל לא נמצאה אף תנועה תקינה לייבוא בקובץ" });
    }

    const existingHashes = new Set(
      db.prepare("SELECT import_hash FROM transactions WHERE import_hash IS NOT NULL").all().map(r => r.import_hash)
    );
    const transactions = result.transactions.map(t => ({ ...t, alreadyImported: existingHashes.has(importHash(t)) }));

    return json(ctx.res, 200, {
      transactions,
      skippedRowsCount: result.skippedCount,
      detectedColumns: result.columns,
    });
  }));

  router.post("/api/transactions/import/commit", requireAdmin(async (ctx) => {
    const list = Array.isArray(ctx.body.transactions) ? ctx.body.transactions : null;
    if (!list || !list.length) return json(ctx.res, 400, { error: "לא התקבלה רשימת תנועות לייבוא" });
    if (list.length > MAX_ROWS_PER_IMPORT) {
      return json(ctx.res, 400, { error: `יותר מדי תנועות בבקשה אחת (הגבלה של ${MAX_ROWS_PER_IMPORT})` });
    }
    const branchId = ctx.body.branchId || null;
    const paymentMethod = ctx.body.source_type === "card" ? "card" : ctx.body.source_type === "bank" ? "bank" : null;

    // שומרים את הקובץ המקורי (אם נשלח) כדי שאפשר יהיה לפתוח/להוריד אותו שוב בהמשך מטאב "כספים" -
    // ר' routes/documents.js. אופציונלי בכוונה (data_base64 עשוי לא להישלח בקריאות ישנות/בדיקות).
    let documentId = null;
    if (ctx.body.data_base64 && ctx.body.filename) {
      try {
        const buffer = decodeBase64File(ctx.body.data_base64);
        const info = db.prepare(
          "INSERT INTO documents (filename, mime_type, size_bytes, data, uploaded_by) VALUES (?, ?, ?, ?, ?)"
        ).run(String(ctx.body.filename).slice(0, 255), ctx.body.mime_type || null, buffer.length, buffer, ctx.user.userId);
        documentId = Number(info.lastInsertRowid);
      } catch (e) {
        console.error("שמירת קובץ המקור נכשלה (לא קריטי, הייבוא ממשיך בלעדיו):", e.message);
      }
    }

    const insert = db.prepare(
      "INSERT INTO transactions (branch_id, type, amount, category, note, source, import_hash, payment_method, document_id, occurred_at, created_by) VALUES (?, ?, ?, ?, ?, 'import', ?, ?, ?, ?, ?)"
    );
    let imported = 0, skippedDuplicates = 0, skippedInvalid = 0;

    for (const raw of list) {
      const type = raw && (raw.type === "income" || raw.type === "expense") ? raw.type : null;
      const amount = raw ? Number(raw.amount) : NaN;
      const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? raw.date : null;
      if (!type || !date || !Number.isFinite(amount) || amount <= 0) { skippedInvalid++; continue; }

      const description = raw.description ? String(raw.description).trim().slice(0, 500) : "";
      const category = raw.category ? String(raw.category).trim().slice(0, 100) : "אחר";
      const t = { date, amount: Math.round(amount * 100) / 100, type, description };
      const hash = importHash(t);

      const exists = db.prepare("SELECT 1 FROM transactions WHERE import_hash = ?").get(hash);
      if (exists) { skippedDuplicates++; continue; }

      try {
        insert.run(branchId, type, t.amount, category, description || null, hash, paymentMethod, documentId, `${date} 12:00:00`, ctx.user.userId);
        imported++;
      } catch (e) {
        if (/UNIQUE constraint failed/i.test(e.message)) skippedDuplicates++;
        else throw e;
      }
    }

    return json(ctx.res, 201, { imported, skippedDuplicates, skippedInvalid, documentId });
  }));
}

module.exports = { register };
