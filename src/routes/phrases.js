// routes/phrases.js — מילון ביטויים שמורים לשדה "תוכן ההוראה" (טקסט חופשי) בטופס ההוראות,
// כדי להציע ביטויים קצרים ששימשו בעבר במקום להקליד אותם מחדש בכל פעם.
"use strict";
const db = require("../db");
const { json } = require("../router");
const { requireAdmin } = require("../middleware/auth");

function register(router) {
  router.get("/api/instruction-phrases", requireAdmin(async (ctx) => {
    const rows = db.prepare("SELECT * FROM instruction_phrases ORDER BY text").all();
    return json(ctx.res, 200, { phrases: rows });
  }));

  router.post("/api/instruction-phrases", requireAdmin(async (ctx) => {
    const { text } = ctx.body;
    if (!text || !text.trim()) return json(ctx.res, 400, { error: "חסר טקסט" });
    const trimmed = text.trim();
    const existing = db.prepare("SELECT id FROM instruction_phrases WHERE text = ?").get(trimmed);
    if (existing) return json(ctx.res, 200, { id: existing.id, alreadyExists: true });
    const info = db.prepare("INSERT INTO instruction_phrases (text) VALUES (?)").run(trimmed);
    return json(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }));

  router.delete("/api/instruction-phrases/:id", requireAdmin(async (ctx) => {
    db.prepare("DELETE FROM instruction_phrases WHERE id = ?").run(ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
