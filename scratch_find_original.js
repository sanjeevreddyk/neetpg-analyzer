const fs = require('fs');

const logPath = 'C:\\Users\\himab\\.gemini\\antigravity\\brain\\a8a7b825-c187-4afb-96c1-4a3461434fad\\.system_generated\\logs\\transcript.jsonl';

try {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  
  let stepLine = lines.find(l => l.includes('"step_index":832'));
  if (!stepLine) {
    stepLine = lines.find(l => l.includes('replace_file_content') && l.includes('isFormat2'));
  }
  
  if (stepLine) {
    const obj = JSON.parse(stepLine);
    const prevStepIndex = obj.step_index - 1;
    const prevLine = lines.find(l => l.includes(`"step_index":${prevStepIndex}`));
    if (prevLine) {
      const prevObj = JSON.parse(prevLine);
      const args = prevObj.tool_calls[0].args;
      
      // Write the complete ReplacementContent and TargetContent to recovered files!
      fs.writeFileSync('recovered_replacement.txt', args.ReplacementContent);
      fs.writeFileSync('recovered_target.txt', args.TargetContent);
      console.log('Successfully wrote recovered_replacement.txt and recovered_target.txt!');
    } else {
      console.log('Previous step line not found');
    }
  } else {
    console.log('Step line not found');
  }
} catch (err) {
  console.error('Error:', err.message);
}
