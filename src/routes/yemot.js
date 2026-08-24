// routes/yemot.js — שלוחת הטלפון "קו שולחן העבודה" בתוך מערכת ימות המשיח הקיימת של המשתמש
// (type=api, ר' README "הגדרת השלוחה בימות"). מכונת מצבים פשוטה, לפי call_logs (call_sid=ApiCallId).
//
// זרימת שיחה:
//   1) מזדהים עם קוד PIN בן 4 ספרות (אותו קוד בדיוק כמו הכניסה לאתר - ר' src/utils/crypto.js).
//   2) אם יש הוראות ממתינות (status='pending') - מקריאים אחת-אחת, ואחרי כל אחת מבקשים סטטוס:
//      1=בוצע, 2=לא בוצע, 3=יש בעיה/צריך חלקים, 9=דלג.
//   3) אחרי כל ההוראות (או אם אין) - אפשרות לדווח דיווח יזום (בחירת סניף אם משויכים כמה + סטטוס).
//   4) אם מוגדר YEMOT_RECORD_EXTENSION - אחרי כל דיווח אפשר גם להשאיר הערה קולית חופשית (שלוחת
//      הקלטה נפרדת בימות, ר' README). ללא ההגדרה - מדלגים על השלב הזה אוטומטית.
"use strict";

const db = require("../db");
const { text } = require("../router");
const { verifyPassword } = require("../utils/crypto");
const { sayAndReadDigits, sayAndReadMenuDigit, sayAndGoToRecordExtension, sayAndHangup, VAL_NAME } = require("../services/yemot");
const { createNotification } = require("../lib/notify");
const { sendEmail } = require("../services/email");

const STATUS_LABELS = { "1": "done", "2": "not_done", "3": "issue", "9": "skip" };
const STATUS_TEXT = { done: "בוצע", not_done: "לא בוצע", issue: "יש בעיה / צריך חלקים", skip: "דולג" };

function getCall(callSid) {
  return db.prepare("SELECT * FROM call_logs WHERE call_sid = ?").get(callSid);
}
function saveCall(callSid, state, draft) {
  const existing = getCall(callSid);
  const draftJson = JSON.stringify(draft || {});
  if (existing) {
    db.prepare("UPDATE call_logs SET state = ?, draft_json = ?, updated_at = datetime('now') WHERE call_sid = ?").run(state, draftJson, callSid);
  } else {
    db.prepare("INSERT INTO call_logs (call_sid, state, draft_json) VALUES (?, ?, ?)").run(callSid, state, draftJson);
  }
}
function endCall(callSid) {
  db.prepare("DELETE FROM call_logs WHERE call_sid = ?").run(callSid);
}

function loadPendingInstructions(workerUserId) {
  return db.prepare(
    `SELECT i.*, b.name AS branch_name FROM instructions i JOIN branches b ON b.id = i.branch_id
     WHERE i.worker_user_id = ? AND i.status = 'pending' ORDER BY i.created_at ASC`
  ).all(workerUserId);
}

function saveReport({ workerUserId, branchId, instructionId, statusKey, source }) {
  const statusCode = STATUS_LABELS[statusKey] || "other";
  db.prepare(
    `INSERT INTO reports (instruction_id, worker_user_id, branch_id, status_code, source) VALUES (?, ?, ?, ?, ?)`
  ).run(instructionId || null, workerUserId, branchId, statusCode, source);
  if (instructionId) db.prepare("UPDATE instructions SET status = 'done' WHERE id = ?").run(instructionId);

  const worker = db.prepare("SELECT full_name FROM users WHERE id = ?").get(workerUserId);
  const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId);
  const summary = `${worker.full_name} דיווח בטלפון על ${branch.name}: ${STATUS_TEXT[statusCode] || statusCode}`;
  createNotification("new_report", null, summary);
  const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND active = 1").all();
  for (const admin of admins) {
    sendEmail({ to: admin.email, subject: `דיווח חדש (טלפון) - ${branch.name}`, body: summary }).catch((e) => console.error("מייל דיווח טלפוני נכשל:", e.message));
  }
}

// אחרי שמירת דיווח - שלב הבא: הערה קולית (אם מוגדרת שלוחת הקלטה) או חזרה להוראה הבאה/סיום.
function afterReport(ctx, callSid, draft) {
  const recordExt = process.env.YEMOT_RECORD_EXTENSION;
  if (recordExt) {
    saveCall(callSid, "voice_note_ask", draft);
    return text(ctx.res, 200, sayAndReadMenuDigit("הדיווח נשמר. אם תרצו להוסיף הערה קולית, הקישו 1. אחרת הקישו 2."));
  }
  return continueFlow(ctx, callSid, draft);
}

// ממשיך לפריט הבא (הוראה הבאה בתור, או למעבר לדיווח יזום, או לסיום השיחה)
function continueFlow(ctx, callSid, draft) {
  if (draft.mode === "instructions" && draft.idx < draft.instructionIds.length) {
    return askNextInstruction(ctx, callSid, draft);
  }
  if (draft.mode === "instructions") {
    // סיימנו את כל ההוראות הממתינות - עוברים לאפשרות דיווח יזום
    draft.mode = "adhoc_offer";
    saveCall(callSid, "adhoc_offer", draft);
    return text(ctx.res, 200, sayAndReadMenuDigit("סיימנו את כל ההוראות הממתינות. אם תרצו לדווח על משהו נוסף, הקישו 1. אחרת נתקו."));
  }
  endCall(callSid);
  return text(ctx.res, 200, sayAndHangup("תודה, השיחה הסתיימה."));
}

function askNextInstruction(ctx, callSid, draft) {
  const instr = db.prepare(
    `SELECT i.*, b.name AS branch_name FROM instructions i JOIN branches b ON b.id = i.branch_id WHERE i.id = ?`
  ).get(draft.instructionIds[draft.idx]);
  saveCall(callSid, "instruction_status", draft);
  const prompt = `הוראה עבור ${instr.branch_name}. ${instr.text} לדיווח: בוצע הקישו 1, לא בוצע הקישו 2, יש בעיה הקישו 3, לדילוג הקישו 9.`;
  return text(ctx.res, 200, sayAndReadMenuDigit(prompt));
}

function register(router) {
  router.post("/yemot/instructions", async (ctx) => {
    const callSid = ctx.body.ApiCallId;
    const digit = String(ctx.body[VAL_NAME] || "").trim();
    if (!callSid) return text(ctx.res, 400, "");

    const call = getCall(callSid);

    // --- שיחה חדשה: מבקשים קוד זיהוי ---
    if (!call) {
      saveCall(callSid, "pin", {});
      return text(ctx.res, 200, sayAndReadDigits("ברוכים הבאים לקו שולחן העבודה. הקישו את קוד הזיהוי האישי שלכם, בן ארבע ספרות.", 4));
    }

    const draft = JSON.parse(call.draft_json || "{}");

    // --- זיהוי לפי PIN ---
    if (call.state === "pin") {
      const workers = db.prepare("SELECT * FROM users WHERE role = 'worker' AND active = 1").all();
      const worker = workers.find((w) => verifyPassword(digit, w.password_hash));
      if (!worker) {
        return text(ctx.res, 200, sayAndReadDigits("קוד לא זוהה. נסו שוב, ארבע ספרות.", 4));
      }
      const pending = loadPendingInstructions(worker.id);
      const newDraft = { workerUserId: worker.id, mode: "instructions", instructionIds: pending.map((p) => p.id), idx: 0 };
      if (pending.length === 0) {
        newDraft.mode = "adhoc_offer";
        saveCall(callSid, "adhoc_offer", newDraft);
        return text(ctx.res, 200, sayAndReadMenuDigit(`שלום ${worker.full_name}. אין הוראות ממתינות עבורכם כרגע. אם תרצו לדווח על משהו, הקישו 1. אחרת נתקו.`));
      }
      saveCall(callSid, "instructions_intro", newDraft);
      return text(ctx.res, 200, sayAndReadMenuDigit(`שלום ${worker.full_name}. יש לכם ${pending.length} הוראות ממתינות. להתחלת ההאזנה הקישו כל ספרה.`));
    }

    if (call.state === "instructions_intro") {
      return askNextInstruction(ctx, callSid, draft);
    }

    // --- מענה לסטטוס הוראה נוכחית ---
    if (call.state === "instruction_status") {
      const instr = db.prepare("SELECT * FROM instructions WHERE id = ?").get(draft.instructionIds[draft.idx]);
      saveReport({ workerUserId: draft.workerUserId, branchId: instr.branch_id, instructionId: instr.id, statusKey: digit, source: "phone" });
      draft.idx += 1;
      return afterReport(ctx, callSid, draft);
    }

    // --- הצעה לדיווח יזום (אחרי כל ההוראות, או אם לא היו הוראות) ---
    if (call.state === "adhoc_offer") {
      if (digit !== "1") {
        endCall(callSid);
        return text(ctx.res, 200, sayAndHangup("תודה, השיחה הסתיימה."));
      }
      const branches = db.prepare(
        `SELECT b.* FROM branches b JOIN worker_branches wb ON wb.branch_id = b.id WHERE wb.worker_user_id = ? ORDER BY b.name`
      ).all(draft.workerUserId);
      if (branches.length === 0) {
        endCall(callSid);
        return text(ctx.res, 200, sayAndHangup("לא נמצא סניף המשויך אליכם. פנו למנהל. השיחה הסתיימה."));
      }
      if (branches.length === 1) {
        draft.adhocBranchId = branches[0].id;
        saveCall(callSid, "adhoc_status", draft);
        return text(ctx.res, 200, sayAndReadMenuDigit(`דיווח עבור ${branches[0].name}. בוצע הקישו 1, לא בוצע הקישו 2, יש בעיה הקישו 3.`));
      }
      draft.branchChoices = branches.map((b) => b.id);
      saveCall(callSid, "adhoc_branch_pick", draft);
      const list = branches.map((b, i) => `למספר ${i + 1}, ${b.name}`).join(". ");
      return text(ctx.res, 200, sayAndReadDigits(`לאיזה סניף הדיווח? ${list}. הקישו את המספר.`, 1));
    }

    if (call.state === "adhoc_branch_pick") {
      const idx = Number(digit) - 1;
      const branchId = draft.branchChoices[idx];
      if (!branchId) {
        return text(ctx.res, 200, sayAndReadDigits("מספר לא תקין. נסו שוב.", 1));
      }
      draft.adhocBranchId = branchId;
      saveCall(callSid, "adhoc_status", draft);
      return text(ctx.res, 200, sayAndReadMenuDigit("בוצע הקישו 1, לא בוצע הקישו 2, יש בעיה הקישו 3."));
    }

    if (call.state === "adhoc_status") {
      saveReport({ workerUserId: draft.workerUserId, branchId: draft.adhocBranchId, instructionId: null, statusKey: digit, source: "phone" });
      draft.mode = "done";
      return afterReport(ctx, callSid, draft);
    }

    // --- הערה קולית (רק אם מוגדר YEMOT_RECORD_EXTENSION) ---
    if (call.state === "voice_note_ask") {
      if (digit === "1") {
        saveCall(callSid, "voice_note_returning", draft);
        return text(ctx.res, 200, sayAndGoToRecordExtension("דברו אחרי הצליל. בסיום הקישו סולמית.", process.env.YEMOT_RECORD_EXTENSION));
      }
      return continueFlow(ctx, callSid, draft);
    }

    // חוזרים משלוחת ההקלטה - ימות שולח בפועל את נתיב/מזהה הקובץ בשדה שמוגדר בשלוחה (ר' README);
    // כרגע רק מסמנים בלוג שהתקבלה הערה קולית (קישור בפועל לקובץ - שיפור עתידי, ר' README).
    if (call.state === "voice_note_returning") {
      console.log(`[YEMOT] התקבלה הערה קולית מעובד ${draft.workerUserId} (ר' ApiCallId=${callSid})`);
      return continueFlow(ctx, callSid, draft);
    }

    // מצב לא מוכר - איפוס
    endCall(callSid);
    return text(ctx.res, 200, sayAndHangup("אירעה שגיאה. נסו להתקשר שוב."));
  });
}

module.exports = { register };
