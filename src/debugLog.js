// debugLog.js — "זיכרון" לוג פנימי בזיכרון (לא נשמר בדיסק, נמחק בכל הפעלה מחדש של השרת) - כדי
// שאפשר יהיה לשלוף בקלות שורות אבחון אחרונות דרך כתובת אחת, בלי לחפש ב-Logs של Render ידנית.
// אותו דפוס בדיוק כמו ב"הפנקס שלי" (backend/src/debugLog.js).
"use strict";

const MAX_LINES = 200;
const lines = [];

function push(line) {
  lines.push(`[${new Date().toISOString()}] ${line}`);
  if (lines.length > MAX_LINES) lines.shift();
}

function getAll() {
  return lines;
}

module.exports = { push, getAll };
