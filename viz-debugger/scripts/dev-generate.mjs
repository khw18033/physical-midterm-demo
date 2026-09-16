// 생성 서비스(gen-lab · 8802)를 띄운다 (260914). `dev-stt.mjs` 와 같은 자리다 —
// **떠 있지 않아도 나머지는 뜨므로** 여기서 실패하면 이유를 한 줄 남기고 물러난다 (`verify:no-llm`).
//
// ## STT 와 다른 것 둘
//
// 1. **`gen-lab/.venv` 가 없으면 띄우지 않는다.** STT 는 PATH 의 python 으로 한 번 시도하는데,
//    260914 에 노트북에서 그 길이 문제를 가렸다 — fastapi 만 있는 python 으로 서비스가 뜨고
//    엔진만 없어서 「연결은 되는데 503」이 됐다. 없으면 없다고 말하고 만다.
//    다른 python 을 쓰려면 `VIZ_GENERATE_PYTHON` 으로 **명시**한다.
//
// 2. **끌 때 프로세스 트리째 내린다.** gen-lab 은 모델을 쓸 때 `llama-server` 를 자식으로
//    띄운다. 부모만 죽이면 그 자식이 8803 과 VRAM 을 잡은 채 남고, 다음 실행이 그 유령에게
//    물어본다(gen-lab/README.md 「유령 llama-server」). gen-lab 의 shutdown 훅은 정상 종료에서만
//    돌기 때문에, 강제로 내리는 여기서는 기대할 수 없다.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const labDir = join(root, '..', 'gen-lab');

function pythonPath() {
  if (process.env.VIZ_GENERATE_PYTHON) return process.env.VIZ_GENERATE_PYTHON;
  const venv = process.platform === 'win32'
    ? join(labDir, '.venv', 'Scripts', 'python.exe')
    : join(labDir, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : null;
}

export function startGenerate() {
  if (!existsSync(join(labDir, 'server', 'main.py'))) {
    console.warn('[generate] gen-lab/server/main.py 가 없다 — 생성 없이 진행한다');
    return null;
  }
  const python = pythonPath();
  if (python === null) {
    console.warn('[generate] gen-lab/.venv 가 없어 생성 서비스를 띄우지 않는다 — 화면은 그대로 뜨고 생성만 꺼진다.');
    console.warn('[generate] 환경 준비 절차는 저장소 루트 README.md 의 「음성 인식(STT)과 생성까지 붙이려면」.');
    return null;
  }
  const child = spawn(python, ['-m', 'server.main'], { cwd: labDir, stdio: 'inherit' });
  child.on('error', (error) => {
    console.warn(`[generate] 띄우지 못했다 (${error.message}) — 화면은 그대로 뜨고 생성만 꺼진다.`);
  });
  child.on('exit', (code) => {
    // 가장 흔한 것은 따로 띄워 둔 gen-lab 이 8802 를 이미 잡고 있는 경우다 — 그때는 그쪽이
    // 답하므로 화면에서는 멀쩡하다. 사유는 위쪽 uvicorn 로그에 있다.
    if (code) console.warn(`[generate] 종료(코드 ${code}) — 생성만 꺼진다. 8802 를 이미 쓰고 있지 않은지 위 로그를 볼 것.`);
  });
  return child;
}

/** 생성 서비스와 그 자식(`llama-server`)까지 내린다. 이미 내려갔으면 아무것도 안 한다. */
export function stopGenerate(child) {
  if (child === null || child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    // `/T` 가 자식까지 — venv 의 python.exe 는 진짜 python 을 한 번 더 띄우는 껍데기라,
    // 트리가 아니면 껍데기만 죽는다.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');   // uvicorn 이 받아 shutdown 훅을 돌리고, 훅이 llama-server 를 내린다
  }
}

// 단독 실행(`npm run dev:generate`)일 때만 여기서 띄운다.
if (process.argv[1]?.endsWith('dev-generate.mjs')) {
  const child = startGenerate();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopGenerate(child); process.exit(0); });
}
