const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Production Bootstrap Seeding: Copy local DB and uploads to persistent volume if empty
if (process.env.NODE_ENV === 'production') {
  console.log('Production Mode: Verifying persistent storage mounts...');
  const bootstrapDbPath = path.resolve(__dirname, 'bootstrap_data/neet_pg_bank_v2.db');
  const bootstrapUploadDir = path.resolve(__dirname, 'bootstrap_data/uploads');
  const targetDbPath = process.env.DATABASE_PATH || '/data/neet_pg_bank_v2.db';
  const targetUploadDir = process.env.UPLOAD_DIR || '/data/uploads';

  // Ensure target directories exist
  const targetDbDir = path.dirname(targetDbPath);
  if (!fs.existsSync(targetDbDir)) {
    fs.mkdirSync(targetDbDir, { recursive: true });
  }
  if (!fs.existsSync(targetUploadDir)) {
    fs.mkdirSync(targetUploadDir, { recursive: true });
  }

  // Seed Database File
  const dbExists = fs.existsSync(targetDbPath);
  let dbSize = 0;
  if (dbExists) {
    try {
      dbSize = fs.statSync(targetDbPath).size;
    } catch (e) {
      dbSize = 0;
    }
  }

  if (fs.existsSync(bootstrapDbPath) && (!dbExists || dbSize < 100 * 1024)) {
    console.log('Production Bootstrap: Seeding local database file to persistent volume (empty/missing database detected)...');
    try {
      fs.copyFileSync(bootstrapDbPath, targetDbPath);
      console.log('Production Bootstrap: Database successfully seeded.');
    } catch (err) {
      console.error('Production Bootstrap ERROR: Failed to seed database:', err.message);
    }
  }

  // Seed Uploaded Files & Diagrams
  if (fs.existsSync(bootstrapUploadDir)) {
    const copyRecursive = (src, dest) => {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src).forEach(file => {
        const srcFile = path.join(src, file);
        const destFile = path.join(dest, file);
        if (fs.statSync(srcFile).isDirectory()) {
          copyRecursive(srcFile, destFile);
        } else if (!fs.existsSync(destFile)) {
          try {
            fs.copyFileSync(srcFile, destFile);
          } catch (err) {
            console.error(`Production Bootstrap ERROR: Failed to copy asset ${file}:`, err.message);
          }
        }
      });
    };
    console.log('Production Bootstrap: Seeding uploaded media assets to persistent volume...');
    copyRecursive(bootstrapUploadDir, targetUploadDir);
    console.log('Production Bootstrap: Uploaded assets successfully seeded.');
  }
}

const { dbQuery, initDatabase } = require('./config/database');
const { processPDFPipeline, enrichPendingQuestions, logToExecutionFile } = require('./services/processingEngine');
const { generateExcelWorkbook, generateTrendsExcelWorkbook } = require('./services/excelGenerator');

const app = express();
const PORT = process.env.PORT || 5000;

// Setup Middleware
app.use(cors());
app.use(express.json());

// Set static files mapping for uploaded images & visual media assets
const uploadDir = process.env.UPLOAD_DIR || path.resolve(__dirname, 'public/uploads');
app.use('/uploads', express.static(uploadDir));

// 1. Establish upload folder directories & multer config
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const fileExt = path.extname(file.originalname);
    cb(null, `${uuidv4()}${fileExt}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB size limit
  fileFilter: (req, file, cb) => {
    const fileExt = path.extname(file.originalname).toLowerCase();
    if (fileExt !== '.pdf') {
      return cb(new Error('Validation Failure: Supported format is PDF only!'), false);
    }
    cb(null, true);
  }
});

// Create central execution log file on initialization
const logDir = path.resolve(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const executionLogPath = path.join(logDir, 'execution.log');
if (!fs.existsSync(executionLogPath)) {
  fs.writeFileSync(executionLogPath, `[${new Date().toISOString()}] [INFO] [SYSTEM] Execution logger service initialized.\n`);
}

// ==========================================
// API ENDPOINTS (Module 6)
// ==========================================

/**
 * 1. POST /api/upload
 * Accepts PDF documents, registers file sizes and dates into SQLite history
 */
app.post('/api/upload', upload.array('pdfFiles'), async (req, res) => {
  const startTime = Date.now();
  if (!req.files || req.files.length === 0) {
    logToExecutionFile('ERROR', 'Upload request failed: No files submitted.');
    return res.status(400).json({ error: 'Please upload at least one PDF file.' });
  }

  const registeredUploads = [];
  
  try {
    for (const file of req.files) {
      const uploadId = uuidv4();
      const uploadDate = new Date().toISOString();
      const userId = 'system_user'; // Default demo user

      // Write historical ledger entry
      await dbQuery.run(`
        INSERT INTO UploadHistory (Upload_ID, User_ID, File_Name, File_Size, Upload_Date, Questions_Extracted, Processing_Status, File_Path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        uploadId,
        userId,
        file.originalname,
        file.size,
        uploadDate,
        0,
        'PENDING',
        file.path
      ]);

      logToExecutionFile('INFO', `File upload complete: ${file.originalname} registered in ledger. Size: ${file.size} bytes.`, uploadId);

      registeredUploads.push({
        uploadId,
        fileName: file.originalname,
        fileSize: file.size,
        filePath: file.path,
        uploadDate,
        status: 'PENDING'
      });
    }

    const duration = Date.now() - startTime;
    logToExecutionFile('INFO', `Upload request completed in ${duration}ms. Ingested ${registeredUploads.length} files.`);
    res.status(200).json({
      success: true,
      message: 'Files uploaded and metadata recorded successfully.',
      uploads: registeredUploads
    });

  } catch (error) {
    logToExecutionFile('ERROR', `File upload endpoint failed: ${error.message}`);
    res.status(500).json({ error: 'Internal system error processing uploads.' });
  }
});

/**
 * 2. POST /api/process
 * Triggers async parsing, image extraction, and OCR cleanings
 */
app.post('/api/process', async (req, res) => {
  const { uploadId } = req.body;
  
  if (!uploadId) {
    return res.status(400).json({ error: 'Request body must include an uploadId.' });
  }

  try {
    // Verify document history row exists
    const record = await dbQuery.get('SELECT * FROM UploadHistory WHERE Upload_ID = ?', [uploadId]);
    if (!record) {
      return res.status(404).json({ error: 'No matching file ledger record found.' });
    }

    if (record.Processing_Status === 'PROCESSING') {
      return res.status(400).json({ error: 'This file is already being processed.' });
    }

    // If retrying a FAILED upload, clean up any partial data from the previous attempt
    if (record.Processing_Status === 'FAILED') {
      logToExecutionFile('INFO', `Retrying FAILED upload — clearing previous partial data.`, uploadId);
      // Clean up any questions that were partially inserted in the failed run
      await dbQuery.run('DELETE FROM Images WHERE Question_ID IN (SELECT Question_ID FROM QuestionBank WHERE Upload_ID = ?)', [uploadId]);
      await dbQuery.run('DELETE FROM QuestionBank WHERE Upload_ID = ?', [uploadId]);
      await dbQuery.run('UPDATE UploadHistory SET Questions_Extracted = 0, Processing_Status = ? WHERE Upload_ID = ?', ['PENDING', uploadId]);
    }

    // Locate the uploaded physical file using the unique path recorded in the ledger
    const filePath = record.File_Path && fs.existsSync(record.File_Path) 
      ? record.File_Path 
      : path.join(uploadDir, 'demo_paper.pdf');

    // Trigger async processing pipeline so endpoint returns instantly
    processPDFPipeline(uploadId, filePath, record.File_Name)
      .catch(err => {
        logToExecutionFile('ERROR', `Async background parsing crashed: ${err.message}`, uploadId);
      });

    res.status(200).json({
      success: true,
      message: 'Processing started in the background.',
      uploadId,
      status: 'PROCESSING'
    });

  } catch (error) {
    logToExecutionFile('ERROR', `API process trigger crashed: ${error.message}`, uploadId);
    res.status(500).json({ error: 'Failed to initiate document processing.' });
  }
});

/**
 * 2b. POST /api/enrichPending
 * Triggers deferred batch enrichment for all pending questions (or a specific upload)
 */
app.post('/api/enrichPending', async (req, res) => {
  try {
    const { uploadId } = req.body;
    let geminiApiKey = null;
    const keyRecord = await dbQuery.get("SELECT Setting_Value FROM SystemSettings WHERE Setting_Key = 'gemini_api_key'");
    if (keyRecord && keyRecord.Setting_Value) {
      geminiApiKey = keyRecord.Setting_Value.trim();
    }

    if (!geminiApiKey) {
      return res.status(400).json({ error: 'Gemini API Key is missing. Please add it in settings.' });
    }

    // Trigger async processing pipeline so endpoint returns instantly
    enrichPendingQuestions(geminiApiKey, uploadId)
      .catch(err => {
        logToExecutionFile('ERROR', `Async background enrichment crashed: ${err.message}`, uploadId || 'BATCH');
      });

    res.status(200).json({
      success: true,
      message: 'Batch enrichment started in the background.'
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger batch enrichment.' });
  }
});

/**
 * 3. GET /api/processingStatus
 * Monitors ongoing parsing status of active queues
 */
app.get('/api/processingStatus', async (req, res) => {
  try {
    const history = await dbQuery.all('SELECT * FROM UploadHistory ORDER BY Upload_Date DESC');
    res.status(200).json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch ingestion history status.' });
  }
});

/**
 * 4. GET /api/questions
 * Returns filtered and paginated list of extracted items
 */
app.get('/api/questions', async (req, res) => {
  try {
    const { subject, difficulty, year, uploadId, search, hasImage, limit = 20, offset = 0 } = req.query;
    
    let query = `SELECT * FROM QuestionBank WHERE 1=1`;
    const params = [];
    
    if (uploadId && uploadId !== 'All') {
      query += ` AND Upload_ID = ?`;
      params.push(uploadId);
    }
    
    if (subject && subject !== 'All') {
      query += ` AND Subject = ?`;
      params.push(subject);
    }
    
    if (difficulty && difficulty !== 'All') {
      query += ` AND Difficulty_Level = ?`;
      params.push(difficulty);
    }

    if (year && year !== 'All') {
      query += ` AND Previous_Year = ?`;
      params.push(parseInt(year));
    }
    
    if (hasImage && hasImage !== 'All') {
      query += ` AND Image_Present = ?`;
      params.push(hasImage === 'true' ? 1 : 0);
    }
    
    if (search) {
      query += ` AND (Question_Text LIKE ? OR Option_A LIKE ? OR Option_B LIKE ? OR Option_C LIKE ? OR Option_D LIKE ? OR Keywords LIKE ?)`;
      const searchWild = `%${search}%`;
      params.push(searchWild, searchWild, searchWild, searchWild, searchWild, searchWild);
    }
    
    // Get total count for pagination headers
    const countQuery = query.replace('SELECT * FROM QuestionBank', 'SELECT COUNT(*) as count FROM QuestionBank');
    const totalCountRow = await dbQuery.get(countQuery, params);
    const totalCount = totalCountRow ? totalCountRow.count : 0;
    
    query += ` ORDER BY Question_Number ASC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));
    
    const questions = await dbQuery.all(query, params);
    
    res.status(200).json({
      questions,
      totalCount,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    res.status(500).json({ error: `Failed to retrieve question records: ${error.message}` });
  }
});

/**
 * 5. GET /api/question/{id}
 * Retrieves comprehensive detail of a specific question entity
 */
app.get('/api/question/:id', async (req, res) => {
  try {
    const question = await dbQuery.get('SELECT * FROM QuestionBank WHERE Question_ID = ?', [req.params.id]);
    if (!question) {
      return res.status(404).json({ error: 'Question not found.' });
    }
    
    const associatedImages = await dbQuery.all('SELECT * FROM Images WHERE Question_ID = ?', [req.params.id]);
    
    res.status(200).json({
      ...question,
      images: associatedImages
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load question details.' });
  }
});

/**
 * 6. GET /api/summary
 * Returns aggregated stats for dashboards
 */
app.get('/api/summary', async (req, res) => {
  try {
    const totalQuestionsRow = await dbQuery.get('SELECT COUNT(*) as count FROM QuestionBank');
    const totalQuestions = totalQuestionsRow ? totalQuestionsRow.count : 0;

    const subjects = await dbQuery.all(`
      SELECT Subject, COUNT(*) as count 
      FROM QuestionBank 
      GROUP BY Subject 
      ORDER BY count DESC
    `);
    
    const chapters = await dbQuery.all(`
      SELECT Chapter, COUNT(*) as count 
      FROM QuestionBank 
      GROUP BY Chapter 
      ORDER BY count DESC
    `);

    const imageCountRow = await dbQuery.get('SELECT COUNT(*) as count FROM QuestionBank WHERE Image_Present = 1');
    const imageCount = imageCountRow ? imageCountRow.count : 0;

    const confidenceStats = await dbQuery.all(`
      SELECT OCR_Confidence, COUNT(*) as count 
      FROM QuestionBank 
      GROUP BY OCR_Confidence
    `);

    const years = await dbQuery.all(`
      SELECT Previous_Year as year, COUNT(*) as count 
      FROM QuestionBank 
      WHERE Previous_Year IS NOT NULL 
      GROUP BY Previous_Year 
      ORDER BY Previous_Year DESC
    `);

    const uploads = await dbQuery.all(`
      SELECT Upload_ID as uploadId, File_Name as fileName 
      FROM UploadHistory 
      WHERE Processing_Status = 'COMPLETED'
      ORDER BY Upload_Date DESC
    `);

    res.status(200).json({
      totalQuestions,
      subjects,
      chapters,
      imageCount,
      confidenceStats,
      years,
      uploads
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compile statistics summary.' });
  }
});

/**
 * 6b. GET /api/trends/subject-matrix
 * Returns dynamic YoY subject distribution counts, totals, percentages, and summaries
 */
app.get('/api/trends/subject-matrix', async (req, res) => {
  try {
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
    yearTotalsRaw.forEach(row => { yearTotals[row.year] = row.total; });

    const imageTotalsRaw = await dbQuery.all(`
      SELECT Previous_Year as year, COUNT(*) as imageCount
      FROM QuestionBank
      WHERE Previous_Year IS NOT NULL AND (Image_Present = 1 OR Image_Present = 'true')
      GROUP BY Previous_Year
    `);
    const imageTotals = {};
    imageTotalsRaw.forEach(row => { imageTotals[row.year] = row.imageCount; });

    const clinicalTotalsRaw = await dbQuery.all(`
      SELECT Previous_Year as year, COUNT(*) as clinicalCount
      FROM QuestionBank
      WHERE Previous_Year IS NOT NULL AND Clinical_or_Conceptual = 'Clinical Scenario'
      GROUP BY Previous_Year
    `);
    const clinicalTotals = {};
    clinicalTotalsRaw.forEach(row => { clinicalTotals[row.year] = row.clinicalCount; });

    const yearsSet = new Set();
    const subjectsSet = new Set();
    rawData.forEach(row => {
      yearsSet.add(row.year);
      subjectsSet.add(row.Subject);
    });

    const years = Array.from(yearsSet).sort((a, b) => b - a);
    const subjects = Array.from(subjectsSet).sort();

    const pivotData = {};
    years.forEach(yr => {
      pivotData[yr] = {};
      subjects.forEach(subj => {
        pivotData[yr][subj] = { count: 0, percentage: 0 };
      });
    });

    rawData.forEach(row => {
      const yr = row.year;
      const subj = row.Subject;
      const cnt = row.count;
      const total = yearTotals[yr] || 0;
      const pct = total ? parseFloat(((cnt / total) * 100).toFixed(2)) : 0;
      if (pivotData[yr] && pivotData[yr][subj]) {
        pivotData[yr][subj] = { count: cnt, percentage: pct };
      }
    });

    const yearStats = {};
    years.forEach(yr => {
      const total = yearTotals[yr] || 0;
      const imgCount = imageTotals[yr] || 0;
      const imgPct = total ? parseFloat(((imgCount / total) * 100).toFixed(2)) : 0;
      const clinCount = clinicalTotals[yr] || 0;
      const clinPct = total ? parseFloat(((clinCount / total) * 100).toFixed(2)) : 0;
      yearStats[yr] = {
        total,
        imageCount: imgCount,
        imagePercentage: imgPct,
        clinicalCount: clinCount,
        clinicalPercentage: clinPct
      };
    });

    res.status(200).json({
      years,
      subjects,
      pivotData,
      yearStats,
      flatData: rawData.map(r => {
        const total = yearTotals[r.year] || 0;
        return {
          ...r,
          percentage: total ? parseFloat(((r.count / total) * 100).toFixed(2)) : 0
        };
      })
    });
  } catch (error) {
    res.status(500).json({ error: `Failed to compile YoY Trends Subject Matrix: ${error.message}` });
  }
});

/**
 * 6c. GET /api/trends/downloadExcel
 * Streams YoY subject distribution metrics to browser downloads
 */
app.get('/api/trends/downloadExcel', async (req, res) => {
  try {
    logToExecutionFile('INFO', `Assembling YoY Subject trends spreadsheet download.`);
    const workbook = await generateTrendsExcelWorkbook();
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=NEET_PG_YoY_Trends_${new Date().toISOString().split('T')[0]}.xlsx`
    );
    await workbook.xlsx.write(res);
    res.end();
    logToExecutionFile('INFO', `YoY Trends spreadsheet file successfully generated and piped to client.`);
  } catch (error) {
    logToExecutionFile('ERROR', `YoY Trends Excel generation failed: ${error.message}`);
    res.status(500).json({ error: `Trends spreadsheet compilation failed: ${error.message}` });
  }
});

/**
 * 7. GET /api/downloadExcel
 * Streams the generated 4-sheet dynamic Excel file to browser downloads
 */
app.get('/api/downloadExcel', async (req, res) => {
  try {
    const { uploadId } = req.query;
    
    logToExecutionFile('INFO', `Assembling spreadsheet download. Filter uploadId: ${uploadId || 'ALL'}`);
    
    const workbook = await generateExcelWorkbook(uploadId);
    
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=NEET_PG_QuestionBank_${new Date().toISOString().split('T')[0]}.xlsx`
    );
    
    await workbook.xlsx.write(res);
    res.end();
    
    logToExecutionFile('INFO', `Spreadsheet file successfully generated and piped to client.`);
  } catch (error) {
    logToExecutionFile('ERROR', `Excel generation endpoint failed: ${error.message}`);
    res.status(500).json({ error: `Spreadsheet compilation failed: ${error.message}` });
  }
});

/**
 * 8. GET /api/logs
 * Helper endpoint to stream backend execution logs to the React logs console
 */
app.get('/api/logs', (req, res) => {
  try {
    if (!fs.existsSync(executionLogPath)) {
      return res.status(200).json({ logs: [] });
    }
    
    const content = fs.readFileSync(executionLogPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() !== '');
    // Return last 100 log lines to avoid transferring massive chunks
    const recentLines = lines.slice(-100);
    res.status(200).json({ logs: recentLines });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read runtime logs.' });
  }
});

/**
 * 9. DELETE /api/question/:id
 * Removes a specific question record and deletes its associated physical image files
 */
app.delete('/api/question/:id', async (req, res) => {
  const { id } = req.params;
  try {
    logToExecutionFile('INFO', `Request to delete question: ${id}`);
    
    // Fetch associated physical images to unlink them
    const images = await dbQuery.all('SELECT * FROM Images WHERE Question_ID = ?', [id]);
    for (const img of images) {
      const filename = path.basename(img.Image_Path);
      const physicalPath = path.resolve(__dirname, 'public/uploads/images', filename);
      if (fs.existsSync(physicalPath)) {
        fs.unlinkSync(physicalPath);
        logToExecutionFile('INFO', `Unlinked physical image file: ${filename}`);
      }
    }
    
    const result = await dbQuery.run('DELETE FROM QuestionBank WHERE Question_ID = ?', [id]);
    
    if (result.changes > 0) {
      logToExecutionFile('INFO', `Successfully deleted question row from QuestionBank: ${id}`);
      res.status(200).json({ success: true, message: 'Question deleted successfully.' });
    } else {
      res.status(404).json({ error: 'Question not found.' });
    }
  } catch (error) {
    logToExecutionFile('ERROR', `Failed to delete question ${id}: ${error.message}`);
    res.status(500).json({ error: `Failed to delete question: ${error.message}` });
  }
});

/**
 * 10. DELETE /api/upload/:id
 * Safely unlinks the physical PDF, deletes all questions associated, and unlinks diagram files
 */
app.delete('/api/upload/:id', async (req, res) => {
  const { id } = req.params;
  try {
    logToExecutionFile('INFO', `Request to delete PDF upload package: ${id}`);
    
    const record = await dbQuery.get('SELECT * FROM UploadHistory WHERE Upload_ID = ?', [id]);
    if (!record) {
      return res.status(404).json({ error: 'Upload package not found.' });
    }
    
    // 1. Fetch questions associated with this upload to clean their physical diagrams
    const questions = await dbQuery.all('SELECT * FROM QuestionBank WHERE Upload_ID = ?', [id]);
    for (const q of questions) {
      const images = await dbQuery.all('SELECT * FROM Images WHERE Question_ID = ?', [q.Question_ID]);
      for (const img of images) {
        const filename = path.basename(img.Image_Path);
        const physicalPath = path.resolve(__dirname, 'public/uploads/images', filename);
        if (fs.existsSync(physicalPath)) {
          fs.unlinkSync(physicalPath);
          logToExecutionFile('INFO', `Unlinked physical diagram: ${filename} for question ${q.Question_ID}`);
        }
      }
    }
    
    // 2. Unlink physical PDF file if tracked
    if (record.File_Path && fs.existsSync(record.File_Path)) {
      fs.unlinkSync(record.File_Path);
      logToExecutionFile('INFO', `Unlinked physical PDF file: ${path.basename(record.File_Path)}`);
    } else {
      // Fallback: search in uploads folder if exact path is not recorded
      const uploadsDir = path.resolve(__dirname, 'public/uploads');
      if (fs.existsSync(uploadsDir)) {
        const files = fs.readdirSync(uploadsDir);
        for (const file of files) {
          if (file.toLowerCase().endsWith('.pdf') && (file.startsWith(id) || record.File_Name.includes(file))) {
            const fallbackPath = path.join(uploadsDir, file);
            fs.unlinkSync(fallbackPath);
            logToExecutionFile('INFO', `Unlinked fallback physical PDF file: ${file}`);
          }
        }
      }
    }
    
    // 3. Remove row (cascades automatically to delete questions and images database records!)
    await dbQuery.run('DELETE FROM UploadHistory WHERE Upload_ID = ?', [id]);
    
    logToExecutionFile('INFO', `Successfully deleted upload package ledger and all associated entities: ${id}`);
    res.status(200).json({ success: true, message: 'Upload package and associated questions deleted successfully.' });
  } catch (error) {
    logToExecutionFile('ERROR', `Failed to delete upload package ${id}: ${error.message}`);
    res.status(500).json({ error: `Failed to delete upload package: ${error.message}` });
  }
});

/**
 * 11. GET /api/settings/gemini_api_key
 * Checks database for API Key and returns a masked placeholder if present
 */
app.get('/api/settings/gemini_api_key', async (req, res) => {
  try {
    const row = await dbQuery.get('SELECT Setting_Value FROM SystemSettings WHERE Setting_Key = ?', ['gemini_api_key']);
    if (row && row.Setting_Value) {
      return res.status(200).json({ apiKeyExists: true, maskedKey: '****' });
    }
    res.status(200).json({ apiKeyExists: false, maskedKey: '' });
  } catch (error) {
    res.status(500).json({ error: `Failed to retrieve API key settings: ${error.message}` });
  }
});

/**
 * 12. POST /api/settings/gemini_api_key
 * Inserts or updates the Google Gemini API Key in the settings table
 */
app.post('/api/settings/gemini_api_key', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || apiKey.trim() === '') {
    return res.status(400).json({ error: 'Google Gemini API key cannot be empty.' });
  }
  try {
    await dbQuery.run(
      'INSERT OR REPLACE INTO SystemSettings (Setting_Key, Setting_Value) VALUES (?, ?)',
      ['gemini_api_key', apiKey.trim()]
    );
    logToExecutionFile('INFO', 'Google Gemini API Key successfully saved/updated in database.');
    res.status(200).json({ success: true, message: 'Google Gemini API key saved/updated successfully.' });
  } catch (error) {
    logToExecutionFile('ERROR', `Failed to save Google Gemini API Key: ${error.message}`);
    res.status(500).json({ error: `Failed to save API key: ${error.message}` });
  }
});

/**
 * 13. POST /api/auth/login
 * Validates the admin passcode against SystemSettings
 */
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Passcode is required.' });
  }
  try {
    const row = await dbQuery.get("SELECT Setting_Value FROM SystemSettings WHERE Setting_Key = 'admin_password'");
    const storedPassword = row ? row.Setting_Value : 'NeetPG2026!';
    if (password === storedPassword) {
      res.status(200).json({ success: true, token: 'session_token_neetpg' });
    } else {
      res.status(401).json({ error: 'Authentication Failed: Incorrect passcode!' });
    }
  } catch (error) {
    logToExecutionFile('ERROR', `Authentication endpoint error: ${error.message}`);
    res.status(500).json({ error: `Login error: ${error.message}` });
  }
});

/**
 * 14. POST /api/settings/admin_password
 * Updates the admin passcode in SystemSettings
 */
app.post('/api/settings/admin_password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new passcodes are required.' });
  }
  try {
    const row = await dbQuery.get("SELECT Setting_Value FROM SystemSettings WHERE Setting_Key = 'admin_password'");
    const storedPassword = row ? row.Setting_Value : 'NeetPG2026!';
    if (currentPassword !== storedPassword) {
      return res.status(400).json({ error: 'Validation Failure: Current passcode is incorrect!' });
    }
    await dbQuery.run(
      "INSERT OR REPLACE INTO SystemSettings (Setting_Key, Setting_Value) VALUES ('admin_password', ?)",
      [newPassword.trim()]
    );
    logToExecutionFile('INFO', 'Admin passcode successfully updated in database.');
    res.status(200).json({ success: true, message: 'Passcode successfully updated.' });
  } catch (error) {
    logToExecutionFile('ERROR', `Failed to update admin passcode: ${error.message}`);
    res.status(500).json({ error: `Failed to update passcode: ${error.message}` });
  }
});

// Global Error Handler for upload limits or system disruptions
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    logToExecutionFile('ERROR', `Multer disruption: ${err.message}`);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Validation Failure: Maximum allowed file size is 1GB!' });
    }
    return res.status(400).json({ error: err.message });
  } else if (err) {
    logToExecutionFile('ERROR', `System boundary failure: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
  next();
});

// Serve static client assets in production
const clientBuildDir = path.resolve(__dirname, 'client/dist');
if (fs.existsSync(clientBuildDir)) {
  console.log(`Production Mode: Serving static client files from ${clientBuildDir}`);
  app.use(express.static(clientBuildDir));
  app.get('*', (req, res, next) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      return res.sendFile(path.join(clientBuildDir, 'index.html'));
    }
    next();
  });
}

// Initialize database schema first, then activate express listener
initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(`NEET PG Processing Engine active on http://0.0.0.0:${PORT}`);
    console.log(`Press Ctrl+C to terminate execution.`);
    console.log(`==================================================`);
  });
}).catch(err => {
  console.error('Fatal initialization error: SQLite tables creation failed.', err);
});
