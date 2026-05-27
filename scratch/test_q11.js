const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const dbPath = 'c:\\Users\\himab\\OneDrive\\ドキュメント\\Neet_PG_Question_analysis\\neet_pg_bank_v2.db';

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('Error opening DB:', err.message);
    return;
  }
  
  db.get('SELECT File_Path, File_Name FROM UploadHistory WHERE File_Name LIKE "%2025%" ORDER BY Upload_Date DESC LIMIT 1', [], async (err, upload) => {
    if (err || !upload) {
      console.error('Failed to get 2025 upload path:', err || 'No upload found');
      db.close();
      return;
    }
    
    console.log(`Found 2025 Upload: ${upload.File_Name} at ${upload.File_Path}`);
    const filePath = path.resolve(__dirname, '../', upload.File_Path);
    
    if (!fs.existsSync(filePath)) {
      console.error(`File does not exist at: ${filePath}`);
      db.close();
      return;
    }
    
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });
    
    const textResult = await parser.getText();
    const imageResult = await parser.getImage();
    await parser.destroy();
    
    // Page 12 (1-indexed)
    const pageNum = 12;
    const pageImageObj = imageResult.pages.find(p => p.pageNumber === pageNum);
    console.log(`\n=== Images on Page ${pageNum} ===`);
    if (pageImageObj && pageImageObj.images) {
      console.log(`Total images extracted by pdf-parse on page ${pageNum}: ${pageImageObj.images.length}`);
      pageImageObj.images.forEach((img, idx) => {
        console.log(`  Img ${idx}: ${img.width}x${img.height} (Data length: ${img.data.length})`);
      });
    } else {
      console.log(`No images found on page ${pageNum}`);
    }
    
    // Let's print out what buildPageDiagramsMap produces for Page 12
    const totalPages = imageResult.pages.length;
    const dimFrequencies = {};
    imageResult.pages.forEach(p => {
      const seenDims = new Set();
      p.images.forEach(img => {
        const dimKey = `${img.width}_${img.height}`;
        seenDims.add(dimKey);
      });
      seenDims.forEach(dimKey => {
        dimFrequencies[dimKey] = (dimFrequencies[dimKey] || 0) + 1;
      });
    });

    const watermarkDims = new Set();
    Object.keys(dimFrequencies).forEach(dimKey => {
      const freq = dimFrequencies[dimKey];
      const isRepeated = totalPages > 2 ? ((freq / totalPages) >= 0.85) : false;
      if (isRepeated) watermarkDims.add(dimKey);
    });

    const knownWatermarks = new Set(['1141_344', '1326_399', '1477_222']);
    
    if (pageImageObj && pageImageObj.images) {
      const filtered = pageImageObj.images.filter(img => {
        const dimKey = `${img.width}_${img.height}`;
        if (watermarkDims.has(dimKey) || knownWatermarks.has(dimKey)) return false;
        if (img.width < 40 || img.height < 40) return false;
        return true;
      });
      console.log(`\nFiltered diagrams on page ${pageNum} (min size 40x40, no watermarks): ${filtered.length}`);
      filtered.forEach((img, idx) => {
        console.log(`  Diag ${idx}: ${img.width}x${img.height}`);
      });
    }
    
    db.close();
  });
});
