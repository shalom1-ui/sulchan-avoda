// routes/documents.js — קבצי בנק/אשראי שהועלו לייבוא (ר' importTransactions.js) - רשימה + הורדה
// חוזרת, כדי שאפשר יהיה לבדוק תנועה מול הקובץ המקורי בלי לחפש אותו שוב במחשב. מנהלים בלבד.
"use strict";
const db = require("../db");
const { json, raw } = require("../router");
const { requireAdmin } = require("../middleware/auth");

function register(router) {
  router.get("/api/documents", requireAdmin(async (ctx) => {
    const rows = db.prepare(
      "SELECT id, filename, mime_type, size_bytes, created_at FROM documents ORDER BY created_at DESC"
    ).all();
    return json(ctx.res, 200, { documents: rows });
  }));

  router.get("/api/documents/:id/download", requireAdmin(async (ctx) => {
    const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(ctx.params.id);
    if (!doc) return json(ctx.res, 404, { error: "הקובץ לא נמצא" });
    return raw(ctx.res, 200, doc.data, { contentType: doc.mime_type || "application/octet-stream", filename: doc.filename });
  }));
}

module.exports = { register };
