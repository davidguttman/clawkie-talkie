// Local dev orchestrator for Clawkie-Talkie.
//
// Runs the two processes the stack needs:
//   1. daemon  — peerjs host (reads XAI_API_KEY and other config from the
//                process environment; the dev:daemon script also loads a
//                repo-root .env if one is present, but it's optional)
//   2. client  — vite dev server on http://localhost:5173
//
// If either process exits, the other is killed; Ctrl-C kills both.
// This script takes no args and has no deps — keep it tiny.

import { spawn } from 'node:child_process';
import process from 'node:process';

const procs = [
  { name: 'daemon', args: ['run', 'dev:daemon'] },
  { name: 'client', args: ['run', 'dev:client'] },
];

const children = procs.map(({ name, args }) => {
  const child = spawn('npm', args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.log(`[dev] ${name} exited (code=${code}, signal=${signal})`);
    shutdown(code ?? 1);
  });
  child.on('error', (err) => {
    console.error(`[dev] ${name} spawn error:`, err);
    shutdown(1);
  });
  return { name, child };
});

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.killed || child.exitCode !== null) continue;
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
