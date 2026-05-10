import { spawn } from 'child_process';

function start(label: string, script: string) {
  const proc = spawn('node', [script], { stdio: 'inherit' });
  proc.on('exit', (code, signal) => {
    process.stdout.write(`[${label}] exited code=${code ?? ''} signal=${signal ?? ''}\n`);
  });
  return proc;
}

const server = start('server', 'dist/server.js');
const worker = start('worker', 'dist/worker.js');

const shutdown = () => {
  server.kill('SIGTERM');
  worker.kill('SIGTERM');
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
