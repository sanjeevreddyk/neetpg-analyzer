const sqlite3 = require('sqlite3').verbose();
const dbPath = 'c:\\Users\\himab\\OneDrive\\ドキュメント\\Neet_PG_Question_analysis\\neet_pg_bank_v2.db';

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Error opening DB:', err.message);
    return;
  }
  
  db.all(
    "SELECT Question_Number, Question_Text, Option_A, Option_B, Option_C, Option_D, Correct_Answer, Image_Present, Embedded_Image FROM QuestionBank WHERE Upload_ID = '1c692795-1e37-4053-8210-c316771554e2' AND Question_Number IN (11, 12) ORDER BY Question_Number ASC",
    [],
    (err, rows) => {
      if (err) {
        console.error('Error querying database:', err);
      } else {
        console.log('\n=== Question 11 and 12 Details ===');
        rows.forEach(r => {
          console.log(`Q${r.Question_Number}: ${r.Question_Text}`);
          console.log(`  Option A: ${JSON.stringify(r.Option_A)}`);
          console.log(`  Option B: ${JSON.stringify(r.Option_B)}`);
          console.log(`  Option C: ${JSON.stringify(r.Option_C)}`);
          console.log(`  Option D: ${JSON.stringify(r.Option_D)}`);
          console.log(`  Correct: ${r.Correct_Answer} | Image Present: ${r.Image_Present} | Image Path: ${r.Embedded_Image}`);
        });
      }
      db.close();
    }
  );
});
