// verify:trace-append (260904 신설) — 기록 열이 **덧붙이기 전용**인가.
//
// REQ-1404 는 「덧붙이기 전용 기록」이라고 적혀 있는데, 260904 이전의 `TraceStore` 는
// `push` 하나짜리 배열 래퍼였고 `snapshot()` 을 부르는 곳이 0이었다. 즉 규칙은 문서에만
// 있었고 코드가 지키는 것은 아무것도 없었다. 이 검사가 보는 것은 셋이다.
//
//  1. **수정·삭제 경로가 없다** — 지우는 메서드도, 꺼낸 사본으로 안을 고치는 길도 없다.
//  2. **같은 seq 재수신이 중복을 만들지 않는다** — 재접속하면 다시 온다 (VZ-I-02).
//  3. **열의 순서는 (atSec, seq)** — 수신 순서는 보장이 없다(중계·재접속). 접기가
//     시각을 걸어 나가므로 순서가 깨지면 되감기가 통째로 틀어진다.
//
// 대조군을 함께 돌린다 — **검사를 무력화한 사본이 반드시 실패로 잡히는지**까지 본다
// (`verify:standalone` 이 셸 import 를 주입해 보는 것과 같은 방식).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storePath = join(root, 'src', 'shared', 'stores', 'traceStore.ts');
const tracePath = join(root, 'src', 'data', 'trace.ts');

const failures = [];
const controls = [];

const event = (seq, atSec, nodeId = 'T-31', extra = {}) => ({
  seq, atSec, nodeId, status: 'running', kind: 'started', producedBy: 'backend', ...extra,
});

// ── ① 저장소의 실동작 ────────────────────────────────────────────────────────
const { TraceStore } = await import(pathToFileURL(storePath).href);

/** 검사 본문. 대조군도 **같은 함수**를 돌린다 — 다른 잣대를 대면 대조가 아니다. */
function checkStore(Store) {
  const f = [];
  const store = new Store('MSN-T');

  // 중복 — 같은 seq 가 다시 오면 열이 자라지 않는다.
  if (store.append(event(1, 0)) !== true) f.push('첫 사건이 들어가지 않았다');
  if (store.append(event(1, 0)) !== false) f.push('같은 seq 재수신이 true 를 돌려줬다 — 새 기록이 아니다');
  if (store.length !== 1) f.push(`같은 seq 를 두 번 넣었더니 열이 ${store.length}건이 됐다 — 재접속마다 기록이 불어난다`);
  // 내용이 달라도 seq 가 같으면 같은 사건이다 — 중계가 필드를 덧붙여 다시 보낼 수 있다.
  store.append(event(1, 0, 'T-31', { status: 'done' }));
  if (store.snapshot()[0].status !== 'running') f.push('같은 seq 의 재수신이 먼저 든 기록을 덮어썼다 — 그건 수정이다');

  // 순서 — 늦게 온 사건이 제자리에 들어간다.
  store.append(event(4, 30));
  store.append(event(2, 10));
  store.append(event(3, 10));
  const order = store.snapshot().map((e) => e.seq);
  if (order.join(',') !== '1,2,3,4') f.push(`열의 순서가 (atSec, seq) 가 아니다 — [${order.join(', ')}]`);
  const times = store.snapshot().map((e) => e.atSec);
  if (times.some((v, i) => i > 0 && times[i - 1] > v)) f.push(`열의 시각이 역전됐다 — [${times.join(', ')}]`);
  if (store.stats().outOfOrder !== 2) f.push(`늦게 온 사건 2건을 ${store.stats().outOfOrder}건으로 셌다`);
  if (store.stats().duplicates !== 2) f.push(`중복 2건을 ${store.stats().duplicates}건으로 셌다`);

  // 덧붙이기 전용 — 꺼낸 사본을 고쳐도, 기록 자체를 고치려 해도 열은 안 바뀐다.
  const copy = store.snapshot();
  // 얼린 사본이면 던진다 — **그게 정상이다.** 내부 배열을 그대로 내줬으면 조용히 성공한다.
  try { copy.push(event(99, 99)); } catch { /* 얼린 배열 */ }
  try { copy.length = 0; } catch { /* 얼린 배열 */ }
  if (store.length !== 4) f.push('snapshot() 이 내부 배열을 그대로 내줬다 — 밖에서 열을 지울 수 있다');
  const record = store.snapshot()[0];
  try { record.status = 'failed'; } catch { /* strict 모드에서는 던진다 — 그게 정상이다 */ }
  if (store.snapshot()[0].status !== 'running') f.push('꺼낸 기록을 고치면 열이 바뀐다 — 수정 경로가 열려 있다');

  // 넣은 뒤 원본을 고쳐도 기록은 안 바뀐다 — 저장소가 자기 사본을 든다.
  const mutable = event(5, 40);
  store.append(mutable);
  mutable.status = 'failed';
  if (store.snapshot().at(-1).status !== 'running') f.push('넣은 객체를 나중에 고치면 기록이 따라 바뀐다');

  return f;
}

failures.push(...checkStore(TraceStore));

// 메서드 표면 — 지우거나 고치는 이름이 아예 없어야 한다. 있으면 언젠가 누가 부른다.
{
  const banned = ['delete', 'remove', 'clear', 'set', 'update', 'splice', 'pop', 'shift', 'replace', 'truncate'];
  const names = Object.getOwnPropertyNames(TraceStore.prototype).filter((n) => n !== 'constructor');
  const bad = names.filter((n) => banned.some((b) => n.toLowerCase().includes(b)));
  if (bad.length) failures.push(`TraceStore 에 수정·삭제 이름의 메서드가 있다: ${bad.join(', ')} (REQ-1404)`);
  for (const need of ['append', 'snapshot', 'stats']) {
    if (!names.includes(need)) failures.push(`TraceStore 에 ${need}() 가 없다`);
  }
}

// ── ② 입구가 하나인가 ────────────────────────────────────────────────────────
// 열에 넣는 길은 `data/trace.ts` 의 appendTrace 하나다. 다른 파일이 TraceStore 를 직접
// 만들어 쓰면 단독 빌드와 통합 빌드의 되감기가 갈린다 (측정축 D 오염).
{
  const { readdirSync, statSync } = await import('node:fs');
  const allowed = new Set(['src/data/trace.ts', 'src/shared/stores/traceStore.ts']);
  const offenders = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const rel = path.slice(root.length + 1).replaceAll('\\', '/');
        if (allowed.has(rel)) continue;
        if (/new\s+TraceStore\s*\(/.test(readFileSync(path, 'utf8'))) offenders.push(rel);
      }
    }
  })(join(root, 'src'));
  if (offenders.length) failures.push(`기록 열을 따로 만드는 곳이 있다: ${offenders.join(', ')} — 입구는 하나여야 한다`);
}

// ── ③ 열의 입구 — 다른 임무의 사건은 안 들어간다 ─────────────────────────────
{
  const trace = await import(pathToFileURL(tracePath).href);
  trace.resetTrace('MSN-A');
  if (trace.appendTrace('MSN-B', event(1, 0)) !== false) failures.push('다른 임무의 사건이 열에 들어간다');
  if (trace.traceEvents().length !== 0) failures.push('다른 임무의 사건이 열에 남았다');
  trace.appendTrace('MSN-A', event(1, 0));
  trace.appendTrace('MSN-A', event(1, 0));
  if (trace.traceEvents().length !== 1) failures.push('입구를 거친 중복이 걸러지지 않는다');
  // 임무가 바뀌면 새 열이다 — 지우는 것이 아니라 새로 만드는 것이다.
  const before = trace.traceEvents();
  trace.resetTrace('MSN-C');
  if (trace.traceEvents().length !== 0) failures.push('임무를 바꿨는데 옛 기록이 남아 있다');
  if (before.length !== 1) failures.push('새 열을 만들었더니 먼저 꺼내 둔 사본이 비었다 — 사본이 사본이 아니다');
  // 사본의 신원 — 덧붙이기 전에는 그대로여야 화면이 헛되이 다시 접지 않는다.
  trace.resetTrace('MSN-D');
  trace.appendTrace('MSN-D', event(1, 0));
  const a = trace.traceEvents();
  if (a !== trace.traceEvents()) failures.push('사건이 없는데 snapshot() 신원이 바뀐다 — 화면이 매 렌더마다 접는다');
  trace.appendTrace('MSN-D', event(2, 5));
  if (a === trace.traceEvents()) failures.push('사건이 들어왔는데 snapshot() 신원이 그대로다 — 화면이 새 기록을 못 본다');
}

// ── 대조군 — 검사를 무력화한 사본이 반드시 잡혀야 한다 ────────────────────────
{
  const scratch = mkdtempSync(join(root, '.verify-trace-'));
  try {
    const source = readFileSync(storePath, 'utf8');
    const mutants = [
      ['중복 무시를 없앤 사본', source.replace('if (this.seen.has(event.seq)) {', 'if (false) {')],
      ['순서 정렬을 없앤 사본', source.replace(
        'let index = this.events.length;\n    while (index > 0 && !precedes(this.events[index - 1], event)) index -= 1;\n    return index;',
        'return this.events.length;',
      )],
      ['사본이 아니라 내부 배열을 내주는 사본', source.replace('if (this.cached === null) this.cached = Object.freeze([...this.events]);\n    return this.cached;', 'return this.events;')],
      ['넣은 객체를 얼리지 않는 사본', source.replace('return Object.freeze(copy);', 'return event;')],
    ];
    for (const [label, code] of mutants) {
      if (code === source) { failures.push(`대조군을 만들지 못했다 — ${label} (원본이 바뀌었나?)`); continue; }
      const path = join(scratch, `traceStore-${controls.length}.ts`);
      writeFileSync(path, code, 'utf8');
      const mutant = await import(pathToFileURL(path).href);
      // 던지는 것도 검출이다 — 무력화된 사본은 검사 도중 자기 발에 걸리기도 한다.
      let detected;
      try { detected = checkStore(mutant.TraceStore).length > 0; } catch { detected = true; }
      if (!detected) failures.push(`대조군 실패: ${label}이 통과했다 — 이 검사는 무의미하다`);
      else controls.push(label);
    }
  } finally {
    // 일부 개발 환경은 파일 삭제가 막혀 EPERM 이 난다 — 검사는 이미 끝났으므로 죽지 않는다.
    try { rmSync(scratch, { recursive: true, force: true }); } catch { console.warn('임시 디렉터리 정리 실패 — ' + scratch); }
  }
}

if (failures.length) {
  console.error(`❌ verify:trace-append\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 덧붙이기 전용 — 수정·삭제 메서드 0건 · 꺼낸 사본으로도 열을 못 고침 · 넣은 원본을 고쳐도 기록은 그대로');
console.log('✅ 중복 무시 — 같은 seq 재수신이 열을 늘리지도 덮어쓰지도 않음 (VZ-I-02 재접속)');
console.log('✅ 순서 — 늦게 온 사건이 (atSec, seq) 자리에 들어감 · 입구는 appendTrace 하나 · 다른 임무 사건은 거부');
console.log(`✅ 대조군 ${controls.length}건 검출 — ${controls.join(' · ')}`);
