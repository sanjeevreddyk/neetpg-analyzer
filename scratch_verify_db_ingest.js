const sqlite3 = require('sqlite3').verbose();

const dbPath = 'c:\\Users\\himab\\OneDrive\\ドキュメント\\Neet_PG_Question_analysis\\neet_pg_bank_v2.db';

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Error opening DB:', err.message);
    return;
  }
  
  const uploadId = '4171e161-b019-48df-93ef-401cebdb7a93';
  
  db.get('SELECT COUNT(*) AS qCount FROM QuestionBank WHERE Upload_ID = ?', [uploadId], (err, row) => {
    console.log(`\n=== Verification for NEET-PG-Recall-2025.pdf (Upload ID: ${uploadId}) ===`);
    console.log(`Total Questions Ingested: ${row ? row.qCount : 0}`);
    
    db.get('SELECT COUNT(*) AS imgCount FROM QuestionBank WHERE Upload_ID = ? AND Image_Present = 1', [uploadId], (err, row2) => {
      console.log(`Total Image-Based Questions (Image_Present = 1): ${row2 ? row2.imgCount : 0}`);
      
      db.all(
        'SELECT Question_Number, Question_Text, Option_A, Option_B, Option_C, Option_D, Correct_Answer, Image_Present, Embedded_Image FROM QuestionBank WHERE Upload_ID = ? AND Image_Present = 1 ORDER BY Question_Number ASC LIMIT 5',
        [uploadId],
        (err, rows) => {
          console.log('\n--- First 5 Image-Based Questions Ingested ---');
          if (rows && rows.length > 0) {
            rows.forEach(r => {
              console.log(`Q${r.Question_Number}: ${r.Question_Text.substring(0, 120)}...`);
              console.log(`  Options: A: ${r.Option_A} | B: ${r.Option_B} | C: ${r.Option_C} | D: ${r.Option_D}`);
              console.log(`  Correct: ${r.Correct_Answer} | Image Path: ${r.Embedded_Image}`);
            });
          } else {
            console.log('No image-based questions found.');
          }
          
          db.close();
        }
      );
    });
  });
});
