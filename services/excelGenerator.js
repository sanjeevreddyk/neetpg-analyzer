const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { dbQuery } = require('../config/database');

/**
 * Excel Generation Engine (Module 5)
 * Compiles question statistics, extraction anomalies, and database records into
 * a highly polished, 4-tab styled spreadsheet utilizing ExcelJS.
 */
async function generateExcelWorkbook(uploadId = null) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NEET PG Processing System';
  workbook.lastModifiedBy = 'System Worker';
  workbook.created = new Date();
  
  // 1. Fetch data from SQLite database
  let questionsQuery = `SELECT * FROM QuestionBank`;
  let imagesQuery = `
    SELECT i.Image_ID, i.Question_ID, i.Image_Path, i.Image_Description, i.Image_Type, q.Question_Number, q.Subject
    FROM Images i
    JOIN QuestionBank q ON i.Question_ID = q.Question_ID
  `;
  const params = [];
  
  if (uploadId) {
    questionsQuery += ` WHERE Upload_ID = ?`;
    imagesQuery += ` WHERE q.Upload_ID = ?`;
    params.push(uploadId);
  }
  
  questionsQuery += ` ORDER BY Question_Number ASC`;
  
  const questions = await dbQuery.all(questionsQuery, params);
  const images = await dbQuery.all(imagesQuery, params);
  
  // Filter for OCR Issues (Medium or Low confidence)
  const ocrIssues = questions.filter(q => q.OCR_Confidence === 'Low' || q.OCR_Confidence === 'Medium');

  // Define Premium Color Styling variables
  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E1B4B' } // Deep indigo color
  };
  
  const headerFont = {
    name: 'Segoe UI',
    color: { argb: 'FFFFFFFF' },
    size: 11,
    bold: true
  };
  
  const sectionHeaderFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE0E7FF' } // Soft lavender
  };
  
  const borderStyle = {
    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
  };

  // ==========================================
  // SHEET 4: Summary (Let's make this the first tab so the user sees it immediately)
  // ==========================================
  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.views = [{ showGridLines: true }];
  
  summarySheet.columns = [
    { header: 'Metric Category', key: 'metric', width: 28 },
    { header: 'Value / Stat', key: 'value', width: 45 }
  ];
  
  // Format summary header row
  summarySheet.getRow(1).height = 26;
  summarySheet.getRow(1).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  // Calculate statistics
  const totalCount = questions.length;
  const imageCount = questions.filter(q => q.Image_Present === 1 || q.Image_Present === true).length;
  
  const highConfidenceCount = questions.filter(q => q.OCR_Confidence === 'High').length;
  const mediumConfidenceCount = questions.filter(q => q.OCR_Confidence === 'Medium').length;
  const lowConfidenceCount = questions.filter(q => q.OCR_Confidence === 'Low').length;
  
  // Count by subject
  const subjectMap = {};
  // Count by chapter
  const chapterMap = {};
  
  questions.forEach(q => {
    subjectMap[q.Subject] = (subjectMap[q.Subject] || 0) + 1;
    chapterMap[q.Chapter] = (chapterMap[q.Chapter] || 0) + 1;
  });

  // Populate Summary values
  summarySheet.addRow(['TOTAL EXTRACTED QUESTIONS', totalCount]);
  summarySheet.addRow(['IMAGE-BASED QUESTIONS', imageCount]);
  summarySheet.addRow(['OCR Confidence: High', `${highConfidenceCount} questions (${totalCount ? ((highConfidenceCount/totalCount)*100).toFixed(1) : 0}%)`]);
  summarySheet.addRow(['OCR Confidence: Medium', `${mediumConfidenceCount} questions (${totalCount ? ((mediumConfidenceCount/totalCount)*100).toFixed(1) : 0}%)`]);
  summarySheet.addRow(['OCR Confidence: Low', `${lowConfidenceCount} questions (${totalCount ? ((lowConfidenceCount/totalCount)*100).toFixed(1) : 0}%)`]);
  
  summarySheet.addRow([]); // Blank row
  
  // Section Header for Subject Statistics
  const subjectSectionRow = summarySheet.addRow(['QUESTIONS BY SUBJECT', '']);
  summarySheet.mergeCells(`A${subjectSectionRow.number}:B${subjectSectionRow.number}`);
  summarySheet.getCell(`A${subjectSectionRow.number}`).fill = sectionHeaderFill;
  summarySheet.getCell(`A${subjectSectionRow.number}`).font = { bold: true, color: { argb: 'FF1E1B4B' } };
  
  Object.entries(subjectMap).forEach(([subj, count]) => {
    summarySheet.addRow([subj, `${count} questions`]);
  });
  
  summarySheet.addRow([]); // Blank row

  // Section Header for Chapter Statistics
  const chapterSectionRow = summarySheet.addRow(['QUESTIONS BY CHAPTER', '']);
  summarySheet.mergeCells(`A${chapterSectionRow.number}:B${chapterSectionRow.number}`);
  summarySheet.getCell(`A${chapterSectionRow.number}`).fill = sectionHeaderFill;
  summarySheet.getCell(`A${chapterSectionRow.number}`).font = { bold: true, color: { argb: 'FF1E1B4B' } };
  
  Object.entries(chapterMap).forEach(([chap, count]) => {
    summarySheet.addRow([chap, `${count} questions`]);
  });

  // Apply visual styling to all cell boundaries on Summary sheet
  summarySheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    row.height = 20;
    row.eachCell(cell => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.border = borderStyle;
    });
  });

  // ==========================================
  // SHEET 1: QuestionBank
  // ==========================================
  const qSheet = workbook.addWorksheet('QuestionBank');
  qSheet.views = [{ showGridLines: true }];
  
  qSheet.columns = [
    { header: 'ID', key: 'Question_ID', width: 10 },
    { header: 'Q No', key: 'Question_Number', width: 8 },
    { header: 'Question Content Text', key: 'Question_Text', width: 50 },
    { header: 'Option A', key: 'Option_A', width: 20 },
    { header: 'Option B', key: 'Option_B', width: 20 },
    { header: 'Option C', key: 'Option_C', width: 20 },
    { header: 'Option D', key: 'Option_D', width: 20 },
    { header: 'Correct Answer', key: 'Correct_Answer', width: 15 },
    { header: 'Answer Explanation', key: 'Answer_Explanation', width: 40 },
    { header: 'Medical Subject', key: 'Subject', width: 18 },
    { header: 'Chapter', key: 'Chapter', width: 18 },
    { header: 'Topic', key: 'Topic', width: 18 },
    { header: 'Difficulty Level', key: 'Difficulty_Level', width: 15 },
    { header: 'Cognitive Domain', key: 'Clinical_or_Conceptual', width: 18 },
    { header: 'Question Type', key: 'Question_Type', width: 18 },
    { header: 'Image Present', key: 'Image_Present', width: 14 },
    { header: 'Question Image', key: 'Question_Image', width: 32 },
    { header: 'Generation Source', key: 'Generation_Source', width: 18 },
    { header: 'Confidence', key: 'OCR_Confidence', width: 12 },
    { header: 'Prev Year', key: 'Previous_Year', width: 10 }
  ];
  
  qSheet.getRow(1).height = 26;
  qSheet.getRow(1).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  questions.forEach(q => {
    const isImgPresent = q.Image_Present === 1 || q.Image_Present === true;
    const addedRow = qSheet.addRow({
      Question_ID: q.Question_ID.substring(0, 8),
      Question_Number: q.Question_Number,
      Question_Text: q.Question_Text,
      Option_A: q.Option_A,
      Option_B: q.Option_B,
      Option_C: q.Option_C,
      Option_D: q.Option_D,
      Correct_Answer: q.Correct_Answer,
      Answer_Explanation: q.Answer_Explanation,
      Subject: q.Subject,
      Chapter: q.Chapter,
      Topic: q.Topic,
      Difficulty_Level: q.Difficulty_Level,
      Clinical_or_Conceptual: q.Clinical_or_Conceptual,
      Question_Type: q.Question_Type,
      Image_Present: isImgPresent ? 'YES' : 'NO',
      Question_Image: isImgPresent ? '' : 'N/A', // Left empty to prevent text from overlapping behind the image
      Generation_Source: q.Generation_Source || 'Local Fallback',
      OCR_Confidence: q.OCR_Confidence,
      Previous_Year: q.Previous_Year
    });

    if (isImgPresent) {
      addedRow.height = 145; // 5 cm physical height allocation
      
      if (q.Embedded_Image) {
        try {
          const imageFilename = q.Embedded_Image.replace('/uploads/images/', '');
          const imagePath = path.resolve(__dirname, '../public/uploads/images/', imageFilename);
          
          if (fs.existsSync(imagePath)) {
            const excelImageId = workbook.addImage({
              filename: imagePath,
              extension: imageFilename.toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
            });
            
            qSheet.addImage(excelImageId, {
              tl: { col: 16, row: addedRow.number - 1, colOff: 100000, rowOff: 100000 },
              br: { col: 17, row: addedRow.number, colOff: -100000, rowOff: -100000 },
              editAs: 'oneCell'
            });
          }
        } catch (imgErr) {
          console.error(`Failed to embed diagram into Excel sheet cell: ${imgErr.message}`);
        }
      }
    } else {
      addedRow.height = 24;
    }
  });

  qSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    
    if (!row.height || row.height < 24) {
      row.height = 24;
    }
    
    row.eachCell(cell => {
      cell.font = { name: 'Segoe UI', size: 9 };
      cell.border = borderStyle;
      cell.alignment = { 
        vertical: 'middle', 
        horizontal: (cell.column === 17 || cell.column === 18) ? 'center' : 'left', 
        wrapText: true 
      };
    });
  });

  // ==========================================
  // SHEET 2: QuestionImages
  // ==========================================
  const imgSheet = workbook.addWorksheet('QuestionImages');
  imgSheet.views = [{ showGridLines: true }];
  
  imgSheet.columns = [
    { header: 'Image ID', key: 'Image_ID', width: 15 },
    { header: 'Question Number', key: 'Question_Number', width: 18 },
    { header: 'Subject', key: 'Subject', width: 20 },
    { header: 'Image Class Type', key: 'Image_Type', width: 22 },
    { header: 'Image Path File', key: 'Image_Path', width: 35 },
    { header: 'Embedded Description / Caption', key: 'Image_Description', width: 45 }
  ];
  
  imgSheet.getRow(1).height = 26;
  imgSheet.getRow(1).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  images.forEach(img => {
    imgSheet.addRow({
      Image_ID: img.Image_ID.substring(0, 8),
      Question_Number: img.Question_Number,
      Subject: img.Subject,
      Image_Type: img.Image_Type,
      Image_Path: img.Image_Path,
      Image_Description: img.Image_Description
    });
  });

  imgSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    row.height = 20;
    row.eachCell(cell => {
      cell.font = { name: 'Segoe UI', size: 9 };
      cell.border = borderStyle;
      cell.alignment = { vertical: 'middle' };
    });
  });

  // ==========================================
  // SHEET 3: OCRIssues
  // ==========================================
  const issueSheet = workbook.addWorksheet('OCRIssues');
  issueSheet.views = [{ showGridLines: true }];
  
  issueSheet.columns = [
    { header: 'Q No', key: 'Question_Number', width: 10 },
    { header: 'Subject', key: 'Subject', width: 18 },
    { header: 'Question Text Segment', key: 'Question_Text', width: 50 },
    { header: 'Confidence Tier', key: 'OCR_Confidence', width: 18 },
    { header: 'Audit Status / Verification Actions', key: 'action', width: 35 }
  ];
  
  issueSheet.getRow(1).height = 26;
  issueSheet.getRow(1).eachCell(cell => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF7F1D1D' } // Crimson Red for Issues/Alerts
    };
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  ocrIssues.forEach(q => {
    issueSheet.addRow({
      Question_Number: q.Question_Number,
      Subject: q.Subject,
      Question_Text: q.Question_Text,
      OCR_Confidence: q.OCR_Confidence,
      action: q.OCR_Confidence === 'Low' ? 'CRITICAL: Manual database text proofing required' : 'Review classification topics'
    });
  });

  issueSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    row.height = 22;
    row.eachCell(cell => {
      cell.font = { name: 'Segoe UI', size: 9 };
      cell.border = borderStyle;
      cell.alignment = { vertical: 'middle', wrapText: true };
    });
  });

  return workbook;
}

/**
 * YoY Trends Excel Generation Engine [NEW]
 * Compiles dynamic pivot matrix and flat list sheets for subject concentration analytics.
 */
async function generateTrendsExcelWorkbook() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NEET PG Processing System';
  workbook.lastModifiedBy = 'System Worker';
  workbook.created = new Date();
  
  // 1. Fetch data from SQLite database
  const rawData = await dbQuery.all(`
    SELECT Previous_Year as year, Subject, COUNT(*) as count
    FROM QuestionBank
    WHERE Previous_Year IS NOT NULL AND Subject IS NOT NULL AND Subject != ''
    GROUP BY Previous_Year, Subject
    ORDER BY Previous_Year DESC, count DESC
  `);

  const yearTotalsRaw = await dbQuery.all(`
    SELECT Previous_Year as year, COUNT(*) as total
    FROM QuestionBank
    WHERE Previous_Year IS NOT NULL
    GROUP BY Previous_Year
  `);
  const yearTotals = {};
  yearTotalsRaw.forEach(row => {
    yearTotals[row.year] = row.total;
  });

  const imageTotalsRaw = await dbQuery.all(`
    SELECT Previous_Year as year, COUNT(*) as imageCount
    FROM QuestionBank
    WHERE Previous_Year IS NOT NULL AND (Image_Present = 1 OR Image_Present = 'true')
    GROUP BY Previous_Year
  `);
  const imageTotals = {};
  imageTotalsRaw.forEach(row => {
    imageTotals[row.year] = row.imageCount;
  });

  const clinicalTotalsRaw = await dbQuery.all(`
    SELECT Previous_Year as year, COUNT(*) as clinicalCount
    FROM QuestionBank
    WHERE Previous_Year IS NOT NULL AND Clinical_or_Conceptual = 'Clinical Scenario'
    GROUP BY Previous_Year
  `);
  const clinicalTotals = {};
  clinicalTotalsRaw.forEach(row => {
    clinicalTotals[row.year] = row.clinicalCount;
  });

  // Extract distinct years and subjects
  const yearsSet = new Set();
  const subjectsSet = new Set();
  rawData.forEach(row => {
    yearsSet.add(row.year);
    subjectsSet.add(row.Subject);
  });

  const years = Array.from(yearsSet).sort((a, b) => b - a);
  const subjects = Array.from(subjectsSet).sort();

  // Color theme definitions
  const headerFill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E1B4B' } // Deep Indigo
  };
  const headerFont = {
    name: 'Segoe UI',
    color: { argb: 'FFFFFFFF' },
    size: 11,
    bold: true
  };
  const borderStyle = {
    top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
    right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
  };

  // ==========================================
  // SHEET 1: YoY Subject Pivot
  // ==========================================
  const pSheet = workbook.addWorksheet('YoY Subject Pivot');
  pSheet.views = [{ showGridLines: true }];

  const pivotColumns = [
    { header: 'Year', key: 'year', width: 12 }
  ];
  subjects.forEach(subj => {
    pivotColumns.push({ header: subj, key: subj, width: 22 });
  });
  pivotColumns.push(
    { header: 'Total Questions', key: 'total', width: 18 },
    { header: 'Image Questions (Count / %)', key: 'images', width: 26 },
    { header: 'Clinical Questions (Count / %)', key: 'clinical', width: 28 }
  );

  pSheet.columns = pivotColumns;

  // Format header row
  pSheet.getRow(1).height = 28;
  pSheet.getRow(1).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });

  // Populate dynamic matrix row by row
  years.forEach(yr => {
    const rowData = { year: yr };
    const total = yearTotals[yr] || 0;

    // Initialize all dynamic subject counts to zero placeholder
    subjects.forEach(subj => {
      rowData[subj] = '0 (0.00%)';
    });

    // Merge actual counted data
    rawData.filter(r => r.year === yr).forEach(r => {
      const pct = total ? ((r.count / total) * 100).toFixed(2) : '0.00';
      rowData[r.Subject] = `${r.count} (${pct}%)`;
    });

    rowData.total = total;

    const imgCount = imageTotals[yr] || 0;
    const imgPct = total ? ((imgCount / total) * 100).toFixed(2) : '0.00';
    rowData.images = `${imgCount} (${imgPct}%)`;

    const clinCount = clinicalTotals[yr] || 0;
    const clinPct = total ? ((clinCount / total) * 100).toFixed(2) : '0.00';
    rowData.clinical = `${clinCount} (${clinPct}%)`;

    pSheet.addRow(rowData);
  });

  pSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    row.height = 24;
    row.eachCell(cell => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.border = borderStyle;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      
      // Bold critical columns
      if (cell.column === 1 || cell.column === pSheet.columns.length - 2) {
        cell.font = { name: 'Segoe UI', size: 10, bold: true };
      }
    });
  });

  // ==========================================
  // SHEET 2: YoY Flat List
  // ==========================================
  const fSheet = workbook.addWorksheet('YoY Flat List');
  fSheet.views = [{ showGridLines: true }];
  
  fSheet.columns = [
    { header: 'Year', key: 'year', width: 12 },
    { header: 'Subject', key: 'subject', width: 25 },
    { header: 'Number of Questions', key: 'count', width: 22 },
    { header: 'Concentration % in Year', key: 'percentage', width: 25 }
  ];

  fSheet.getRow(1).height = 26;
  fSheet.getRow(1).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  rawData.forEach(row => {
    const yr = row.year;
    const total = yearTotals[yr] || 0;
    const percentage = total ? parseFloat(((row.count / total) * 100).toFixed(2)) : 0;
    fSheet.addRow({
      year: yr,
      subject: row.Subject,
      count: row.count,
      percentage: `${percentage}%`
    });
  });

  fSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    row.height = 20;
    row.eachCell(cell => {
      cell.font = { name: 'Segoe UI', size: 10 };
      cell.border = borderStyle;
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
  });

  return workbook;
}

module.exports = {
  generateExcelWorkbook,
  generateTrendsExcelWorkbook
};
