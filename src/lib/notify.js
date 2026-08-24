// lib/notify.js — יצירת התראה פנימית (פעמון/באדג' באתר) למנהלים. שימוש משותף מ-reports.js ו-chat.js.
"use strict";
const db = require("../db");

function createNotification(type, refId, text) {
  db.prepare("INSERT INTO notifications (type, ref_id, text) VALUES (?, ?, ?)").run(type, refId, text);
}

module.exports = { createNotification };
