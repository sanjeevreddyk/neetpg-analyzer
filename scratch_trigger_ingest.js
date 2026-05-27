const http = require('http');

const uploadId = '4171e161-b019-48df-93ef-401cebdb7a93';

function post(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(data);
    const options = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function run() {
  console.log('Triggering ingestion for uploadId:', uploadId);
  try {
    const triggerRes = await post('http://localhost:5000/api/process', { uploadId });
    console.log(`Trigger Response (HTTP ${triggerRes.statusCode}):`, triggerRes.body);
    
    if (triggerRes.statusCode !== 200) {
      console.error('Trigger failed!');
      return;
    }
    
    // Poll status
    console.log('\n--- Polling Ingestion Status ---');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusRes = await get(`http://localhost:5000/api/processingStatus?uploadId=${uploadId}`);
      console.log(`Poll #${i+1}: status =`, statusRes.body);
      
      const parsed = JSON.parse(statusRes.body);
      if (parsed.status === 'COMPLETED') {
        console.log('\n====================================');
        console.log('Ingestion completed successfully!');
        console.log(`Questions Extracted: ${parsed.questionsExtracted}`);
        console.log('====================================');
        break;
      } else if (parsed.status === 'FAILED') {
        console.error('\nIngestion failed!');
        break;
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}

run();
