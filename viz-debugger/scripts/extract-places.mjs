/**
 * scripts/extract-places.mjs — 작업프롬프트_마일스톤분리_260904.md §1
 *
 * Unity 씬(N45F_Map.unity)에서 장소 위상과 기하를 뽑아 두 파일로 나눈다.
 *
 * **기준 좌표계는 이 씬의 월드 좌표다 — 그것이 `site-global` 의 정의이고 단위는 m.**
 * 씬 자체는 줄자 실측과 피난 안내도 밑그림으로 만들었다. 측량 등급이 아니다(places/README.md).
 *
 *   places/places.json           위상 — 생성 서비스가 읽는다 (좌표 없음)
 *   places/places.geometry.json  기하 — 생성 서비스는 읽지 않는다
 *
 * **분류 규칙은 좌표에서 나온다.** 문 이름을 보고 손으로 배정하지 않는다 —
 * 복도 두 축의 위치를 씬에서 계산하고, 각 문이 어느 축에 붙었는지로 정한다.
 * 그래야 층이 늘어도 같은 스크립트가 돈다.
 *
 * **방은 번호로만 부른다.** 기능 이름(강의실·산학협동실 …)은 씬에 없는 정보이고
 * 방 용도는 바뀐다 — 그때마다 추출 결과가 흔들리면 그것은 실측이 아니다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SCENE_REL = 'Unity_Map/Assets/Scenes/N45F_Map.unity';
const ROOM503_REL = 'Unity_Map/Assets/XRI/lab.unity';
const SCENE = ROOT + SCENE_REL;
const ROOM503 = ROOT + ROOM503_REL;
const ZONE = 'zone-503';
const FLOOR = 5;


// ── 씬 파싱 ────────────────────────────────────────────────────────────────
const txt = readFileSync(SCENE, 'utf8');
const blocks = txt.split(/\n--- /);
const gos = new Map();      // fileID -> name
const trs = new Map();      // fileID -> {go, pos, father}
const prefabs = [];         // {name, local, parent}

for (const b of blocks) {
  const h = b.match(/^!u!(\d+) &(\d+)/);
  if (!h) continue;
  const [, cls, fid] = h;
  if (cls === '1') {
    const n = b.match(/\n  m_Name: (.*)/);
    gos.set(fid, n ? n[1].trim() : '');
  } else if (cls === '4') {
    const g = b.match(/m_GameObject: \{fileID: (\d+)\}/);
    const p = b.match(/m_LocalPosition: \{x: (\S+), y: (\S+), z: (\S+)\}/);
    const f = b.match(/m_Father: \{fileID: (\d+)\}/);
    trs.set(fid, {
      go: g?.[1] ?? null,
      pos: p ? [+p[1], +p[2], +p[3]] : [0, 0, 0],
      father: f?.[1] ?? '0',
    });
  } else if (cls === '1001') {
    let name = null; const loc = {};
    for (const m of b.matchAll(/propertyPath: (m_Name|m_LocalPosition\.[xyz])\s*\n\s*value: (\S*)/g)) {
      if (m[1] === 'm_Name') name = m[2];
      else loc[m[1].slice(-1)] = +m[2];
    }
    const par = b.match(/m_TransformParent: \{fileID: (\d+)\}/);
    if (name) prefabs.push({ name, local: [loc.x ?? 0, loc.y ?? 0, loc.z ?? 0], parent: par?.[1] ?? '0' });
  }
}

const world = (tid) => {
  let [x, y, z] = [0, 0, 0], cur = tid, guard = 0;
  while (cur && cur !== '0' && trs.has(cur) && guard++ < 32) {
    const t = trs.get(cur);
    x += t.pos[0]; y += t.pos[1]; z += t.pos[2];
    cur = t.father;
  }
  return [x, y, z];
};
const prefabWorld = (p) => {
  const [px, py, pz] = p.parent === '0' ? [0, 0, 0] : world(p.parent);
  return [px + p.local[0], py + p.local[1], pz + p.local[2]];
};
/** 이름으로 씬의 일반 오브젝트 월드 좌표를 찾는다. */
const byName = (name) => {
  for (const [tid, t] of trs) if (t.go && gos.get(t.go) === name) return world(tid);
  return null;
};

// ── 문 ─────────────────────────────────────────────────────────────────────
const doors = prefabs
  .filter((p) => /^Door_(\d{3})([FB])?$/.test(p.name))
  .map((p) => {
    const m = p.name.match(/^Door_(\d{3})([FB])?$/);
    return { room: m[1], side: (m[2] ?? '').toLowerCase(), w: prefabWorld(p) };
  });
if (doors.length === 0) throw new Error('문을 하나도 못 찾았다 — 씬 구조가 바뀌었다');

// ── 복도 두 축을 좌표에서 찾는다 ──────────────────────────────────────────
/**
 * 문은 네 줄로 서 있다 — z 가 같은 줄 둘(동서 복도의 양쪽)과 x 가 같은 줄 둘(남북 복도의 양쪽).
 * 그래서 **어느 좌표를 이웃과 공유하는가**로 가른다. 축 하나만 보고 임계값으로 자르면
 * 복도 끝에 붙은 문(520 앞문)이 반대 복도로 넘어간다.
 */
const r2 = (v) => Math.round(v * 20) / 20;
const shareZ = (d) => doors.filter((q) => r2(q.w[2]) === r2(d.w[2])).length;
const shareX = (d) => doors.filter((q) => r2(q.w[0]) === r2(d.w[0])).length;
const mainDoors = doors.filter((d) => shareZ(d) >= shareX(d));
const wingDoors = doors.filter((d) => !mainDoors.includes(d));
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
// 축은 마주 보는 두 줄의 가운데다 — 복도 중심선
const MAIN = { id: 'corridor-5f-main', z: mean([...new Set(mainDoors.map((d) => r2(d.w[2])))]) };
const WING = { id: 'corridor-5f-wing', x: mean([...new Set(wingDoors.map((d) => r2(d.w[0])))]) };
const corridorOf = (d) => (mainDoors.includes(d) ? MAIN.id : WING.id);

// ── 지물 ───────────────────────────────────────────────────────────────────
const landmarks = [
  { id: 'elevator-5f',   kind: 'elevator', label: '엘리베이터',     src: 'Elevator_Area',     aliases: ['엘레베이터', '승강기'] },
  { id: 'restroom-5f',   kind: 'zone',     label: '화장실',         src: 'Restroom_Area',     aliases: ['화장실', '남녀 화장실'] },
  { id: 'stair-5f-west', kind: 'stair',    label: '서편 계단',      src: 'Wall_Stair1',       aliases: ['계단', '비상계단'] },
  { id: 'stair-5f-east', kind: 'stair',    label: '동편 계단',      src: 'Stair_Area',        aliases: ['계단', '비상계단'] },
  { id: 'stair-5f-north',kind: 'stair',    label: '북편 계단',      src: 'Stair_Area_Back_2', aliases: ['계단', '비상계단'] },
].map((l) => {
  const p = prefabs.find((q) => q.name === l.src);
  return { ...l, w: p ? prefabWorld(p) : byName(l.src) };
}).filter((l) => l.w);

// ── 위상 ───────────────────────────────────────────────────────────────────
const places = [];
const adj = new Map();
const link = (a, b) => {
  if (!adj.has(a)) adj.set(a, new Set());
  if (!adj.has(b)) adj.set(b, new Set());
  adj.get(a).add(b); adj.get(b).add(a);
};

for (const d of doors) {
  const id = `door-${d.room}${d.side}`;
  link(id, `room-${d.room}`);
  link(id, corridorOf(d));
}
link(MAIN.id, WING.id);
const NEAR = 8; // m. 복도 교차부의 지물은 두 복도 모두에서 닿는다 — 하나로 강제하지 않는다
for (const l of landmarks) {
  const dMain = Math.abs(l.w[2] - MAIN.z);
  const dWing = Math.abs(l.w[0] - WING.x);
  let linked = false;
  if (dMain < NEAR) { link(l.id, MAIN.id); linked = true; }
  if (dWing < NEAR) { link(l.id, WING.id); linked = true; }
  if (!linked) link(l.id, dMain <= dWing ? MAIN.id : WING.id);
}

const rooms = [...new Set(doors.map((d) => d.room))].sort();
for (const r of rooms) {
  places.push({
    place_id: `room-${r}`, label: `${r}호`,
    aliases: [r, `${r}호`],
    kind: 'room', floor: FLOOR, adjacent: [...(adj.get(`room-${r}`) ?? [])].sort(), zone_id: ZONE,
  });
}
for (const d of doors.sort((a, b) => (a.room + a.side).localeCompare(b.room + b.side))) {
  const id = `door-${d.room}${d.side}`;
  const sideKo = d.side === 'f' ? ' 앞문' : d.side === 'b' ? ' 뒷문' : ' 문';
  places.push({
    place_id: id, label: `${d.room}호${sideKo}`,
    aliases: [`${d.room}호 문`, `${d.room} 문`],
    kind: 'door', floor: FLOOR, adjacent: [...adj.get(id)].sort(), zone_id: ZONE,
  });
}
places.push({
  place_id: MAIN.id, label: '5층 동서 복도',
  aliases: ['복도', '5층 복도', '메인 복도'],
  kind: 'corridor', floor: FLOOR, adjacent: [...adj.get(MAIN.id)].sort(), zone_id: ZONE,
});
places.push({
  place_id: WING.id, label: '5층 남북 복도',
  aliases: ['복도', '5층 복도', '측면 복도'],
  kind: 'corridor', floor: FLOOR, adjacent: [...adj.get(WING.id)].sort(), zone_id: ZONE,
});
for (const l of landmarks) {
  places.push({
    place_id: l.id, label: l.label, aliases: l.aliases,
    kind: l.kind, floor: FLOOR, adjacent: [...adj.get(l.id)].sort(), zone_id: ZONE,
  });
}
/**
 * ── 자리표시: 아직 재지 않은 곳 ─────────────────────────────────────────────
 *
 * 지금 잰 것은 **5층 복도와 503호뿐이다.** 4층 맵 데이터는 없다(2026-09-07 확인).
 *
 * `room-415` 는 옛 편 `MSN-260826-01` 의 발화(「415호에서 503호로」)에 나오므로
 * **자리는 두되 인접을 비운다.** 4층 복도·엘리베이터를 이어 붙이면 재지 않은 위상을
 * 지어내는 것이 되고, 그 지도로 낸 숫자는 실측 위에 서 있지 않게 된다.
 *
 * **그래서 415→503 임무는 지금 그라운딩이 성립하지 않는다.** 모델에게 415호는 어디로도
 * 이어지지 않은 섬이다. 그 편의 점수를 다른 편과 같은 표에 올리면 안 된다 —
 * 처리는 채점기 쪽에 있다(`score-generation.mjs` 의 보류 표시).
 *
 * 4층을 재면 그때 잇는다. 그 전까지는 **없는 것을 없는 대로 둔다.**
 */
const HELD_OPEN = [
  { place_id: 'room-415', label: '415호', aliases: ['415', '415호'], kind: 'room', floor: 4,
    adjacent: [] },
];
for (const h of HELD_OPEN) places.push({ ...h, zone_id: null });

// ── 기하 ───────────────────────────────────────────────────────────────────
const round = (v) => Math.round(v * 100) / 100;
const geometry = [];
for (const d of doors) geometry.push({
  place_id: `door-${d.room}${d.side}`,
  position: { x: round(d.w[0]), y: round(d.w[1]), z: round(d.w[2]), frame: 'site-global' },
});
for (const l of landmarks) geometry.push({
  place_id: l.id,
  position: { x: round(l.w[0]), y: round(l.w[1]), z: round(l.w[2]), frame: 'site-global' },
});
geometry.push({ place_id: MAIN.id, axis: 'z', at: round(MAIN.z),
  span: { from: round(Math.min(...mainDoors.map((d) => d.w[0]))), to: round(Math.max(...mainDoors.map((d) => d.w[0]))) }, frame: 'site-global' });
geometry.push({ place_id: WING.id, axis: 'x', at: round(WING.x),
  span: { from: round(Math.min(...wingDoors.map((d) => d.w[2]))), to: round(Math.max(...wingDoors.map((d) => d.w[2]))) }, frame: 'site-global' });

// ── 503호 실내 ─────────────────────────────────────────────────────────────
/**
 * 503호는 별도 씬(`XRI/lab.unity`)이고 **자기 좌표계**를 쓴다.
 * 두 프레임을 잇는 앵커는 문 하나다 — 실내의 `Door` 가 복도의 `door-503` 이다.
 * 배치는 씬 그대로가 맞고 회전은 없다(2026-09-06 확인). 그래서 평행이동 하나면 된다.
 *
 * **y 는 넣지 않는다.** 씬의 벽 높이는 편의값이고 실측이 아니다 — 없는 것을 있는 척하지 않는다.
 */
function room503() {
  const raw = readFileSync(ROOM503, 'utf8');
  const bl = raw.split(/\n--- /);
  const g2 = new Map(); const t2 = new Map();
  for (const b of bl) {
    const h = b.match(/^!u!(\d+) &(\d+)/); if (!h) continue;
    if (h[1] === '1') { const n = b.match(/\n  m_Name: (.*)/); g2.set(h[2], n ? n[1].trim() : ''); }
    else if (h[1] === '4') {
      const gg = b.match(/m_GameObject: \{fileID: (\d+)\}/);
      const pp = b.match(/m_LocalPosition: \{x: (\S+), y: (\S+), z: (\S+)\}/);
      const ss = b.match(/m_LocalScale: \{x: (\S+), y: (\S+), z: (\S+)\}/);
      const ff = b.match(/m_Father: \{fileID: (\d+)\}/);
      t2.set(h[2], { go: gg?.[1] ?? null, pos: pp ? [+pp[1], +pp[2], +pp[3]] : [0, 0, 0],
                     scale: ss ? [+ss[1], +ss[2], +ss[3]] : [1, 1, 1], father: ff?.[1] ?? '0' });
    }
  }
  const w2 = (tid) => { let [x, y, z] = [0, 0, 0], c = tid, n = 0;
    while (c && c !== '0' && t2.has(c) && n++ < 32) { const t = t2.get(c); x += t.pos[0]; y += t.pos[1]; z += t.pos[2]; c = t.father; } return [x, y, z]; };
  const find = (name) => { for (const [tid, t] of t2) if (t.go && g2.get(t.go) === name) return { w: w2(tid), scale: t.scale }; return null; };
  const walls = []; for (const [tid, t] of t2) { const n = g2.get(t.go); if (n && /^wall/i.test(n)) walls.push({ w: w2(tid), s: t.scale }); }
  // 옆벽(z 로 긴 것)이 x 경계를, 앞뒤벽(x 로 긴 것)이 z 경계를 준다
  const sideX = walls.filter((w) => w.s[2] > w.s[0]).map((w) => w.w[0]);
  const endZ  = walls.filter((w) => w.s[0] > w.s[2]).map((w) => w.w[2]);
  const door = find('Door');
  if (!door || !sideX.length || !endZ.length) return null;
  const corridorDoor = geometry.find((g) => g.place_id === 'door-503');
  if (!corridorDoor) return null;
  // 앵커 평행이동 — 회전 없음
  const dx = corridorDoor.position.x - door.w[0];
  const dz = corridorDoor.position.z - door.w[2];
  const to = (p) => ({ x: round(p[0] + dx), z: round(p[2] + dz) });
  const anchors = {};
  for (const n of ['StartPoint', 'GoalPoint', 'go1', 'Anchor360']) { const f = find(n); if (f) anchors[n] = to(f.w); }
  return {
    place_id: 'room-503',
    frame: 'site-global',
    bounds: { x: { from: round(Math.min(...sideX) + dx), to: round(Math.max(...sideX) + dx) },
              z: { from: round(Math.min(...endZ) + dz),  to: round(Math.max(...endZ) + dz) } },
    size_m: { width: round(Math.max(...sideX) - Math.min(...sideX)), depth: round(Math.max(...endZ) - Math.min(...endZ)) },
    interior: { scene: ROOM503_REL, anchor: 'Door ↔ door-503', rotation_deg: 0,
                offset: { x: round(dx), z: round(dz) } },
    anchors,
    note: 'y(높이)는 없다 — 씬의 벽 높이는 편의값이고 실측이 아니다(2026-09-06 확인).',
  };
}
const r503 = room503();
if (r503) geometry.push(r503);

// ── 쓰기 ───────────────────────────────────────────────────────────────────
writeFileSync(ROOT + 'places/places.json', JSON.stringify({
  schema: 'contracts/place.schema.json',
  extracted_from: { scene: SCENE_REL, script: 'scripts/extract-places.mjs' },
  held_open: HELD_OPEN.map((h) => h.place_id),
  held_open_note: '아직 재지 않은 자리다 — 좌표도 인접도 없다. 4층 맵 데이터가 없어서 415호는 섬으로 둔다(260907). places.geometry.json 에 이들의 자리는 없어야 하고 verify:places 가 그것을 검사한다.',
  note: '좌표는 여기 없다 — places.geometry.json 이 든다. **방은 번호로만 부른다** — 기능 이름(강의실·연구실)은 넣지 않는다: 씬에 없는 정보이고 방 용도는 바뀐다.',
  places,
}, null, 2) + '\n');
writeFileSync(ROOT + 'places/places.geometry.json', JSON.stringify({
  extracted_from: { scene: SCENE_REL, script: 'scripts/extract-places.mjs' },
  warning: '생성 서비스는 이 파일을 읽지 않는다 — verify:places 가 그 경로를 검사한다.',
  frame: 'site-global = N45F_Map.unity 월드 좌표, 단위 m. 줄자 실측 기반이며 측량 등급이 아니다(places/README.md).',
  geometry,
}, null, 2) + '\n');

console.log(`자리표시 ${HELD_OPEN.length}건 (측정 안 함 · 좌표 없음): ${HELD_OPEN.map((h) => h.place_id).join(' · ')}`);
console.log(`장소 ${places.length}건 — 방 ${rooms.length} · 문 ${doors.length} · 복도 2 · 지물 ${landmarks.length}`);
if (r503) console.log(`503호 실내 ${r503.size_m.width}\u00d7${r503.size_m.depth} m — 오프셋 (${r503.interior.offset.x}, ${r503.interior.offset.z}), 앵커 ${Object.keys(r503.anchors).join(' · ')}`);
console.log(`동서 복도 z=${round(MAIN.z)} (문 ${mainDoors.length}) · 남북 복도 x=${round(WING.x)} (문 ${wingDoors.length})`);
