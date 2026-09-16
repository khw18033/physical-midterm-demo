/**
 * scripts/dev-all.mjs
 *
 * 목 게이트웨이와 Vite 개발 서버를 한 번에 띄운다.
 * 라이브러리를 늘리지 않으려고 concurrently 같은 도구 대신 child_process만 쓴다.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const procs = [];

// shell 없이 스크립트 파일을 직접 실행한다 — shell:true + args 조합은 인자가
// 이스케이프되지 않고 이어붙기만 해서 Node가 경고한다(DEP0190).
function start(name, args) {
  const p = spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  p.on('exit', (code) => {
    process.stdout.write('[dev-all] ' + name + ' 종료 (code=' + code + ')\n');
    stopAll();
    process.exit(code ?? 0);
  });
  procs.push(p);
  return p;
}

function stopAll() {
  for (const p of procs) {
    if (!p.killed) p.kill();
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopAll();
    process.exit(0);
  });
}

start('mock-gateway', ['mock-gateway/server.ts']);
start('vite', [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')]);
