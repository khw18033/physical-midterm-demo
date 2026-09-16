// STT 서비스를 띄운다. **떠 있지 않아도 나머지는 뜨므로** 여기서 실패하면
// 이유를 한 줄 남기고 조용히 물러난다 (제약 5 · VZ-C-02).
//
// 파이썬 환경을 여기서 만들어 주지 않는다. 없으면 없다고 말하고 만다 —
// 첫 실행에 몇 분짜리 설치가 말없이 시작되면 "왜 안 뜨지"를 진단할 수가 없다.
// 만드는 절차는 stt/README.md 에 있다.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sttDir = join(root, 'stt');

/** 전용 가상환경이 있으면 그것을 쓴다. 없으면 PATH 의 python 으로 시도한다. */
function pythonPath() {
  const venv = process.platform === 'win32'
    ? join(sttDir, '.venv', 'Scripts', 'python.exe')
    : join(sttDir, '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;
  return process.env.VIZ_STT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export function startStt() {
  const python = pythonPath();
  if (!existsSync(join(sttDir, 'service.py'))) {
    console.warn('[stt] stt/service.py 가 없다 — 음성 인식 없이 진행한다');
    return null;
  }
  const child = spawn(python, ['service.py'], { cwd: sttDir, stdio: 'inherit' });
  child.on('error', (error) => {
    console.warn(`[stt] 띄우지 못했다 (${error.message}) — 화면은 그대로 뜨고 음성 기능만 꺼진다.`);
    console.warn('[stt] 환경 준비 절차는 viz-debugger/stt/README.md 를 볼 것.');
  });
  child.on('exit', (code) => {
    if (code) console.warn(`[stt] 종료(코드 ${code}) — 음성 기능만 꺼진다. 나머지 화면은 그대로다.`);
  });
  return child;
}

// 단독 실행(`npm run dev:stt`)일 때만 여기서 띄운다.
if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}` || process.argv[1].endsWith('dev-stt.mjs')) {
  const child = startStt();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child?.kill(); process.exit(0); });
}
