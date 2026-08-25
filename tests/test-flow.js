// test-flow.js — בדיקת עשן end-to-end מול השרת האמיתי (לא mock) - מפעיל שרת על פורט זמני,
// עובר על הזרימה המרכזית: התחברות מנהל, יצירת עובד, שיוך לסניף, שליחת הוראה, דיווח, צ'אט, תנועה כספית.
"use strict";
process.env.PORT = "0";
process.env.DB_PATH = require("path").join(__dirname, "test.db");
process.env.EMAIL_MOCK = "true";

const fs = require("fs");
if (fs.existsSync(process.env.DB_PATH)) fs.unlinkSync(process.env.DB_PATH);
for (const ext of ["-wal", "-shm"]) {
  if (fs.existsSync(process.env.DB_PATH + ext)) fs.unlinkSync(process.env.DB_PATH + ext);
}

const assert = require("assert");
const server = require("../src/server");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.error(`❌ ${label}`); }
}

async function main() {
  // server.js כבר קורא ל-listen() בזמן ה-require (PORT=0 -> פורט זמני אקראי) - מחכים שיהיה מוכן.
  if (!server.address()) await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  async function call(path, opts = {}) {
    const res = await fetch(base + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: "Bearer " + opts.token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  // התחברות מנהל (זרעו admin1/0000 ע"י db.js)
  const login = await call("/api/login", { method: "POST", body: { username: "admin1", pin: "0000" } });
  ok(login.status === 200 && login.data.token, "מנהל מתחבר בהצלחה");
  const adminToken = login.data.token;

  const health = await call("/api/health");
  ok(health.status === 200 && health.data.status === "ok", "בדיקת חיים תקינה");

  const branches = await call("/api/branches", { token: adminToken });
  ok(branches.status === 200 && branches.data.branches.length === 13, "13 סניפים נזרעו");
  const branchId = branches.data.branches[0].id;

  const newWorker = await call("/api/users", { method: "POST", token: adminToken, body: {
    fullName: "עובד בדיקה", username: "worker1", pin: "1234", role: "worker", email: "worker@example.com",
  }});
  ok(newWorker.status === 201, "נוצר עובד חדש");
  const workerId = newWorker.data.id;

  const assignBranch = await call(`/api/users/${workerId}/branches`, { method: "POST", token: adminToken, body: { branchId } });
  ok(assignBranch.status === 201, "עובד שויך לסניף");

  const workerLogin = await call("/api/login", { method: "POST", body: { username: "worker1", pin: "1234" } });
  ok(workerLogin.status === 200 && workerLogin.data.user.role === "worker", "עובד מתחבר בהצלחה");
  const workerToken = workerLogin.data.token;

  const instr = await call("/api/instructions", { method: "POST", token: adminToken, body: {
    branchId, workerUserId: workerId, text: "לנקות את עמדות המחשב",
  }});
  ok(instr.status === 201, "מנהל שולח הוראה");

  const myInstr = await call("/api/instructions", { token: workerToken });
  ok(myInstr.status === 200 && myInstr.data.instructions.length === 1, "עובד רואה את ההוראה שלו");

  const report = await call("/api/reports", { method: "POST", token: workerToken, body: {
    branchId, instructionId: instr.data.id, statusCode: "done", noteText: "נוקה בהצלחה",
  }});
  ok(report.status === 201, "עובד שולח דיווח");

  const notifs = await call("/api/notifications", { token: adminToken });
  ok(notifs.status === 200 && notifs.data.unreadCount >= 1, "התראה נוצרה אצל המנהל");

  const chatSend = await call(`/api/chat/${branchId}/${workerId}`, { method: "POST", token: workerToken, body: { text: "שלום, סיימתי" } });
  ok(chatSend.status === 201, "עובד שולח הודעת צ'אט");
  const chatRead = await call(`/api/chat/${branchId}/${workerId}`, { token: adminToken });
  // 2 הודעות: ההוראה שנוצרה אוטומטית כהודעת צ'אט (ר' routes/instructions.js) + ההודעה שהעובד כתב עכשיו
  ok(chatRead.status === 200 && chatRead.data.messages.length === 2 && chatRead.data.messages.some(m => m.text.includes("📋 הוראה")), "מנהל רואה גם את ההוראה וגם את הודעת הצ'אט של העובד");

  // --- מנהל שולח הודעת צ'אט לעובד (כיוון הפוך) - נשלח מייל לעובד (MOCK), לא אמור לזרוק שגיאה ---
  const adminChat = await call(`/api/chat/${branchId}/${workerId}`, { method: "POST", token: adminToken, body: { text: "תודה על העבודה!" } });
  ok(adminChat.status === 201, "מנהל שולח הודעת צ'אט לעובד (עם שליחת מייל ברקע)");

  const ben = await call(`/api/branches/${branchId}/beneficiaries`, { method: "POST", token: adminToken, body: {
    name: "מוטב בדיקה", monthlyAmount: 500,
  }});
  ok(ben.status === 201, "מוטב נוסף לסניף (קטגוריה ברירת מחדל: salary)");

  const elec = await call(`/api/branches/${branchId}/beneficiaries`, { method: "POST", token: adminToken, body: {
    name: "חברת חשמל", monthlyAmount: 300, category: "electricity",
  }});
  ok(elec.status === 201, "רשומת חשמל נוספה עם קטגוריה נפרדת");

  const editAmount = await call(`/api/beneficiaries/${ben.data.id}`, { method: "PUT", token: adminToken, body: { monthlyAmount: 550 } });
  ok(editAmount.status === 200, "עריכת סכום חודשי של מוטב עובדת");

  const allBen = await call("/api/beneficiaries", { token: adminToken });
  ok(allBen.status === 200 && allBen.data.beneficiaries.length === 2 && allBen.data.beneficiaries.every(b => b.branch_name), "רשימת מוטבים שטוחה (כל הסניפים) מחזירה גם שם סניף");

  const tx = await call("/api/transactions", { method: "POST", token: adminToken, body: { type: "income", amount: 1000, category: "תשלום סניף" } });
  ok(tx.status === 201, "תנועת הכנסה נוספה");
  const txList = await call("/api/transactions", { token: adminToken });
  ok(txList.status === 200 && txList.data.summary.income === 1000, "סיכום הכנסות תקין");

  const forbidden = await call("/api/transactions", { token: workerToken });
  ok(forbidden.status === 403, "עובד לא יכול לראות נתונים כספיים");

  // --- הוראה ל"כולם"/"כל הסניפים": יוצרים עובד שני, ובודקים שהוראה עם branchIds+workerUserIds
  //     יוצרת הוראה נפרדת לכל צירוף (עובד × סניף) ---
  const worker2 = await call("/api/users", { method: "POST", token: adminToken, body: {
    fullName: "עובד שני", username: "worker2", pin: "5678", role: "worker",
  }});
  ok(worker2.status === 201, "נוצר עובד שני לבדיקת שידור לכולם");
  // בכוונה לא כוללים כאן את workerId המקורי - יש לו כבר בדיקות pending-instructions ייעודיות
  // בהמשך (זרימת הטלפון למטה), ולא רוצים ליצור לו כאן עוד הוראות pending שיפריעו לזה.
  const secondBranchId = branches.data.branches[1].id;
  const broadcast = await call("/api/instructions", { method: "POST", token: adminToken, body: {
    branchIds: [branchId, secondBranchId], workerUserIds: [worker2.data.id], text: "בדיקת שיבוץ לכולם",
  }});
  ok(broadcast.status === 201 && broadcast.data.created === 2, "הוראה ל-1 עובד × 2 סניפים יוצרת 2 הוראות בבת אחת");

  // --- עדכון קטגוריה (טקסט חופשי) לתנועה קיימת ---
  const txId = tx.data.transaction.id;
  const editCat = await call(`/api/transactions/${txId}`, { method: "PUT", token: adminToken, body: { category: "קטגוריה חדשה" } });
  ok(editCat.status === 200 && editCat.data.transaction.category === "קטגוריה חדשה", "עריכת קטגוריה של תנועה קיימת עובדת");

  // --- ייבוא עם שמירת קובץ מקור + payment_method, וסינון "רק כרטיס אשראי" ---
  const fakeCsv = Buffer.from("date,description,amount,type\n2026-01-01,קפה,50,expense\n").toString("base64");
  const commitWithFile = await call("/api/transactions/import/commit", { method: "POST", token: adminToken, body: {
    transactions: [{ date: "2026-01-02", type: "expense", amount: 75, description: "בדיקה" }],
    data_base64: fakeCsv, filename: "test-statement.csv", mime_type: "text/csv", source_type: "card",
  }});
  ok(commitWithFile.status === 201 && commitWithFile.data.documentId, "ייבוא עם קובץ שומר מסמך חדש");

  const docsList = await call("/api/documents", { token: adminToken });
  ok(docsList.status === 200 && docsList.data.documents.some(d => d.filename === "test-statement.csv"), "המסמך שנשמר מופיע ברשימת המסמכים");

  const docDownload = await call(`/api/documents/${commitWithFile.data.documentId}/download`, { token: adminToken });
  ok(docDownload.status === 200, "ניתן להוריד את המסמך שנשמר");

  const txAfterImport = await call("/api/transactions", { token: adminToken });
  const importedTx = txAfterImport.data.transactions.find(t => t.note === "בדיקה");
  ok(importedTx && importedTx.payment_method === "card", "תנועה מיובאת מקבלת payment_method='card' נכון");

  // --- שלוחת ימות: PIN של העובד מזהה אותו (עדיין בלי טלפון רשום לאף עובד - הבדיקה לא נאכפת) ---
  async function callRaw(path, body) {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  }
  const yemotStart = await callRaw("/yemot/instructions", { ApiCallId: "test-call-1", ApiPhone: "0500000000" });
  ok(yemotStart.status === 200 && yemotStart.text.includes("קוד הזיהוי"), "שלוחת ימות עונה לשיחה חדשה (אין עדיין טלפונים רשומים - לא חוסמת)");

  // --- עכשיו רושמים טלפון לעובד, ובודקים חסימה של מספר לא מוכר + מעבר של מספר מוכר ---
  await call(`/api/users/${workerId}`, { method: "PUT", token: adminToken, body: { phone: "0501112222" } });
  const yemotBlocked = await callRaw("/yemot/instructions", { ApiCallId: "test-call-2", ApiPhone: "0509998888" });
  ok(yemotBlocked.status === 200 && !yemotBlocked.text.includes("קוד הזיהוי") && !yemotBlocked.text.includes("שולחן העבודה"), "מספר לא רשום נחסם בשקט, בלי לגלות שהשלוחה קיימת");
  const yemotAllowed = await callRaw("/yemot/instructions", { ApiCallId: "test-call-3", ApiPhone: "050-111-2222" });
  ok(yemotAllowed.status === 200 && yemotAllowed.text.includes("קוד הזיהוי"), "מספר רשום (גם עם מקפים) עובר וממשיך לבקשת קוד");

  // --- ממשיכים את השיחה: מקישים PIN נכון (1234), מסרבים לדיווח יזום, ובודקים שההודעה הסופית
  //     מזכירה את 2 הודעות הצ'אט הלא-נקראות (ההוראה שהמנהל יצר + "תודה על העבודה!") ---
  const yemotPin = await callRaw("/yemot/instructions", { ApiCallId: "test-call-3", ApiPhone: "050-111-2222", speech: "1234" });
  ok(yemotPin.status === 200 && yemotPin.text.includes("אין הוראות ממתינות"), "PIN נכון מזהה את העובד, אין הוראות ממתינות (כבר טופלה)");
  const yemotDecline = await callRaw("/yemot/instructions", { ApiCallId: "test-call-3", ApiPhone: "050-111-2222", speech: "9" });
  // הערה: sanitizeForYemot (services/yemot.js) מסירה אפוסטרופים מהטקסט המושמע - "צ'אט" הופך ל"צאט"
  ok(yemotDecline.status === 200 && yemotDecline.text.includes("2 הודעות חדשות בצאט"), "השיחה הטלפונית מזכירה בסיום את מספר הודעות הצ'אט הלא-נקראות");

  // --- תפריט ראשי משותף (שלוחה 1): מבקש ספרה, ואז מפנה לשלוחה הנכונה ---
  const menuStart = await callRaw("/yemot/main-menu", { ApiCallId: "test-call-menu-1" });
  ok(menuStart.status === 200 && menuStart.text.includes("שולחן עבודה"), "התפריט הראשי מציע את שתי האפשרויות");
  const menuPickWork = await callRaw("/yemot/main-menu", { ApiCallId: "test-call-menu-1", speech: "2" });
  ok(menuPickWork.status === 200 && menuPickWork.text.includes("g-/3"), "בחירת 2 מפנה לשלוחה 3 (שולחן עבודה)");
  const menuPickAccounts = await callRaw("/yemot/main-menu", { ApiCallId: "test-call-menu-2" }).then(() =>
    callRaw("/yemot/main-menu", { ApiCallId: "test-call-menu-2", speech: "1" })
  );
  ok(menuPickAccounts.status === 200 && menuPickAccounts.text.includes("g-/4"), "בחירת 1 מפנה לשלוחה 4 (ניהול חשבונות)");

  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  // ניקוי קובץ ה-DB הזמני - לא קריטי אם נכשל (למשל נעילת קובץ ב-Windows); לא מפיל את הבדיקות.
  try {
    fs.unlinkSync(process.env.DB_PATH);
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(process.env.DB_PATH + ext)) fs.unlinkSync(process.env.DB_PATH + ext);
    }
  } catch (e) {
    console.warn("(ניקוי קובץ הבדיקה הזמני נכשל, לא קריטי):", e.message);
  }

  console.log(`\n${pass}/${pass + fail} בדיקות עברו בהצלחה.`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
