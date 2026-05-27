const fs = require('fs');
const path = require('path');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const { dbQuery } = require('../config/database');
const { classifyQuestion } = require('./classificationEngine');

// Ensure image upload directories exist
const imageDir = path.resolve(__dirname, '../public/uploads/images');
if (!fs.existsSync(imageDir)) {
  fs.mkdirSync(imageDir, { recursive: true });
}

// Log helper to write to server log file
function logToExecutionFile(level, message, uploadId = 'SYSTEM') {
  const logDir = path.resolve(__dirname, '../logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'execution.log');
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] [Upload: ${uploadId}] ${message}\n`;
  fs.appendFileSync(logPath, logLine);
}

// Simple sleep helper for rate-limit throttling
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Gemini API — used ONLY to generate question explanations
// Returns result object or null if it fails (caller uses placeholder)
// ─────────────────────────────────────────────────────────────────────────────
async function callGeminiForExplanation(apiKey, questionText, optA, optB, optC, optD, correctAns) {
  const promptText = `You are an expert medical professor preparing candidates for the NEET PG entrance exam.
Analyze the following NEET PG multiple-choice question, options, and correct answer:

Question: ${questionText}
Option A: ${optA}
Option B: ${optB}
Option C: ${optC}
Option D: ${optD}
Correct Answer Letter: ${correctAns}

Provide your analysis in JSON format with exactly the following fields:
{
  "explanation": "Detailed explanation explaining why the correct answer is correct and why others are wrong.",
  "subject": "Standard medical subject (e.g. Anatomy, Physiology, Biochemistry, Pathology, Microbiology, Pharmacology, Forensic Medicine, PSM, ENT, Ophthalmology, Medicine, Surgery, Obstetrics & Gynecology, Pediatrics, Psychiatry, Dermatology, Radiology, Anaesthesia, Orthopaedics)",
  "chapter": "Specific clinical chapter of the subject",
  "topic": "Specific medical topic under the chapter",
  "difficulty": "Easy, Medium, or Hard",
  "clinicalType": "Clinical Scenario, Conceptual, or Fact Recall",
  "questionType": "Clinical Scenario, Single Best Answer, Image Based, Assertion Reason, or Fact Recall",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}`;

  const payload = JSON.stringify({
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: { responseMimeType: 'application/json' }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    port: 443,
    path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const response = await httpsPost(options, payload);

  if (response.statusCode !== 200) {
    // Log the status but don't throw — caller uses placeholder
    return null;
  }

  try {
    const parsed = JSON.parse(response.body);
    const parts = parsed?.candidates?.[0]?.content?.parts;
    if (!parts || !parts[0] || !parts[0].text) return null;
    return JSON.parse(parts[0].text);
  } catch {
    return null;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Gemini Multimodal API — used ONLY when local text extraction fails
// Extracts question text/options/metadata from scanned PDF pages
// Returns array of question objects, or null if it fails
// ─────────────────────────────────────────────────────────────────────────────
// Helper: parse retryDelay seconds from a 429 Gemini error response body
function parseRetryDelay(body) {
  try {
    const parsed = JSON.parse(body);
    const details = parsed?.error?.details || [];
    for (const d of details) {
      if (d['@type'] && d['@type'].includes('RetryInfo') && d.retryDelay) {
        const match = d.retryDelay.match(/(\d+)/);
        if (match) return parseInt(match[1]) * 1000; // convert to ms
      }
    }
  } catch {}
  return 0;
}

// Helper: make a single HTTPS POST and return { statusCode, body }
function httpsPost(options, payload) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ statusCode: 0, body: e.message }));
    req.setTimeout(120000, () => { req.destroy(); resolve({ statusCode: 0, body: 'TIMEOUT' }); });
    req.write(payload);
    req.end();
  });
}

// Multimodal extraction — calls Gemini with the full PDF to extract question text/options
// Retries once on 429 if a retry delay is specified
async function callGeminiMultimodalForExtraction(apiKey, pdfBase64, uploadId) {
  const promptText = `You are an expert at reading medical exam PDFs.
Extract ALL multiple-choice questions from the attached PDF.
IMPORTANT: Copy the EXACT text as shown — do NOT paraphrase or generate new content.

For each question output a JSON object with these fields:
- questionNumber: integer (e.g. 1, 2, 3)
- pageNumber: integer (1-indexed page the question appears on)
- questionText: string (the question stem, exactly as written)
- optionA: string (option O1 text)
- optionB: string (option O2 text)
- optionC: string (option O3 text)
- optionD: string (option O4 text)
- correctAnswer: string — convert answer number to letter: "1"→"A", "2"→"B", "3"→"C", "4"→"D"
- subject: string (from "Subject:" line or classify)
- chapter: string (from "Topic:" line or classify)
- topic: string (from "Sub-Topic:" line or empty string)
- hasImage: boolean — true ONLY if the question shows a clinical photograph/diagram/X-ray
- imageDescription: string — if hasImage is true, briefly describe what the image depicts

Output a valid JSON array:
[
  {
    "questionNumber": 1,
    "pageNumber": 1,
    "questionText": "Identify the thickened nerve marked in the arrow in the image shown below:",
    "optionA": "Great auricular nerve",
    "optionB": "Lesser occipital nerve",
    "optionC": "Facial nerve",
    "optionD": "Auriculotemporal nerve",
    "correctAnswer": "A",
    "subject": "Anatomy",
    "chapter": "Head and Neck",
    "topic": "",
    "hasImage": true,
    "imageDescription": "Clinical photograph showing neck region with arrow pointing to a thickened nerve"
  }
]`;

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { text: promptText },
        { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }
      ]
    }],
    generationConfig: { responseMimeType: 'application/json' }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    port: 443,
    path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  // Attempt 1
  let response = await httpsPost(options, payload);
  logToExecutionFile('INFO', `Gemini multimodal response: HTTP ${response.statusCode}`, uploadId);

  // On 429, wait the specified retryDelay and try once more
  if (response.statusCode === 429) {
    const retryDelayMs = parseRetryDelay(response.body);
    if (retryDelayMs > 0 && retryDelayMs <= 90000) {
      logToExecutionFile('WARN',
        `Gemini 429 quota — waiting ${retryDelayMs / 1000}s and retrying...`, uploadId);
      await sleep(retryDelayMs + 2000); // extra 2s buffer
      response = await httpsPost(options, payload);
      logToExecutionFile('INFO', `Gemini multimodal retry response: HTTP ${response.statusCode}`, uploadId);
    } else {
      // Daily quota exhausted (no reasonable retry delay)
      logToExecutionFile('ERROR',
        `Gemini daily quota exhausted. Retry delay: ${retryDelayMs}ms. Response: ${response.body.substring(0, 300)}`, uploadId);
      return null;
    }
  }

  if (response.statusCode !== 200) {
    logToExecutionFile('ERROR',
      `Gemini multimodal failed HTTP ${response.statusCode}: ${response.body.substring(0, 300)}`, uploadId);
    return null;
  }

  try {
    const parsed = JSON.parse(response.body);
    const parts = parsed?.candidates?.[0]?.content?.parts;
    if (!parts || !parts[0] || !parts[0].text) {
      logToExecutionFile('WARN', 'Gemini multimodal: empty candidate response.', uploadId);
      return null;
    }
    const result = JSON.parse(parts[0].text);
    if (!Array.isArray(result)) {
      logToExecutionFile('WARN', 'Gemini multimodal: response was not a JSON array.', uploadId);
      return null;
    }
    return result;
  } catch (err) {
    logToExecutionFile('ERROR', `Gemini multimodal parse error: ${err.message}`, uploadId);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Watermark cleaning utility
// ─────────────────────────────────────────────────────────────────────────────
function cleanWatermarks(rawText) {
  if (!rawText) return '';
  let cleaned = rawText;
  const watermarkRegexes = [
    /www\.marrow\.com/gi,
    /www\.prepladder\.com/gi,
    /prepladder/gi,
    /t\.me\/[a-zA-Z0-9_]+/gi,
    /Downloaded\s+from\s+Telegram/gi,
    /Copyright\s+©\s+\w+/gi,
    /DAMS\s+Medical\s+Academy/gi,
    /Dr\.\s+Bhatia's\s+Medical\s+Institute/gi,
    /PrepLadder\s+-\s+Dream\s+Team/gi,
    /MARROW\s+-\s+Edition\s+\d+/gi,
    /For\s+personal\s+use\s+only\.\s+Unauthorized\s+sharing\s+is\s+prohibited/gi,
    /Page\s+\d+\s+of\s+\d+/gi,
    /NEET\s+PG\s+-\s+\d{4}\s+Memory\s+Based/gi
  ];
  watermarkRegexes.forEach(regex => { cleaned = cleaned.replace(regex, ''); });
  return cleaned.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the pageDiagramsMap from pdf-parse image extraction
// Returns Map<pageNumber, Array<imageObject>>
// Only non-watermark, non-banner images are included
// ─────────────────────────────────────────────────────────────────────────────
function buildPageDiagramsMap(imageResult, totalPagesCount, uploadId) {
  const pageDiagramsMap = new Map();
  if (!imageResult || !imageResult.pages) return pageDiagramsMap;

  // Count how many pages each image dimension appears on
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

  // Flag repeated dimensions as watermarks (≥2 pages AND ≥25% of total pages)
  const watermarkDims = new Set();
  Object.keys(dimFrequencies).forEach(dimKey => {
    const freq = dimFrequencies[dimKey];
    const isRepeated = totalPagesCount > 1
      ? (freq >= 2 && (freq / totalPagesCount) >= 0.25)
      : (dimKey === '1141_344' || dimKey === '1326_399');
    if (isRepeated) {
      watermarkDims.add(dimKey);
      logToExecutionFile('INFO',
        `Watermark dimension flagged: ${dimKey} (freq: ${freq}/${totalPagesCount})`, uploadId);
    }
  });

  // Also always exclude known PrepLadder/Marrow banner sizes
  const knownWatermarks = new Set(['1141_344', '1326_399', '1141_344', '1477_222']);

  // Build the map with filtered diagrams
  imageResult.pages.forEach(p => {
    const diagrams = p.images.filter(img => {
      const dimKey = `${img.width}_${img.height}`;
      // Skip if repeated watermark or known banner
      if (watermarkDims.has(dimKey) || knownWatermarks.has(dimKey)) return false;
      // Skip very small images (icons, bullets, tiny decorations < 100x100)
      if (img.width < 100 || img.height < 100) return false;
      // Skip very wide but short images (horizontal banners)
      if (img.height < 80) return false;
      return true;
    });

    if (diagrams.length > 0) {
      pageDiagramsMap.set(p.pageNumber, diagrams);
      logToExecutionFile('INFO',
        `Page ${p.pageNumber}: ${diagrams.length} clinical diagram(s) found`, uploadId);
    }
  });

  return pageDiagramsMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// Save a diagram to disk and return the web-accessible path
// ─────────────────────────────────────────────────────────────────────────────
function saveDiagramToDisk(questionId, imageData) {
  const physicalPath = path.join(imageDir, `${questionId}.png`);
  fs.writeFileSync(physicalPath, imageData);
  return `/uploads/images/${questionId}.png`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert one question + optional image record into the database
// ─────────────────────────────────────────────────────────────────────────────
async function insertQuestion(uploadId, params) {
  const {
    questionId, qNum, cleanText, optA, optB, optC, optD, correctAns,
    explanationText, subject, chapter, topic, difficulty, clinicalType,
    questionType, imagePresent, imagePath, imageDesc, imageType,
    pageNum, keywords, generationSource, year
  } = params;

  await dbQuery.run(`
    INSERT INTO QuestionBank (
      Question_ID, Upload_ID, Question_Number, Question_Text,
      Option_A, Option_B, Option_C, Option_D, Correct_Answer,
      Answer_Explanation, Subject, Chapter, Topic, Difficulty_Level,
      Clinical_or_Conceptual, Question_Type, Image_Present, Embedded_Image,
      Image_Description, Previous_Year, Page_Number, Keywords,
      Similarity_Group_ID, OCR_Confidence, Generation_Source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    questionId, uploadId, qNum, cleanText,
    optA, optB, optC, optD, correctAns,
    explanationText, subject, chapter, topic, difficulty,
    clinicalType, imagePresent ? 'Image Based' : questionType,
    imagePresent ? 1 : 0, imagePath, imageDesc, year, pageNum,
    keywords, uuidv4().substring(0, 8), 'High', generationSource
  ]);

  if (imagePresent && imagePath) {
    await dbQuery.run(`
      INSERT INTO Images (Image_ID, Question_ID, Image_Path, Image_Description, Image_Type)
      VALUES (?, ?, ?, ?, ?)
    `, [uuidv4(), questionId, imagePath, imageDesc, imageType]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrich a question with Gemini explanation
// Falls back to placeholder text gracefully — never throws
// ─────────────────────────────────────────────────────────────────────────────
async function enrichWithGemini(apiKey, qNum, cleanText, optA, optB, optC, optD,
    correctAns, classification, uploadId) {
  if (!apiKey) {
    return {
      explanation: `Explanation pending — Gemini API key not configured. This question covers ${classification.subject}: ${classification.chapter}.`,
      subject: classification.subject,
      chapter: classification.chapter,
      topic: classification.topic,
      difficulty: classification.difficulty,
      clinicalType: classification.clinicalType,
      questionType: classification.questionType,
      keywords: classification.keywords,
      source: 'Local Classifier'
    };
  }

  // Small throttle delay to respect rate limits
  await sleep(800);

  logToExecutionFile('INFO', `Enriching Q${qNum} explanation via Gemini...`, uploadId);
  const geminiData = await callGeminiForExplanation(
    apiKey, cleanText, optA, optB, optC, optD, correctAns
  );

  if (geminiData && geminiData.explanation) {
    logToExecutionFile('INFO', `Q${qNum} explanation enriched via Gemini.`, uploadId);
    return {
      explanation: geminiData.explanation,
      subject: geminiData.subject || classification.subject,
      chapter: geminiData.chapter || classification.chapter,
      topic: geminiData.topic || classification.topic,
      difficulty: geminiData.difficulty || classification.difficulty,
      clinicalType: geminiData.clinicalType || classification.clinicalType,
      questionType: geminiData.questionType || classification.questionType,
      keywords: Array.isArray(geminiData.keywords) ? geminiData.keywords : classification.keywords,
      source: 'Gemini AI'
    };
  }

  // Gemini failed — use placeholder, don't fail the job
  logToExecutionFile('WARN',
    `Q${qNum} Gemini explanation failed — using placeholder text.`, uploadId);
  return {
    explanation: `[AI Explanation Pending] This question on ${classification.subject} – ${classification.chapter} covers key NEET PG concepts. Manual review recommended. Correct answer: ${correctAns}.`,
    subject: classification.subject,
    chapter: classification.chapter,
    topic: classification.topic,
    difficulty: classification.difficulty,
    clinicalType: classification.clinicalType,
    questionType: classification.questionType,
    keywords: classification.keywords,
    source: 'Local Classifier'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PDF PROCESSING PIPELINE
//
// Strategy:
//   Path A (text-based PDF):
//     1. Local text extraction via pdf-parse
//     2. Parse Ques No / O1 / O2 / Ans blocks locally
//     3. Extract images locally (pdf-parse getImage)
//     4. Call Gemini ONLY for each question's explanation (fail gracefully)
//
//   Path B (scanned / image-based PDF):
//     1. pdf-parse getText returns no useful text
//     2. Local image extraction still works — build pageDiagramsMap
//     3. Call Gemini multimodal ONCE to extract question text/options (no explanation)
//     4. Then call Gemini text per question for explanation (fail gracefully)
//     5. If Gemini multimodal also fails — set FAILED status, no fake questions
// ─────────────────────────────────────────────────────────────────────────────
async function processPDFPipeline(uploadId, filePath, fileName) {
  const startTime = Date.now();
  logToExecutionFile('INFO', `Starting PDF processing: ${fileName}`, uploadId);

  try {
    // ── Load API key ──────────────────────────────────────────────────────────
    let geminiApiKey = null;
    try {
      const keyRecord = await dbQuery.get(
        "SELECT Setting_Value FROM SystemSettings WHERE Setting_Key = 'gemini_api_key'"
      );
      if (keyRecord && keyRecord.Setting_Value) {
        geminiApiKey = keyRecord.Setting_Value.trim();
        logToExecutionFile('INFO', 'Gemini API key loaded from system settings.', uploadId);
      }
    } catch (dbErr) {
      logToExecutionFile('WARN', `Could not load Gemini API key: ${dbErr.message}`, uploadId);
    }

    // ── Mark as PROCESSING ────────────────────────────────────────────────────
    await dbQuery.run(
      'UPDATE UploadHistory SET Processing_Status = ? WHERE Upload_ID = ?',
      ['PROCESSING', uploadId]
    );

    // ── Step 1: Load PDF and extract text + images locally ───────────────────
    logToExecutionFile('INFO', 'Loading PDF and extracting content locally...', uploadId);
    const { PDFParse } = require('pdf-parse');
    const dataBuffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: dataBuffer });

    const textResult = await parser.getText();
    const imageResult = await parser.getImage();
    await parser.destroy();

    const rawText = textResult.text || '';
    const totalPagesCount = imageResult.pages ? imageResult.pages.length : 0;

    logToExecutionFile('INFO',
      `Text extracted: ${rawText.length} chars. Pages with images: ${totalPagesCount}`, uploadId);

    // ── Step 2: Build diagram map from local image extraction ────────────────
    const pageDiagramsMap = buildPageDiagramsMap(imageResult, totalPagesCount, uploadId);
    logToExecutionFile('INFO',
      `Diagram map built. ${pageDiagramsMap.size} page(s) have clinical diagrams.`, uploadId);

    // ── Step 3: Try local text parsing (PATH A) ───────────────────────────────
    let extractedCount = 0;

    // Find page boundary positions in the raw text
    const pageRegex = /--\s*(\d+)\s*of\s*\d+\s*--/gi;
    let m;
    const pagePositions = [];
    while ((m = pageRegex.exec(rawText)) !== null) {
      pagePositions.push({ page: parseInt(m[1]), index: m.index });
    }

    // Find all "Ques No:" positions for page tracking
    const quesNoRegex = /Ques No:\s*/gi;
    const quesNoPositions = [];
    while ((m = quesNoRegex.exec(rawText)) !== null) {
      quesNoPositions.push(m.index);
    }

    // Clean text for splitting
    let cleanedText = rawText
      .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '')
      .replace(/PrepLadder/gi, '');

    const blocks = cleanedText.split(/Ques No:\s*/i);
    const hasTextQuestions = blocks.length > 1;

    if (hasTextQuestions) {
      // ─── PATH A: Text-based PDF ────────────────────────────────────────────
      logToExecutionFile('INFO',
        `PATH A: Found ${blocks.length - 1} question block(s) via text extraction.`, uploadId);

      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i].trim();
        if (!block) continue;

        // Determine page number using raw text position
        const rawPos = quesNoPositions[i - 1] || 0;
        let pageNum = 1;
        for (const pp of pagePositions) {
          if (pp.index < rawPos) pageNum = pp.page;
          else break;
        }

        const lines = block.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // Question number
        const qNumMatch = block.match(/^(\d+)/);
        if (!qNumMatch) continue;
        const qNum = parseInt(qNumMatch[1]);

        // Locate structural markers
        const o1Idx = lines.findIndex(l => /^O1:/i.test(l));
        const o2Idx = lines.findIndex(l => /^O2:/i.test(l));
        const o3Idx = lines.findIndex(l => /^O3:/i.test(l));
        const o4Idx = lines.findIndex(l => /^O4:/i.test(l));
        const ansIdx = lines.findIndex(l => /^Ans:/i.test(l));

        // Must have all 4 options and an answer to be a valid question
        if (o1Idx === -1 || o2Idx === -1 || o3Idx === -1 || o4Idx === -1 || ansIdx === -1) {
          logToExecutionFile('WARN', `Q${qNum} skipped — missing option/answer markers.`, uploadId);
          continue;
        }

        const subjectIdx = lines.findIndex(l => /^Subject:/i.test(l));
        const topicIdx = lines.findIndex(l => /^Topic:/i.test(l));
        const subTopicIdx = lines.findIndex(l => /^Sub-Topic:/i.test(l));

        const pdfSubject = subjectIdx !== -1 ? lines[subjectIdx].replace(/^Subject:/i, '').trim() : '';
        const pdfTopic = topicIdx !== -1 ? lines[topicIdx].replace(/^Topic:/i, '').trim() : '';
        const pdfSubTopic = subTopicIdx !== -1 ? lines[subTopicIdx].replace(/^Sub-Topic:/i, '').trim() : '';

        // Question text starts after Sub-Topic (or after first line if no header)
        const qTextStart = subTopicIdx !== -1 ? subTopicIdx + 1 : 1;
        const rawQText = lines.slice(qTextStart, o1Idx).join(' ');

        const optA = lines.slice(o1Idx + 1, o2Idx).join(' ').trim();
        const optB = lines.slice(o2Idx + 1, o3Idx).join(' ').trim();
        const optC = lines.slice(o3Idx + 1, o4Idx).join(' ').trim();
        const optD = lines.slice(o4Idx + 1, ansIdx).join(' ').trim();

        // Map "Ans: 1/2/3/4" → A/B/C/D
        const ansMatch = lines[ansIdx].match(/Ans:\s*(\d)/i);
        const ansMap = { '1': 'A', '2': 'B', '3': 'C', '4': 'D' };
        const correctAns = ansMatch ? (ansMap[ansMatch[1]] || 'A') : 'A';

        const questionId = uuidv4();
        const cleanText = cleanWatermarks(rawQText);

        // Local classification
        const classification = classifyQuestion(cleanText);
        if (pdfSubject) classification.subject = pdfSubject;
        if (pdfTopic) { classification.chapter = pdfTopic; classification.topic = pdfSubTopic || pdfTopic; }

        // Gemini enrichment for explanation only
        const enriched = await enrichWithGemini(
          geminiApiKey, qNum, cleanText, optA, optB, optC, optD,
          correctAns, classification, uploadId
        );

        // Check for actual diagram on this page
        const pageDiagrams = pageDiagramsMap.get(pageNum);
        const diagram = pageDiagrams && pageDiagrams.length > 0 ? pageDiagrams.shift() : null;

        let imagePath = null;
        let imagePresent = false;
        let imageDesc = null;

        if (diagram) {
          imagePath = saveDiagramToDisk(questionId, diagram.data);
          imagePresent = true;
          imageDesc = `Clinical diagram extracted from PDF Page ${pageNum} for Question ${qNum}`;
          logToExecutionFile('INFO',
            `Q${qNum}: diagram saved (${diagram.width}×${diagram.height}): ${imagePath}`, uploadId);
        }

        const imageType = /x-ray|radiograph/i.test(cleanText)
          ? 'X-Ray'
          : /histolog|biopsy|microscop/i.test(cleanText)
          ? 'Histopathology'
          : 'Clinical Diagram';

        // Also check if question text says "image below" / "figure" / "photograph"
        const textIndicatesImage = /image\s+below|figure\s+below|photograph|shown\s+below|shown\s+here/i.test(cleanText);
        if (textIndicatesImage && !imagePresent) {
          logToExecutionFile('WARN',
            `Q${qNum} text references an image but no diagram found on page ${pageNum}.`, uploadId);
        }

        await insertQuestion(uploadId, {
          questionId, qNum, cleanText, optA, optB, optC, optD, correctAns,
          explanationText: enriched.explanation,
          subject: enriched.subject,
          chapter: enriched.chapter,
          topic: enriched.topic,
          difficulty: enriched.difficulty,
          clinicalType: enriched.clinicalType,
          questionType: enriched.questionType,
          imagePresent, imagePath, imageDesc, imageType,
          pageNum,
          keywords: Array.isArray(enriched.keywords) ? enriched.keywords.join(', ') : '',
          generationSource: enriched.source,
          year: new Date().getFullYear()
        });

        extractedCount++;
        logToExecutionFile('INFO', `Q${qNum} saved to database (${enriched.source}).`, uploadId);
      }

    } else {
      // ─── PATH B: Scanned / image-based PDF ────────────────────────────────
      logToExecutionFile('INFO',
        'PATH B: No text found locally. Activating Gemini multimodal for question extraction...', uploadId);

      if (!geminiApiKey) {
        logToExecutionFile('ERROR',
          'Cannot process scanned PDF without Gemini API key. Please add your Gemini API key in Settings.', uploadId);
        await dbQuery.run(
          'UPDATE UploadHistory SET Processing_Status = ?, Questions_Extracted = 0 WHERE Upload_ID = ?',
          ['FAILED', uploadId]
        );
        return;
      }

      // Call Gemini multimodal ONCE to extract question structure (no explanation requested)
      const pdfBase64 = fs.readFileSync(filePath).toString('base64');
      logToExecutionFile('INFO', 'Sending PDF to Gemini for question text extraction...', uploadId);

      const geminiQuestions = await callGeminiMultimodalForExtraction(geminiApiKey, pdfBase64, uploadId);

      if (!geminiQuestions || geminiQuestions.length === 0) {
        logToExecutionFile('ERROR',
          'Gemini multimodal extraction returned no questions. Cannot process this PDF. ' +
          'Check your API quota and try again.', uploadId);
        await dbQuery.run(
          'UPDATE UploadHistory SET Processing_Status = ?, Questions_Extracted = 0 WHERE Upload_ID = ?',
          ['FAILED', uploadId]
        );
        return;
      }

      logToExecutionFile('INFO',
        `Gemini extracted ${geminiQuestions.length} question(s) from scanned PDF.`, uploadId);

      for (const q of geminiQuestions) {
        const questionId = uuidv4();
        const qNum = q.questionNumber || (extractedCount + 1);
        const cleanText = cleanWatermarks(q.questionText || '');
        const optA = (q.optionA || '').trim();
        const optB = (q.optionB || '').trim();
        const optC = (q.optionC || '').trim();
        const optD = (q.optionD || '').trim();
        const correctAns = q.correctAnswer || 'A';
        const pageNum = q.pageNumber || 1;

        if (!cleanText) {
          logToExecutionFile('WARN', `Q${qNum} skipped — empty question text from Gemini.`, uploadId);
          continue;
        }

        // Local classification using extracted text
        const classification = classifyQuestion(cleanText);
        if (q.subject) classification.subject = q.subject;
        if (q.chapter) classification.chapter = q.chapter;
        if (q.topic) classification.topic = q.topic;

        // Gemini enrichment for explanation ONLY (separate call per question)
        const enriched = await enrichWithGemini(
          geminiApiKey, qNum, cleanText, optA, optB, optC, optD,
          correctAns, classification, uploadId
        );

        // Check for actual diagram on this page from local image extraction
        const pageDiagrams = pageDiagramsMap.get(pageNum);
        const diagram = pageDiagrams && pageDiagrams.length > 0 ? pageDiagrams.shift() : null;

        let imagePath = null;
        let imagePresent = false;
        let imageDesc = null;

        if (diagram) {
          imagePath = saveDiagramToDisk(questionId, diagram.data);
          imagePresent = true;
          imageDesc = q.imageDescription ||
            `Clinical diagram extracted from PDF Page ${pageNum} for Question ${qNum}`;
          logToExecutionFile('INFO',
            `Q${qNum}: diagram saved (${diagram.width}×${diagram.height}): ${imagePath}`, uploadId);
        } else if (q.hasImage) {
          // Gemini says there's an image but we couldn't extract it
          // Mark as image present with description but no file path
          imagePresent = true;
          imageDesc = q.imageDescription || `Image referenced in Question ${qNum} on Page ${pageNum}`;
          logToExecutionFile('WARN',
            `Q${qNum} Gemini says image present but local extraction found none on page ${pageNum}.`, uploadId);
        }

        const imageType = /x-ray|radiograph/i.test(cleanText)
          ? 'X-Ray'
          : /histolog|biopsy|microscop/i.test(cleanText)
          ? 'Histopathology'
          : 'Clinical Diagram';

        await insertQuestion(uploadId, {
          questionId, qNum, cleanText, optA, optB, optC, optD, correctAns,
          explanationText: enriched.explanation,
          subject: enriched.subject,
          chapter: enriched.chapter,
          topic: enriched.topic,
          difficulty: enriched.difficulty,
          clinicalType: enriched.clinicalType,
          questionType: enriched.questionType,
          imagePresent, imagePath, imageDesc, imageType,
          pageNum,
          keywords: Array.isArray(enriched.keywords) ? enriched.keywords.join(', ') : '',
          generationSource: enriched.source,
          year: new Date().getFullYear()
        });

        extractedCount++;
        logToExecutionFile('INFO', `Q${qNum} saved to database (${enriched.source}).`, uploadId);
      }
    }

    // ── Final update ──────────────────────────────────────────────────────────
    await dbQuery.run(
      'UPDATE UploadHistory SET Questions_Extracted = ?, Processing_Status = ? WHERE Upload_ID = ?',
      [extractedCount, 'COMPLETED', uploadId]
    );

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logToExecutionFile('INFO',
      `Processing complete. Questions extracted: ${extractedCount}. Time: ${duration}s.`, uploadId);

  } catch (error) {
    logToExecutionFile('ERROR', `Pipeline failed: ${error.message}\n${error.stack}`, uploadId);
    await dbQuery.run(
      'UPDATE UploadHistory SET Processing_Status = ? WHERE Upload_ID = ?',
      ['FAILED', uploadId]
    );
    throw error;
  }
}

module.exports = {
  processPDFPipeline,
  cleanWatermarks,
  logToExecutionFile
};
