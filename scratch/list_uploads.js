const sqlite3 = require('sqlite3').verbose();
const dbPath = 'c:\\Users\\himab\\OneDrive\\ドキュメント\\Neet_PG_Question_analysis\\neet_pg_bank_v2.db';

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Error opening DB:', err.message);
    return;
  }
  
  db.all('SELECT Upload_ID, File_Name, Upload_Date, Questions_Extracted, Processing_Status FROM UploadHistory ORDER BY Upload_Date DESC', [], (err, rows) => {
    if (err) {
      console.error('Error querying UploadHistory:', err);
    } else {
      console.log('\n=== All Uploads ===');
      rows.forEach(r => {
        console.log(`- ${r.File_Name} (ID: ${r.Upload_ID}) on ${r.Upload_Date}`);
        console.log(`  Extracted: ${r.Questions_Extracted} | Status: ${r.Processing_Status}`);
      });
    }
    db.close();
  });
});
