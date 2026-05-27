const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const path = require('path');

async function inspectPDF(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data: dataBuffer });

  const textResult = await parser.getText();
  await parser.destroy();

  const rawText = textResult.text || '';
  
  console.log('=== RAW TEXT SAMPLE (first 4000 chars) ===');
  console.log(rawText.substring(0, 4000));
  console.log('\n=== Checking for known format markers ===');
  console.log('Contains "Ques No:":', /Ques No:/i.test(rawText));
  console.log('Contains "O1:":', /\bO1:/i.test(rawText));
  console.log('Contains "Ans:":', /\bAns:/i.test(rawText));
  console.log('Contains "Q." numbered (e.g. Q.1.):', /\bQ\.?\s*\d+\./i.test(rawText));
  console.log('Contains "(a)" options:', /\(a\)/i.test(rawText));
  console.log('Contains "A)" options:', /^A\)/m.test(rawText));
  console.log('Contains numeric "1." question start:', /^\d+\.\s/m.test(rawText));
  
  console.log('\n=== Line-by-line first 100 non-empty lines ===');
  const lines = rawText.split('\n').filter(l => l.trim());
  lines.slice(0, 100).forEach((line, idx) => {
    console.log(`L${idx + 1}: ${JSON.stringify(line)}`);
  });
}

const uploadsDir = path.resolve(__dirname, 'public/uploads');
const pdfs = fs.readdirSync(uploadsDir).filter(f => f.toLowerCase().endsWith('.pdf'));
if (pdfs.length === 0) {
  console.log('No PDF files found in public/uploads. Please re-upload the 2024 paper first.');
  process.exit(1);
}

console.log(`Found ${pdfs.length} PDF(s): ${pdfs.join(', ')}`);
console.log('Inspecting first found:', pdfs[0], '\n');
inspectPDF(path.join(uploadsDir, pdfs[0])).catch(console.error);
