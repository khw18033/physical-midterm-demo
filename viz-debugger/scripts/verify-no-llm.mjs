// verify:no-llm (260904 신설 — 마일스톤 분리 지시서 §3)
//
// **생성 서비스가 없어도 화면이 뜨고 대본 재생·되감기·캔버스가 도는가.**
//
// 배치 ①(생성 꺼짐)이 기본형이다 — 심사·평가 배포에는 `dist/` 만 뿌리고 생성 서비스를
// 두지 않는다. 그 상태에서 지금까지 만든 것이 전부 돌아야 한다. 이 검사가 막으려는 실패는
// 「모델을 붙이면서 화면 전체가 모델에 매달리는 것」이다.
//
// `verify:no-stt` 와 같은 모양으로 셋을 본다.
//   1. 서비스가 전부 실패하는 상태에서 `probe()` 가 **던지지 않고** alive:false + 사유를 주는가
//   2. 그 상태의 `capabilities()` 가 **생성만** 끄는가 — 값을 지운 대조군 포함
//   3. `generateMission()` 이 LlmUnavailableError('offline') 를 던지는가
//
// 그리고 `verify:no-stt` 에 없는 넷째를 본다.
//   4. **대본 재생·되감기·캔버스가 생성 계층을 import 하지 않는가.** 이것이 「생성만 꺼진다」의
//      구조적 근거다 — 함수가 true 를 돌려주는 것만으로는 부족하고, 그 셋이 애초에
//      생성 서비스를 모르는지 봐야 한다.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(vizRoot, 'src');
const failures = [];
const controls = [];

// --- 1. 전부 실패하는 LlmClient ------------------------------------------------
// 서비스가 꺼져 있을 때 브라우저 fetch 가 하는 것과 같은 실패를 심는다.
globalThis.fetch = async () => {
  throw new TypeError('Failed to fetch');
};

const client = await import(pathToFileURL(join(srcDir, 'generate', 'LlmClient.ts')).href);
const { LlmUnavailableError } = await import(pathToFileURL(join(srcDir, 'generate', 'types.ts')).href);

let probed;
try {
  probed = await client.probe();
} catch (error) {
  failures.push(`probe() 가 예외를 던졌다 (${error?.name}) — 첫 렌더가 통째로 죽는다`);
}
if (probed?.alive !== false) failures.push(`probe() 가 ${JSON.stringify(probed)} 를 돌려줬다 — 꺼진 서비스를 살아 있다고 봤다`);
if (!probed?.reason) failures.push('probe() 가 실패 사유를 버렸다 — 화면이 「닿지 않습니다」 한 문장밖에 못 적는다');
else if (!probed.reason.includes('8802')) failures.push(`실패 사유에 주소가 없다 — ${probed.reason}`);

try {
  await client.generateMission('503호에서 엘리베이터까지 가줘');
  failures.push('generateMission() 이 실패를 던지지 않았다');
} catch (error) {
  if (!(error instanceof LlmUnavailableError)) failures.push(`generateMission() 이 LlmUnavailableError 가 아닌 ${error?.name} 를 던졌다`);
  else if (error.kind !== 'offline') failures.push(`서비스가 꺼진 실패를 kind='${error.kind}' 로 분류했다 (offline 이어야 한다)`);
}

// 문법은 서비스 없이도 뽑힌다 — 계약이 빌드에 박혀 있기 때문이다.
try {
  const grammar = client.missionGrammar();
  if (!grammar.text.includes('root ::=')) failures.push('계약에서 뽑은 문법에 root 규칙이 없다');
  if (!grammar.digest) failures.push('문법 지문이 비었다 — 「어느 계약으로 만든 문법인가」를 기록에 남길 수 없다');
} catch (error) {
  failures.push(`서비스가 없는데 문법 뽑기가 실패했다 (${error?.message}) — 계약은 빌드에 박혀 있어야 한다`);
}

// --- 2. 그 상태의 화면 기능 ----------------------------------------------------
const availabilityPath = join(srcDir, 'generate', 'availability.ts');
const { capabilities } = await import(pathToFileURL(availabilityPath).href);

const ALWAYS = ['scriptPlayback', 'replay', 'canvas', 'commands'];
for (const status of ['probing', 'ready', 'unavailable']) {
  const able = capabilities(status);
  for (const key of ALWAYS) {
    if (able[key] !== true) failures.push(`capabilities('${status}') 가 ${key} 를 껐다 — 생성 서비스와 무관한 기능이다`);
  }
}
const down = capabilities('unavailable');
if (down.canGenerate) failures.push('서비스가 꺼졌는데 생성 경로가 켜져 있다');
if (!down.note) failures.push('무엇이 왜 꺼졌는지 화면에 알려 줄 문구가 없다 — 조용히 사라진다');
const withReason = capabilities('unavailable', probed?.reason ?? '테스트 사유 8802');
if (!withReason.note?.includes('8802')) failures.push('probe() 사유를 넘겼는데 화면 문구에 실리지 않는다');
for (const key of ALWAYS) {
  if (withReason[key] !== true) failures.push(`사유를 넘겼더니 ${key} 가 꺼졌다 — note 말고는 아무것도 바뀌면 안 된다`);
}
if (capabilities('ready').canGenerate !== true) failures.push('서비스가 살아 있는데 생성이 꺼져 있다');

// 대조군 — 대본 재생을 상태에 묶은 사본은 반드시 잡혀야 한다.
{
  const scratch = mkdtempSync(join(srcDir, 'generate', '.verify-no-llm-'));
  try {
    const mutantPath = join(scratch, 'availability.ts');
    writeFileSync(
      mutantPath,
      readFileSync(availabilityPath, 'utf8').replace(
        "  const always = { scriptPlayback: true, replay: true, canvas: true, commands: true } as const;",
        "  const always = { scriptPlayback: (status === 'ready') as true, replay: true, canvas: true, commands: true };",
      ),
      'utf8',
    );
    const mutant = await import(pathToFileURL(mutantPath).href);
    if (mutant.capabilities('unavailable').scriptPlayback === true) {
      failures.push('대조군을 만들지 못했다: 대본 재생을 상태에 묶은 사본이 여전히 true 다 — 이 검사는 무의미하다');
    } else {
      controls.push('대본 재생을 생성 상태에 묶은 사본');
    }
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { console.warn('임시 디렉터리 정리 실패 — ' + scratch); }
  }
}

// --- 4. 대본 재생·되감기·캔버스가 생성 계층을 모르는가 ---------------------------
//
// 함수가 true 를 돌려주는 것만으로는 부족하다. 그 셋이 **애초에 생성 서비스를 import 하지
// 않는지**가 「생성만 꺼진다」의 구조적 근거다.
{
  const files = [];
  (function walk(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) { if (!name.startsWith('.')) walk(path); }
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  })(srcDir);

  /** 생성과 무관하게 돌아야 하는 것들. 대본 재생 · 되감기 · 캔버스 · 명령 출구. */
  const INDEPENDENT = [
    'data/scenario.ts', 'data/fold.ts', 'data/trace.ts',
    'scenarios/library.ts', 'scenarios/matcher.ts', 'scenarios/nowPlaying.ts',
    'shared/stores/traceStore.ts', 'shared/commandCenter.ts', 'shared/commandEgress.ts',
    'canvas/useCanvas.ts', 'canvas/persist.ts', 'canvas/scope.ts',
    'graph/layout.ts', 'main.tsx',
    // 260907 — **근거의 모양을 든 중립 자리.** 임무 저장소가 이것을 import 하므로,
    // 이 파일이 생성 계층을 끌어오는 순간 `data/scenario.ts` 가 전이로 끌어오게 되고
    // 위 목록 전체가 무의미해진다. 오늘 타입인 것이 내일 함수가 된다.
    'shared/provenance.ts',
  ];
  function dependents(extra = '') {
    const bad = [];
    for (const path of files) {
      const rel = relative(srcDir, path).replaceAll('\\', '/');
      if (!INDEPENDENT.includes(rel)) continue;
      const source = readFileSync(path, 'utf8') + (rel === INDEPENDENT[0] ? extra : '');
      if (/from\s+['"][^'"]*generate\/(LlmClient|gbnf|types|availability)/.test(source)) bad.push(rel);
    }
    return bad;
  }
  const offenders = dependents();
  if (offenders.length) {
    failures.push(`대본 재생·되감기·캔버스가 생성 계층을 import 한다: ${offenders.join(', ')} — 서비스가 꺼지면 같이 죽는다`);
  }
  // 대조군 — 하나에 주입하면 반드시 잡혀야 한다.
  if (dependents("\nimport { probe } from '../generate/LlmClient.ts';").length === 0) {
    failures.push('생성 import 를 주입한 대조군을 검출하지 못했다 — 이 검사는 무의미하다');
  } else {
    controls.push('되감기 저장소에 생성 import 를 주입한 사본');
  }
}

if (failures.length) {
  console.error(`❌ verify:no-llm\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 서비스가 전부 실패해도 probe() 는 조용히 alive:false + 사유(주소 포함) · generateMission 은 offline 으로 던짐');
console.log('✅ 꺼지는 것은 생성 하나 — 대본 재생·되감기·캔버스·명령 출구는 모든 상태에서 켜져 있다 (타입 고정)');
console.log('✅ 그 넷은 생성 계층을 import 하지 않는다 — 「생성만 꺼진다」의 구조적 근거');
console.log('✅ 문법은 서비스 없이도 계약에서 뽑힌다 (배치 ① 생성 꺼짐에서도 계약은 빌드에 있다)');
console.log(`✅ 대조군 ${controls.length}건 검출 — ${controls.join(' · ')}`);
