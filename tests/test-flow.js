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
  ok(chatRead.status === 200 && chatRead.data.messages.length === 1, "מנהל רואה את הודעת הצ'אט");

  const ben = await call(`/api/branches/${branchId}/beneficiaries`, { method: "POST", token: adminToken, body: {
    name: "מוטב בדיקה", monthlyAmount: 500,
  }});
  ok(ben.status === 201, "מוטב נוסף לסניף");

  const tx = await call("/api/transactions", { method: "POST", token: adminToken, body: { type: "income", amount: 1000, category: "תשלום סניף" } });
  ok(tx.status === 201, "תנועת הכנסה נוספה");
  const txList = await call("/api/transactions", { token: adminToken });
  ok(txList.status === 200 && txList.data.summary.income === 1000, "סיכום הכנסות תקין");

  const forbidden = await call("/api/transactions", { token: workerToken });
  ok(forbidden.status === 403, "עובד לא יכול לראות נתונים כספיים");

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
