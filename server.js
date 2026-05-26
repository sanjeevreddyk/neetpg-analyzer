const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { dbQuery, initDatabase } = require('./config/database');
const { processPDFPipeline, logToExecutionFile } = require('./services/processingEngine');
const { generateExcelWorkbook } = require('./services/excelGenerator');

const app = express();
const PORT = process.env.PORT || 5000;

// Setup Middleware
app.use(cors());
app.use(express.json());

// Set static files mapping for uploaded images & visual media assets
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// 1. Establish upload folder directories & multer config
const uploadDir = path.resolve(__dirname, 'public/uploads');
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
    const { subject, difficulty, year, search, limit = 20, offset = 0 } = req.query;
    
    let query = `SELECT * FROM QuestionBank WHERE 1=1`;
    const params = [];
    
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

    res.status(200).json({
      totalQuestions,
      subjects,
      chapters,
      imageCount,
      confidenceStats,
      years
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compile statistics summary.' });
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

// Initialize database schema first, then activate express listener
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`NEET PG Processing Engine active on http://localhost:${PORT}`);
    console.log(`Press Ctrl+C to terminate execution.`);
    console.log(`==================================================`);
  });
}).catch(err => {
  console.error('Fatal initialization error: SQLite tables creation failed.', err);
});
