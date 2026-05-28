const { spawn } = require('child_process');
const path = require('path');

console.log('⚡ Starting NEET PG Question Processing System in developer mode...');

// Determine package manager run executable (cross-platform fallback for Windows)
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// 1. Spawning Backend Server (Port 5000)
const backend = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: ['pipe', 'pipe', 'pipe']
});

backend.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(`[Backend] ${output}`);
});

backend.stderr.on('data', (data) => {
  process.stderr.write(`[Backend ERROR] ${data.toString()}`);
});

// 2. Spawning Frontend Dev Server (Port 3000)
const frontend = spawn(npmCmd, ['run', 'dev'], {
  cwd: path.join(__dirname, 'client'),
  stdio: ['pipe', 'pipe', 'pipe']
});

let browserOpened = false;

frontend.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(`[Frontend] ${output}`);

  // Automatically detect when Vite dev server is ready and launch default browser
  if (!browserOpened && (output.includes('Local:') || output.includes('ready in'))) {
    browserOpened = true;
    const appUrl = 'http://localhost:3000';
    console.log(`\n🚀 Ingestion Console is ready! Launching default browser at ${appUrl}...\n`);

    try {
      const openCommand = process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', appUrl])
        : process.platform === 'darwin'
        ? spawn('open', [appUrl])
        : spawn('xdg-open', [appUrl]);

      openCommand.on('error', (err) => {
        console.error('Failed to open browser automatically:', err.message);
      });
    } catch (err) {
      console.error('Failed to open browser automatically:', err.message);
    }
  }
});

frontend.stderr.on('data', (data) => {
  process.stderr.write(`[Frontend ERROR] ${data.toString()}`);
});

// Handle termination signals to cleanly kill child processes
const cleanup = () => {
  console.log('\n🛑 Shutting down backend and frontend services...');
  backend.kill();
  frontend.kill();
  process.exit();
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
