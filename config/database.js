const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, '../neet_pg_bank.db');

// Ensure database directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  } else {
    console.log('Connected to the SQLite database at:', dbPath);
    db.run('PRAGMA foreign_keys = ON;');
  }
});

// Promisified DB operations
const dbQuery = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },
  
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
};

// Initialize schema
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        // Table 1: UploadHistory
        await dbQuery.run(`
          CREATE TABLE IF NOT EXISTS UploadHistory (
            Upload_ID TEXT PRIMARY KEY,
            User_ID TEXT DEFAULT 'system_user',
            File_Name TEXT NOT NULL,
            File_Size INTEGER NOT NULL,
            Upload_Date DATETIME NOT NULL,
            Questions_Extracted INTEGER DEFAULT 0,
            Processing_Status TEXT CHECK (Processing_Status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
            File_Path TEXT
          );
        `);

        // Table 2: QuestionBank
        await dbQuery.run(`
          CREATE TABLE IF NOT EXISTS QuestionBank (
            Question_ID TEXT PRIMARY KEY,
            Upload_ID TEXT NOT NULL,
            Question_Number INTEGER,
            Question_Text TEXT NOT NULL,
            Option_A TEXT NOT NULL,
            Option_B TEXT NOT NULL,
            Option_C TEXT NOT NULL,
            Option_D TEXT NOT NULL,
            Correct_Answer TEXT,
            Answer_Explanation TEXT,
            Subject TEXT,
            Chapter TEXT,
            Topic TEXT,
            Difficulty_Level TEXT CHECK (Difficulty_Level IN ('Easy', 'Medium', 'Hard')),
            Clinical_or_Conceptual TEXT CHECK (Clinical_or_Conceptual IN ('Clinical Scenario', 'Conceptual', 'Fact Recall')),
            Question_Type TEXT CHECK (Question_Type IN ('Clinical Scenario', 'Single Best Answer', 'Image Based', 'Assertion Reason', 'Fact Recall')),
            Image_Present BOOLEAN DEFAULT FALSE,
            Embedded_Image TEXT,
            Image_Description TEXT,
            Previous_Year INTEGER,
            Page_Number INTEGER,
            Keywords TEXT,
            Similarity_Group_ID TEXT,
            OCR_Confidence TEXT CHECK (OCR_Confidence IN ('High', 'Medium', 'Low')),
            Generation_Source TEXT DEFAULT 'Local Fallback',
            Created_Date DATETIME DEFAULT CURRENT_TIMESTAMP,
            Updated_Date DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (Upload_ID) REFERENCES UploadHistory(Upload_ID) ON DELETE CASCADE
          );
        `);

        // Table 3: Images
        await dbQuery.run(`
          CREATE TABLE IF NOT EXISTS Images (
            Image_ID TEXT PRIMARY KEY,
            Question_ID TEXT NOT NULL,
            Image_Path TEXT NOT NULL,
            Image_Description TEXT,
            Image_Type TEXT,
            FOREIGN KEY (Question_ID) REFERENCES QuestionBank(Question_ID) ON DELETE CASCADE
          );
        `);

        // Table 4: SystemSettings (stores api keys and modular dynamic tokens)
        await dbQuery.run(`
          CREATE TABLE IF NOT EXISTS SystemSettings (
            Setting_Key TEXT PRIMARY KEY,
            Setting_Value TEXT NOT NULL
          );
        `);

        // Index creations
        await dbQuery.run(`CREATE INDEX IF NOT EXISTS IDX_QB_Subject ON QuestionBank(Subject);`);
        await dbQuery.run(`CREATE INDEX IF NOT EXISTS IDX_QB_Upload ON QuestionBank(Upload_ID);`);
        await dbQuery.run(`CREATE INDEX IF NOT EXISTS IDX_QB_Confidence ON QuestionBank(OCR_Confidence);`);
        // Migration to add File_Path to UploadHistory if not present
        try {
          await dbQuery.run(`ALTER TABLE UploadHistory ADD COLUMN File_Path TEXT;`);
          console.log('Database migration: Added File_Path column to UploadHistory table.');
        } catch (e) {
          // Ignore error if column already exists
        }

        // Migration to add Generation_Source to QuestionBank if not present
        try {
          await dbQuery.run(`ALTER TABLE QuestionBank ADD COLUMN Generation_Source TEXT DEFAULT 'Local Fallback';`);
          console.log('Database migration: Added Generation_Source column to QuestionBank table.');
        } catch (e) {
          // Ignore error if column already exists
        }

        console.log('Database tables and indexes verified successfully.');
        resolve();
      } catch (err) {
        console.error('Failed to initialize database tables:', err);
        reject(err);
      }
    });
  });
}

module.exports = {
  db,
  dbQuery,
  initDatabase
};
