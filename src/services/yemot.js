// yemot.js — שכבת הטלפוניה מול "ימות המשיח". בונה את מחרוזות התגובה שהפרוטוקול של ימות מצפה
// להן. אותו דפוס בדיוק כמו ב"הפנקס שלי" (backend/src/services/yemot.js), מצומצם למה שצריך כאן.
"use strict";

const VAL_NAME = "speech";

function sanitizeForYemot(text) {
  return String(text || "").replace(/[.\-"'&|]/g, "");
}

// הקשת קוד ספרות קבוע-אורך (PIN) - typing_playback_mode="No" כדי שהקוד לא יישמע בקול תוך כדי ההקשה.
function sayAndReadDigits(text, digits) {
  const safe = sanitizeForYemot(text);
  const ops = ["no", String(digits), String(digits), "7", "No", "no", "no", "", "", "", "", "", ""];
  return `read=t-${safe}=${VAL_NAME},${ops.join(",")}`;
}

// הקשת ספרה בודדת מתוך תפריט (סטטוס דיווח וכו')
function sayAndReadMenuDigit(text) {
  return sayAndReadDigits(text, 1);
}

// מעבר לשלוחת הקלטה נפרדת (type=record בממשק הניהול של ימות) - להערה קולית חופשית. חוזרת אוטומטית
// לשלוחה שלנו (record_end_goto, מוגדר בממשק הניהול, ר' README).
function sayAndGoToRecordExtension(text, recordExtension) {
  const safe = sanitizeForYemot(text);
  return `id_list_message=t-${safe}.g-/${recordExtension}`;
}

function sayAndHangup(text) {
  const safe = sanitizeForYemot(text);
  return `id_list_message=t-${safe}.g-hangup`;
}

module.exports = { sayAndReadDigits, sayAndReadMenuDigit, sayAndGoToRecordExtension, sayAndHangup, sanitizeForYemot, VAL_NAME };
