// Simple supervisor to keep server alive and restart immediately on crash
const { spawn } = require('child_process');

let restarting = false;
let child = null;

function start() {
  restarting = false;
  child = spawn(process.execPath, ['server.js'], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    // If the parent is exiting intentionally, don't respawn
    if (restarting) return;
    console.error(`Server exited with code=${code} signal=${signal}. Restarting...`);
    // Immediate restart with a tiny delay to avoid hot loops
    setTimeout(start, 250);
  });

  child.on('error', (err) => {
    console.error('Failed to start server process:', err);
    setTimeout(start, 1000);
  });
}

// Handle Ctrl+C and parent termination gracefully
function shutdown() {
  restarting = true;
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
