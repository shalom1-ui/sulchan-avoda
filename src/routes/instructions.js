// routes/instructions.js — הוראות שמנהל שולח לעובד לגבי סניף. נשלחות במייל (אם יש לעובד כתובת),
// ומחכות בשלוחת הטלפון (routes/yemot.js מקריא הוראות pending כשהעובד מתקשר ומזהה את עצמו).
"use strict";
const { randomUUID } = require("crypto");
const db = require("../db");
const { json } = require("../router");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { sendEmail } = require("../services/email");

// מקבץ שורות instructions (עם branch_name/worker_name כבר מצורפים ע"י ה-SELECT) לפי batch_id+עובד -
// כך ששליחה אחת לכמה סניפים מוצגת כקבוצה אחת (טקסט ההוראה פעם אחת + רשימת סניפים), במקום שורה
// נפרדת ומלאה לכל סניף (ר' משוב המשתמש - גם בתצוגת המנהל וגם בתצוגת העובד). הוראות ישנות בלי
// batch_id (NULL) מוצגות כל אחת כקבוצה בפני עצמה.
function groupInstructionRows(rows) {
  const groups = [];
  const groupByKey = new Map();
  for (const row of rows) {
    const key = row.batch_id ? `${row.batch_id}-${row.worker_user_id}` : `single-${row.id}`;
    let group = groupByKey.get(key);
    if (!group) {
      group = {
        batchId: row.batch_id, workerUserId: row.worker_user_id, workerName: row.worker_name,
        text: row.text, createdAt: row.created_at, emailSent: !!row.email_sent, branches: [],
      };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.branches.push({ instructionId: row.id, branchId: row.branch_id, branchName: row.branch_name, status: row.status });
    if (!row.email_sent) group.emailSent = false;
  }
  for (const g of groups) {
    g.doneCount = g.branches.filter(b => b.status !== "pending").length;
    g.totalCount = g.branches.length;
  }
  return groups;
}

function register(router) {
  // מנהל: כל ההוראות מקובצות לפי שליחה (ר' groupInstructionRows) - שורה אחת עם רשימת כל הסניפים
  // וסיכום סטטוס, לא שורה נפרדת לכל סניף. עובד: אותו קיבוץ, אבל לכל קבוצה יש גם רשימת "שורות" עם
  // צ'קבוקס נפרד לכל סניף - "הודעה אחת מפורטת, וכמה שורות לסמן טופל/לא" (ר' משוב המשתמש).
  router.get("/api/instructions", requireAuth(async (ctx) => {
    if (ctx.user.role === "admin") {
      const rows = db.prepare(
        `SELECT i.*, b.name AS branch_name, u.full_name AS worker_name
         FROM instructions i JOIN branches b ON b.id = i.branch_id JOIN users u ON u.id = i.worker_user_id
         ORDER BY i.created_at DESC LIMIT 500`
      ).all();
      return json(ctx.res, 200, { instructionGroups: groupInstructionRows(rows).slice(0, 200) });
    }
    const rows = db.prepare(
      `SELECT i.*, b.name AS branch_name, u.full_name AS worker_name
       FROM instructions i JOIN branches b ON b.id = i.branch_id JOIN users u ON u.id = i.worker_user_id
       WHERE i.worker_user_id = ? ORDER BY i.created_at DESC LIMIT 100`
    ).all(ctx.user.userId);
    return json(ctx.res, 200, { instructionGroups: groupInstructionRows(rows) });
  }));

  // יוצר רשומת הוראה בודדת (סניף אחד + עובד אחד) במסד הנתונים + מוסיף לשרשור הצ'אט - בלי לשלוח מייל
  // (המייל נשלח מרוכז לכל העובד אחרי שכל ההוראות שלו נוצרו - ר' POST /api/instructions למטה).
  function createOneInstruction(branchId, worker, text, createdByUserId, batchId) {
    const info = db.prepare(
      "INSERT INTO instructions (branch_id, worker_user_id, created_by, text, batch_id) VALUES (?, ?, ?, ?, ?)"
    ).run(branchId, worker.id, createdByUserId, text, batchId);
    const instructionId = Number(info.lastInsertRowid);

    // ההוראה מופיעה גם בשרשור הצ'אט של אותו (סניף, עובד) - כדי שהמנהל והעובד יראו הכל במקום אחד
    // (ר' משוב המשתמש: "מה שיש בהוראות יהיה גם בצ'אט"). לא שולחת מייל/התראה כפולה - זו רק תצוגה.
    db.prepare(
      "INSERT INTO chat_messages (branch_id, worker_user_id, sender_user_id, text) VALUES (?, ?, ?, ?)"
    ).run(branchId, worker.id, createdByUserId, `📋 הוראה: ${text}`);

    return instructionId;
  }

  // תומך גם בהוראה בודדת (branchId+workerUserId, כמו קודם) וגם ב"לכולם"/"כל הסניפים": שולחים
  // branchIds[] ו/או workerUserIds[] - נוצרת רשומת הוראה נפרדת לכל צירוף (עובד × סניף) לצורך מעקב
  // סטטוס/הקראה בטלפון, אבל לכל עובד נשלח **מייל אחד מרוכז** שמפרט את כל הסניפים ברשימה - לא מייל
  // נפרד לכל סניף (ר' משוב המשתמש: "מייל אחד ושיהיה כתוב רשימה של הסניפים").
  router.post("/api/instructions", requireAdmin(async (ctx) => {
    const { branchId, workerUserId, branchIds, workerUserIds, text } = ctx.body;
    const branchIdList = Array.isArray(branchIds) && branchIds.length ? branchIds : (branchId ? [branchId] : []);
    const workerIdList = Array.isArray(workerUserIds) && workerUserIds.length ? workerUserIds : (workerUserId ? [workerUserId] : []);
    if (!branchIdList.length || !workerIdList.length || !text || !text.trim()) {
      return json(ctx.res, 400, { error: "חסרים שדות חובה (סניף/סניפים, עובד/עובדים, תוכן ההוראה)" });
    }
    if (branchIdList.length * workerIdList.length > 200) {
      return json(ctx.res, 400, { error: "יותר מדי צירופי עובד/סניף בבת אחת (הגבלה 200)" });
    }

    const trimmedText = text.trim();
    // מזהה משותף לכל ההוראות שנוצרות בקריאה הזו - כדי שהתצוגה למנהל תציג אותן כשורה אחת (ר' GET
    // /api/instructions למעלה), גם כששולחים לכמה עובדים בבת אחת (לכל עובד אותו batch_id - זה בסדר,
    // הקיבוץ הוא לפי batch_id+worker_user_id יחד באמצעות ה-JOIN, לא לפי batch_id בלבד).
    const batchId = randomUUID();
    let createdCount = 0;
    let emailsSent = 0;
    let firstInstructionId = null;

    for (const wId of workerIdList) {
      const worker = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'worker'").get(wId);
      if (!worker) continue;

      const instructionIds = [];
      const branchNames = [];
      for (const bId of branchIdList) {
        const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(bId);
        if (!branch) continue;
        const instructionId = createOneInstruction(bId, worker, trimmedText, ctx.user.userId, batchId);
        instructionIds.push(instructionId);
        branchNames.push(branch.name);
        createdCount++;
        if (firstInstructionId === null) firstInstructionId = instructionId;
      }
      if (!instructionIds.length) continue;

      if (worker.email) {
        try {
          const branchList = branchNames.map((n) => `- ${n}`).join("\n");
          await sendEmail({
            to: worker.email,
            subject: branchNames.length === 1 ? `הוראה חדשה - ${branchNames[0]}` : `הוראה חדשה - ${branchNames.length} סניפים`,
            body: `שלום ${worker.full_name},\n\nהוראה חדשה עבור ${branchNames.length === 1 ? "הסניף הבא" : "הסניפים הבאים"}:\n${branchList}\n\nתוכן ההוראה:\n${trimmedText}\n\nניתן גם לשמוע את ההוראה ולדווח דרך שלוחת הטלפון, או להתחבר לאתר.`,
          });
          db.prepare(`UPDATE instructions SET email_sent = 1 WHERE id IN (${instructionIds.map(() => "?").join(",")})`).run(...instructionIds);
          emailsSent += instructionIds.length;
        } catch (e) {
          console.error("שליחת מייל הוראה מרוכז נכשלה:", e.message);
        }
      }
    }
    if (!createdCount) return json(ctx.res, 404, { error: "לא נמצאו עובדים/סניפים תקינים" });

    return json(ctx.res, 201, {
      id: firstInstructionId, emailSent: emailsSent > 0, // תאימות לאחור לגרסה הישנה (הוראה בודדת)
      created: createdCount, emailsSent,
    });
  }));

  router.put("/api/instructions/:id/status", requireAuth(async (ctx) => {
    const instr = db.prepare("SELECT * FROM instructions WHERE id = ?").get(ctx.params.id);
    if (!instr) return json(ctx.res, 404, { error: "לא נמצא" });
    if (ctx.user.role !== "admin" && Number(ctx.user.userId) !== instr.worker_user_id) {
      return json(ctx.res, 403, { error: "אין הרשאה" });
    }
    const { status } = ctx.body;
    if (!["pending", "heard_phone", "read_web", "done"].includes(status)) {
      return json(ctx.res, 400, { error: "status לא תקין" });
    }
    db.prepare("UPDATE instructions SET status = ? WHERE id = ?").run(status, ctx.params.id);
    return json(ctx.res, 200, { ok: true });
  }));
}

module.exports = { register };
