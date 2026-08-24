// db.js — שכבת מסד הנתונים.
// משתמש ב-node:sqlite המובנה ב-Node.js (מגרסה 22.5 ומעלה) — אין צורך בהתקנת שום חבילה חיצונית.
// דפוס זהה ל"הפנקס שלי" (backend/src/db.js).
"use strict";

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "app.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  -- משתמשים: גם מנהלים (role='admin', גישה מלאה) וגם עובדים (role='worker', גישה מוגבלת -
  -- דיווח וצ'אט בלבד). סיסמה = קוד PIN בן 4 ספרות בדיוק (אותו hash משמש גם ככניסה לאתר וגם
  -- כקוד זיהוי בטלפון בשלוחה) - בדיוק כמו ב"הפנקס שלי" (ר' src/utils/crypto.js, isValidPin).
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,       -- PIN בן 4 ספרות, מוצפן
    role TEXT NOT NULL,                -- 'admin' | 'worker'
    phone TEXT,                        -- מספר הטלפון שממנו מזוהה העובד בשלוחה (Caller ID), אופציונלי
    email TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- סניפים (= חדרי מחשבים, כל חדר הוא סניף בפני עצמו - לא היררכיה). ניתן להוסיף/לערוך/למחוק דרך האתר.
  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                -- למשל "רמה ד' 1"
    address TEXT,                      -- למשל "רב זירא 3 (מול אפיפית), בחניה 3, קומת כניסה"
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- שיוך עובדים לסניפים (many-to-many) - עובד יכול להיות משויך לכמה סניפים, וסניף יכול להיות
  -- מטופל ע"י כמה עובדים.
  CREATE TABLE IF NOT EXISTS worker_branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_user_id INTEGER NOT NULL REFERENCES users(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    UNIQUE(worker_user_id, branch_id)
  );

  -- מוטבים למשכורות: מי מקבל תשלום על כל סניף (יכול להיות אותו אדם כמו העובד המנקה, או מישהו אחר).
  CREATE TABLE IF NOT EXISTS beneficiaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    name TEXT NOT NULL,
    phone TEXT,
    payment_details TEXT,               -- הערות חופשיות (פרטי תשלום/בנק/הערה)
    monthly_amount REAL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- הוראות שנשלחות לעובד ספציפי לגבי סניף ספציפי - דרך מייל + שלוחה בטלפון.
  CREATE TABLE IF NOT EXISTS instructions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    worker_user_id INTEGER NOT NULL REFERENCES users(id),
    created_by INTEGER NOT NULL REFERENCES users(id), -- איזה מנהל יצר את ההוראה
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | heard_phone | read_web | done
    email_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- דיווחי עובדים (תגובה להוראה, או דיווח יזום). מקשים בטלפון (status_code) + הערה קולית/טקסט חופשי.
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instruction_id INTEGER REFERENCES instructions(id), -- NULL = דיווח יזום, לא תגובה להוראה ספציפית
    worker_user_id INTEGER NOT NULL REFERENCES users(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    status_code TEXT NOT NULL,          -- 'done' | 'not_done' | 'issue' | 'other'
    note_text TEXT,                     -- הערה חופשית (מהאתר, או תמלול/תיאור הערה קולית מהטלפון)
    voice_note_path TEXT,               -- נתיב קובץ הקלטה קולית אם הגיע מהטלפון (עתידי - ר' README)
    source TEXT NOT NULL DEFAULT 'web',  -- 'web' | 'phone'
    read_by_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- צ'אט פנימי בין מנהל לעובד, לפי סניף (שיחה חופשית, לא רק דיווח חד-כיווני).
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    worker_user_id INTEGER NOT NULL REFERENCES users(id), -- עם איזה עובד השיחה (הצ'אט הוא תמיד עובד<->מנהלים)
    sender_user_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- הכנסות/הוצאות (אותו מבנה כמו "הפנקס שלי" - מאפשר להשתמש באותם ספריות ייבוא בנק/אשראי כמו שהן).
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id), -- NULL = הכנסה/הוצאה כללית, לא משויכת לסניף מסוים
    type TEXT NOT NULL,                -- income | expense
    amount REAL NOT NULL,
    category TEXT,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'web',-- web | import
    import_hash TEXT,                  -- זיהוי כפילויות מייבוא (ר' routes/importTransactions.js)
    occurred_at TEXT DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  );

  -- מצב שיחה פעילה בשלוחת הטלפון (ימות המשיח) - מכונת מצבים פשוטה, לפי ApiCallId (call_sid).
  CREATE TABLE IF NOT EXISTS call_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid TEXT UNIQUE,
    state TEXT,
    draft_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- התראות למנהלים (פעמון/באדג' באתר) - נוצרת אוטומטית על כל דיווח חדש.
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,                -- 'new_report' | 'new_chat_message'
    ref_id INTEGER,                    -- מזהה השורה הרלוונטית (report.id / chat_messages.id)
    text TEXT NOT NULL,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_import_hash ON transactions(import_hash) WHERE import_hash IS NOT NULL");
} catch (e) {
  console.error("שגיאה ביצירת אינדקס import_hash (לא קריטי):", e.message);
}

// זריעת נתוני התחלה: 13 הסניפים מהפלייר של "שולחן עבודה" (אושרו ע"י המשתמש), רק אם הטבלה ריקה -
// כדי לא לדרוס נתונים שהמשתמש כבר ערך בעצמו דרך האתר.
const branchCount = db.prepare("SELECT COUNT(*) AS c FROM branches").get().c;
if (branchCount === 0) {
  const insertBranch = db.prepare("INSERT INTO branches (name, address) VALUES (?, ?)");
  const seedBranches = [
    ["קניון לב הרמה (ליד רב-קו)", "נהר הירדן 1"],
    ["רמה ב'", "ריב\"ל 5"],
    ["רמה ג' 2 - אלישע הנביא", "אלישע הנביא 2, בחניה"],
    ["רמה ג' 2 - מרים הנביאה", "מרים הנביאה 18"],
    ["רמה ד' 1 - רב זירא", "רב זירא 3 (מול אפיפית), בחניה 3, קומת כניסה"],
    ["רמה ד' 1 - ריש לקיש", "ריש לקיש 34"],
    ["רמה ד' 1 - מר עוקבא", "מר עוקבא 14"],
    ["רמה ד' 1 - רב חנן", "רב חנן 1, בחניה"],
    ["רמה ד' 3 - האמוראים", "האמוראים 69, בחניה"],
    ["רמה ד' 3 - תלמוד בבלי", "תלמוד בבלי 18, בחניה"],
    ["רמה ד' 3 - נהרדעא 6", "נהרדעא 6, בחניה"],
    ["רמה ד' 3 - נהרדעא 28", "נהרדעא 28"],
    ["רמה ד' 4 - חלקיה בר\"ט", "חלקיה בר\"ט 7, בחניה"],
  ];
  for (const [name, address] of seedBranches) insertBranch.run(name, address);
}

// זריעת שני חשבונות מנהל ברירת מחדל, רק אם אין עדיין אף מנהל - כדי לאפשר כניסה ראשונה לאתר.
// **חשוב**: קוד ברירת המחדל (0000) חייב להתחלף מיד אחרי הכניסה הראשונה (ר' README).
const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c;
if (adminCount === 0) {
  const { hashPassword } = require("./utils/crypto");
  const insertUser = db.prepare("INSERT INTO users (full_name, username, password_hash, role) VALUES (?, ?, ?, 'admin')");
  insertUser.run("מנהל 1", "admin1", hashPassword("0000"));
  insertUser.run("מנהל 2", "admin2", hashPassword("0000"));
}

module.exports = db;
