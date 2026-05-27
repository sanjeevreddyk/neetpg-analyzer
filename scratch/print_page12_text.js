const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const filePath = 'C:\\Users\\himab\\OneDrive\\ドキュメント\\Neet_PG_Question_analysis\\public\\uploads\\e8f43c61-7cc4-47ab-af3a-0f01f7220fd5.pdf';

async function run() {
  const dataBuffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: dataBuffer });
  
  // Custom font extraction
  const doc = await parser.load();
  const page = await doc.getPage(12);
  await page.getOperatorList();
  const textContent = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  
  const o = [];
  let l, h;
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
  
  console.log('=== PAGE 12 RICH TEXT ===');
  console.log(o.join(''));
  
  await page.cleanup();
  await parser.destroy();
}

run().catch(console.error);
