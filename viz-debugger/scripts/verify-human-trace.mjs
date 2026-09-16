// verify:human-trace (260904 신설) — 화면에서 나가는 **모든 명령**이 `produced_by=human`
// 으로 기록되고, **되감기에 보이는가**.
//
// `VZ-D-08` 은 「모든 조작은 `produced_by=human` 으로 기록된다」고 적혀 있는데, 260904
// 이전의 `recordHuman()` 은 별도 배열에 넣고 `console.log` 하는 것이 끝이었다. 화면 어디에도
// 안 나오는 것을 기록이라고 부를 수는 없다. 이 검사가 보는 것은 넷이다.
//
//  1. **규칙이 한 곳에만 있다** — `produced_by=human` 을 손으로 적는 자리가 여럿이면 갈라진다.
//  2. **기록하는 자리가 출구 본체다** — 껍데기에서 적으면 추적기를 직접 부르는 화면
//     (제어 뷰 노드)이 기록 없이 샌다. 실제로 그 구멍이 있었고 260904에 막았다.
//  3. **같은 열에 들어간다** — 대본·백엔드 사건과 나뉘어 있으면 되감기가 둘을 못 겹친다.
//  4. **되감기 화면이 그것을 그린다** — 열에만 있고 화면에 없으면 1번과 같은 상태다.
//
// 대조군 포함 — 기록을 무력화한 사본이 반드시 실패로 잡히는지까지 본다.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const tracePath = join(src, 'data', 'trace.ts');
const foldPath = join(src, 'data', 'fold.ts');

const failures = [];
const controls = [];

const read = (...parts) => readFileSync(join(src, ...parts), 'utf8');

// ── ① 규칙이 한 곳에만 있다 ──────────────────────────────────────────────────
{
  const offenders = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const rel = path.slice(src.length + 1).replaceAll('\\', '/');
        if (rel === 'data/trace.ts') continue;
        // 타입 선언(model/types.ts)과 전선 필드 이름(missionBridge)은 규칙이 아니라 어휘다.
        if (rel === 'model/types.ts' || rel === 'shell/missionBridge.ts') continue;
        if (/producedBy\s*:\s*'human'/.test(readFileSync(path, 'utf8'))) offenders.push(rel);
      }
    }
  })(src);
  if (offenders.length) failures.push(`produced_by=human 을 손으로 적는 곳이 또 있다: ${offenders.join(', ')} — 규칙은 data/trace.ts 하나여야 한다`);
}

// ── ② 기록하는 자리가 출구 본체인가 ──────────────────────────────────────────
//
// 앱의 명령 출구는 `shared/commandCenter.ts` 의 `CommandTracker.issue()` 다
// (verify:single-egress 가 그것을 못박는다). 사람 조작 기록은 **그 안**에 있어야 한다.
function checkEgress(centerSource, egressSource, controlPanelSource) {
  const f = [];
  if (!/recordHuman\s*\(/.test(centerSource)) {
    f.push('출구 본체(commandCenter.issue)가 recordHuman 을 부르지 않는다 — 추적기를 직접 부르는 화면의 조작이 기록 없이 샌다');
  } else {
    // 발행 **전**에 적어야 한다. 무엇을 눌렀는지는 발행 성공 여부와 무관한 사실이다.
    if (centerSource.indexOf('recordHuman(') > centerSource.indexOf('publishCommand')) {
      f.push('recordHuman 이 발행 뒤에 있다 — 발행이 실패한 조작은 기록에서 사라진다');
    }
  }
  // 껍데기가 또 적으면 한 조작이 두 번 기록된다.
  if (/recordHuman\s*\(/.test(egressSource)) f.push('껍데기(commandEgress)도 recordHuman 을 부른다 — 한 조작이 두 번 기록된다');
  // 추적기를 직접 부르는 화면이 있어도 된다 — 본체가 적으므로. 다만 **있다는 사실**은
  // 이 검사의 전제이므로 사라지면 알려 준다(전제가 바뀌면 검사의 뜻도 바뀐다).
  if (!/commandTracker\.issue\s*\(/.test(controlPanelSource)) {
    f.push('제어 패널이 더 이상 추적기를 직접 부르지 않는다 — 이 검사의 전제가 바뀌었으니 규칙을 다시 적어라');
  }
  return f;
}
const centerSource = read('shared', 'commandCenter.ts');
const egressSource = read('shared', 'commandEgress.ts');
const controlPanelSource = read('tabs', 'views', 'ControlPanel.tsx');
failures.push(...checkEgress(centerSource, egressSource, controlPanelSource));

// 대조군 — 기록 한 줄을 지운 사본이 잡히는가.
if (checkEgress(centerSource.replace(/recordHuman\s*\(/g, 'noop('), egressSource, controlPanelSource).length === 0) {
  failures.push('대조군 실패: 출구 본체에서 기록을 지운 사본이 잡히지 않았다');
} else {
  controls.push('출구 본체의 기록 삭제 사본');
}
if (checkEgress(centerSource, egressSource + '\nrecordHuman("x");', controlPanelSource).length === 0) {
  failures.push('대조군 실패: 껍데기에 기록을 덧붙인(이중 기록) 사본이 잡히지 않았다');
} else {
  controls.push('이중 기록 사본');
}

// ── ③ 같은 열에 들어가는가 · 되감기가 그것을 보는가 ──────────────────────────
const { foldStatuses } = await import(pathToFileURL(foldPath).href);

const view = {
  missionId: 'MSN-H',
  label: '검사용',
  world: 'registry',
  utteranceText: '',
  durationSec: 100,
  milestones: [{ id: 'MS-A', title: 'a', assignedTargets: [], staticStatus: null }],
  tasks: [{ id: 'T-1', title: 't', deps: [], target: 'robot-01', actionItems: [], milestone: 'MS-A' }],
  events: [],
  cast: ['robot-01'],
  hardware: null,
  params: {},
  map: null,
  refEdges: [],
};

/** 검사 본문. 대조군도 **같은 함수**를 돌린다. */
async function checkColumn(modulePath) {
  const f = [];
  const trace = await import(pathToFileURL(modulePath).href);
  trace.resetTrace(view.missionId);
  // 대본·백엔드 사건이 먼저 흐른다.
  trace.appendTrace(view.missionId, { seq: 1, atSec: 10, nodeId: 'T-1', status: 'running', kind: 'started', producedBy: 'backend' });
  trace.appendTrace(view.missionId, { seq: 2, atSec: 80, nodeId: 'T-1', status: 'done', kind: 'evaluated', producedBy: 'backend' });

  const event = trace.appendHuman(view.missionId, 'close_gate', 'actuator-01', 40, { target_pct: 0 });
  if (event === null) { f.push('사람 조작이 열에 들어가지 않았다'); return f; }
  if (event.producedBy !== 'human') f.push(`사람 조작의 producedBy 가 '${event.producedBy}' 다 — VZ-D-08 은 human 이라고 적혀 있다`);
  if (event.seq < trace.HUMAN_SEQ_BASE) f.push(`사람 조작의 seq(${event.seq})가 대본 대역과 겹친다 — 조작 하나가 대본 사건 하나를 중복으로 지운다`);
  if (event.atSec !== 40) f.push(`사람 조작이 t=${event.atSec} 에 적혔다 — 조작한 그 시각(40)이어야 되감기에서 자리를 찾는다`);

  // **같은 열**인가 — 대본 사건과 시각 순서로 섞여 있어야 한다.
  const column = trace.traceEvents();
  if (column.length !== 3) f.push(`열이 ${column.length}건 — 사람 조작이 다른 곳에 쌓였다`);
  const order = column.map((e) => e.atSec);
  if (order.join(',') !== '10,40,80') f.push(`열의 시각 순서가 [${order.join(', ')}] — 사람 조작이 제자리에 없다`);
  const human = column.filter((e) => e.producedBy === 'human');
  if (human.length !== 1) f.push(`열에서 사람 조작을 ${human.length}건 찾았다 — 되감기 화면이 그릴 것이 없다`);

  // **되감기에 보이는가** — 조작 전 시각에는 없고, 조작 뒤 시각에는 있다.
  const visibleBefore = column.filter((e) => e.atSec <= 39 && e.producedBy === 'human').length;
  const visibleAfter = column.filter((e) => e.atSec <= 41 && e.producedBy === 'human').length;
  if (visibleBefore !== 0) f.push('조작하기 전 시각으로 되감았는데 그 조작이 보인다 — 미래가 과거에 그려진다');
  if (visibleAfter !== 1) f.push('조작한 뒤 시각으로 되감았는데 그 조작이 안 보인다 — 기록이라고 부를 수 없다');

  // 조작이 태스크 접기를 흔들면 안 된다 — 대상이 태스크가 아니라 장비다.
  const folded = foldStatuses(50, view, column);
  if (folded.tasks['T-1'].status !== 'running') f.push(`사람 조작이 T-1 상태를 '${folded.tasks['T-1'].status}' 로 바꿨다 — 조작 대상은 장비다`);
  if (folded.tasks['actuator-01'] !== undefined) f.push('장비가 태스크 표에 들어왔다 — 그래프에 없는 노드가 상태를 갖는다');
  return f;
}

failures.push(...await checkColumn(tracePath));

// ── ④ 되감기 화면이 그리는가 ─────────────────────────────────────────────────
function checkScreen(mainSource) {
  const f = [];
  if (!/humanMarks\s*\(/.test(mainSource)) f.push('되감기 화면에 사람 조작 줄이 없다 — 열에만 있고 화면에 없으면 기록이 아니다');
  if (!/timelineSegments\(view,\s*trace,/.test(mainSource)) f.push('되감기 타임라인이 기록 열이 아니라 대본을 그린다 — 아직 오지 않은 사건까지 칠해진다');
  if (/view\.events\.filter/.test(mainSource)) f.push('화면이 여전히 view.events 를 걸러 그린다 — 대본은 화면의 원천이 아니다');
  return f;
}
const mainSource = read('main.tsx');
failures.push(...checkScreen(mainSource));
if (checkScreen(mainSource.replaceAll('humanMarks', 'xxx')).length === 0) {
  failures.push('대조군 실패: 사람 조작 줄을 지운 화면 사본이 잡히지 않았다');
} else {
  controls.push('되감기 화면의 사람 조작 줄 삭제 사본');
}

// ── 대조군 — 기록 규칙 자체를 무력화한 사본 ──────────────────────────────────
{
  const scratch = mkdtempSync(join(src, 'data', '.verify-human-'));
  try {
    // **줄끝을 맞춰 둔다.** `.gitattributes` 는 저장소 안을 LF 로 고정하지만 작업 트리는
    // 환경의 관례를 따르므로(`core.autocrlf`) Windows 체크아웃에서는 CRLF 다. 자리표에
    // `\n` 이 들어간 사본은 그때 안 만들어지고, 검사는 「원본이 바뀌었나?」라고 말한다 —
    // 원본은 그대로인데. 사본은 임시 파일이라 줄끝이 무엇이든 상관없다.
    const source = readFileSync(tracePath, 'utf8').replaceAll('\r\n', '\n');
    const mutants = [
      ["producedBy 를 backend 로 바꾼 사본", source.replace("producedBy: 'human',", "producedBy: 'backend',")],
      ['사람 조작을 열에 안 넣는 사본', source.replace('if (!appendTrace(missionId, event)) return null;', 'return event;')],
      // 자리표가 **사람 사건의 것임을 대역 이름으로 못박는다.** `atSec,` 하나로는 같은
      // 모양의 다른 사건이 생기는 순간 어느 쪽을 뭉갠 것인지 말할 수 없다.
      ['조작 시각을 임무 끝에 몰아 두는 사본', source.replace('HUMAN_SEQ_BASE + humanCount,\n    atSec,\n', 'HUMAN_SEQ_BASE + humanCount,\n    atSec: 0,\n')],
    ];
    for (const [label, code] of mutants) {
      if (code === source) { failures.push(`대조군을 만들지 못했다 — ${label} (원본이 바뀌었나?)`); continue; }
      const path = join(scratch, `trace-${controls.length}.ts`);
      writeFileSync(path, code, 'utf8');
      let detected;
      try { detected = (await checkColumn(path)).length > 0; } catch { detected = true; }
      if (!detected) failures.push(`대조군 실패: ${label}이 통과했다 — 이 검사는 무의미하다`);
      else controls.push(label);
    }
  } finally {
    // 일부 개발 환경은 파일 삭제가 막혀 EPERM 이 난다 — 검사는 이미 끝났으므로 죽지 않는다.
    try { rmSync(scratch, { recursive: true, force: true }); } catch { console.warn('임시 디렉터리 정리 실패 — ' + scratch); }
  }
}

if (failures.length) {
  console.error(`❌ verify:human-trace\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ produced_by=human 규칙은 data/trace.ts 한 곳 · 기록은 출구 본체(commandCenter.issue)가 발행 전에 · 껍데기 이중 기록 없음');
console.log('✅ 같은 열 — 대본·백엔드 사건과 시각 순서로 섞이고, 조작한 그 시각에 적힌다 (seq 대역은 분리)');
console.log('✅ 되감기 — 조작 전 시각에는 안 보이고 조작 뒤에는 보임 · 태스크 접기는 안 흔들림 · 화면에 사람 조작 줄이 있음');
console.log(`✅ 대조군 ${controls.length}건 검출 — ${controls.join(' · ')}`);
