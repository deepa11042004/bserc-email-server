import { spawn } from 'child_process';
import { createInterface } from 'readline';

let shuttingDown = false;

function start(label: string, script: string) {
  console.log(`[start-all] starting ${label} → node ${script}`);

  const proc = spawn('node', [script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  createInterface({ input: proc.stdout! }).on('line', (line) =>
    process.stdout.write(`[${label}] ${line}\n`),
  );

  createInterface({ input: proc.stderr! }).on('line', (line) =>
    process.stderr.write(`[${label}] ${line}\n`),
  );

  proc.on('exit', (code, signal) => {
    console.log(
      `[start-all] ${label} stopped — code=${code ?? '-'} signal=${signal ?? '-'}`,
    );
    if (!shuttingDown) {
      // One process died unexpectedly — exit so Render restarts the whole service
      console.error(`[start-all] ${label} exited unexpectedly, restarting service`);
      process.exitCode = 1;
      shutdown();
    }
  });

  return proc;
}

const server = start('server', 'dist/server.js');
const worker = start('worker', 'dist/worker.js');

console.log('[start-all] both server and worker are running');

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[start-all] shutting down...');
  server.kill('SIGTERM');
  worker.kill('SIGTERM');
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
