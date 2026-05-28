const mongoose = require('mongoose');

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.warn('MONGODB_URI is not set. Database initialization will fail until it is provided.');
}

const uploadHistorySchema = new mongoose.Schema(
  {
    Upload_ID: { type: String, required: true, unique: true, index: true },
    User_ID: { type: String, default: 'system_user' },
    File_Name: { type: String, required: true },
    File_Size: { type: Number, required: true },
    Upload_Date: { type: Date, required: true, index: true },
    Questions_Extracted: { type: Number, default: 0 },
    Processing_Status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
      index: true
    },
    File_Path: { type: String, default: null }
  },
  { versionKey: false }
);

const questionBankSchema = new mongoose.Schema(
  {
    Question_ID: { type: String, required: true, unique: true, index: true },
    Upload_ID: { type: String, required: true, index: true },
    Question_Number: { type: Number, index: true },
    Question_Text: { type: String, required: true },
    Option_A: { type: String, required: true },
    Option_B: { type: String, required: true },
    Option_C: { type: String, required: true },
    Option_D: { type: String, required: true },
    Correct_Answer: { type: String, default: null },
    Answer_Explanation: { type: String, default: null },
    Subject: { type: String, default: null, index: true },
    Chapter: { type: String, default: null },
    Topic: { type: String, default: null },
    Difficulty_Level: { type: String, enum: ['Easy', 'Medium', 'Hard', null], default: null, index: true },
    Clinical_or_Conceptual: {
      type: String,
      enum: ['Clinical Scenario', 'Conceptual', 'Fact Recall', null],
      default: null
    },
    Question_Type: {
      type: String,
      enum: ['Clinical Scenario', 'Single Best Answer', 'Image Based', 'Assertion Reason', 'Fact Recall', null],
      default: null
    },
    Image_Present: { type: Boolean, default: false, index: true },
    Embedded_Image: { type: String, default: null },
    Image_Description: { type: String, default: null },
    Previous_Year: { type: Number, default: null, index: true },
    Page_Number: { type: Number, default: null },
    Keywords: { type: String, default: null },
    Similarity_Group_ID: { type: String, default: null },
    OCR_Confidence: { type: String, enum: ['High', 'Medium', 'Low', null], default: null, index: true },
    Generation_Source: { type: String, default: 'Local Fallback' },
    Gemini_Enriched: { type: Boolean, default: false, index: true },
    Created_Date: { type: Date, default: Date.now },
    Updated_Date: { type: Date, default: Date.now }
  },
  { versionKey: false }
);

const imageSchema = new mongoose.Schema(
  {
    Image_ID: { type: String, required: true, unique: true, index: true },
    Question_ID: { type: String, required: true, index: true },
    Image_Path: { type: String, required: true },
    Image_Description: { type: String, default: null },
    Image_Type: { type: String, default: null }
  },
  { versionKey: false }
);

const systemSettingsSchema = new mongoose.Schema(
  {
    Setting_Key: { type: String, required: true, unique: true, index: true },
    Setting_Value: { type: String, required: true }
  },
  { versionKey: false }
);

const UploadHistory = mongoose.models.UploadHistory || mongoose.model('UploadHistory', uploadHistorySchema, 'UploadHistory');
const QuestionBank = mongoose.models.QuestionBank || mongoose.model('QuestionBank', questionBankSchema, 'QuestionBank');
const Images = mongoose.models.Images || mongoose.model('Images', imageSchema, 'Images');
const SystemSettings = mongoose.models.SystemSettings || mongoose.model('SystemSettings', systemSettingsSchema, 'SystemSettings');

function toPlain(doc) {
  if (!doc) return null;
  if (typeof doc.toObject === 'function') return doc.toObject();
  return doc;
}

function normalizeSql(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function boolFromSqlValue(v) {
  if (v === 1 || v === '1' || v === true || v === 'true') return true;
  return false;
}

async function executeRun(sql, params) {
  const normalized = normalizeSql(sql);

  if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX') || normalized.startsWith('ALTER TABLE')) {
    return { lastID: null, changes: 0 };
  }

  if (normalized.includes('INSERT INTO UploadHistory')) {
    const payload = {
      Upload_ID: params[0],
      User_ID: params[1],
      File_Name: params[2],
      File_Size: params[3],
      Upload_Date: new Date(params[4]),
      Questions_Extracted: params[5],
      Processing_Status: params[6],
      File_Path: params[7]
    };
    await UploadHistory.create(payload);
    return { lastID: payload.Upload_ID, changes: 1 };
  }

  if (normalized.includes('INSERT INTO QuestionBank')) {
    const payload = {
      Question_ID: params[0],
      Upload_ID: params[1],
      Question_Number: params[2],
      Question_Text: params[3],
      Option_A: params[4],
      Option_B: params[5],
      Option_C: params[6],
      Option_D: params[7],
      Correct_Answer: params[8],
      Answer_Explanation: params[9],
      Subject: params[10],
      Chapter: params[11],
      Topic: params[12],
      Difficulty_Level: params[13],
      Clinical_or_Conceptual: params[14],
      Question_Type: params[15],
      Image_Present: boolFromSqlValue(params[16]),
      Embedded_Image: params[17],
      Image_Description: params[18],
      OCR_Confidence: params[19],
      Generation_Source: params[20],
      Previous_Year: params[21],
      Page_Number: params[22],
      Keywords: params[23],
      Gemini_Enriched: boolFromSqlValue(params[24]),
      Updated_Date: new Date()
    };
    await QuestionBank.create(payload);
    return { lastID: payload.Question_ID, changes: 1 };
  }

  if (normalized.includes('INSERT INTO Images')) {
    const payload = {
      Image_ID: params[0],
      Question_ID: params[1],
      Image_Path: params[2],
      Image_Description: params[3],
      Image_Type: params[4]
    };
    await Images.create(payload);
    return { lastID: payload.Image_ID, changes: 1 };
  }

  if (normalized.includes('INSERT OR REPLACE INTO SystemSettings')) {
    const key = params[0];
    const value = params[1];
    const result = await SystemSettings.updateOne(
      { Setting_Key: key },
      { $set: { Setting_Value: value } },
      { upsert: true }
    );
    return { lastID: key, changes: (result.modifiedCount || result.upsertedCount || 0) };
  }

  if (normalized.includes("INSERT INTO SystemSettings (Setting_Key, Setting_Value) VALUES ('admin_password'")) {
    const value = params[0];
    const result = await SystemSettings.updateOne(
      { Setting_Key: 'admin_password' },
      { $set: { Setting_Value: value } },
      { upsert: true }
    );
    return { lastID: 'admin_password', changes: (result.modifiedCount || result.upsertedCount || 0) };
  }

  if (normalized.includes('INSERT INTO SystemSettings (Setting_Key, Setting_Value) VALUES (\'admin_password\'')) {
    await SystemSettings.updateOne(
      { Setting_Key: 'admin_password' },
      { $setOnInsert: { Setting_Value: 'NeetPG2026!' } },
      { upsert: true }
    );
    return { lastID: 'admin_password', changes: 1 };
  }

  if (normalized.startsWith('DELETE FROM Images WHERE Question_ID IN (SELECT Question_ID FROM QuestionBank WHERE Upload_ID = ?)')) {
    const uploadId = params[0];
    const questions = await QuestionBank.find({ Upload_ID: uploadId }, { Question_ID: 1, _id: 0 });
    const questionIds = questions.map(q => q.Question_ID);
    const result = await Images.deleteMany({ Question_ID: { $in: questionIds } });
    return { lastID: null, changes: result.deletedCount || 0 };
  }

  if (normalized.startsWith('DELETE FROM Images WHERE Question_ID = ?')) {
    const result = await Images.deleteMany({ Question_ID: params[0] });
    return { lastID: null, changes: result.deletedCount || 0 };
  }

  if (normalized.startsWith('DELETE FROM QuestionBank WHERE Upload_ID = ?')) {
    const uploadId = params[0];
    const questions = await QuestionBank.find({ Upload_ID: uploadId }, { Question_ID: 1, _id: 0 });
    const questionIds = questions.map(q => q.Question_ID);
    await Images.deleteMany({ Question_ID: { $in: questionIds } });
    const result = await QuestionBank.deleteMany({ Upload_ID: uploadId });
    return { lastID: null, changes: result.deletedCount || 0 };
  }

  if (normalized.startsWith('DELETE FROM QuestionBank WHERE Question_ID = ?')) {
    const questionId = params[0];
    await Images.deleteMany({ Question_ID: questionId });
    const result = await QuestionBank.deleteOne({ Question_ID: questionId });
    return { lastID: null, changes: result.deletedCount || 0 };
  }

  if (normalized.startsWith('DELETE FROM UploadHistory WHERE Upload_ID = ?')) {
    const uploadId = params[0];
    const questions = await QuestionBank.find({ Upload_ID: uploadId }, { Question_ID: 1, _id: 0 });
    const questionIds = questions.map(q => q.Question_ID);
    await Images.deleteMany({ Question_ID: { $in: questionIds } });
    await QuestionBank.deleteMany({ Upload_ID: uploadId });
    const result = await UploadHistory.deleteOne({ Upload_ID: uploadId });
    return { lastID: null, changes: result.deletedCount || 0 };
  }

  if (normalized.startsWith('UPDATE UploadHistory SET Questions_Extracted = 0, Processing_Status = ? WHERE Upload_ID = ?')) {
    const result = await UploadHistory.updateOne(
      { Upload_ID: params[1] },
      { $set: { Questions_Extracted: 0, Processing_Status: params[0] } }
    );
    return { lastID: null, changes: result.modifiedCount || 0 };
  }

  if (normalized.startsWith('UPDATE UploadHistory SET Processing_Status = ?, Questions_Extracted = 0 WHERE Upload_ID = ?')) {
    const result = await UploadHistory.updateOne(
      { Upload_ID: params[1] },
      { $set: { Processing_Status: params[0], Questions_Extracted: 0 } }
    );
    return { lastID: null, changes: result.modifiedCount || 0 };
  }

  if (normalized.startsWith('UPDATE UploadHistory SET Questions_Extracted = ?, Processing_Status = ? WHERE Upload_ID = ?')) {
    const result = await UploadHistory.updateOne(
      { Upload_ID: params[2] },
      { $set: { Questions_Extracted: params[0], Processing_Status: params[1] } }
    );
    return { lastID: null, changes: result.modifiedCount || 0 };
  }

  if (normalized.startsWith('UPDATE UploadHistory SET Processing_Status = ? WHERE Upload_ID = ?')) {
    const result = await UploadHistory.updateOne(
      { Upload_ID: params[1] },
      { $set: { Processing_Status: params[0] } }
    );
    return { lastID: null, changes: result.modifiedCount || 0 };
  }

  if (normalized.startsWith('UPDATE QuestionBank SET Answer_Explanation = ?, Subject = ?, Chapter = ?, Topic = ?, Difficulty_Level = ?, Clinical_or_Conceptual = ?, Question_Type = ?, Keywords = ?, Gemini_Enriched = 1 WHERE Question_ID = ?')) {
    const result = await QuestionBank.updateOne(
      { Question_ID: params[8] },
      {
        $set: {
          Answer_Explanation: params[0],
          Subject: params[1],
          Chapter: params[2],
          Topic: params[3],
          Difficulty_Level: params[4],
          Clinical_or_Conceptual: params[5],
          Question_Type: params[6],
          Keywords: params[7],
          Gemini_Enriched: true,
          Updated_Date: new Date()
        }
      }
    );
    return { lastID: null, changes: result.modifiedCount || 0 };
  }

  if (normalized.startsWith('UPDATE QuestionBank SET Subject =')) {
    if (normalized.includes("WHERE LOWER(TRIM(Subject)) = 'anesthesia'")) {
      const result = await QuestionBank.updateMany(
        { Subject: { $regex: /^anesthesia$/i } },
        { $set: { Subject: 'Anaesthesia' } }
      );
      return { lastID: null, changes: result.modifiedCount || 0 };
    }
    if (normalized.includes("WHERE LOWER(TRIM(Subject)) = 'general medicine'")) {
      const result = await QuestionBank.updateMany(
        { Subject: { $regex: /^general medicine$/i } },
        { $set: { Subject: 'Medicine' } }
      );
      return { lastID: null, changes: result.modifiedCount || 0 };
    }
    if (normalized.includes("WHERE LOWER(TRIM(Subject)) = 'embryology' OR LOWER(TRIM(Subject)) = 'histology'")) {
      const result = await QuestionBank.updateMany(
        { Subject: { $in: [/^embryology$/i, /^histology$/i] } },
        { $set: { Subject: 'Anatomy' } }
      );
      return { lastID: null, changes: result.modifiedCount || 0 };
    }
    if (normalized.includes("WHERE LOWER(TRIM(Subject)) = 'obstetrics and gynecology'")) {
      const result = await QuestionBank.updateMany(
        {
          Subject: {
            $in: [
              /^obstetrics and gynecology$/i,
              /^obstetrics & gynecology$/i,
              /^obstetrics and gynaecology$/i
            ]
          }
        },
        { $set: { Subject: 'Gynaecology & Obstetrics' } }
      );
      return { lastID: null, changes: result.modifiedCount || 0 };
    }
  }

  throw new Error(`Unsupported run query for Mongo adapter: ${normalized}`);
}

function parseQuestionBankFilterSql(sql, params) {
  const filter = {};
  let idx = 0;

  const applyFieldEq = (field, transform = v => v) => {
    if (sql.includes(`AND ${field} = ?`)) {
      filter[field] = transform(params[idx]);
      idx += 1;
    }
  };

  applyFieldEq('Upload_ID');
  applyFieldEq('Subject');
  applyFieldEq('Difficulty_Level');
  applyFieldEq('Previous_Year', v => parseInt(v, 10));
  applyFieldEq('Image_Present', v => boolFromSqlValue(v));

  if (sql.includes('Question_Text LIKE ? OR Option_A LIKE ? OR Option_B LIKE ? OR Option_C LIKE ? OR Option_D LIKE ? OR Keywords LIKE ?')) {
    const raw = params[idx] || '';
    const token = String(raw).replace(/^%|%$/g, '');
    const regex = new RegExp(escapeRegExp(token), 'i');
    filter.$or = [
      { Question_Text: regex },
      { Option_A: regex },
      { Option_B: regex },
      { Option_C: regex },
      { Option_D: regex },
      { Keywords: regex }
    ];
    idx += 6;
  }

  return { filter, consumed: idx };
}

async function executeGet(sql, params) {
  const normalized = normalizeSql(sql);

  if (normalized === 'SELECT * FROM UploadHistory WHERE Upload_ID = ?') {
    return toPlain(await UploadHistory.findOne({ Upload_ID: params[0] }).lean());
  }

  if (normalized === 'SELECT * FROM QuestionBank WHERE Question_ID = ?') {
    return toPlain(await QuestionBank.findOne({ Question_ID: params[0] }).lean());
  }

  if (normalized === "SELECT Setting_Value FROM SystemSettings WHERE Setting_Key = 'gemini_api_key'" ||
      normalized === "SELECT Setting_Value FROM SystemSettings WHERE Setting_Key = 'admin_password'") {
    const key = normalized.includes('gemini_api_key') ? 'gemini_api_key' : 'admin_password';
    return toPlain(await SystemSettings.findOne({ Setting_Key: key }, { _id: 0, Setting_Value: 1 }).lean());
  }

  if (normalized === 'SELECT Setting_Value FROM SystemSettings WHERE Setting_Key = ?') {
    return toPlain(await SystemSettings.findOne({ Setting_Key: params[0] }, { _id: 0, Setting_Value: 1 }).lean());
  }

  if (normalized === "SELECT 1 FROM SystemSettings WHERE Setting_Key = 'admin_password'") {
    const row = await SystemSettings.findOne({ Setting_Key: 'admin_password' }, { _id: 0, Setting_Key: 1 }).lean();
    return row ? { 1: 1 } : null;
  }

  if (normalized.startsWith('SELECT COUNT(*) as count FROM QuestionBank WHERE 1=1')) {
    const { filter } = parseQuestionBankFilterSql(normalized, params);
    const count = await QuestionBank.countDocuments(filter);
    return { count };
  }

  if (normalized === 'SELECT COUNT(*) as count FROM QuestionBank') {
    const count = await QuestionBank.countDocuments({});
    return { count };
  }

  if (normalized === 'SELECT COUNT(*) as count FROM QuestionBank WHERE Image_Present = 1') {
    const count = await QuestionBank.countDocuments({ Image_Present: true });
    return { count };
  }

  throw new Error(`Unsupported get query for Mongo adapter: ${normalized}`);
}

async function executeAll(sql, params) {
  const normalized = normalizeSql(sql);

  if (normalized === 'SELECT * FROM UploadHistory ORDER BY Upload_Date DESC') {
    return UploadHistory.find({}).sort({ Upload_Date: -1 }).lean();
  }

  if (normalized.startsWith('SELECT * FROM QuestionBank WHERE 1=1')) {
    const { filter, consumed } = parseQuestionBankFilterSql(normalized, params);
    let limit = 0;
    let offset = 0;
    if (normalized.includes('ORDER BY Question_Number ASC LIMIT ? OFFSET ?')) {
      limit = parseInt(params[consumed], 10);
      offset = parseInt(params[consumed + 1], 10);
    }
    return QuestionBank.find(filter)
      .sort({ Question_Number: 1 })
      .skip(offset)
      .limit(limit)
      .lean();
  }

  if (normalized === 'SELECT * FROM Images WHERE Question_ID = ?') {
    return Images.find({ Question_ID: params[0] }).lean();
  }

  if (normalized === 'SELECT * FROM QuestionBank ORDER BY Question_Number ASC') {
    return QuestionBank.find({}).sort({ Question_Number: 1 }).lean();
  }

  if (normalized === 'SELECT * FROM QuestionBank WHERE Upload_ID = ? ORDER BY Question_Number ASC') {
    return QuestionBank.find({ Upload_ID: params[0] }).sort({ Question_Number: 1 }).lean();
  }

  if (normalized.startsWith('SELECT i.Image_ID, i.Question_ID, i.Image_Path, i.Image_Description, i.Image_Type, q.Question_Number, q.Subject FROM Images i JOIN QuestionBank q ON i.Question_ID = q.Question_ID')) {
    const filter = {};
    if (normalized.includes('WHERE q.Upload_ID = ?')) filter.Upload_ID = params[0];
    const qById = new Map();
    const qRows = await QuestionBank.find(filter, { Question_ID: 1, Question_Number: 1, Subject: 1, _id: 0 }).lean();
    qRows.forEach(q => qById.set(q.Question_ID, q));
    const imageQuery = qRows.length ? { Question_ID: { $in: qRows.map(q => q.Question_ID) } } : {};
    const images = await Images.find(imageQuery).lean();
    return images
      .filter(img => qById.has(img.Question_ID))
      .map(img => ({
        Image_ID: img.Image_ID,
        Question_ID: img.Question_ID,
        Image_Path: img.Image_Path,
        Image_Description: img.Image_Description,
        Image_Type: img.Image_Type,
        Question_Number: qById.get(img.Question_ID).Question_Number,
        Subject: qById.get(img.Question_ID).Subject
      }));
  }

  if (normalized === 'SELECT * FROM QuestionBank WHERE Upload_ID = ?') {
    return QuestionBank.find({ Upload_ID: params[0] }).lean();
  }

  if (normalized === 'SELECT Subject, COUNT(*) as count FROM QuestionBank GROUP BY Subject ORDER BY count DESC') {
    return QuestionBank.aggregate([
      { $group: { _id: '$Subject', count: { $sum: 1 } } },
      { $project: { _id: 0, Subject: '$_id', count: 1 } },
      { $sort: { count: -1 } }
    ]);
  }

  if (normalized === 'SELECT Chapter, COUNT(*) as count FROM QuestionBank GROUP BY Chapter ORDER BY count DESC') {
    return QuestionBank.aggregate([
      { $group: { _id: '$Chapter', count: { $sum: 1 } } },
      { $project: { _id: 0, Chapter: '$_id', count: 1 } },
      { $sort: { count: -1 } }
    ]);
  }

  if (normalized === 'SELECT OCR_Confidence, COUNT(*) as count FROM QuestionBank GROUP BY OCR_Confidence') {
    return QuestionBank.aggregate([
      { $group: { _id: '$OCR_Confidence', count: { $sum: 1 } } },
      { $project: { _id: 0, OCR_Confidence: '$_id', count: 1 } }
    ]);
  }

  if (normalized === 'SELECT Previous_Year as year, COUNT(*) as count FROM QuestionBank WHERE Previous_Year IS NOT NULL GROUP BY Previous_Year ORDER BY Previous_Year DESC') {
    return QuestionBank.aggregate([
      { $match: { Previous_Year: { $ne: null } } },
      { $group: { _id: '$Previous_Year', count: { $sum: 1 } } },
      { $project: { _id: 0, year: '$_id', count: 1 } },
      { $sort: { year: -1 } }
    ]);
  }

  if (normalized === "SELECT Upload_ID as uploadId, File_Name as fileName FROM UploadHistory WHERE Processing_Status = 'COMPLETED' ORDER BY Upload_Date DESC") {
    return UploadHistory.find(
      { Processing_Status: 'COMPLETED' },
      { _id: 0, Upload_ID: 1, File_Name: 1 }
    )
      .sort({ Upload_Date: -1 })
      .lean()
      .then(rows => rows.map(r => ({ uploadId: r.Upload_ID, fileName: r.File_Name })));
  }

  if (normalized === "SELECT Previous_Year as year, Subject, COUNT(*) as count FROM QuestionBank WHERE Previous_Year IS NOT NULL AND Subject IS NOT NULL AND Subject != '' GROUP BY Previous_Year, Subject ORDER BY Previous_Year DESC, count DESC") {
    return QuestionBank.aggregate([
      { $match: { Previous_Year: { $ne: null }, Subject: { $nin: [null, ''] } } },
      { $group: { _id: { year: '$Previous_Year', subject: '$Subject' }, count: { $sum: 1 } } },
      { $project: { _id: 0, year: '$_id.year', Subject: '$_id.subject', count: 1 } },
      { $sort: { year: -1, count: -1 } }
    ]);
  }

  if (normalized === 'SELECT Previous_Year as year, COUNT(*) as total FROM QuestionBank WHERE Previous_Year IS NOT NULL GROUP BY Previous_Year') {
    return QuestionBank.aggregate([
      { $match: { Previous_Year: { $ne: null } } },
      { $group: { _id: '$Previous_Year', total: { $sum: 1 } } },
      { $project: { _id: 0, year: '$_id', total: 1 } }
    ]);
  }

  if (normalized === "SELECT Previous_Year as year, COUNT(*) as imageCount FROM QuestionBank WHERE Previous_Year IS NOT NULL AND (Image_Present = 1 OR Image_Present = 'true') GROUP BY Previous_Year") {
    return QuestionBank.aggregate([
      { $match: { Previous_Year: { $ne: null }, Image_Present: true } },
      { $group: { _id: '$Previous_Year', imageCount: { $sum: 1 } } },
      { $project: { _id: 0, year: '$_id', imageCount: 1 } }
    ]);
  }

  if (normalized === "SELECT Previous_Year as year, COUNT(*) as clinicalCount FROM QuestionBank WHERE Previous_Year IS NOT NULL AND Clinical_or_Conceptual = 'Clinical Scenario' GROUP BY Previous_Year") {
    return QuestionBank.aggregate([
      { $match: { Previous_Year: { $ne: null }, Clinical_or_Conceptual: 'Clinical Scenario' } },
      { $group: { _id: '$Previous_Year', clinicalCount: { $sum: 1 } } },
      { $project: { _id: 0, year: '$_id', clinicalCount: 1 } }
    ]);
  }

  if (normalized === 'SELECT * FROM QuestionBank WHERE Gemini_Enriched = 0') {
    return QuestionBank.find({ Gemini_Enriched: false }).lean();
  }

  if (normalized === 'SELECT * FROM QuestionBank WHERE Gemini_Enriched = 0 AND Upload_ID = ?') {
    return QuestionBank.find({ Gemini_Enriched: false, Upload_ID: params[0] }).lean();
  }

  throw new Error(`Unsupported all query for Mongo adapter: ${normalized}`);
}

const dbQuery = {
  async run(sql, params = []) {
    return executeRun(sql, params);
  },
  async get(sql, params = []) {
    return executeGet(sql, params);
  },
  async all(sql, params = []) {
    return executeAll(sql, params);
  }
};

async function initDatabase() {
  if (!mongoUri) {
    throw new Error('MONGODB_URI is required for MongoDB Atlas integration.');
  }

  await mongoose.connect(mongoUri, {
    autoIndex: true
  });

  await SystemSettings.updateOne(
    { Setting_Key: 'admin_password' },
    { $setOnInsert: { Setting_Value: 'NeetPG2026!' } },
    { upsert: true }
  );

  // One-time subject normalization migration for historic data.
  await QuestionBank.updateMany(
    { Subject: { $regex: /^anesthesia$/i } },
    { $set: { Subject: 'Anaesthesia' } }
  );
  await QuestionBank.updateMany(
    { Subject: { $regex: /^general medicine$/i } },
    { $set: { Subject: 'Medicine' } }
  );
  await QuestionBank.updateMany(
    { Subject: { $in: [/^embryology$/i, /^histology$/i] } },
    { $set: { Subject: 'Anatomy' } }
  );
  await QuestionBank.updateMany(
    {
      Subject: {
        $in: [
          /^obstetrics and gynecology$/i,
          /^obstetrics & gynecology$/i,
          /^obstetrics and gynaecology$/i
        ]
      }
    },
    { $set: { Subject: 'Gynaecology & Obstetrics' } }
  );

  console.log('Connected to MongoDB and verified collections/indexes.');
}

module.exports = {
  db: mongoose.connection,
  models: {
    UploadHistory,
    QuestionBank,
    Images,
    SystemSettings
  },
  dbQuery,
  initDatabase
};
