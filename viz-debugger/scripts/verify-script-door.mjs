// verify:script-door (260909 신설 — 시연 대본 지시서 §8)
//
// 5편째 `MSN-260909-01` 「저기 문 쪽으로 가」가 발표장에서 하기로 한 일을 하는지.
//
// 막으려는 실패 넷.
//  1. **발화 변형 중 하나가 다른 대본을 고르는 것.** 발표장에서 말이 조금 달라지는 것은
//     정상이고, 그때 3편(월류방어벽)이 뜨면 시연이 끝난다. 넷이 전부 이 편에 와야 한다.
//  2. **「수문」과 함께 맞아 모호 거부되는 것.** 3편의 must 가 「수문」이라 새 편을 「문」
//     하나로 잡으면 두 편에 걸린다. 매처는 모호하면 고르지 않으므로 조용한 실패가 아니라
//     대놓고 거부가 되지만, 어느 쪽이든 시연은 못 한다.
//  3. **순서도의 부채꼴이 무너지는 것.** `T-A4-*` 여덟이 `T-A3` 하나에 나란히 매달리고,
//     `T-A5` 는 그중 90도(`T-A4-2`) **하나에만** 매달린다. 나머지 일곱에서 선이 나가면
//     순서도가 아니다.
//  4. **초록이 하나가 아닌 것.** 문 있음은 90도 하나다(§4). 둘이면 「판단」이 성립하지 않고
//     0이면 보여줄 것이 없다.
//
// 매칭은 `src/scenarios/matcher.ts` 하나를 쓴다 — 게이트웨이·브라우저와 같은 파일이라
// 여기서 통과하면 발표장 세 곳이 같은 대본을 고른다는 뜻이다.
//
// 대조군 포함 — 검사를 무력화한 사본이 반드시 실패로 잡히는지까지 본다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const { matchLibrary } = await import(pathToFileURL(join(root, 'src', 'scenarios', 'matcher.ts')).href);
const { SCRIPT_IDS, LEGACY_ID } = await import(pathToFileURL(join(root, 'src', 'scenarios', 'manifest.ts')).href);

const DOOR_ID = 'MSN-260909-01';
const read = (id) => JSON.parse(readFileSync(join(root, 'scenarios', `${id}.json`), 'utf8'));

const failures = [];
const controls = [];

if (!SCRIPT_IDS.includes(DOOR_ID)) {
  console.error(`❌ verify:script-door\n- ${DOOR_ID} 가 manifest 목록에 없다 — 라이브러리에 실리지 않는다`);
  process.exit(1);
}

const door = read(DOOR_ID);
const legacySidecar = JSON.parse(readFileSync(join(root, 'scenarios', `${LEGACY_ID}.match.json`), 'utf8'));

/** 라이브러리 전체 — 발화가 **이 편에만** 맞는지 보려면 나머지 편이 다 있어야 한다. */
const library = [
  ...SCRIPT_IDS.map((id) => ({ missionId: id, match: read(id).match })),
  { missionId: LEGACY_ID, match: legacySidecar.match },
];

// ── 1. 발화 변형 넷 ───────────────────────────────────────────────────────────
//
// STT 오인식 대비로 띄어쓰기 양쪽을 다 넣는다(§1). 매처의 normalize 가 공백을 지우므로
// 두 형태는 **같은 값**이 되지만, 발표장에서 실제로 나올 문장은 둘 다이므로 둘 다 넣어 본다.
const VARIANTS = [
  '저기 문 쪽으로 가',
  '문 쪽으로 가',
  '문쪽으로 가',
  '문으로 가줘',
  '문 앞으로 이동해줘',
  '문앞으로 이동해줘',
];

function matchOf(sentence) {
  const outcome = matchLibrary(sentence, library);
  return outcome.kind === 'matched' ? outcome.entry.missionId : outcome.kind;
}

for (const sentence of VARIANTS) {
  const got = matchOf(sentence);
  if (got !== DOOR_ID) failures.push(`「${sentence}」 → ${got} — ${DOOR_ID} 하나에만 맞아야 한다`);
}

// 발표장에서 음성이 실패하면 텍스트로 같은 문장을 넣는다(§1). 매칭 경로가 하나라서
// 같은 함수를 지나지만, 「같은 경로다」는 검사로만 유지된다.
if (matchOf(VARIANTS[0]) !== matchOf(VARIANTS[0].replace(/\s+/g, ''))) {
  failures.push('공백을 지운 같은 문장이 다른 대본을 고른다 — normalize 가 매칭 경로 하나를 지나지 않는다');
}

// ── 2. 이웃 편을 빼앗지 않는가 ────────────────────────────────────────────────
//
// 새 편의 키워드가 넓으면 기존 편의 문장이 모호로 넘어간다. 특히 3편의 must 는 「수문」이라
// 「문」과 겹칠 자리다. 기존 네 문장이 **여전히 자기 편에만** 맞아야 한다.
for (const id of SCRIPT_IDS) {
  if (id === DOOR_ID) continue;
  const s = read(id);
  const got = matchOf(s.utterance.text);
  if (got !== id) failures.push(`기존 편 문장 「${s.utterance.text}」 → ${got} — 새 편이 ${id} 을 빼앗았다`);
}
for (const sentence of ['수문을 가동해', '수문 개폐해줘']) {
  const got = matchOf(sentence);
  if (got !== 'MSN-260831-03') {
    failures.push(`「${sentence}」 → ${got} — 「수문」은 3편이어야 한다. 새 편의 「문」이 넓다`);
  }
}
if (matchOf('안녕하세요') !== 'none') failures.push('「안녕하세요」가 거부되지 않았다');

// ── 3. 마일스톤 셋 · 순서도의 부채꼴 ──────────────────────────────────────────
const milestoneIds = door.milestones.map((m) => m.id);
if (JSON.stringify(milestoneIds) !== JSON.stringify(['MS-A', 'MS-B', 'MS-C'])) {
  failures.push(`마일스톤이 [${milestoneIds.join(', ')}] — 순서도는 MS-A · MS-B · MS-C 셋이다`);
}
// MS-C 는 순서도상 태스크가 없는 종료 마일스톤이지만, 빈 마일스톤은 접어도 영원히
// pending 이라 verify:script-library 가 막는다. 종료 태스크 하나를 두기로 했다(§2 대비책).
const msC = door.tasks.filter((t) => t.milestone === 'MS-C');
if (msC.length !== 1) failures.push(`MS-C 의 태스크가 ${msC.length}개 — 종료 확인 하나여야 한다`);

const byId = new Map(door.tasks.map((t) => [t.id, t]));
const FAN = Array.from({ length: 8 }, (_, i) => `T-A4-${i}`);

for (const id of FAN) {
  const t = byId.get(id);
  if (!t) { failures.push(`${id} 이 없다 — 8분할 뷰포인트가 여덟이 아니다`); continue; }
  if (JSON.stringify(t.deps) !== JSON.stringify(['T-A3'])) {
    failures.push(`${id}.deps 가 [${(t.deps ?? []).join(', ')}] — 여덟이 모두 T-A3 하나에 매달려야 한다(부채꼴)`);
  }
  if (t.milestone !== 'MS-A') failures.push(`${id} 이 MS-A 밖이다 — ${t.milestone}`);
}

// T-A5 는 90도 하나에만 매달린다. 나머지 일곱에서는 선이 나가지 않는다(§3).
const a5 = byId.get('T-A5');
if (!a5) {
  failures.push('T-A5 가 없다');
} else if (JSON.stringify(a5.deps) !== JSON.stringify(['T-A4-2'])) {
  failures.push(`T-A5.deps 가 [${(a5.deps ?? []).join(', ')}] — 순서도는 90도(T-A4-2) 하나다`);
}
const strays = door.tasks.filter(
  (t) => t.id !== 'T-A5' && (t.deps ?? []).some((d) => FAN.includes(d)),
);
if (strays.length > 0) {
  failures.push(`뷰포인트에서 T-A5 말고도 선이 나간다 — ${strays.map((t) => t.id).join(', ')}`);
}

// ── 4. 초록은 90도 하나 ──────────────────────────────────────────────────────
const detections = (door.viewpointTimeline ?? []).filter((f) => f.channel === 'detection');
if (detections.length !== 8) {
  failures.push(`탐지 프레임이 ${detections.length}개 — 여덟이어야 한다`);
}
const doors = detections.filter((f) => f.payload.door === true);
if (doors.length !== 1) {
  failures.push(`문 있음이 ${doors.length}곳 — 90도 하나여야 한다`);
} else if (doors[0].payload.index !== 2 || doors[0].payload.angle_deg !== 90) {
  failures.push(`문 있음이 index ${doors[0].payload.index}(${doors[0].payload.angle_deg}도) — 90도 하나여야 한다`);
}
// 근거 문장은 발표에서 읽힌다. 비어 있으면 5절의 자리가 빈 채로 시연에 들어간다.
if (!String(doors[0]?.payload?.reason ?? '').trim()) failures.push('문 있음 프레임에 근거 문장이 없다');
if (!Array.isArray(doors[0]?.payload?.bbox)) failures.push('문 있음 프레임에 bbox 가 없다');

// ── 5. 회전 박자 — 1초 회전 + 1초 유지, 여덟이면 16초 (§4) ────────────────────
const rotations = (door.viewpointTimeline ?? []).filter((f) => f.channel === 'robot_state' && f.payload.state === 'rotating');
if (rotations.length !== 8) {
  failures.push(`회전 프레임이 ${rotations.length}개 — 여덟이어야 한다`);
} else {
  const seen = rotations.map((f) => f.payload.rotation_index).join(',');
  if (seen !== '0,1,2,3,4,5,6,7') failures.push(`회전 인덱스가 ${seen} — 0~7 이어야 한다`);
  for (let i = 0; i < 8; i += 1) {
    const gap = detections[i].atSec - rotations[i].atSec;
    if (gap !== 1) failures.push(`인덱스 ${i}: 회전과 탐지 사이가 ${gap}초 — 1초 회전 + 1초 유지다`);
  }
  const span = rotations[7].atSec + 2 - rotations[0].atSec;
  if (span !== 16) failures.push(`여덟의 회전 구간이 ${span}초 — 16초여야 한다`);
}
// 대본에는 실시간 초를 적는다(§4). 배속 압축은 재생기의 몫이다.
if (door.params?.spin_seconds !== 16) failures.push('params.spin_seconds 가 16이 아니다 — 대본에는 실시간 초를 적는다');

// ── 6. 8분할 배치 선언 (§4 · 특례의 원천) ────────────────────────────────────
const vp = door.viewpoints;
if (!vp) {
  failures.push('viewpoints 선언이 없다 — 원형 배치 특례가 걸릴 곳이 없다');
} else {
  if (vp.parentTaskId !== 'T-A3') failures.push(`viewpoints.parentTaskId 가 ${vp.parentTaskId} — T-A3 여야 한다`);
  if (JSON.stringify(vp.taskIds) !== JSON.stringify(FAN)) failures.push('viewpoints.taskIds 가 T-A4-0~7 여덟이 아니다');
  if (vp.stepDeg !== 45) failures.push(`viewpoints.stepDeg 가 ${vp.stepDeg} — 45도여야 한다`);
}

// ── 대조군 — 무력화한 사본이 잡히는가 ────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // 새 편의 must 를 「문」 하나로 넓히면 3편과 겹친다 — 그것이 잡히는가.
  const wide = library.map((e) => (e.missionId === DOOR_ID ? { ...e, match: { ...e.match, must: [['문']] } } : e));
  const outcome = matchLibrary('수문을 가동해', wide);
  control('must 를 「문」으로 넓힘(3편과 모호)', outcome.kind === 'ambiguous');
}
{
  // 여덟 중 하나를 다른 부모에 매달면 부채꼴이 아니다.
  const m = structuredClone(door);
  m.tasks.find((t) => t.id === 'T-A4-5').deps = ['T-A4-4'];
  const bad = FAN.some((id) => JSON.stringify(m.tasks.find((t) => t.id === id).deps) !== JSON.stringify(['T-A3']));
  control('뷰포인트 하나를 사슬로 바꿈', bad);
}
{
  // 초록을 둘로 만들면 판단이 성립하지 않는다.
  const m = structuredClone(door);
  m.viewpointTimeline.find((f) => f.channel === 'detection' && f.payload.index === 5).payload.door = true;
  const greens = m.viewpointTimeline.filter((f) => f.channel === 'detection' && f.payload.door === true);
  control('초록을 둘로 늘림', greens.length !== 1);
}

// ── 결과 ─────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`❌ verify:script-door\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`✅ 발화 변형 ${VARIANTS.length}개 전부 ${DOOR_ID} 하나에 — 텍스트 입력도 같은 경로`);
console.log('✅ 기존 편 문장 무사 · 「수문」은 3편 · 「안녕하세요」는 거부');
console.log(`✅ 마일스톤 셋 · 태스크 ${door.tasks.length} · T-A4-0~7 여덟이 T-A3 하나에 · T-A5 는 90도 하나에만`);
console.log('✅ 초록은 90도 하나 · 근거 문장과 bbox 있음 · 회전 16초(1초 회전 + 1초 유지)');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
