/**
 * scripts/verify-places.mjs — 작업프롬프트_마일스톤분리_260904.md §1 검사
 *
 * 셋을 본다.
 *  1. 계약 — place.schema.json 의 필수 항목과 enum
 *  2. 위상 — 인접이 양쪽에 적혀 있는가, 없는 장소를 가리키지 않는가
 *  3. 대본 — 대본 4편의 발화·마일스톤에 나오는 장소가 전부 풀리는가
 *  4. 경계 — 생성 서비스가 기하 파일을 읽는 경로가 없는가
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const fail = [];
const ok = (m) => console.log(`  ok   ${m}`);
const no = (m) => { fail.push(m); console.log(`  FAIL ${m}`); };

const doc = JSON.parse(readFileSync(join(ROOT, 'places/places.json'), 'utf8'));
const places = doc.places ?? [];
const byId = new Map(places.map((p) => [p.place_id, p]));

console.log('1. 계약');
const KINDS = new Set(['room', 'corridor', 'door', 'elevator', 'stair', 'zone']);
let bad = 0;
for (const p of places) {
  for (const k of ['place_id', 'label', 'aliases', 'kind', 'floor', 'adjacent']) {
    if (!(k in p)) { no(`${p.place_id}: 필수 항목 ${k} 없음`); bad++; }
  }
  if (!KINDS.has(p.kind)) { no(`${p.place_id}: kind '${p.kind}' 는 계약에 없다`); bad++; }
  if (!p.label) { no(`${p.place_id}: label 이 비었다`); bad++; }
}
if (places.length === 0) no('places 가 비어 있다 — 추출이 안 돌았다');
else if (!bad) ok(`${places.length}건 전부 계약을 만족한다`);

console.log('2. 위상');
let asym = 0;
for (const p of places) {
  for (const a of p.adjacent) {
    if (!byId.has(a)) { no(`${p.place_id} → ${a}: 없는 장소를 가리킨다`); asym++; continue; }
    if (!byId.get(a).adjacent.includes(p.place_id)) { no(`${p.place_id} ↔ ${a}: 한쪽에만 적혀 있다`); asym++; }
  }
}
if (!asym) ok('인접이 전부 양쪽에 적혀 있다');
const heldIds = new Set(doc.held_open ?? []);
const orphan = places.filter((p) => p.adjacent.length === 0 && !heldIds.has(p.place_id));
if (orphan.length) no(`고아 장소: ${orphan.map((p) => p.place_id).join(', ')}`);
else ok(`고아 장소 없음 (자리표시 ${heldIds.size}건은 예외 — 아직 안 쟀다)`);

// 260907 — 자리표시(측정하지 않은 4층 경로)는 **연결만 있고 좌표가 없어야 한다.**
// 좌표가 생기면 그것은 잰 값이 아니라 지어낸 값이다. 있는 것과 없는 것을 가르는 선이
// 이 검사다 — 「연결 예정」과 같은 원칙이고 places/README.md 에 근거가 있다.
const held = doc.held_open ?? [];
if (held.length === 0) {
  no('held_open 목록이 없다 — 자리표시와 실측을 가르는 표시가 사라졌다');
} else {
  const geo = JSON.parse(readFileSync(join(ROOT, 'places/places.geometry.json'), 'utf8'));
  const geoIds = new Set((geo.geometry ?? []).map((g) => g.place_id));
  const leaked = held.filter((id) => geoIds.has(id));
  const missing = held.filter((id) => !byId.has(id));
  if (missing.length) no(`held_open 이 없는 장소를 가리킨다: ${missing.join(', ')}`);
  if (leaked.length) no(`자리표시에 좌표가 생겼다: ${leaked.join(', ')} — 재지 않은 값이다`);
  const wired = held.filter((id) => (byId.get(id)?.adjacent ?? []).length > 0);
  if (wired.length) no(`자리표시에 인접이 생겼다: ${wired.join(', ')} — 재지 않은 위상이다`);
  if (!missing.length && !leaked.length && !wired.length) ok(`자리표시 ${held.length}건은 좌표도 인접도 없다 (${held.join(' · ')})`);
}

console.log('3. 대본');
const SC = join(ROOT, 'viz-debugger/scenarios');
const vocab = new Set();
for (const p of places) { vocab.add(p.label); for (const a of p.aliases) vocab.add(a); }
const resolves = (t) => [...vocab].some((v) => v && t.includes(v));
let miss = 0;
for (const f of readdirSync(SC).filter((f) => f.endsWith('.json') && !f.includes('.match.'))) {
  const s = JSON.parse(readFileSync(join(SC, f), 'utf8'));
  const texts = [s.utterance?.text ?? '', ...(s.milestones ?? []).map((m) => m.title)];
  const found = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(/\d{3}호?/g)) found.add(m[0]);
    for (const m of t.matchAll(/복도|엘리베이터|엘레베이터|승강기|계단|화장실/g)) found.add(m[0]);
  }
  const unresolved = [...found].filter((w) => !resolves(w));
  if (unresolved.length) { no(`${f}: 못 푸는 장소 ${unresolved.join(', ')}`); miss++; }
  else ok(`${f}: 장소 ${found.size}종 전부 풀린다`);
}

console.log('4. 경계 — 생성 서비스는 기하를 읽지 않는다');
const scan = [join(ROOT, 'viz-debugger/src/generate'), join(ROOT, 'gen-lab/server')];
let leak = 0;
for (const dir of scan) {
  if (!existsSync(dir)) continue;
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  for (const f of walk(dir)) {
    if (!/\.(ts|tsx|js|mjs|py)$/.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    if (src.includes('places.geometry')) { no(`${f.replace(ROOT, '')} 가 기하 파일을 읽는다`); leak++; }
  }
}
if (!leak) ok('생성 경로에 기하 파일 참조가 없다');

console.log(fail.length ? `\nverify:places 실패 ${fail.length}건` : '\nverify:places 통과');
process.exit(fail.length ? 1 : 0);
