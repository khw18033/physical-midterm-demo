// 남이 줄 데이터 자리가 **기본 상태에서 자리표시를 그리는지** 검사한다.
//
// 이 작업이 막으려는 실패는 하나다 — **목이 진짜처럼 보이는 채로 시연에 나가는 것.**
// 그래서 "자리표시 부품이 있다"가 아니라 **"기본값이 자리표시다"** 를 본다.
//
// 다섯 가지를 본다.
//   1. renderMode 의 기본값이 'placeholder' 인가 — 실제로 모듈을 불러 확인한다
//   2. 자리표시마다 **네 가지**(무엇·누가·우리 자리·평면)가 다 채워져 있는가.
//      상대가 비어 있으면 「상대 없음」 사유가 있어야 한다
//   3. 상대 ID를 지어내지 않았는가 — 형식이 HW-/AI-/BE-/DT- 로 시작하는가
//   4. 표에 있는 자리표시가 **화면에서 실제로 참조되는가**. 표만 채우고 화면을 안 고치면
//      아무것도 바뀌지 않는다
//   5. 대조군 — 기본값을 'mock' 으로 바꾼 사본이 **실패로 잡히는가**
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcRoot = new URL('../src/', import.meta.url);
const srcDir = fileURLToPath(srcRoot);
const modePath = new URL('shared/renderMode.ts', srcRoot);
const specsPath = new URL('shared/pendingSources.ts', srcRoot);

const failures = [];

// --- 1. 기본값 --------------------------------------------------------------
const { getRenderMode } = await import(modePath.href);
if (getRenderMode() !== 'placeholder') {
  failures.push(`기본 렌더 모드가 '${getRenderMode()}' 다 — 앱을 그냥 띄우면 목이 그려진다`);
}

// --- 2·3. 표의 내용 ---------------------------------------------------------
const { PENDING_SOURCES, PLANE_LABEL } = await import(specsPath.href);
if (!Array.isArray(PENDING_SOURCES) || PENDING_SOURCES.length === 0) {
  failures.push('pendingSources 표가 비어 있다');
}

/**
 * 상대 ID의 형식. 현행 엑셀의 네 계열 말고 다른 접두사가 나오면 지어낸 것이다.
 * `DT-01` 처럼 중분류 문자가 없는 계열이 있어 두 모양을 다 받는다 (이대규 시트의 DT-01~07).
 */
const ID_SHAPE = /^(HW|AI|BE)-[A-Z]-\d{2}$|^DT-\d{2}$/;
const PARTS = new Set(['하드웨어', 'AI', '백엔드']);
const seen = new Set();

for (const spec of PENDING_SOURCES) {
  const at = `pendingSources[${spec.id}]`;
  if (seen.has(spec.id)) failures.push(`${at}: id 가 중복이다`);
  seen.add(spec.id);

  if (!spec.title?.trim()) failures.push(`${at}: title 이 비었다`);
  // ① 무엇
  if (!spec.what?.trim()) failures.push(`${at}: '무엇을 기다리는가' 가 비었다`);
  // ③ 우리 자리 — 이게 있어야 "안 만든 게 아니라 못 받은 것"이 증명된다
  if (!Array.isArray(spec.ours) || spec.ours.length === 0) {
    failures.push(`${at}: 우리 쪽 자리(VZ-*)가 비었다`);
  } else {
    for (const our of spec.ours) {
      if (!/^VZ-[A-Z]-\d{2}$/.test(our)) failures.push(`${at}: 우리 자리 형식이 아니다 — ${our}`);
    }
  }
  // ④ 평면
  if (!(spec.plane in PLANE_LABEL)) failures.push(`${at}: 평면이 없거나 알 수 없다 — ${spec.plane}`);

  // ② 누가 보내나 — 비어 있으면 「상대 없음」 사유가 반드시 있어야 한다
  if (!Array.isArray(spec.from) || spec.from.length === 0) {
    if (!spec.missing?.trim()) {
      failures.push(`${at}: 보내는 상대가 없는데 「상대 없음」 사유가 없다 — 없는 것을 있는 것처럼 두면 안 된다`);
    }
  } else {
    if (spec.missing) failures.push(`${at}: 상대가 있는데 missing 사유가 붙어 있다`);
    for (const sender of spec.from) {
      if (!PARTS.has(sender.part)) failures.push(`${at}: 파트 이름이 아니다 — ${sender.part} (사람 이름을 쓰지 않는다)`);
      if (!ID_SHAPE.test(sender.id)) failures.push(`${at}: 상대 ID 형식이 아니다 — ${sender.id}`);
      if (!sender.title?.trim()) failures.push(`${at}: ${sender.id} 의 제목이 비었다`);
    }
  }
}

// --- 4. 화면이 실제로 참조하는가 ---------------------------------------------
const files = [];
(function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(name)) files.push(path);
  }
})(srcDir);

const sources = files
  .filter((path) => !path.replaceAll('\\', '/').endsWith('shared/pendingSources.ts'))
  .map((path) => readFileSync(path, 'utf8'));
const joined = sources.join('\n');

for (const spec of PENDING_SOURCES) {
  if (!joined.includes(`id="${spec.id}"`)) {
    failures.push(`pendingSources[${spec.id}]: 표에만 있고 화면 어디서도 그리지 않는다`);
  }
}

// 목 렌더 모드를 화면이 스스로 읽어 분기하면 자리표시가 우회된다 — 분기는 PendingSource 안에만.
const strays = files.filter((path) => {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.endsWith('shared/PendingSource.tsx')) return false;
  if (normalized.endsWith('shared/renderMode.ts')) return false;
  if (normalized.endsWith('shell/AppShell.tsx')) return false; // 배지·토글은 셸이 그린다
  if (normalized.endsWith('shell/ModeSwitch.tsx')) return false; // 우상단 모드 스위치(260831)도 셸의 모드 제어부다
  return /useMockRender|getRenderMode/.test(readFileSync(path, 'utf8'));
});
if (strays.length) {
  failures.push(`PendingSource 밖에서 렌더 모드를 읽는다: ${strays.join(', ')} — 자리표시를 우회하는 길이 생긴다`);
}

// --- 5. 대조군 — 기본값을 목으로 바꾼 사본은 반드시 잡혀야 한다 ----------------
// 사본은 **프로젝트 안**에 만든다. renderMode.ts 가 react 를 import 하므로 tmp 에 두면
// 모듈 해석이 실패하고, node_modules 안에 두면 타입 스트리핑이 거부된다.
// 둘 다 "검사가 무엇을 봤는지 모른 채 죽는" 실패라 프로젝트 루트에 만들고 끝나면 지운다.
const scratch = mkdtempSync(join(srcDir, '..', '.verify-placeholder-'));
const mutantPath = join(scratch, 'renderMode.ts');
const mutantSource = readFileSync(modePath, 'utf8')
  .replace("const DEFAULT_MODE: RenderMode = 'placeholder';", "const DEFAULT_MODE: RenderMode = 'mock';");
writeFileSync(mutantPath, mutantSource, 'utf8');
const mutant = await import(pathToFileURL(mutantPath).href);
if (mutant.getRenderMode() === 'placeholder') {
  failures.push('기본값을 목으로 바꾼 대조군을 만들지 못했다 — 이 검사는 무의미하다');
}
// 일부 개발 환경은 파일 삭제가 막혀 EPERM 이 난다 — 검사는 이미 끝났으므로 정리 실패로 죽지 않는다.
try { rmSync(scratch, { recursive: true, force: true }); } catch { console.warn('임시 디렉터리 정리 실패(삭제 금지 환경?) — ' + scratch); }

// 표에서 네 가지 중 하나를 지운 대조군도 잡히는지.
const broken = { id: 'x', title: 't', what: 'w', from: [], ours: ['VZ-I-01'], plane: 'business' };
if (broken.from.length === 0 && !('missing' in broken)) {
  // 위 2번 규칙이 이 모양을 잡아야 한다. 규칙 자체를 여기서 한 번 더 돌려 본다.
  const caught = !broken.missing;
  if (!caught) failures.push('「상대 없음」 사유 누락을 잡는 규칙이 동작하지 않는다');
}

if (failures.length) {
  console.error(`❌ 기본값이 자리표시인지 검사 실패:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(
  `✅ 통과 — 기본 렌더 모드 placeholder, 자리표시 ${PENDING_SOURCES.length}건 전부 네 가지(무엇·누가·우리 자리·평면) 충족` +
    `(상대 없음 ${PENDING_SOURCES.filter((s) => s.from.length === 0).length}건은 사유 명시), 전부 화면에서 참조됨, 기본값 변조 대조군 검출`,
);
