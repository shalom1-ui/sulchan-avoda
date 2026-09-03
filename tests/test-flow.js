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

  const login2 = await call("/api/login", { method: "POST", body: { username: "admin2", pin: "0000" } });
  ok(login2.status === 200 && login2.data.token, "מנהל שני (admin2) מתחבר בהצלחה");
  const admin2Token = login2.data.token;
  const admin2Id = login2.data.user.id;

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

  // --- שינוי שם תצוגה (למשל "עובד בדיקה" -> שם אמיתי) ---
  const renameWorker = await call(`/api/users/${workerId}`, { method: "PUT", token: adminToken, body: { fullName: "שלום כהן" } });
  ok(renameWorker.status === 200, "שינוי שם מלא של משתמש עובד");
  const usersAfterRename = await call("/api/users", { token: adminToken });
  ok(usersAfterRename.data.users.find(u => u.id === workerId).full_name === "שלום כהן", "השם החדש נשמר ומוחזר נכון");

  // --- שכחתי סיסמה: תשובה גנרית תמיד, וקוד אמיתי נוצר רק אם למשתמש יש מייל ---
  // (משתמש נפרד לבדיקה הזו, כדי לא לשנות את הסיסמה של worker1 שנבדקת בהמשך בשלוחת ימות)
  const forgotTestUser = await call("/api/users", { method: "POST", token: adminToken, body: {
    fullName: "עובד לבדיקת איפוס", username: "forgotuser", pin: "1234", role: "worker", email: "forgotuser@example.com",
  }});
  ok(forgotTestUser.status === 201, "נוצר עובד ייעודי לבדיקת שכחתי-סיסמה");

  const forgotUnknown = await call("/api/forgot-password/request", { method: "POST", body: { username: "לא-קיים" } });
  ok(forgotUnknown.status === 200, "בקשת איפוס לשם משתמש לא קיים מחזירה תשובה גנרית (לא חושפת מידע)");

  // לוכדים את הקוד בפועל מתוך הלוג (מצב MOCK) כדי לבדוק את זרימת האישור המלאה מקצה לקצה
  let capturedCode = null;
  const originalLog = console.log;
  console.log = (...args) => { const line = args.join(" "); const m = line.match(/קוד לאיפוס הסיסמה שלכם: (\d{4})/); if (m) capturedCode = m[1]; originalLog(...args); };
  const forgotRequest = await call("/api/forgot-password/request", { method: "POST", body: { username: "forgotuser" } });
  console.log = originalLog;
  ok(forgotRequest.status === 200 && capturedCode, "בקשת איפוס למשתמש עם מייל שולחת קוד (MOCK - נלכד מהלוג)");

  const confirmWrongCode = await call("/api/forgot-password/confirm", { method: "POST", body: { username: "forgotuser", code: "0000", newPin: "9999" } });
  ok(confirmWrongCode.status === 400, "אישור עם קוד שגוי נדחה");

  const confirmRight = await call("/api/forgot-password/confirm", { method: "POST", body: { username: "forgotuser", code: capturedCode, newPin: "9999" } });
  ok(confirmRight.status === 200, "אישור עם קוד נכון מאפס את הסיסמה");

  const loginWithNewPin = await call("/api/login", { method: "POST", body: { username: "forgotuser", pin: "9999" } });
  ok(loginWithNewPin.status === 200, "התחברות עם הסיסמה החדשה (אחרי איפוס) עובדת");
  const loginWithOldPin = await call("/api/login", { method: "POST", body: { username: "forgotuser", pin: "1234" } });
  ok(loginWithOldPin.status === 401, "הסיסמה הישנה כבר לא עובדת אחרי איפוס");

  // --- כלי חירום: איפוס PIN ישיר דרך debug endpoint (מוגן במפתח קבוע) ---
  const debugResetWrongKey = await call("/api/debug/reset-user-pin", { method: "POST", body: { key: "wrong", username: "forgotuser", newPin: "1111" } });
  ok(debugResetWrongKey.status === 403, "כלי איפוס החירום דוחה מפתח שגוי");
  const debugReset = await call("/api/debug/reset-user-pin", { method: "POST", body: { key: "sulchan-diag-7429", username: "forgotuser", newPin: "1111" } });
  ok(debugReset.status === 200, "כלי איפוס החירום מאפס PIN עם המפתח הנכון");
  const loginAfterDebugReset = await call("/api/login", { method: "POST", body: { username: "forgotuser", pin: "1111" } });
  ok(loginAfterDebugReset.status === 200, "התחברות עובדת אחרי איפוס חירום");

  // --- הרשמה עצמית: נכשלת בלי הזמנה מראש, מצליחה אחרי שהמנהל מוסיף את המייל ---
  const registerBlocked = await call("/api/register", { method: "POST", body: {
    email: "new-worker@example.com", fullName: "עובד חדש", username: "newworker", pin: "1111",
  }});
  ok(registerBlocked.status === 403, "הרשמה עצמית נכשלת ללא הזמנה מאושרת מראש");

  const workerCannotInvite = await call("/api/invites", { method: "POST", token: workerToken, body: { email: "new-worker@example.com", role: "worker" } });
  ok(workerCannotInvite.status === 403, "עובד לא יכול להוסיף הזמנות הרשמה");

  const invite = await call("/api/invites", { method: "POST", token: adminToken, body: { email: "New-Worker@Example.com", role: "worker" } });
  ok(invite.status === 201, "מנהל מאשר מייל להרשמה עצמית");

  const registerAllowed = await call("/api/register", { method: "POST", body: {
    email: "new-worker@example.com", fullName: "עובד חדש", username: "newworker", pin: "1111",
  }});
  ok(registerAllowed.status === 201 && registerAllowed.data.token && registerAllowed.data.user.role === "worker", "הרשמה עצמית מצליחה אחרי אישור, ומקבלת role נכון מההזמנה (גם שהאימייל נכתב באותיות גדולות)");

  const registerAgainFails = await call("/api/register", { method: "POST", body: {
    email: "new-worker@example.com", fullName: "עובד חדש שוב", username: "newworker2", pin: "2222",
  }});
  ok(registerAgainFails.status === 403, "אותה הזמנה לא ניתנת לשימוש פעמיים");

  const invitesList = await call("/api/invites", { token: adminToken });
  ok(invitesList.status === 200 && invitesList.data.invites.find(i => i.email === "new-worker@example.com").used_by_name === "עובד חדש", "רשימת ההזמנות מראה מי נרשם עם כל הזמנה");

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

  // --- "סמן כממתין לטיפול" - מחזיר שרשור שכבר נקרא למצב לא-נקרא, בלי למחוק כלום ---
  const threadsBeforePending = await call("/api/chat/threads", { token: adminToken });
  const threadBefore = threadsBeforePending.data.threads.find(t => t.branch_id === branchId && t.worker_user_id === workerId);
  ok(threadBefore && threadBefore.unread_count === 0, "אחרי שהמנהל פתח וקרא את השרשור, אין הודעות לא-נקראות");
  const markPending = await call(`/api/chat/${branchId}/${workerId}/mark-pending`, { method: "PUT", token: adminToken });
  ok(markPending.status === 200, "מנהל מסמן שרשור כממתין לטיפול המשך");
  const threadsAfterPending = await call("/api/chat/threads", { token: adminToken });
  const threadAfter = threadsAfterPending.data.threads.find(t => t.branch_id === branchId && t.worker_user_id === workerId);
  ok(threadAfter && threadAfter.unread_count === 1, "אחרי הסימון, השרשור שוב מופיע כלא-נקרא ברשימת השרשורים");
  const msgsStillThere = await call(`/api/chat/${branchId}/${workerId}`, { token: adminToken });
  ok(msgsStillThere.status === 200 && msgsStillThere.data.messages.length === 2, "סימון כממתין לא מוחק אף הודעה");
  const workerCannotMarkPending = await call(`/api/chat/${branchId}/${workerId}/mark-pending`, { method: "PUT", token: workerToken });
  ok(workerCannotMarkPending.status === 403, "עובד לא יכול לסמן שרשור כממתין לטיפול (מוגבל למנהלים)");

  // --- צירוף תמונה/וידאו להודעת צ'אט (כמו וואטסאפ) ---
  const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const chatWithImage = await call(`/api/chat/${branchId}/${workerId}`, { method: "POST", token: workerToken, body: {
    text: "", attachment: { data_base64: tinyPng, filename: "תקלה.png", mime_type: "image/png" },
  }});
  ok(chatWithImage.status === 201, "הודעת צ'אט בלי טקסט, עם תמונה מצורפת, נשלחת בהצלחה");
  const chatAfterImage = await call(`/api/chat/${branchId}/${workerId}`, { token: adminToken });
  const imageMsg = chatAfterImage.data.messages.find(m => m.id === chatWithImage.data.id);
  ok(imageMsg && imageMsg.has_attachment && imageMsg.attachment_mime === "image/png" && imageMsg.attachment_filename === "תקלה.png", "רשימת ההודעות מציגה את מטא-הנתונים של הצירוף (בלי הבייטים עצמם)");
  ok(!("attachment_data" in imageMsg), "ה-BLOB של הצירוף לא חוזר ברשימת ההודעות (רק דרך נתיב ההורדה)");

  const attachmentRes = await fetch(`${base}/api/chat/message/${chatWithImage.data.id}/attachment`, { headers: { Authorization: "Bearer " + adminToken } });
  const attachmentBuf = Buffer.from(await attachmentRes.arrayBuffer());
  ok(attachmentRes.status === 200 && attachmentRes.headers.get("content-type") === "image/png" && attachmentBuf.equals(Buffer.from(tinyPng, "base64")), "מנהל מוריד את התמונה המצורפת ומקבל בדיוק את אותם בייטים");
  const workerAttachmentRes = await fetch(`${base}/api/chat/message/${chatWithImage.data.id}/attachment`, { headers: { Authorization: "Bearer " + workerToken } });
  ok(workerAttachmentRes.status === 200, "העובד ששלח את התמונה יכול גם הוא להוריד אותה");

  const emptyNoAttachment = await call(`/api/chat/${branchId}/${workerId}`, { method: "POST", token: workerToken, body: { text: "" } });
  ok(emptyNoAttachment.status === 400, "הודעה בלי טקסט ובלי צירוף נדחית");

  const oversizedBase64 = Buffer.alloc(14 * 1024 * 1024, 1).toString("base64"); // 14MB גולמי > 12MB המותר
  const oversized = await call(`/api/chat/${branchId}/${workerId}`, { method: "POST", token: workerToken, body: {
    text: "", attachment: { data_base64: oversizedBase64, filename: "גדול.png", mime_type: "image/png" },
  }});
  ok(oversized.status === 413, "קובץ מצורף גדול מדי (מעל 12MB) נדחה עם 413");

  // --- מנהל שולח הודעת צ'אט לעובד (כיוון הפוך) - נשלח מייל לעובד (MOCK), לא אמור לזרוק שגיאה ---
  const adminChat = await call(`/api/chat/${branchId}/${workerId}`, { method: "POST", token: adminToken, body: { text: "תודה על העבודה!" } });
  ok(adminChat.status === 201, "מנהל שולח הודעת צ'אט לעובד (עם שליחת מייל ברקע)");

  // --- מחיקת הודעת צ'אט: עובד לא יכול למחוק הודעה של המנהל, מנהל כן יכול ---
  const workerDeleteAdminMsg = await call(`/api/chat/message/${adminChat.data.id}`, { method: "DELETE", token: workerToken });
  ok(workerDeleteAdminMsg.status === 403, "עובד לא יכול למחוק הודעה ששלח המנהל");
  const adminDeleteOwnMsg = await call(`/api/chat/message/${adminChat.data.id}`, { method: "DELETE", token: adminToken });
  ok(adminDeleteOwnMsg.status === 200, "מנהל יכול למחוק הודעת צ'אט");

  // --- "לטיפול המשך" + מחיקת דיווח ---
  const followupOn = await call(`/api/reports/${report.data.id}/followup`, { method: "PUT", token: adminToken, body: { needsFollowup: true } });
  ok(followupOn.status === 200, "סימון דיווח כ'לטיפול המשך' עובד");
  const reportsAfterFollowup = await call("/api/reports", { token: adminToken });
  const flaggedReport = reportsAfterFollowup.data.reports.find(r => r.id === report.data.id);
  ok(flaggedReport && flaggedReport.needs_followup === 1, "הדגל 'לטיפול המשך' נשמר ומוחזר נכון");
  const deleteReportRes = await call(`/api/reports/${report.data.id}`, { method: "DELETE", token: adminToken });
  ok(deleteReportRes.status === 200, "מחיקת דיווח עובדת");

  // --- צ'אט בין מנהלים (admin1 <-> admin2), נפרד מהצ'אט לפי סניף ---
  const peers = await call("/api/admin-chat/peers", { token: adminToken });
  ok(peers.status === 200 && peers.data.peers.some(p => p.id === admin2Id), "מנהל 1 רואה את מנהל 2 ברשימת המנהלים לצ'אט");

  const adminMsg1 = await call(`/api/admin-chat/${admin2Id}`, { method: "POST", token: adminToken, body: { text: "שלום מנהל 2" } });
  ok(adminMsg1.status === 201, "מנהל 1 שולח הודעה למנהל 2");

  const adminThreadsForAdmin2 = await call("/api/admin-chat/threads", { token: admin2Token });
  ok(adminThreadsForAdmin2.status === 200 && adminThreadsForAdmin2.data.threads.length === 1 && adminThreadsForAdmin2.data.threads[0].unread_count === 1, "מנהל 2 רואה שרשור עם הודעה אחת לא-נקראה");

  const adminMsgsRead = await call(`/api/admin-chat/${login.data.user.id}`, { token: admin2Token });
  ok(adminMsgsRead.status === 200 && adminMsgsRead.data.messages.length === 1, "מנהל 2 קורא את הודעת מנהל 1 (וזה מסמן אותה כנקראה)");

  const workerCannotAdminChat = await call(`/api/admin-chat/${admin2Id}`, { method: "POST", token: workerToken, body: { text: "לא אמור לעבוד" } });
  ok(workerCannotAdminChat.status === 403, "עובד לא יכול לשלוח בצ'אט מנהלים (מוגבל למנהלים בלבד)");

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

  // הסניף הראשון כבר מגיע עם עמדות/טאבלטים מזריעת נתונים ראשונית (ר' src/db.js) - הבדיקות סופרות
  // יחסית לבייסליין ולא במספר מוחלט, כדי לא להישבר כשמוסיפים עוד סניפים לזריעה בעתיד.
  const stationsBaseline = await call(`/api/branches/${branchId}/stations`, { token: adminToken });
  const stationBaseCount = stationsBaseline.data.stations.length;
  const station1 = await call(`/api/branches/${branchId}/stations`, { method: "POST", token: adminToken, body: { number: "1" } });
  ok(station1.status === 201, "עמדה נוספה לסניף בלי קבוצה/אגף");
  const station2 = await call(`/api/branches/${branchId}/stations`, { method: "POST", token: adminToken, body: { number: "2", groupLabel: "נשים" } });
  ok(station2.status === 201, "עמדה נוספה עם קבוצה/אגף");
  const noNumber = await call(`/api/branches/${branchId}/stations`, { method: "POST", token: adminToken, body: {} });
  ok(noNumber.status === 400, "עמדה בלי מספר נדחית");
  const stationsList = await call(`/api/branches/${branchId}/stations`, { token: workerToken });
  ok(stationsList.status === 200 && stationsList.data.stations.length === stationBaseCount + 2 && stationsList.data.stations.some(s => s.id === station2.data.id && s.group_label === "נשים"), "עובד יכול לראות את רשימת העמדות של הסניף");
  const editStation = await call(`/api/stations/${station1.data.id}`, { method: "PUT", token: adminToken, body: { number: "1", groupLabel: "גברים" } });
  ok(editStation.status === 200, "עריכת עמדה (הוספת קבוצה/אגף) עובדת");
  const workerCannotAddStation = await call(`/api/branches/${branchId}/stations`, { method: "POST", token: workerToken, body: { number: "9" } });
  ok(workerCannotAddStation.status === 403, "עובד לא יכול להוסיף עמדה (מוגבל למנהלים)");
  const deleteStation = await call(`/api/stations/${station2.data.id}`, { method: "DELETE", token: adminToken });
  ok(deleteStation.status === 200, "מחיקת עמדה (רכה) עובדת");
  const stationsAfterDelete = await call(`/api/branches/${branchId}/stations`, { token: adminToken });
  ok(stationsAfterDelete.status === 200 && stationsAfterDelete.data.stations.length === stationBaseCount + 1, "עמדה שנמחקה לא מופיעה יותר ברשימה");

  const phrase1 = await call("/api/instruction-phrases", { method: "POST", token: adminToken, body: { text: "לתקן מקלדת" } });
  ok(phrase1.status === 201, "ביטוי חדש נוסף למילון");
  const phraseDup = await call("/api/instruction-phrases", { method: "POST", token: adminToken, body: { text: "לתקן מקלדת" } });
  ok(phraseDup.status === 200 && phraseDup.data.alreadyExists, "הוספת ביטוי כפול לא יוצרת שורה נוספת, רק מחזירה את הקיים");
  const phrasesList = await call("/api/instruction-phrases", { token: adminToken });
  ok(phrasesList.status === 200 && phrasesList.data.phrases.length === 1, "רשימת המילון מכילה ביטוי אחד בלבד אחרי הכפילות");
  const deletePhrase = await call(`/api/instruction-phrases/${phrase1.data.id}`, { method: "DELETE", token: adminToken });
  ok(deletePhrase.status === 200, "מחיקת ביטוי מהמילון עובדת");

  const tabletsBaseline = await call("/api/tablets", { token: adminToken });
  const tabletBaseCount = tabletsBaseline.data.tablets.length;
  const tabletWithBranch = await call("/api/tablets", { method: "POST", token: adminToken, body: { label: "טאבלט בדיקה", branchId } });
  ok(tabletWithBranch.status === 201, "טאבלט נוסף עם שיוך לסניף");
  const tabletNoBranch = await call("/api/tablets", { method: "POST", token: adminToken, body: { label: "טאבלט בלי סניף" } });
  ok(tabletNoBranch.status === 201, "טאבלט נוסף בלי שיוך לסניף (branchId ריק מותר)");
  const noLabel = await call("/api/tablets", { method: "POST", token: adminToken, body: {} });
  ok(noLabel.status === 400, "טאבלט בלי תווית נדחה");
  const tabletsList = await call("/api/tablets", { token: adminToken });
  ok(tabletsList.status === 200 && tabletsList.data.tablets.length === tabletBaseCount + 2 && tabletsList.data.tablets.some(t => t.id === tabletNoBranch.data.id && t.branch_name === null), "רשימת הטאבלטים מחזירה גם את הטאבלט בלי סניף");
  const editTablet = await call(`/api/tablets/${tabletNoBranch.data.id}`, { method: "PUT", token: adminToken, body: { label: "טאבלט בדיקה 2", branchId } });
  ok(editTablet.status === 200, "עריכת טאבלט (הוספת שיוך לסניף) עובדת");
  const workerCannotAddTablet = await call("/api/tablets", { method: "POST", token: workerToken, body: { label: "לא אמור לעבוד" } });
  ok(workerCannotAddTablet.status === 403, "עובד לא יכול להוסיף טאבלט (מוגבל למנהלים)");
  const deleteTablet = await call(`/api/tablets/${tabletWithBranch.data.id}`, { method: "DELETE", token: adminToken });
  ok(deleteTablet.status === 200, "מחיקת טאבלט (רכה) עובדת");
  const tabletsAfterDelete = await call("/api/tablets", { token: adminToken });
  ok(tabletsAfterDelete.status === 200 && tabletsAfterDelete.data.tablets.length === tabletBaseCount + 1, "טאבלט שנמחק לא מופיע יותר ברשימה");

  const tx = await call("/api/transactions", { method: "POST", token: adminToken, body: { type: "income", amount: 1000, category: "תשלום סניף" } });
  ok(tx.status === 201, "תנועת הכנסה נוספה");
  const txList = await call("/api/transactions", { token: adminToken });
  ok(txList.status === 200 && txList.data.summary.income === 1000, "סיכום הכנסות תקין");

  const forbidden = await call("/api/transactions", { token: workerToken });
  ok(forbidden.status === 403, "עובד לא יכול לראות נתונים כספיים");

  // --- הוראה ל"כולם"/"כל הסניפים": יוצרים עובד שני, ובודקים שהוראה עם branchIds+workerUserIds
  //     יוצרת הוראה נפרדת לכל צירוף (עובד × סניף) ---
  const worker2 = await call("/api/users", { method: "POST", token: adminToken, body: {
    fullName: "עובד שני", username: "worker2", pin: "5678", role: "worker", email: "worker2@example.com",
  }});
  ok(worker2.status === 201, "נוצר עובד שני לבדיקת שידור לכולם");
  // בכוונה לא כוללים כאן את workerId המקורי - יש לו כבר בדיקות pending-instructions ייעודיות
  // בהמשך (זרימת הטלפון למטה), ולא רוצים ליצור לו כאן עוד הוראות pending שיפריעו לזה.
  const secondBranchId = branches.data.branches[1].id;
  const broadcast = await call("/api/instructions", { method: "POST", token: adminToken, body: {
    branchIds: [branchId, secondBranchId], workerUserIds: [worker2.data.id], text: "בדיקת שיבוץ לכולם",
  }});
  ok(broadcast.status === 201 && broadcast.data.created === 2, "הוראה ל-1 עובד × 2 סניפים יוצרת 2 הוראות בבת אחת");

  // --- "בחר הכל" בצ'אט: הודעה חדשה ל-1 עובד × 2 סניפים יוצרת 2 הודעות צ'אט (שרשור נפרד לכל סניף),
  //     אבל מייל מרוכז אחד בלבד (לא מייל נפרד לכל סניף) ---
  const chatBroadcast = await call("/api/chat/bulk", { method: "POST", token: adminToken, body: {
    branchIds: [branchId, secondBranchId], workerUserIds: [worker2.data.id], text: "בדיקת בחר הכל בצאט",
  }});
  ok(chatBroadcast.status === 201 && chatBroadcast.data.created === 2 && chatBroadcast.data.emailsSent === 1,
    "'בחר הכל' בצ'אט יוצר 2 הודעות אבל שולח מייל מרוכז אחד בלבד");
  const chatThread1 = await call(`/api/chat/${branchId}/${worker2.data.id}`, { token: adminToken });
  const chatThread2 = await call(`/api/chat/${secondBranchId}/${worker2.data.id}`, { token: adminToken });
  ok(chatThread1.data.messages.some(m => m.text === "בדיקת בחר הכל בצאט") && chatThread2.data.messages.some(m => m.text === "בדיקת בחר הכל בצאט"),
    "הודעת הצ'אט המרוכזת מופיעה בשני השרשורים (לפי סניף)");
  const workerCantBulk = await call("/api/chat/bulk", { method: "POST", token: workerToken, body: {
    branchIds: [branchId], workerUserIds: [worker2.data.id], text: "נסיון לא מורשה",
  }});
  ok(workerCantBulk.status === 403, "עובד לא יכול לשלוח הודעת צ'אט מרוכזת (מוגבל למנהלים)");

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
  // הערה: sanitizeForYemot (services/yemot.js) מסירה אפוסטרופים מהטקסט המושמע - "צ'אט" הופך ל"צאט".
  // רק הודעה אחת לא-נקראה בשלב הזה (הודעת המנהל השנייה נמחקה בבדיקת מחיקת-הודעות למעלה).
  ok(yemotDecline.status === 200 && yemotDecline.text.includes("1 הודעות חדשות בצאט"), "השיחה הטלפונית מזכירה בסיום את מספר הודעות הצ'אט הלא-נקראות");

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
