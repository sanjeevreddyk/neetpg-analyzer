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
async function callGeminiForExplanation(apiKey, cleanText, optA, optB, optC, optD, correctAns) {
  const promptText = `You are an expert medical professor preparing candidates for the NEET PG entrance exam.
Analyze the following NEET PG multiple-choice question.

Question: ${cleanText}
Option A: ${optA}
Option B: ${optB}
Option C: ${optC}
Option D: ${optD}
Correct Answer Letter: ${correctAns}

Provide your analysis in a valid JSON object with exactly the following fields:
{
  "explanation": "Provide a very brief, high-yield rationale. You MUST limit your explanation to a maximum of 70 to 80 words.",
  "subject": "Standard medical subject (e.g. Anatomy, Physiology, Pathology, etc.)",
  "chapter": "Specific clinical chapter of the subject",
  "topic": "Specific medical topic under the chapter",
  "difficulty": "Easy, Medium, or Hard",
  "clinicalType": "Clinical Scenario, Conceptual, or Fact Recall",
  "questionType": "Clinical Scenario, Single Best Answer, Image Based, Assertion Reason, or Fact Recall",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

Output ONLY a valid JSON object.`;

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

  if (response.statusCode === 429) {
    const retryDelayMs = parseRetryDelay(response.body);
    if (retryDelayMs > 0 && retryDelayMs <= 90000) {
      logToExecutionFile('WARN', `Gemini 429 quota in single enrich — waiting ${retryDelayMs / 1000}s...`, 'SINGLE');
      await sleep(retryDelayMs + 2000);
      return callGeminiForExplanation(apiKey, cleanText, optA, optB, optC, optD, correctAns); // Retry once
    } else {
      logToExecutionFile('ERROR', `Gemini daily quota exhausted during single enrichment.`, 'SINGLE');
      return null;
    }
  }

  if (response.statusCode !== 200) {
    logToExecutionFile('ERROR', `Single enrichment failed HTTP ${response.statusCode}: ${response.body.substring(0, 300)}`, 'SINGLE');
    return null;
  }

  try {
    const parsed = JSON.parse(response.body);
    const parts = parsed?.candidates?.[0]?.content?.parts;
    if (!parts || !parts[0] || !parts[0].text) return null;
    const result = JSON.parse(parts[0].text);
    return result && typeof result === 'object' ? result : null;
  } catch (err) {
    logToExecutionFile('ERROR', `Single enrichment parse error: ${err.message}`, 'SINGLE');
    return null;
  }
}

async function callGeminiForExplanationBatch(apiKey, questionsArray, uploadId = 'BATCH') {
  if (!questionsArray || questionsArray.length === 0) return [];

  const questionsFormatted = questionsArray.map((q, idx) => `
--- Question Index: ${idx} ---
Question: ${q.Question_Text}
Option A: ${q.Option_A}
Option B: ${q.Option_B}
Option C: ${q.Option_C}
Option D: ${q.Option_D}
Correct Answer Letter: ${q.Correct_Answer}
`).join('\n');

  const promptText = `You are an expert medical professor preparing candidates for the NEET PG entrance exam.
Analyze the following batch of NEET PG multiple-choice questions.

${questionsFormatted}

For each question, provide your analysis in a JSON array. Each object in the array must have exactly the following fields:
{
  "questionIndex": [The integer index matching the question above],
  "explanation": "Provide a very brief, high-yield rationale. You MUST limit your explanation to a maximum of 70 to 80 words per question.",
  "subject": "Standard medical subject (e.g. Anatomy, Physiology, Pathology, etc.)",
  "chapter": "Specific clinical chapter of the subject",
  "topic": "Specific medical topic under the chapter",
  "difficulty": "Easy, Medium, or Hard",
  "clinicalType": "Clinical Scenario, Conceptual, or Fact Recall",
  "questionType": "Clinical Scenario, Single Best Answer, Image Based, Assertion Reason, or Fact Recall",
  "keywords": ["keyword1", "keyword2", "keyword3"]
}

Output ONLY a valid JSON array of these objects.`;

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

  if (response.statusCode === 429) {
    const retryDelayMs = parseRetryDelay(response.body);
    if (retryDelayMs > 0 && retryDelayMs <= 90000) {
      logToExecutionFile('WARN', `Gemini 429 quota in batch enrich — waiting ${retryDelayMs / 1000}s...`, uploadId);
      await sleep(retryDelayMs + 2000);
      return callGeminiForExplanationBatch(apiKey, questionsArray, uploadId); // Retry once
    } else {
      logToExecutionFile('ERROR', `Gemini daily quota exhausted during batch enrichment.`, uploadId);
      return null;
    }
  }

  if (response.statusCode !== 200) {
    logToExecutionFile('ERROR', `Batch enrichment failed HTTP ${response.statusCode}: ${response.body.substring(0, 300)}`, uploadId);
    return null;
  }

  try {
    const parsed = JSON.parse(response.body);
    const parts = parsed?.candidates?.[0]?.content?.parts;
    if (!parts || !parts[0] || !parts[0].text) return null;
    const result = JSON.parse(parts[0].text);
    return Array.isArray(result) ? result : null;
  } catch (err) {
    logToExecutionFile('ERROR', `Batch enrichment parse error: ${err.message}`, uploadId);
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

  // Flag repeated dimensions as watermarks (≥85% of total pages)
  // We use 85% because publishers often resize clinical images to exact same dimensions,
  // which was causing valid images to be flagged as watermarks with the old 25% threshold.
  const watermarkDims = new Set();
  Object.keys(dimFrequencies).forEach(dimKey => {
    const freq = dimFrequencies[dimKey];
    const isRepeated = totalPagesCount > 2
      ? ((freq / totalPagesCount) >= 0.85)
      : false;
    if (isRepeated || dimKey === '1141_344' || dimKey === '1326_399' || dimKey === '1477_222') {
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
      // Skip very small images (icons, bullets, tiny decorations < 40x40)
      if (img.width < 40 || img.height < 40) return false;
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

// Helper: Extract diagram checking current page range and fallback to previous page
function extractDiagramForQuestionRange(startPage, endPage, pageDiagramsMap) {
  const pagesToCheck = [];
  for (let p = startPage; p <= endPage; p++) {
    pagesToCheck.push(p);
  }
  pagesToCheck.push(startPage - 1); // fallback for images placed right before the question text

  for (const p of pagesToCheck) {
    if (p < 1) continue;
    const diagrams = pageDiagramsMap.get(p);
    if (diagrams && diagrams.length > 0) {
      return diagrams.shift();
    }
  }
  return null;
}

// Helper: Compute image affinity score to match diagrams accurately in Path A
function computeImageAffinityScore(text) {
  let score = 0;
  const lowerText = text.toLowerCase();

  const strongPhrases = [
    'image shown below', 'image below', 'shown in the image', 'picture below',
    'figure below', 'diagram below', 'as shown in the', 'marked as a in the',
    'histology of the tissue is as given', 'histopathology finding as shown',
    'microscopic appearance', 'x-ray shown', 'scan shown', 'ct scan of a',
    'mri shows', 'ct shows', 'mri of a', 'ultrasound of a', 'arrows point to',
    'arrow in the image', 'marked in the arrow', 'arrow points to', 'arrow in the diagram',
    'indicated by the arrow', 'marked with blue arrow', 'picture of his eye has been provided',
    'lesions as shown below', 'specimen was retrieved', 'specimen shown',
    'represented in the image', 'identify the mallampati class', 'identify the structure marked',
    'identify the condition', 'cells seen in the lymph node are indicative of',
    'following instrument is used'
  ];

  for (const phrase of strongPhrases) {
    if (lowerText.includes(phrase)) {
      score += 15;
    }
  }

  const mediumKeywords = [
    { regex: /\bimage\b/i, weight: 8 },
    { regex: /\bfigure\b/i, weight: 8 },
    { regex: /\bphotograph\b/i, weight: 8 },
    { regex: /\bpicture\b/i, weight: 8 },
    { regex: /\bdiagram\b/i, weight: 8 },
    { regex: /\barrow\b/i, weight: 6 },
    { regex: /\bmarked\b/i, weight: 5 },
    { regex: /\bshown\b/i, weight: 4 },
    { regex: /\bscan\b/i, weight: 6 },
    { regex: /\bx-ray\b/i, weight: 8 },
    { regex: /\bradiograph\b/i, weight: 8 },
    { regex: /\bct\b/i, weight: 6 },
    { regex: /\bmri\b/i, weight: 6 },
    { regex: /\bultrasound\b/i, weight: 8 },
    { regex: /\bspecimen\b/i, weight: 8 },
    { regex: /\binstrument\b/i, weight: 10 },
    { regex: /\bhistopathology\b/i, weight: 8 },
    { regex: /\bhistology\b/i, weight: 8 },
    { regex: /\bmicroscopic\b/i, weight: 6 },
    { regex: /\bbiopsy\b/i, weight: 6 }
  ];

  for (const { regex, weight } of mediumKeywords) {
    if (regex.test(lowerText)) {
      score += weight;
    }
  }

  const weakKeywords = [
    { regex: /\bdiagnosis\b/i, weight: 2 },
    { regex: /\bidentify\b/i, weight: 2 },
    { regex: /\blesion\b/i, weight: 2 },
    { regex: /\bcondition\b/i, weight: 1 },
    { regex: /\bpatient\b/i, weight: 1 },
    { regex: /\bpresentation\b/i, weight: 1 }
  ];

  for (const { regex, weight } of weakKeywords) {
    if (regex.test(lowerText)) {
      score += weight;
    }
  }

  // Short question boost
  if (lowerText.length < 50 && (/\bdiagnosis\b/i.test(lowerText) || /\bidentify\b/i.test(lowerText) || /\bcondition\b/i.test(lowerText) || /\binstrument\b/i.test(lowerText))) {
    score += 6;
  }

  return score;
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
// Save option visual graphics to disk and return paths
// ─────────────────────────────────────────────────────────────────────────────
function saveOptionImageToDisk(questionId, optionLetter, imageData) {
  const physicalPath = path.join(imageDir, `${questionId}_opt${optionLetter}.png`);
  fs.writeFileSync(physicalPath, imageData);
  return `/uploads/images/${questionId}_opt${optionLetter}.png`;
}

function hasNoTextOptions(q) {
  const cleanA = (q.optA || '').replace(/‹\/?B›/g, '').trim().toLowerCase();
  const cleanB = (q.optB || '').replace(/‹\/?B›/g, '').trim().toLowerCase();
  const cleanC = (q.optC || '').replace(/‹\/?B›/g, '').trim().toLowerCase();
  
  const isEmptyA = cleanA === '' || cleanA === 'refer to image';
  const isEmptyB = cleanB === '' || cleanB === 'refer to image';
  const isEmptyC = cleanC === '' || cleanC === 'refer to image';
  
  return isEmptyA && isEmptyB && isEmptyC;
}


// ─────────────────────────────────────────────────────────────────────────────
// Insert one question + optional image record into the database
// ─────────────────────────────────────────────────────────────────────────────
async function insertQuestion(uploadId, params) {
  const {
    questionId, qNum, cleanText, optA, optB, optC, optD, correctAns,
    explanationText, subject, chapter, topic, difficulty, clinicalType,
    questionType, imagePresent, imagePath, imageDesc, imageType,
    pageNum, keywords, generationSource, year, geminiEnriched
  } = params;

  await dbQuery.run(`
    INSERT INTO QuestionBank (
      Question_ID, Upload_ID, Question_Number, Question_Text,
      Option_A, Option_B, Option_C, Option_D, Correct_Answer,
      Answer_Explanation, Subject, Chapter, Topic, Difficulty_Level,
      Clinical_or_Conceptual, Question_Type, Image_Present, Embedded_Image,
      Image_Description, Previous_Year, Page_Number, Keywords,
      Similarity_Group_ID, OCR_Confidence, Generation_Source, Gemini_Enriched
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    questionId, uploadId, qNum, cleanText,
    optA, optB, optC, optD, correctAns,
    explanationText, subject, chapter, topic, difficulty,
    clinicalType, imagePresent ? 'Image Based' : questionType,
    imagePresent ? 1 : 0, imagePath, imageDesc, year, pageNum,
    keywords, uuidv4().substring(0, 8), 'High', generationSource, geminiEnriched ? 1 : 0
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
    let finalSubject = geminiData.subject || classification.subject;
    if (finalSubject) {
      const fsLower = finalSubject.toLowerCase().trim();
      if (fsLower === 'anesthesia') {
        finalSubject = 'Anaesthesia';
      } else if (fsLower === 'general medicine') {
        finalSubject = 'Medicine';
      }
    }
    return {
      explanation: geminiData.explanation,
      subject: finalSubject,
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
// Shared Diagram Assignment Helpers (used by both PATH A-1 and PATH A-2)
// ─────────────────────────────────────────────────────────────────────────────

// Build a flat list of diagram objects from the pageDiagramsMap
function flatDiagramsFrom(pageDiagramsMap) {
  const flat = [];
  for (const [pageNum, diagrams] of pageDiagramsMap.entries()) {
    diagrams.forEach((diag, idx) => {
      flat.push({
        id: `${pageNum}_${idx}`,
        page: pageNum,
        data: diag.data,
        width: diag.width,
        height: diag.height,
        assigned: false
      });
    });
  }
  return flat;
}

// Shared: score-based diagram assignment (Pass 1) + proximity fallback (Pass 2) + DB insert
async function assignDiagramsAndInsert(parsedQuestions, flatDiagrams, pageDiagramsMap, uploadId, extractedYear, totalPagesCount) {
  // Pre-pass: Handle questions with NO TEXT OPTIONS
  // Extract and assign option images before standard diagram matching
  for (const q of parsedQuestions) {
    const isNoText = hasNoTextOptions(q);
    if (isNoText) {
      q.preGenId = uuidv4();
      
      const pageDiags = flatDiagrams.filter(d => d.page === q.startPage && !d.assigned);
      logToExecutionFile('INFO', `Pre-pass: Q${q.qNum} has no text options. Found ${pageDiags.length} unassigned diagrams on page ${q.startPage}`, uploadId);
      
      const hasOptD = q.hasOptD !== undefined ? q.hasOptD : (q.optD && q.optD.trim() !== '');
      const numOptionsNeeded = hasOptD ? 4 : 3;
      
      if (pageDiags.length > 0) {
        // Heuristic: Does the first diagram belong to the question stem?
        const textIndicatesImage = /\b(image|figure|photograph|picture|diagram|graph|chart|shown|marked|mark|arrow|arrows|identify|visual|radiograph|x-ray|scan|mri|ct|ultrasound|histopathology|biopsy|investigation|provided|sarcomere)\b/i.test(q.cleanText);
        const firstIsLarge = pageDiags[0] && (pageDiags[0].width > 300 || pageDiags[0].height > 250);
        const hasExtraDiagram = pageDiags.length > numOptionsNeeded;
        
        const isFirstStemDiag = hasExtraDiagram || textIndicatesImage || firstIsLarge;
        
        let optionStartIdx = 0;
        if (isFirstStemDiag) {
          // The first one is the question stem diagram
          const qStemDiag = pageDiags[0];
          qStemDiag.assigned = true;
          q.assignedDiagram = qStemDiag;
          optionStartIdx = 1;
          logToExecutionFile('INFO', `Pre-pass: Assigned diagram 0 on page ${q.startPage} as question stem image for Q${q.qNum}`, uploadId);
        }
        
        // Assign the remaining diagrams as options A, B, C, D
        const diagsLeft = pageDiags.slice(optionStartIdx);
        if (diagsLeft.length > 0) {
          const diagA = diagsLeft[0];
          const diagB = diagsLeft.length > 1 ? diagsLeft[1] : null;
          const diagC = diagsLeft.length > 2 ? diagsLeft[2] : null;
          const diagD = diagsLeft.length > 3 ? diagsLeft[3] : null;
          
          if (diagA) {
            q.optA = saveOptionImageToDisk(q.preGenId, 'A', diagA.data);
            diagA.assigned = true;
          }
          if (diagB) {
            q.optB = saveOptionImageToDisk(q.preGenId, 'B', diagB.data);
            diagB.assigned = true;
          }
          if (diagC) {
            q.optC = saveOptionImageToDisk(q.preGenId, 'C', diagC.data);
            diagC.assigned = true;
          }
          if (diagD && hasOptD) {
            q.optD = saveOptionImageToDisk(q.preGenId, 'D', diagD.data);
            diagD.assigned = true;
          } else {
            q.optD = '';
          }
          
          logToExecutionFile('INFO', `Pre-pass: Assigned option images for Q${q.qNum}: A=${q.optA}, B=${q.optB}, C=${q.optC}, D=${q.optD}`, uploadId);
        }
      } else {
        logToExecutionFile('WARN', `Pre-pass: Q${q.qNum} has no text options but page ${q.startPage} has no unassigned diagrams`, uploadId);
      }
    }
  }

  // Compute image affinity score for each question
  parsedQuestions.forEach(q => {
    q.affinityScore = computeImageAffinityScore(q.cleanText);
  });

  // Pass 1: Global maximum matching based on affinity score and same-page priority
  const possiblePairs = [];
  flatDiagrams.forEach(diag => {
    if (diag.assigned) return;
    parsedQuestions.forEach(q => {
      if (q.assignedDiagram) return;
      const isPageMatch = q.startPage >= diag.page - 1 && q.startPage <= diag.page + 1;
      if (isPageMatch) {
        const pageDiff = Math.abs(q.startPage - diag.page);
        const priorityScore = q.affinityScore + (pageDiff === 0 ? 50 : 0);
        possiblePairs.push({ diagram: diag, question: q, score: priorityScore, rawScore: q.affinityScore });
      }
    });
  });
  possiblePairs.sort((a, b) => b.score - a.score);
  possiblePairs.forEach(pair => {
    if (!pair.diagram.assigned && !pair.question.assignedDiagram && pair.rawScore >= 2) {
      pair.diagram.assigned = true;
      pair.question.assignedDiagram = pair.diagram;
      logToExecutionFile('INFO',
        `[Pass 1] Matched diagram p.${pair.diagram.page} → Q${pair.question.qNum} (p.${pair.question.startPage}), affinity=${pair.rawScore}`, uploadId);
    }
  });

  // Pass 2: Proximity fallback for any remaining unassigned diagrams
  flatDiagrams.forEach(diag => {
    if (diag.assigned) return;
    let bestCandidate = null;
    let minPageDiff = Infinity;
    parsedQuestions.forEach(q => {
      if (q.assignedDiagram) return;
      const isPageMatch = q.startPage >= diag.page - 1 && q.startPage <= diag.page + 1;
      if (isPageMatch) {
        const pageDiff = Math.abs(q.startPage - diag.page);
        if (pageDiff < minPageDiff || (pageDiff === minPageDiff && bestCandidate && q.affinityScore > bestCandidate.affinityScore)) {
          minPageDiff = pageDiff;
          bestCandidate = q;
        }
      }
    });
    if (bestCandidate) {
      diag.assigned = true;
      bestCandidate.assignedDiagram = diag;
      logToExecutionFile('INFO',
        `[Pass 2 Fallback] Assigned diagram p.${diag.page} → Q${bestCandidate.qNum} (p.${bestCandidate.startPage})`, uploadId);
    } else {
      logToExecutionFile('WARN',
        `[Pass 2 Fallback] No candidate for diagram on page ${diag.page}`, uploadId);
    }
  });

  // Insert all questions into DB
  for (const q of parsedQuestions) {
    const questionId = q.preGenId || uuidv4();
    const classification = classifyQuestion(q.cleanText);
    if (q.pdfSubject) classification.subject = q.pdfSubject;
    
    // Normalize Subject Names
    if (classification.subject.toLowerCase() === 'anesthesia') {
      classification.subject = 'Anaesthesia';
    } else if (classification.subject.toLowerCase() === 'general medicine') {
      classification.subject = 'Medicine';
    }
    if (q.pdfTopic) {
      classification.chapter = q.pdfTopic;
      classification.topic = q.pdfSubTopic || q.pdfTopic;
    }

    const pendingExplanation = `[AI Explanation Pending] This question on ${classification.subject} – ${classification.chapter} covers key NEET PG concepts. Manual review recommended. Correct answer: ${q.correctAns}.`;

    let imagePath = null;
    let imagePresent = false;
    let imageDesc = null;

    if (q.assignedDiagram) {
      imagePath = saveDiagramToDisk(questionId, q.assignedDiagram.data);
      imagePresent = true;
      imageDesc = `Clinical diagram extracted from PDF Page ${q.assignedDiagram.page} for Question ${q.qNum}`;
      logToExecutionFile('INFO',
        `Q${q.qNum}: diagram saved (${q.assignedDiagram.width}×${q.assignedDiagram.height}): ${imagePath}`, uploadId);
    } else {
      const textIndicatesImage = /\b(image|figure|photograph|picture|diagram|shown|marked|mark|arrow|arrows|identify|visual|radiograph|x-ray|scan|mri|ct|ultrasound|histopathology|biopsy|investigation|provided)\b/i.test(q.cleanText);
      if (textIndicatesImage) {
        logToExecutionFile('WARN',
          `Q${q.qNum} text references an image but no diagram found on page ${q.startPage}.`, uploadId);
      }
    }

    const imageType = /x-ray|radiograph/i.test(q.cleanText)
      ? 'X-Ray'
      : /histolog|biopsy|microscop/i.test(q.cleanText)
      ? 'Histopathology'
      : 'Clinical Diagram';

    await insertQuestion(uploadId, {
      questionId,
      qNum: q.qNum,
      cleanText: q.cleanText,
      optA: q.optA,
      optB: q.optB,
      optC: q.optC,
      optD: q.optD,
      correctAns: q.correctAns,
      explanationText: pendingExplanation,
      subject: classification.subject,
      chapter: classification.chapter,
      topic: classification.topic,
      difficulty: classification.difficulty,
      clinicalType: classification.clinicalType,
      questionType: classification.questionType,
      imagePresent,
      imagePath,
      imageDesc,
      imageType,
      pageNum: q.startPage,
      keywords: Array.isArray(classification.keywords) ? classification.keywords.join(', ') : '',
      generationSource: 'Local Classifier',
      year: extractedYear,
      geminiEnriched: false
    });
    logToExecutionFile('INFO', `Q\${q.qNum} saved to database (Pending Enrichment).`, uploadId);
  }
}

// Helper: Extract full PDF text with page boundary tags and ‹B›‹/B› bold markers
async function extractFullTextWithBold(parser) {
  const doc = await parser.load();
  const totalPages = doc.numPages;
  const parts = [];

  for (let s = 1; s <= totalPages; s++) {
    const page = await doc.getPage(s);
    await page.getOperatorList();
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    
    parts.push(`\n-- PAGE ${s} --\n`);
    
    const o = [];
    let l, h, c = 0;
    
    for (const d of textContent.items) {
      if (!('str' in d)) continue;
      const transform = d.transform;
      const [e, i] = viewport.convertToViewportPoint(transform[4], transform[5]);
      
      const font = d.fontName ? page.commonObjs.get(d.fontName) : null;
      const fontName = font ? font.name : '';
      const isBold = fontName && /bold|bd|heavy|black/i.test(fontName);
      
      let str = d.str;
      if (isBold && str.trim().length > 0) {
        str = '‹B›' + str + '‹/B›';
      }
      
      if (h !== undefined && Math.abs(h - i) > 3) {
        const prev = o.length ? o[o.length - 1] : undefined;
        const startsWithNL = d.str.startsWith('\n') || (d.str.trim() === '' && d.hasEOL);
        if (prev !== '\n' && !startsWithNL) {
          o.push('\n');
        }
      }
      
      o.push(str);
      l = e + d.width;
      h = i;
      if (d.hasEOL) o.push('\n');
    }
    parts.push(o.join(''));
    await page.cleanup();
  }
  return parts.join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PDF PROCESSING PIPELINE
//
// Strategy:
//   Path A-1 (PrepLadder format):  "Ques No:", "O1:", "O2:", "O3:", "O4:", "Ans: N"
//   Path A-2 (Q.N. style format):  "Q.1.", numbered 1-4 options, "Correct Answer: [text]"
//   Path B   (scanned / image):    No recognisable text → Gemini multimodal fallback
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

    const rawText = textResult.text || '';
    const totalPagesCount = imageResult.pages ? imageResult.pages.length : 0;

    let extractedYear = new Date().getFullYear();
    const yearMatch = fileName.match(/(?:19|20)\d{2}/);
    if (yearMatch) {
      extractedYear = parseInt(yearMatch[0], 10);
    } else if (rawText) {
      const textYearMatch = rawText.substring(0, 1000).match(/(?:19|20)\d{2}/);
      if (textYearMatch) {
        extractedYear = parseInt(textYearMatch[0], 10);
      }
    }

    logToExecutionFile('INFO',
      `Text extracted: ${rawText.length} chars. Pages with images: ${totalPagesCount}. Extracted Year: ${extractedYear}`, uploadId);

    // ── Step 2: Build diagram map from local image extraction ────────────────
    const pageDiagramsMap = buildPageDiagramsMap(imageResult, totalPagesCount, uploadId);
    logToExecutionFile('INFO',
      `Diagram map built. ${pageDiagramsMap.size} page(s) have clinical diagrams.`, uploadId);

    // ── Step 3: Try local text parsing (PATH A) ───────────────────────────────
    let extractedCount = 0;

    // ── Auto-detect PDF question format ──────────────────────────────────────
    // FORMAT 1 (PrepLadder): "Ques No:", "O1:", "O2:", "O3:", "O4:", "Ans: 1/2/3/4"
    // FORMAT 2 (Q.N. Style): "Q.1.", "1. ... 2. ... 3. ... 4. ...", "Correct Answer: [text]"

    // Detect Format 1
    const format1Blocks = rawText.split(/Ques No:\s*/i);
    const isFormat1 = format1Blocks.length > 1;

    // Detect Format 2 — look for "Q.1." or "Q. 1." style question starters
    const format2Regex = /Q\.\s*(\d+)\.\s*/gi;
    const format2Matches = rawText.match(format2Regex);
    const isFormat2 = !isFormat1 && format2Matches && format2Matches.length > 0;

    // Detect Format 3 — look for "Subject :" and "Q. " without number
    const hasSubjectHeader = /Subject\s*:\s*[a-zA-Z]+/i.test(rawText);
    const hasQDotFormat3 = /(?:\r?\n|^)Q\.\s+[a-zA-Z]+/i.test(rawText);
    const isFormat3 = !isFormat1 && !isFormat2 && hasSubjectHeader && hasQDotFormat3;

    logToExecutionFile('INFO',
      `Format detection — Format1 (PrepLadder): ${isFormat1}, Format2 (Q.N.): ${isFormat2}, Format3 (Bold Options): ${isFormat3}`, uploadId);

    let richText = rawText;
    if (isFormat3) {
      logToExecutionFile('INFO', 'Format 3 detected. Extracting rich text with font bold markers...', uploadId);
      richText = await extractFullTextWithBold(parser);
    }
    await parser.destroy();

    // Find page boundary positions in the raw text (used by both formats for page tracking)
    const pageRegex = /--\s*(\d+)\s*of\s*\d+\s*--/gi;
    let m;
    const pagePositions = [];
    while ((m = pageRegex.exec(rawText)) !== null) {
      pagePositions.push({ page: parseInt(m[1]), index: m.index });
    }

    if (isFormat1) {
      // ─── PATH A-1: PrepLadder / Ques No: format ──────────────────────────

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

      logToExecutionFile('INFO',
        `PATH A-1: Found ${blocks.length - 1} question block(s) via PrepLadder text extraction.`, uploadId);

      const parsedQuestions = [];

      for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i].trim();
        if (!block) continue;

        // Determine page number using raw text position
        const rawPos = quesNoPositions[i - 1] || 0;
        let startPage = 1;
        for (const pp of pagePositions) {
          if (pp.index < rawPos) startPage = pp.page + 1;
          else break;
        }

        // Determine endPage using the next question's position
        let endPage = startPage;
        if (i < blocks.length - 1) {
          const nextRawPos = quesNoPositions[i] || 0;
          for (const pp of pagePositions) {
            if (pp.index < nextRawPos) endPage = pp.page + 1;
            else break;
          }
        } else {
          endPage = totalPagesCount > 0 ? totalPagesCount : startPage;
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

        const qTextStart = subTopicIdx !== -1 ? subTopicIdx + 1 : 1;
        const rawQText = lines.slice(qTextStart, o1Idx).join(' ');

        const optA = lines.slice(o1Idx + 1, o2Idx).join(' ').trim();
        const optB = lines.slice(o2Idx + 1, o3Idx).join(' ').trim();
        const optC = lines.slice(o3Idx + 1, o4Idx).join(' ').trim();
        const optD = lines.slice(o4Idx + 1, ansIdx).join(' ').trim();

        const ansMatch = lines[ansIdx].match(/Ans:\s*(\d)/i);
        const ansMap = { '1': 'A', '2': 'B', '3': 'C', '4': 'D' };
        const correctAns = ansMatch ? (ansMap[ansMatch[1]] || 'A') : 'A';

        const cleanText = cleanWatermarks(rawQText);

        parsedQuestions.push({
          qNum, startPage, endPage,
          optA, optB, optC, optD, correctAns, cleanText,
          pdfSubject, pdfTopic, pdfSubTopic,
          assignedDiagram: null, affinityScore: 0
        });
      }

      // Assign diagrams and insert into DB (shared logic below)
      await assignDiagramsAndInsert(
        parsedQuestions, flatDiagramsFrom(pageDiagramsMap), pageDiagramsMap,
        uploadId, extractedYear, totalPagesCount
      );
      extractedCount = parsedQuestions.length;

    } else if (isFormat2) {
      // ─── PATH A-2: Q.N. Style format ──────────────────────────────────────
      logToExecutionFile('INFO',
        `PATH A-2: Found ${format2Matches.length} question(s) via Q.N. style format.`, uploadId);

      // Find all Q.N. positions in raw text for page tracking
      const qDotRegex = /Q\.\s*(\d+)\.\s*/gi;
      const qDotPositions = [];
      let qm;
      while ((qm = qDotRegex.exec(rawText)) !== null) {
        qDotPositions.push({ num: parseInt(qm[1]), index: qm.index });
      }

      // Clean and split by Q.N. pattern
      const cleanedText2 = rawText
        .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, '');

      // Split into segments, each starting at Q.N.
      const qDotSplitRegex = /Q\.\s*\d+\.\s*/gi;
      const segments = cleanedText2.split(qDotSplitRegex);

      const parsedQuestions2 = [];

      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i].trim();
        if (!seg) continue;

        const qNum = qDotPositions[i - 1] ? qDotPositions[i - 1].num : i;

        // Determine page number using raw text position
        const rawPos = qDotPositions[i - 1] ? qDotPositions[i - 1].index : 0;
        let startPage = 1;
        for (const pp of pagePositions) {
          if (pp.index < rawPos) startPage = pp.page + 1;
          else break;
        }

        // Determine endPage using the next question's position
        let endPage = startPage;
        if (i < segments.length - 1) {
          const nextRawPos = qDotPositions[i] ? qDotPositions[i].index : 0;
          for (const pp of pagePositions) {
            if (pp.index < nextRawPos) endPage = pp.page + 1;
            else break;
          }
        } else {
          endPage = totalPagesCount > 0 ? totalPagesCount : startPage;
        }

        const lines = seg.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // Locate options (1. 2. 3. 4.)
        const opt1Idx = lines.findIndex(l => /^\s*1\.\s+/i.test(l));
        const opt2Idx = lines.findIndex(l => /^\s*2\.\s+/i.test(l));
        const opt3Idx = lines.findIndex(l => /^\s*3\.\s+/i.test(l));
        const opt4Idx = lines.findIndex(l => /^\s*4\.\s+/i.test(l));

        if (opt1Idx === -1 || opt2Idx === -1 || opt3Idx === -1 || opt4Idx === -1) {
          logToExecutionFile('WARN', `Q${qNum} skipped — missing Option 1, 2, 3, or 4 markers.`, uploadId);
          continue;
        }

        const subjectIdx = lines.findIndex(l => /^Subject:/i.test(l));
        const topicIdx = lines.findIndex(l => /^Topic:/i.test(l));
        const subTopicIdx = lines.findIndex(l => /^Sub-Topic:/i.test(l));

        const pdfSubject = subjectIdx !== -1 ? lines[subjectIdx].replace(/^Subject:/i, '').trim() : '';
        const pdfTopic = topicIdx !== -1 ? lines[topicIdx].replace(/^Topic:/i, '').trim() : '';
        const pdfSubTopic = subTopicIdx !== -1 ? lines[subTopicIdx].replace(/^Sub-Topic:/i, '').trim() : '';
        const correctAnsIdx = lines.findIndex(l => /^Correct Answer:/i.test(l));

        // Question text is everything from the first non-Subject/Topic line up to option 1
        // Skip Subject/Topic header lines
        const skipPrefixes = /^(Subject:|Topic:|Sub-Topic:)/i;
        const qTextLines = [];
        for (let li = 0; li < opt1Idx; li++) {
          if (!skipPrefixes.test(lines[li])) {
            qTextLines.push(lines[li]);
          }
        }
        const rawQText = qTextLines.join(' ').trim();

        // Extract option texts (multi-line options: everything between consecutive option markers)
        const extractOpt = (fromIdx, toIdx) => {
          // Start line text (after the "N. " prefix)
          const firstLine = lines[fromIdx].replace(/^\s*\d[\.\)]\s+/, '').trim();
          const moreLines = (toIdx > fromIdx + 1)
            ? lines.slice(fromIdx + 1, toIdx).join(' ').trim()
            : '';
          return moreLines ? `${firstLine} ${moreLines}`.trim() : firstLine;
        };

        const optA = extractOpt(opt1Idx, opt2Idx);
        const optB = extractOpt(opt2Idx, opt3Idx);
        const optC = extractOpt(opt3Idx, opt4Idx);
        // Option D goes until Correct Answer line (or end of segment)
        const opt4End = correctAnsIdx > opt4Idx ? correctAnsIdx : lines.length;
        const optD = extractOpt(opt4Idx, opt4End);

        // Map "Correct Answer: [text]" → A/B/C/D by fuzzy text matching
        let correctAns = 'A';
        if (correctAnsIdx !== -1) {
          const correctText = lines[correctAnsIdx]
            .replace(/^Correct Answer:/i, '').trim().toLowerCase();
          
          const normalize = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
          const opts = [
            { letter: 'A', text: normalize(optA) },
            { letter: 'B', text: normalize(optB) },
            { letter: 'C', text: normalize(optC) },
            { letter: 'D', text: normalize(optD) }
          ];

          // Try exact match first, then substring match
          const normalCorrect = normalize(correctText);
          let matched = opts.find(o => o.text === normalCorrect);
          if (!matched) matched = opts.find(o => normalCorrect.includes(o.text) || o.text.includes(normalCorrect));
          if (!matched) {
            // Fallback: find the option with the most words in common
            const correctWords = new Set(normalCorrect.split(/\s+/));
            let bestScore = 0;
            for (const o of opts) {
              const common = o.text.split(/\s+/).filter(w => correctWords.has(w)).length;
              if (common > bestScore) { bestScore = common; matched = o; }
            }
          }
          if (matched) correctAns = matched.letter;
        }

        const cleanText = cleanWatermarks(rawQText);
        if (!cleanText || cleanText.length < 5) {
          logToExecutionFile('WARN', `Q${qNum} skipped — empty question text.`, uploadId);
          continue;
        }

        parsedQuestions2.push({
          qNum, startPage, endPage,
          optA, optB, optC, optD, correctAns, cleanText,
          pdfSubject, pdfTopic, pdfSubTopic: '',
          assignedDiagram: null, affinityScore: 0
        });
      }

      await assignDiagramsAndInsert(
        parsedQuestions2, flatDiagramsFrom(pageDiagramsMap), pageDiagramsMap,
        uploadId, extractedYear, totalPagesCount
      );
      extractedCount = parsedQuestions2.length;

    } else if (isFormat3) {
      // ─── PATH A-3: Format 3 (bold options, sequential numbering) ──────────
      logToExecutionFile('INFO',
        `PATH A-3: Parsing Format 3 PDF using bold option detection page-by-page.`, uploadId);

      const pages = richText.split(/--\s*PAGE\s*\d+\s*--/gi);
      logToExecutionFile('INFO', `Found ${pages.length - 1} page(s) in rich text.`, uploadId);

      let currentSubject = 'Anatomy'; // Default fallback
      const parsedQuestions3 = [];
      let qSeqNum = 1;

      for (let s = 1; s < pages.length; s++) {
        const pageText = pages[s].trim();
        if (!pageText) continue;

        // Page 1 is the cover page, skip it
        if (s === 1) {
          const subjMatch = pageText.match(/Subject\s*:\s*(.+)/i);
          if (subjMatch) currentSubject = subjMatch[1].trim();
          continue;
        }

        const lines = pageText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        // Check and update active subject
        const subjLine = lines.find(l => /^Subject\s*:\s*/i.test(l.replace(/‹\/?B›/g, '').trim()));
        if (subjLine) {
          const cleanSubj = subjLine.replace(/‹\/?B›/g, '').trim();
          currentSubject = cleanSubj.replace(/^Subject\s*:\s*/i, '').trim();
        }

        // Filter out metadata headers like "Subject: X" from actual question lines
        const cleanLines = lines.filter(l => {
          const clean = l.replace(/‹\/?B›/g, '').trim();
          return !/^Subject\s*:\s*/i.test(clean) && !/^NEETPG\s*\d+/i.test(clean) && !/^Recall\s*Questions/i.test(clean);
        });

        // Split any side-by-side options in cleanLines
        const finalCleanLines = [];
        for (const line of cleanLines) {
          const clean = line.replace(/‹\/?B›/g, '').trim();
          if (/^\s*(?:‹B›)?\s*A\.(\s+|$)/i.test(clean)) {
            const bMatch = line.match(/\s+((?:‹B›)?\s*B\.(\s+|$).*)/i);
            if (bMatch) {
              const part1 = line.substring(0, bMatch.index).trim();
              const part2 = bMatch[1].trim();
              finalCleanLines.push(part1);
              finalCleanLines.push(part2);
              continue;
            }
          }
          if (/^\s*(?:‹B›)?\s*C\.(\s+|$)/i.test(clean)) {
            const dMatch = line.match(/\s+((?:‹B›)?\s*D\.(\s+|$).*)/i);
            if (dMatch) {
              const part1 = line.substring(0, dMatch.index).trim();
              const part2 = dMatch[1].trim();
              finalCleanLines.push(part1);
              finalCleanLines.push(part2);
              continue;
            }
          }
          // Support numeric side-by-side options if any
          if (/^\s*(?:‹B›)?\s*1\.(\s+|$)/i.test(clean)) {
            const twoMatch = line.match(/\s+((?:‹B›)?\s*2\.(\s+|$).*)/i);
            if (twoMatch) {
              const part1 = line.substring(0, twoMatch.index).trim();
              const part2 = twoMatch[1].trim();
              finalCleanLines.push(part1);
              finalCleanLines.push(part2);
              continue;
            }
          }
          if (/^\s*(?:‹B›)?\s*3\.(\s+|$)/i.test(clean)) {
            const fourMatch = line.match(/\s+((?:‹B›)?\s*4\.(\s+|$).*)/i);
            if (fourMatch) {
              const part1 = line.substring(0, fourMatch.index).trim();
              const part2 = fourMatch[1].trim();
              finalCleanLines.push(part1);
              finalCleanLines.push(part2);
              continue;
            }
          }
          finalCleanLines.push(line);
        }

        // Locate options (A, B, C, D)
        let cleanOpt1Idx = finalCleanLines.findIndex(l => {
          const clean = l.replace(/‹\/?B›/g, '').trim();
          return /^\s*(?:‹B›)?\s*A\.(\s+|$)/i.test(clean);
        });
        let cleanOpt2Idx = finalCleanLines.findIndex(l => {
          const clean = l.replace(/‹\/?B›/g, '').trim();
          return /^\s*(?:‹B›)?\s*B\.(\s+|$)/i.test(clean);
        });
        let cleanOpt3Idx = finalCleanLines.findIndex(l => {
          const clean = l.replace(/‹\/?B›/g, '').trim();
          return /^\s*(?:‹B›)?\s*C\.(\s+|$)/i.test(clean);
        });
        let cleanOpt4Idx = finalCleanLines.findIndex(l => {
          const clean = l.replace(/‹\/?B›/g, '').trim();
          return /^\s*(?:‹B›)?\s*D\.(\s+|$)/i.test(clean);
        });

        let isNumericOptions = false;
        if (cleanOpt1Idx === -1 || cleanOpt2Idx === -1 || cleanOpt3Idx === -1) {
          // Fallback: check for options labeled "1.", "2.", "3.", "4."
          cleanOpt1Idx = finalCleanLines.findIndex(l => {
            const clean = l.replace(/‹\/?B›/g, '').trim();
            return /^\s*(?:‹B›)?\s*1\.(\s+|$)/i.test(clean);
          });
          cleanOpt2Idx = finalCleanLines.findIndex(l => {
            const clean = l.replace(/‹\/?B›/g, '').trim();
            return /^\s*(?:‹B›)?\s*2\.(\s+|$)/i.test(clean);
          });
          cleanOpt3Idx = finalCleanLines.findIndex(l => {
            const clean = l.replace(/‹\/?B›/g, '').trim();
            return /^\s*(?:‹B›)?\s*3\.(\s+|$)/i.test(clean);
          });
          cleanOpt4Idx = finalCleanLines.findIndex(l => {
            const clean = l.replace(/‹\/?B›/g, '').trim();
            return /^\s*(?:‹B›)?\s*4\.(\s+|$)/i.test(clean);
          });
          
          if (cleanOpt1Idx !== -1 && cleanOpt2Idx !== -1 && cleanOpt3Idx !== -1) {
            isNumericOptions = true;
          }
        }

        let optA = '';
        let optB = '';
        let optC = '';
        let optD = '';
        let correctAns = 'A';
        let cleanText = '';

        if (cleanOpt1Idx !== -1 && cleanOpt2Idx !== -1 && cleanOpt3Idx !== -1) {
          const extractOptText = (fromIdx, toIdx) => {
            const slice = finalCleanLines.slice(fromIdx, toIdx);
            let text = slice.join(' ').trim();
            if (isNumericOptions) {
              text = text.replace(/^\s*(?:‹B›)?\s*[1-4]\.(\s+|$)(?:‹\/B›)?/i, '').trim();
            } else {
              text = text.replace(/^\s*(?:‹B›)?\s*[A-D]\.(\s+|$)(?:‹\/B›)?/i, '').trim();
            }
            return text;
          };

          optA = extractOptText(cleanOpt1Idx, cleanOpt2Idx);
          optB = extractOptText(cleanOpt2Idx, cleanOpt3Idx);
          
          if (cleanOpt4Idx !== -1) {
            optC = extractOptText(cleanOpt3Idx, cleanOpt4Idx);
            optD = extractOptText(cleanOpt4Idx, finalCleanLines.length);
          } else {
            optC = extractOptText(cleanOpt3Idx, finalCleanLines.length);
          }

          // Determine correct answer via bold tag checks on the full option slice (body and prefix)
          const checkSliceBold = (fromIdx, toIdx) => {
            const slice = finalCleanLines.slice(fromIdx, toIdx);
            const text = slice.join(' ');
            return text.includes('‹B›') || text.includes('‹/B›');
          };

          if (checkSliceBold(cleanOpt1Idx, cleanOpt2Idx)) correctAns = 'A';
          else if (checkSliceBold(cleanOpt2Idx, cleanOpt3Idx)) correctAns = 'B';
          else if (cleanOpt4Idx !== -1) {
            if (checkSliceBold(cleanOpt3Idx, cleanOpt4Idx)) correctAns = 'C';
            else if (checkSliceBold(cleanOpt4Idx, finalCleanLines.length)) correctAns = 'D';
          } else {
            if (checkSliceBold(cleanOpt3Idx, finalCleanLines.length)) correctAns = 'C';
          }

          const qTextLines = [];
          for (let li = 0; li < cleanOpt1Idx; li++) {
            qTextLines.push(finalCleanLines[li]);
          }
          cleanText = qTextLines.join(' ').replace(/‹\/?B›/g, '').trim();
          cleanText = cleanText.replace(/^\s*Q\.\s*/i, '').trim();
        } else {
          // Fallback: No options
          const qTextLines = [];
          for (let li = 0; li < finalCleanLines.length; li++) {
            qTextLines.push(finalCleanLines[li]);
          }
          cleanText = qTextLines.join(' ').replace(/‹\/?B›/g, '').trim();
          cleanText = cleanText.replace(/^\s*Q\.\s*/i, '').trim();
          optA = 'Refer to image';
          optB = 'Refer to image';
          optC = 'Refer to image';
          optD = 'Refer to image';
          correctAns = 'A';
        }

        const cleanedQuestionText = cleanWatermarks(cleanText);

        if (!cleanedQuestionText || cleanedQuestionText.length < 5) {
          logToExecutionFile('WARN', `Page ${s} skipped — empty question text.`, uploadId);
          continue;
        }

        parsedQuestions3.push({
          qNum: qSeqNum++,
          startPage: s,
          endPage: s,
          optA: optA.replace(/‹\/?B›/g, '').trim(),
          optB: optB.replace(/‹\/?B›/g, '').trim(),
          optC: optC.replace(/‹\/?B›/g, '').trim(),
          optD: optD.replace(/‹\/?B›/g, '').trim(),
          correctAns,
          cleanText: cleanedQuestionText,
          pdfSubject: currentSubject,
          pdfTopic: '',
          pdfSubTopic: '',
          assignedDiagram: null,
          affinityScore: 0,
          hasOptD: cleanOpt4Idx !== -1
        });
      }

      await assignDiagramsAndInsert(
        parsedQuestions3, flatDiagramsFrom(pageDiagramsMap), pageDiagramsMap,
        uploadId, extractedYear, totalPagesCount
      );
      extractedCount = parsedQuestions3.length;

    } else {
      // ─── PATH B: Scanned / image-based PDF ────────────────────────────────
      logToExecutionFile('INFO',
        'PATH B: No recognised text format. Activating Gemini multimodal for question extraction...', uploadId);

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

      for (let idx = 0; idx < geminiQuestions.length; idx++) {
        const q = geminiQuestions[idx];
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
        
        // Normalize Subject Names
        if (classification.subject.toLowerCase() === 'anesthesia') {
          classification.subject = 'Anaesthesia';
        } else if (classification.subject.toLowerCase() === 'general medicine') {
          classification.subject = 'Medicine';
        }
        
        if (q.chapter) classification.chapter = q.chapter;
        if (q.topic) classification.topic = q.topic;

        // Set default pending explanation (Gemini enrichment happens in batch later)
        const pendingExplanation = `[AI Explanation Pending] This question on ${classification.subject} – ${classification.chapter} covers key NEET PG concepts. Manual review recommended. Correct answer: ${correctAns}.`;
        
        const endPage = (idx < geminiQuestions.length - 1 && geminiQuestions[idx + 1].pageNumber)
          ? geminiQuestions[idx + 1].pageNumber
          : (totalPagesCount > 0 ? totalPagesCount : pageNum);

        // Check for actual diagram (handling page boundaries)
        let diagram = null;
        if (q.hasImage) {
          diagram = extractDiagramForQuestionRange(pageNum, endPage, pageDiagramsMap);
        }

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
          explanationText: pendingExplanation,
          subject: classification.subject,
          chapter: classification.chapter,
          topic: classification.topic,
          difficulty: classification.difficulty,
          clinicalType: classification.clinicalType,
          questionType: classification.questionType,
          imagePresent, imagePath, imageDesc, imageType,
          pageNum,
          keywords: Array.isArray(classification.keywords) ? classification.keywords.join(', ') : '',
          generationSource: 'Gemini Multimodal (Base)',
          year: extractedYear,
          geminiEnriched: false
        });

        extractedCount++;
        logToExecutionFile('INFO', `Q${qNum} saved to database (Pending Enrichment).`, uploadId);
      }
    }

    // ── Final update ──────────────────────────────────────────────────────────
    await dbQuery.run(
      'UPDATE UploadHistory SET Questions_Extracted = ?, Processing_Status = ? WHERE Upload_ID = ?',
      [extractedCount, 'COMPLETED', uploadId]
    );

    const duration = Date.now() - startTime;
    logToExecutionFile('INFO',
      `PDF processing complete. Total extracted: ${extractedCount}. Time: ${duration}ms.`, uploadId);


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
  enrichPendingQuestions,
  cleanWatermarks,
  logToExecutionFile
};

// ─────────────────────────────────────────────────────────────────────────────
// Deferred Batch Enrichment Runner
// Processes all questions where Gemini_Enriched = 0 in batches
// ─────────────────────────────────────────────────────────────────────────────
async function enrichPendingQuestions(apiKey, uploadId = null) {
  try {
    let query = 'SELECT * FROM QuestionBank WHERE Gemini_Enriched = 0';
    const params = [];
    if (uploadId) {
      query += ' AND Upload_ID = ?';
      params.push(uploadId);
    }

    const pendingQuestions = await dbQuery.all(query, params);
    if (!pendingQuestions || pendingQuestions.length === 0) {
      logToExecutionFile('INFO', `No pending questions to enrich.`, uploadId || 'BATCH');
      return { success: true, enrichedCount: 0 };
    }

    logToExecutionFile('INFO', `Found ${pendingQuestions.length} questions to enrich. Starting batch process...`, uploadId || 'BATCH');
    let enrichedCount = 0;
    const batchSize = 30; // Safe size to stay within output token limits

    for (let i = 0; i < pendingQuestions.length; i += batchSize) {
      const batch = pendingQuestions.slice(i, i + batchSize);
      logToExecutionFile('INFO', `Processing batch ${i / batchSize + 1} (${batch.length} questions)...`, uploadId || 'BATCH');

      const explanations = await callGeminiForExplanationBatch(apiKey, batch, uploadId || 'BATCH');
      
      if (!explanations) {
        logToExecutionFile('WARN', `Batch enrichment stopped due to API failure. Will resume on retry.`, uploadId || 'BATCH');
        break; // Stop processing further batches, keep them pending
      }

      for (const expl of explanations) {
        const qIndex = expl.questionIndex;
        if (qIndex >= 0 && qIndex < batch.length) {
          const q = batch[qIndex];
          const explanationText = expl.explanation || 'Explanation generated but empty.';
          let finalSubject = expl.subject || q.Subject;
          if (finalSubject) {
            const fsLower = finalSubject.toLowerCase().trim();
            if (fsLower === 'anesthesia') {
              finalSubject = 'Anaesthesia';
            } else if (fsLower === 'general medicine') {
              finalSubject = 'Medicine';
            }
          }

          await dbQuery.run(`
            UPDATE QuestionBank 
            SET Answer_Explanation = ?, Subject = ?, Chapter = ?, Topic = ?, Difficulty_Level = ?, 
                Clinical_or_Conceptual = ?, Question_Type = ?, Keywords = ?, Gemini_Enriched = 1
            WHERE Question_ID = ?
          `, [
            explanationText,
            finalSubject,
            expl.chapter || q.Chapter,
            expl.topic || q.Topic,
            expl.difficulty || q.Difficulty_Level,
            expl.clinicalType || q.Clinical_or_Conceptual,
            expl.questionType || q.Question_Type,
            Array.isArray(expl.keywords) ? expl.keywords.join(', ') : q.Keywords,
            q.Question_ID
          ]);
          enrichedCount++;
        }
      }
      
      // Sleep slightly between successful batches to avoid rapid-fire limit hits
      await sleep(1500);
    }

    logToExecutionFile('INFO', `Batch enrichment complete. Successfully enriched ${enrichedCount} out of ${pendingQuestions.length} questions.`, uploadId || 'BATCH');
    return { success: true, enrichedCount, totalPending: pendingQuestions.length };

  } catch (err) {
    logToExecutionFile('ERROR', `Deferred enrichment failed: ${err.message}`, uploadId || 'BATCH');
    return { success: false, error: err.message };
  }
}
