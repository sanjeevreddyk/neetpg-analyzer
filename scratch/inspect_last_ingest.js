const sqlite3 = require('sqlite3').verbose();
const dbPath = 'c:\\Users\\himab\\OneDrive\\ドキュメント\\Neet_PG_Question_analysis\\neet_pg_bank_v2.db';

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Error opening DB:', err.message);
    return;
  }
  
  db.get('SELECT Upload_ID, File_Name, Upload_Date, Questions_Extracted FROM UploadHistory ORDER BY Upload_Date DESC LIMIT 1', [], (err, upload) => {
    if (err) {
      console.error('Error querying upload history:', err);
      db.close();
      return;
    }
    
    if (!upload) {
      console.log('No uploads found.');
      db.close();
      return;
    }
    
    console.log(`\nLast Upload: ${upload.File_Name} (Upload ID: ${upload.Upload_ID}) on ${upload.Upload_Date}`);
    console.log(`Extracted: ${upload.Questions_Extracted} questions.`);
    
    db.all(
      'SELECT Question_ID, Question_Number, Question_Text, Option_A, Option_B, Option_C, Option_D, Correct_Answer, Image_Present, Embedded_Image FROM QuestionBank WHERE Upload_ID = ? ORDER BY Question_Number ASC LIMIT 10',
      [upload.Upload_ID],
      (err, rows) => {
        if (err) {
          console.error('Error querying question bank:', err);
        } else {
          console.log('\n--- First 10 Questions Ingested ---');
          rows.forEach(r => {
            console.log(`Q${r.Question_Number} (ID: ${r.Question_ID}): ${r.Question_Text.substring(0, 100)}...`);
            console.log(`  Option A: ${r.Option_A}`);
            console.log(`  Option B: ${r.Option_B}`);
            console.log(`  Option C: ${r.Option_C}`);
            console.log(`  Option D: ${r.Option_D}`);
            console.log(`  Correct: ${r.Correct_Answer} | Image Present: ${r.Image_Present} | Image Path: ${r.Embedded_Image}`);
          });
        }
        db.close();
      }
    );
  });
});
