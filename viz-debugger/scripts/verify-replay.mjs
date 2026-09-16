// verify:replay (260904 신설) — **임의 시점 복원 = 순차 재생.**
//
// 되감기(REQ-1405)가 성립하려면 「그때까지 일어난 일을 접은 결과」가 **어떻게 도달했든
// 같아야** 한다. 다른 말로:
//
//   ① 순차 재생 — 사건이 도착할 때마다 열이 자라고, 그때그때 접은 결과
//   ② 임의 복원 — 열이 다 찬 뒤 슬라이더를 t 로 끌어 한 번에 접은 결과
//
// 둘이 다르면 되감기 화면은 「그 시각의 상태」가 아니라 「거기까지 오면서 쌓인 무언가」다.
// 증분 접기를 넣는다면 그것도 여기 ①에 해당한다 — 전체 접기와 같아야 한다.
//
// 함께 보는 것 셋.
//  - **수신 순서가 뒤바뀌어도 같은 결과** — 중계·재접속이 순서를 보장하지 않는다.
//  - **빈 열은 전부 pending** — 정지 미리보기(t=0)의 규칙 (VZ-U-07).
//  - **접기 시간 실측** — 기술 문서 §5-2 의 16 ms 목표. 논문 측정축 D 본문이다.
//
// 대조군 포함 — 접기를 무력화한 사본이 반드시 실패로 잡히는지까지 본다.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const foldPath = join(root, 'src', 'data', 'fold.ts');
const storePath = join(root, 'src', 'shared', 'stores', 'traceStore.ts');

const failures = [];
const controls = [];
const measurements = [];

const { TraceStore } = await import(pathToFileURL(storePath).href);
const { foldStatuses } = await import(pathToFileURL(foldPath).href);

/**
 * 대본 → 화면 형태. `src/data/scenario.ts` 의 `scriptToView` 와 같은 필드만 쓴다 —
 * 그 파일은 옛 편 JSON 을 import 하고 있어 Node 에서 열리지 않는다.
 * 옛 편(MSN-260826-01)은 태스크에 milestone 필드가 없어 전부 MS-C 다(적재 규칙과 같다).
 */
function viewOf(raw) {
  return {
    missionId: raw.missionId,
    label: raw.title ?? raw.missionId,
    world: raw.cast ? 'registry' : 'legacy',
    utteranceText: raw.utterance?.text ?? '',
    durationSec: raw.durationSec,
    milestones: raw.milestones.map((m) => ({ id: m.id, title: m.title, assignedTargets: m.assignedTargets, staticStatus: m.status ?? null })),
    tasks: raw.tasks.map((t) => ({ ...t, milestone: t.milestone ?? 'MS-C' })),
    events: raw.events,
    cast: raw.cast ?? (raw.hardware ?? []).map((h) => h.id),
    hardware: raw.hardware ?? null,
    params: raw.params ?? {},
    map: raw.map ?? null,
    refEdges: raw.refEdges ?? [],
  };
}

const scriptIds = ['MSN-260826-01', 'MSN-260831-01', 'MSN-260831-02', 'MSN-260831-03'];
const views = scriptIds.map((id) => viewOf(JSON.parse(readFileSync(join(root, 'scenarios', id + '.json'), 'utf8'))));

/** 결정적인 뒤섞기 — 수신 순서가 뒤바뀐 상황을 재현하되 실행마다 달라지면 재현이 안 된다. */
function shuffled(events) {
  const out = [...events];
  let seed = 20260904;
  for (let i = out.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const key = (folded) => JSON.stringify([
  Object.entries(folded.tasks).sort(([a], [b]) => a.localeCompare(b)),
  Object.entries(folded.milestones).sort(([a], [b]) => a.localeCompare(b)),
]);

/** 검사 본문. 대조군도 **같은 함수**를 돌린다 — 다른 잣대를 대면 대조가 아니다. */
function checkReplay(fold) {
  const f = [];
  for (const view of views) {
    // ① 순차 재생 — 사건이 도착할 때마다 열이 자란다. 그 시각의 접기를 그때 적어 둔다.
    const growing = new TraceStore(view.missionId);
    const sequential = new Map();
    let cursor = 0;
    for (let t = 0; t <= view.durationSec; t += 1) {
      while (cursor < view.events.length && view.events[cursor].atSec <= t) {
        growing.append(view.events[cursor]);
        cursor += 1;
      }
      sequential.set(t, key(fold(t, view, growing.snapshot())));
    }

    // ② 임의 복원 — 열이 다 찬 뒤 아무 시각으로나 끌어 접는다. 순서도 뒤섞어 넣는다.
    const complete = new TraceStore(view.missionId);
    for (const event of shuffled(view.events)) complete.append(event);
    if (complete.length !== view.events.length) f.push(`${view.missionId}: 뒤섞어 넣었더니 열이 ${complete.length}건 — 대본은 ${view.events.length}건이다`);
    const column = complete.snapshot();

    let mismatch = 0;
    let firstAt = null;
    for (let t = view.durationSec; t >= 0; t -= 1) {
      // 뒤에서 앞으로 — 되감기가 실제로 하는 방향이다.
      if (key(fold(t, view, column)) !== sequential.get(t)) {
        mismatch += 1;
        if (firstAt === null) firstAt = t;
      }
    }
    if (mismatch > 0) f.push(`${view.missionId}: 임의 시점 복원이 순차 재생과 다르다 — ${mismatch}개 시각(처음 어긋난 곳 t=${firstAt}s)`);

    // ③ 빈 열 — 정지 미리보기(t=0)는 전부 pending 이어야 한다.
    const empty = fold(0, view, []);
    const notPending = Object.entries(empty.tasks).filter(([, v]) => v.status !== 'pending').map(([id]) => id);
    if (notPending.length) f.push(`${view.missionId}: 기록이 하나도 없는데 태스크 ${notPending.join(', ')} 가 pending 이 아니다 — 승인 전에는 아무것도 재생되지 않는다(VZ-U-07)`);

    // ④ 사람 조작이 섞여도 태스크 접기는 안 흔들린다 — 조작 대상은 장비·임무지 태스크가 아니다.
    const withHuman = new TraceStore(view.missionId);
    for (const event of view.events) withHuman.append(event);
    withHuman.append({ seq: 1_000_000, atSec: Math.floor(view.durationSec / 2), nodeId: view.cast[0] ?? view.missionId, status: 'rerunning', kind: 'mission_pause', producedBy: 'human', payload: {} });
    const mid = Math.floor(view.durationSec / 2) + 1;
    if (key(fold(mid, view, withHuman.snapshot())) !== key(fold(mid, view, column))) {
      f.push(`${view.missionId}: 사람 조작 하나가 태스크 접기를 바꿨다 — 조작 대상은 태스크가 아니다`);
    }
  }
  return f;
}

failures.push(...checkReplay(foldStatuses));

// ── 접기 시간 실측 (기술 문서 §5-2 — 16 ms 목표) ──────────────────────────────
//
// 재는 것은 **임의 시점 복원 한 번**이다 — 슬라이더를 끌면 일어나는 그 일. 사건 수를
// 늘려 가며 재서 「지금 대본에서 빠르다」가 아니라 「어디까지 빠른가」를 남긴다.
{
  const FOLD_BUDGET_MS = 16;
  const stress = views[2]; // 가장 긴 편(2편 · 810s · 72건)을 늘린다.
  const cases = [];
  for (const view of views) cases.push({ label: view.missionId, view, events: view.events });
  for (const hz of [1, 5, 20]) {
    // 20 Hz × 810s = 16,200건. 실제 백엔드가 붙었을 때의 상한 쪽 그림이다.
    const events = [];
    let seq = 1;
    for (let t = 0; t < stress.durationSec; t += 1 / hz) {
      const task = stress.tasks[seq % stress.tasks.length];
      events.push({ seq: seq++, atSec: Math.round(t * 1000) / 1000, nodeId: task.id, status: 'running', kind: 'tick', producedBy: 'backend' });
    }
    cases.push({ label: `합성 ${hz} Hz × ${stress.durationSec}s`, view: stress, events });
  }

  for (const item of cases) {
    const store = new TraceStore(item.view.missionId);
    for (const event of item.events) store.append(event);
    const column = store.snapshot();
    const marks = [0.25, 0.5, 0.75, 1].map((r) => Math.round(item.view.durationSec * r));
    // 예열 — 첫 호출은 JIT 몫이라 그것을 실측이라고 적으면 거짓말이 된다.
    for (let i = 0; i < 50; i += 1) foldStatuses(marks[i % marks.length], item.view, column);
    const runs = 200;
    const samples = [];
    for (let i = 0; i < runs; i += 1) {
      const at = marks[i % marks.length];
      const started = performance.now();
      foldStatuses(at, item.view, column);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 = samples[Math.floor(samples.length * 0.95)];
    measurements.push({ label: item.label, events: column.length, tasks: item.view.tasks.length, avg, p95, max: samples.at(-1) });
    if (p95 > FOLD_BUDGET_MS) failures.push(`${item.label}: 접기 p95 ${p95.toFixed(3)} ms — 16 ms 목표를 넘는다 (사건 ${column.length}건)`);
  }
}

// ── 대조군 — 접기를 무력화한 사본이 반드시 잡혀야 한다 ────────────────────────
{
  const scratch = mkdtempSync(join(root, 'src', 'data', '.verify-replay-'));
  try {
    const source = readFileSync(foldPath, 'utf8');
    const mutants = [
      ['시각 경계를 없앤 사본(미래 사건까지 접는다)', source.replace('if (event.atSec > second) break;', '')],
      ['되감기를 무시하는 사본(늘 마지막 상태)', source.replace('if (event.atSec > second) break;', 'if (false) break;')],
      ['사람 조작까지 태스크로 접는 사본', source.replace('if (!known.has(event.nodeId)) continue;', '')],
    ];
    for (const [label, code] of mutants) {
      if (code === source) { failures.push(`대조군을 만들지 못했다 — ${label} (원본이 바뀌었나?)`); continue; }
      const path = join(scratch, `fold-${controls.length}.ts`);
      writeFileSync(path, code, 'utf8');
      const mutant = await import(pathToFileURL(path).href);
      let detected;
      try { detected = checkReplay(mutant.foldStatuses).length > 0; } catch { detected = true; }
      if (!detected) failures.push(`대조군 실패: ${label}이 통과했다 — 이 검사는 무의미하다`);
      else controls.push(label);
    }
  } finally {
    // 일부 개발 환경은 파일 삭제가 막혀 EPERM 이 난다 — 검사는 이미 끝났으므로 죽지 않는다.
    try { rmSync(scratch, { recursive: true, force: true }); } catch { console.warn('임시 디렉터리 정리 실패 — ' + scratch); }
  }
}

for (const m of measurements) {
  console.log(`   접기 ${m.label} — 사건 ${String(m.events).padStart(6)}건 · 노드 ${m.tasks}개 · 평균 ${m.avg.toFixed(3)} ms · p95 ${m.p95.toFixed(3)} ms · 최대 ${m.max.toFixed(3)} ms`);
}
if (failures.length) {
  console.error(`❌ verify:replay\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`✅ 임의 시점 복원 = 순차 재생 — 대본 ${views.length}편 · 매 초 대조 · 수신 순서를 뒤섞어도 같음`);
console.log('✅ 빈 열은 전부 pending (정지 미리보기 · VZ-U-07) · 사람 조작은 태스크 접기를 흔들지 않음');
console.log('✅ 접기 시간 — 위 실측 전부 16 ms 목표 안 (기술 문서 §5-2)');
console.log(`✅ 대조군 ${controls.length}건 검출 — ${controls.join(' · ')}`);
