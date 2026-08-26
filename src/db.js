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
    reset_code_hash TEXT,               -- קוד שחזור סיסמה (4 ספרות, hash) - ר' routes/auth.js forgot-password
    reset_code_expires_at TEXT,
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
    category TEXT NOT NULL DEFAULT 'salary', -- 'salary' (מוטב קבוע) | 'electricity' (חשמל) | 'property_tax' (ארנונה)
    name TEXT NOT NULL,
    phone TEXT,
    payment_details TEXT,               -- הערות חופשיות (פרטי תשלום/בנק/הערה)
    monthly_amount REAL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- הזמנות הרשמה: מנהל מוסיף מייל מראש (עם תפקיד), ורק אז מי שמגיע עם המייל הזה יכול להירשם בעצמו
  -- (ר' POST /api/register) - "כל אחד יכול להירשם, אבל רק אם המייל שלו כבר אושר ע"י מנהל".
  CREATE TABLE IF NOT EXISTS signup_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    role TEXT NOT NULL,                 -- 'admin' | 'worker' - התפקיד שהחשבון יקבל בהרשמה
    used_at TEXT,
    used_by_user_id INTEGER REFERENCES users(id),
    created_by INTEGER REFERENCES users(id),
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
    needs_followup INTEGER NOT NULL DEFAULT 0, -- "לטיפול המשך" - דגל שהמנהל מסמן/מבטל ידנית, בנפרד מסטטוס הדיווח עצמו
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

  -- צ'אט בין מנהלים (נפרד מ-chat_messages, שהוא תמיד לפי סניף+עובד) - שיחה חופשית פשוטה בין שני
  -- משתמשים מסוג admin, בלי הקשר של סניף (ר' משוב המשתמש: "לדבר גם עם מנהלים, לא רק עם עובדים").
  CREATE TABLE IF NOT EXISTS admin_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_user_id INTEGER NOT NULL REFERENCES users(id),
    recipient_user_id INTEGER NOT NULL REFERENCES users(id),
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
    payment_method TEXT,               -- 'bank' | 'card' | NULL (לא ידוע/הוזן ידנית) - לסינון "רק כרטיס אשראי" וכו'
    document_id INTEGER REFERENCES documents(id), -- הקובץ המקורי שממנו יובאה התנועה (ר' טבלת documents), NULL אם הוזנה ידנית
    occurred_at TEXT DEFAULT (datetime('now')),
    created_by INTEGER REFERENCES users(id)
  );

  -- קבצים שהועלו לייבוא (דפי בנק/אשראי) - נשמרים כדי שאפשר יהיה לפתוח/להוריד אותם שוב בהמשך מתוך
  -- טאב "כספים", בלי לצטרך לחפש אותם שוב במחשב. size_bytes רק לתצוגה, לא נאכף כהגבלה כאן.
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    data BLOB NOT NULL,
    uploaded_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
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

  -- עמדות מחשב (תחנות עבודה) בתוך סניף - מספר עמדה + קבוצה/אגף אופציונלי (למשל "נשים תלמוד
  -- בבלי", לסניפים שמתחלקים לכמה קבוצות מחשבים) - כדי לשלוח הוראת תחזוקה/ניקיון לעמדה ספציפית
  -- בתוך הסניף, לא רק לסניף כולו (ר' משוב המשתמש).
  CREATE TABLE IF NOT EXISTS stations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    number TEXT NOT NULL,              -- מספר/תווית העמדה, למשל "3" או "עמדה 7"
    group_label TEXT,                  -- קבוצה/אגף אופציונלי, למשל "נשים תלמוד בבלי"
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- מילון ביטויים שמורים לשדה "תוכן ההוראה" (טקסט חופשי) - שומרים ביטויים קצרים שחוזרים על עצמם
  -- כדי להציע אותם מהר בפעם הבאה במקום להקליד מחדש (ר' משוב המשתמש).
  CREATE TABLE IF NOT EXISTS instruction_phrases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- טאבלטים - ציוד נפרד מעמדות המחשב (בד"כ טאבלט אחד לסניף, לפעמים ייעודי כמו "הפקדת צ'קים").
  -- branch_id יכול להיות NULL אם לא ברור לאיזה סניף בדיוק שייך הטאבלט (ר' משוב המשתמש).
  CREATE TABLE IF NOT EXISTS tablets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id),
    label TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
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

// מיגרציה: הוספת עמודות חדשות לטבלת transactions שכבר קיימת (CREATE TABLE IF NOT EXISTS למעלה לא
// מוסיף עמודות למסד נתונים קיים - רלוונטי לסביבת הפיתוח המקומית ולסביבת הייצור שכבר יש בהן נתונים).
// ALTER TABLE ADD COLUMN לא תומך ב"IF NOT EXISTS" ב-SQLite - עוטפים ב-try/catch ומתעלמים משגיאת
// "duplicate column" (כלומר העמודה כבר קיימת מריצה קודמת).
for (const alterSql of [
  "ALTER TABLE transactions ADD COLUMN payment_method TEXT",
  "ALTER TABLE transactions ADD COLUMN document_id INTEGER REFERENCES documents(id)",
  "ALTER TABLE beneficiaries ADD COLUMN category TEXT NOT NULL DEFAULT 'salary'",
  "ALTER TABLE reports ADD COLUMN needs_followup INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN reset_code_hash TEXT",
  "ALTER TABLE users ADD COLUMN reset_code_expires_at TEXT",
]) {
  try {
    db.exec(alterSql);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) console.error(`שגיאת מיגרציה (${alterSql}):`, e.message);
  }
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

// שינוי שם: הסניף שהיה רשום כ"קניון לב הרמה" נקרא בפועל "מגן הרמה" במערכת החיצונית (אישור
// המשתמש) - מחליפים בשם פעם אחת, בטוח להרצה חוזרת (לא עושה כלום אם השם כבר שונה).
db.exec(`UPDATE branches SET name = REPLACE(name, 'לב הרמה', 'מגן הרמה') WHERE name LIKE '%לב הרמה%'`);

// תיקון: עמדות "תלמוד בבלי" שנזרעו בגרסה קודמת עם group_label ריק - עכשיו שיש נתון מלא יותר,
// מסתבר שהיה להן שם קבוצה ("גברים תלמוד בבלי") שפשוט לא הגיע בהדבקה הראשונה. UPDATE בטוח להרצה חוזרת.
db.exec(`
  UPDATE stations SET group_label = 'גברים תלמוד בבלי'
  WHERE group_label IS NULL AND branch_id = (SELECT id FROM branches WHERE name = 'רמה ד'' 3 - תלמוד בבלי')
`);

// זריעת עמדות ראשוניות מהנתונים שהמשתמש העתיק והדביק בשיחה (צילומי מסך של מערכת חיצונית) - כדי
// שלא יצטרך להקליד אותן ידנית. לכל סניף: רק אם עדיין אין לו אף עמדה (לא לשכפל/לדרוס עריכה ידנית).
const stationSeedData = {
  "רמה ג' 2 - אלישע הנביא": [
    { group: "גברים אלישע", numbers: ["2", "3", "4", "5", "7", "8"] },
    { group: "נשים אלישע", numbers: ["2", "3", "4", "5", "6"] },
  ],
  "רמה ד' 4 - חלקיה בר\"ט": [
    { group: "גברים רב חלקיה בר טוביה ד4", numbers: ["1", "2", "3", "4", "5", "6", "עמדה 7"] },
    { group: "נשים רב חלקיה בר טוביה", numbers: ["עמדה 1", "עמדה 2", "עמדה 3", "עמדה 4", "עמדה 5 זוגות"] },
  ],
  "רמה ד' 1 - מר עוקבא": [
    { group: "גברים מר עוקבא ד2", numbers: ["1", "2", "3", "4", "5", "6", "7", "8"] },
    { group: "נשים מר עוקבא", numbers: ["עמדה 1", "עמדה 2", "עמדה 3", "עמדה 4"] },
  ],
  "רמה ג' 2 - מרים הנביאה": [
    { group: "גברים ג2 מרים הנביאה", numbers: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] },
    { group: "נשים ג2 מרים הנביאה", numbers: ["1", "2", "3", "4", "5"] },
  ],
  "רמה ד' 1 - רב חנן": [
    { group: "גברים רב חנן", numbers: ["1", "2", "3", "4", "5", "6"] },
    { group: "נשים רב חנן", numbers: ["1", "2", "3", "4", "זוגות 5"] },
  ],
  "רמה ד' 1 - רב זירא": [
    { group: "גברים רבי זירא", numbers: ["1", "2", "3", "4", "5", "6", "7"] },
    { group: "נשים רבי זירא", numbers: ["1", "2", "3", "4", "4"] },
  ],
  "רמה ב'": [
    { group: "גברים ריב\"ל", numbers: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "עמדה מהירה"] },
    { group: "נשים ריב\"ל", numbers: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "זוגי 1", "זוגי 2"] },
  ],
  "רמה ד' 1 - ריש לקיש": [
    { group: "גברים ד2 ריש לקיש", numbers: ["1", "2", "3", "4", "5", "6", "7", "8", "טאבלט ריש לקיש"] },
    { group: "נשים ד2 ריש לקיש", numbers: ["2", "3", "4", "5", "6"] },
  ],
  "רמה ד' 3 - האמוראים": [
    { group: "גברים ד3 האמוראים", numbers: ["1", "2", "3", "4", "5"] },
    { group: "נשים ד3 האמוראים", numbers: ["1", "2", "3", "4", "זוגות 1", "זוגות 2"] },
  ],
  // בהתקנה קיימת (פרודקשן) הסניף הזה כבר הוזרע בגרסה קודמת - ה-UPDATE למעלה מתקן את group_label
  // שם. הערך כאן משמש רק בהתקנה חדשה-לגמרי (dev מקומי טרי וכו') שעדיין אין לה אף עמדה בכלל.
  "רמה ד' 3 - תלמוד בבלי": [
    { group: "גברים תלמוד בבלי", numbers: ["1", "2", "3", "4", "5", "6", "עמדה 7"] },
    { group: "נשים תלמוד בבלי", numbers: ["1", "2", "3", "4", "5", "6"] },
  ],
  // "מגן הרמה" - אושר ע"י המשתמש שזה השם החדש של "קניון לב הרמה" (ר' שינוי השם למעלה).
  "קניון מגן הרמה (ליד רב-קו)": [
    { group: "גברים מגן הרמה", numbers: ["2", "3", "3", "4", "5", "6", "7", "עמדה 8 גברים", "עמדה גברים 9"] },
    { group: "נשים מגן הרמה", numbers: ["1", "2", "3", "4", "5", "6", "7"] },
  ],
  // "קאשווי" אושר ע"י המשתמש כשייך לנהרדעא 6; "נהרדעא ד3" (בלי תיוג נוסף) משויך ל-28 מהשארה.
  "רמה ד' 3 - נהרדעא 6": [
    { group: "נהרדעא -קאשווי גברים", numbers: ["1", "2", "3", "4", "5", "6", "7"] },
    { group: "נהרדעא -קאשווי נשים", numbers: ["1", "2", "3", "4", "5"] },
  ],
  "רמה ד' 3 - נהרדעא 28": [
    { group: "נהרדעא ד3 גברים", numbers: ["1", "2", "3", "4", "5", "6"] },
    { group: "נהרדעא ד3 נשים", numbers: ["1", "2", "זוגות 3"] },
  ],
};
for (const [branchName, groups] of Object.entries(stationSeedData)) {
  const branch = db.prepare("SELECT id FROM branches WHERE name = ?").get(branchName);
  if (!branch) continue;
  const existingCount = db.prepare("SELECT COUNT(*) AS c FROM stations WHERE branch_id = ?").get(branch.id).c;
  if (existingCount > 0) continue;
  const insertStation = db.prepare("INSERT INTO stations (branch_id, number, group_label) VALUES (?, ?, ?)");
  for (const g of groups) {
    for (const n of g.numbers) insertStation.run(branch.id, n, g.group);
  }
}

// זריעת טאבלטים ראשוניים מהנתונים שהמשתמש שלח (אישר "תעשה לי משהו חדש, זה בסדר") - רק אם עדיין
// אין אף טאבלט בטבלה (לא לשכפל אם כבר הוזנו/נערכו ידנית). branchName=null = לא היה ברור מהצילום
// לאיזה סניף בדיוק שייך (למשל "טאבלט נהרדעא" הכללי, בלי לציין 6 או 28).
const tabletCount = db.prepare("SELECT COUNT(*) AS c FROM tablets").get().c;
if (tabletCount === 0) {
  const tabletSeedData = [
    ["רמה ד' 3 - תלמוד בבלי", "הפקדת צ'קים תלמוד בבלי"],
    ["רמה ד' 3 - האמוראים", "טאבלט 6 ד3 שדרת האמוראים"],
    ["רמה ג' 2 - אלישע הנביא", "טאבלט אלישע"],
    ["קניון מגן הרמה (ליד רב-קו)", "טאבלט לב הרמה"],
    ["רמה ד' 1 - מר עוקבא", "טאבלט מר עוקבא"],
    ["רמה ד' 3 - נהרדעא 6", "טאבלט קאשוי"],
    ["רמה ד' 1 - רב זירא", "טאבלט רב זירא"],
    ["רמה ד' 4 - חלקיה בר\"ט", "טאבלט חלקיה"],
    ["רמה ד' 1 - רב חנן", "טאבלט רב חנן"],
    ["רמה ב'", "טאבלט ריבל 5"],
    ["רמה ג' 2 - מרים הנביאה", "טאבלט- מרים הנביאה"],
    [null, "טאבלט נהרדעא"], // לא ברור אם 6 או 28 - השאר בלי סניף עד לבירור
  ];
  const insertTablet = db.prepare("INSERT INTO tablets (branch_id, label) VALUES (?, ?)");
  for (const [branchName, label] of tabletSeedData) {
    const branchId = branchName ? (db.prepare("SELECT id FROM branches WHERE name = ?").get(branchName) || {}).id : null;
    insertTablet.run(branchId || null, label);
  }
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
