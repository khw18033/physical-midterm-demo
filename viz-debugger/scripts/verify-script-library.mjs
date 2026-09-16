// 대본 라이브러리 검증 — 시나리오 대본 세 편(+옛 편 사이드카)이 약속을 지키는지.
//
// 이 작업이 막으려는 실패는 둘이다.
//  1. **대본이 registry.json 세계 밖을 가리키는 것** — 탭 간 연결은 같은 ID라야 성립한다.
//     cast·worldTimeline·commands의 장비가 전부 레지스트리에 실재해야 하고,
//     명령은 그 장비의 ACTION_CATALOG에 있는 것이어야 한다.
//  2. **대본 조회가 LLM 흉내를 내는 것** — 매칭은 키워드 대조이고, 맞는 대본이 없으면
//     없다고 해야 한다. 세 문장이 각각 자기 대본에만 맞고, 옛 문장은 옛 편에만 맞고,
//     "안녕하세요"는 아무 대본에도 안 맞아야 한다. 두 편에 맞으면 억지로 고르지 않는다.
//
// 매칭 규칙(normalize·must·any)은 `src/scenarios/matcher.ts` **하나**를 import 한다 —
// 게이트웨이(script-engine)·브라우저(발화 패널)와 같은 파일이라, 이 검사가 통과하면
// 세 곳이 같은 대본을 고른다는 뜻이 된다. 두 벌이면 갈라진다.
//
// 음성 대조군 포함 — 검사를 무력화한 사본(유령 장비·시각 역전·제목의 하드웨어 어휘·
// 근거값 삭제·빈 must·중복 매칭·derived 필드 삭제)이 반드시 실패로 잡히는지 확인한다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// 매처·목록 — 게이트웨이·브라우저와 같은 원천.
const { matchLibrary } = await import(pathToFileURL(join(root, 'src', 'scenarios', 'matcher.ts')).href);
const { SCRIPT_IDS: MANIFEST_IDS, LEGACY_ID } = await import(
  pathToFileURL(join(root, 'src', 'scenarios', 'manifest.ts')).href
);

// ── 원천 셋: 레지스트리 · 액션 카탈로그 · 대본 파일 ─────────────────────────────
// 레지스트리 경로는 server.ts와 같은 규칙 — 복사본을 만들지 않는다 (REQ-305).
const registryDir = process.env.VIZ_REGISTRY_DIR ?? join(root, '..', 'web-dashboard', 'mock-gateway');
const registry = JSON.parse(readFileSync(join(registryDir, 'registry.json'), 'utf8'));
const { ACTION_CATALOG } = await import(pathToFileURL(join(root, 'gateway', 'commands.ts')).href);

const registryIds = new Set(registry.entities.map((e) => e.id));
// 제목에 나오면 안 되는 하드웨어 어휘 — entity ID · display_name · entity_type (REQ-1408).
// aliases는 검사하지 않는다: 사용자가 준 단계 자체가 「고정 카메라」 같은 역할 명사를
// 포함하며, 그것은 등록된 특정 장비 이름이 아니라 도메인 어휘다.
const forbiddenVocab = [
  ...registry.entities.map((e) => e.id),
  ...registry.entities.map((e) => e.display_name),
  ...new Set(registry.entities.map((e) => e.entity_type)),
];

const SCRIPT_IDS = [...MANIFEST_IDS];
const scripts = SCRIPT_IDS.map((id) =>
  JSON.parse(readFileSync(join(root, 'scenarios', `${id}.json`), 'utf8')),
);
const legacy = JSON.parse(readFileSync(join(root, 'scenarios', `${LEGACY_ID}.json`), 'utf8'));
const legacySidecar = JSON.parse(readFileSync(join(root, 'scenarios', `${LEGACY_ID}.match.json`), 'utf8'));

const STATUSES = new Set(['pending', 'running', 'done', 'failed', 'skipped', 'awaiting_evaluation', 'not_executed', 'rerunning']);
const KINDS = new Set(['created', 'dispatched', 'acked', 'started', 'progress', 'evaluated', 'failed', 'derived']);

// ── 대본 한 편 검사 ───────────────────────────────────────────────────────────
function checkScript(s) {
  const f = [];
  const at = s.missionId ?? '(missionId 없음)';

  if (s.world !== 'registry') f.push(`${at}: world가 'registry'가 아니다 — ${s.world}`);
  if (!s.utterance?.text?.trim()) f.push(`${at}: utterance.text가 비었다`);
  if (typeof s.durationSec !== 'number' || s.durationSec <= 0) f.push(`${at}: durationSec이 없다`);

  // match — must가 비어 있으면 아무 문장이나 맞거나 아무 문장도 안 맞는다. 둘 다 사고다.
  if (!Array.isArray(s.match?.must) || s.match.must.length === 0) {
    f.push(`${at}: match.must가 비었다`);
  } else {
    for (const group of s.match.must) {
      if (!Array.isArray(group) || group.length === 0 || group.some((w) => !String(w).trim())) {
        f.push(`${at}: match.must 그룹이 비었거나 빈 문자열을 담는다`);
      }
    }
  }

  // cast — 탭②~⑤에 그려도 되는 장비. 전부 레지스트리에 실재해야 한다.
  if (!Array.isArray(s.cast) || s.cast.length === 0) f.push(`${at}: cast가 비었다`);
  const cast = new Set(s.cast ?? []);
  if (cast.size !== (s.cast ?? []).length) f.push(`${at}: cast에 중복이 있다`);
  for (const id of cast) {
    if (!registryIds.has(id)) f.push(`${at}: cast의 ${id}가 registry.json에 없다`);
  }

  // milestones — 정적 status 금지(태스크 상태를 접은 결과라야 되감기와 안 어긋난다).
  const milestoneIds = new Set();
  for (const m of s.milestones ?? []) {
    if (!m.id?.trim() || !m.title?.trim()) f.push(`${at}: 마일스톤 id/title이 비었다`);
    if (milestoneIds.has(m.id)) f.push(`${at}: 마일스톤 id 중복 — ${m.id}`);
    milestoneIds.add(m.id);
    if ('status' in m) f.push(`${at}/${m.id}: 마일스톤에 정적 status가 있다 — 태스크 상태를 접은 결과여야 한다`);
    for (const t of m.assignedTargets ?? []) {
      if (!cast.has(t)) f.push(`${at}/${m.id}: assignedTargets의 ${t}가 cast에 없다`);
    }
  }

  // tasks — 제목의 하드웨어 어휘 · deps DAG · target ∈ cast.
  const taskIds = new Set();
  const evalTasks = new Set();
  for (const t of s.tasks ?? []) {
    if (taskIds.has(t.id)) f.push(`${at}: 태스크 id 중복 — ${t.id}`);
    taskIds.add(t.id);
    if (!milestoneIds.has(t.milestone)) f.push(`${at}/${t.id}: milestone ${t.milestone}이 없다`);
    if (t.target !== null && !cast.has(t.target)) f.push(`${at}/${t.id}: target ${t.target}이 cast에 없다`);
    for (const d of t.deps ?? []) {
      if (d === t.id) f.push(`${at}/${t.id}: 자기 자신에 의존한다`);
    }
    if (t.evaluation) {
      if (!Array.isArray(t.evaluation.criteria) || t.evaluation.criteria.length === 0) {
        f.push(`${at}/${t.id}: evaluation.criteria가 비었다`);
      }
      evalTasks.add(t.id);
    }
  }
  for (const t of s.tasks ?? []) {
    for (const d of t.deps ?? []) {
      if (d !== t.id && !taskIds.has(d)) f.push(`${at}/${t.id}: deps의 ${d}가 없다`);
    }
  }
  // 순환 검사 — DAG여야 되감기 접기가 성립한다 (REQ-1402).
  const depsOf = Object.fromEntries((s.tasks ?? []).map((t) => [t.id, t.deps ?? []]));
  const state = {};
  const cyclic = (id) => {
    if (state[id] === 2) return false;
    if (state[id] === 1) return true;
    state[id] = 1;
    const hit = (depsOf[id] ?? []).some((d) => d in depsOf && cyclic(d));
    state[id] = 2;
    return hit;
  };
  if ((s.tasks ?? []).some((t) => cyclic(t.id))) f.push(`${at}: 태스크 deps에 순환이 있다`);

  // 마일스톤마다 태스크가 하나는 있어야 한다 — 없으면 접어도 영원히 pending이다.
  for (const id of milestoneIds) {
    if (!(s.tasks ?? []).some((t) => t.milestone === id)) {
      f.push(`${at}/${id}: 이 마일스톤을 접을 태스크가 없다`);
    }
  }

  // 제목의 하드웨어 어휘 (REQ-1408) — verify:hierarchy는 계약 스키마의 필드 주입만 보므로
  // 제목 문구는 여기서 새로 본다. entity ID·display_name·entity_type이 기준이다.
  const titles = [
    ...(s.milestones ?? []).map((m) => ({ where: `${at}/${m.id}`, title: m.title ?? '' })),
    ...(s.tasks ?? []).map((t) => ({ where: `${at}/${t.id}`, title: t.title ?? '' })),
  ];
  for (const { where, title } of titles) {
    const lower = title.toLowerCase();
    for (const word of forbiddenVocab) {
      if (word && lower.includes(String(word).toLowerCase())) {
        f.push(`${where}: 제목에 하드웨어 어휘 「${word}」 — 기종 의존 값은 assignedTargets·target·액션 아이템으로`);
      }
    }
  }

  // events — 시각 순서 · 8상태 · trace kind · 파생 사건의 형식.
  const events = s.events ?? [];
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (i > 0 && e.atSec < events[i - 1].atSec) f.push(`${at}: 이벤트 시각 역전 — seq ${e.seq}`);
    if (!taskIds.has(e.nodeId)) f.push(`${at}: 이벤트 seq ${e.seq}의 nodeId ${e.nodeId}가 태스크에 없다`);
    if (!STATUSES.has(e.status)) f.push(`${at}: 이벤트 seq ${e.seq}의 status가 8상태 밖 — ${e.status}`);
    if (!KINDS.has(e.kind)) f.push(`${at}: 이벤트 seq ${e.seq}의 kind가 계약 밖 — ${e.kind}`);
    if (e.atSec > s.durationSec) f.push(`${at}: 이벤트 seq ${e.seq}가 durationSec을 넘는다`);
    if (e.kind === 'derived') {
      // 파생은 새 태스크가 아니라 같은 태스크의 2회차다 — derivedFrom과 attempt: 2가 있어야
      // "왜 다시 도는가"를 화면이 되짚을 수 있다.
      if (e.attempt !== 2) f.push(`${at}: derived 사건 seq ${e.seq}에 attempt: 2가 없다`);
      if (!e.derivedFrom || !taskIds.has(e.derivedFrom)) f.push(`${at}: derived 사건 seq ${e.seq}에 derivedFrom이 없거나 태스크 밖이다`);
    }
  }

  // 평가로 끝나는 태스크 — awaiting_evaluation → done 전이와 근거값 (REQ-1403 · REQ-1505).
  for (const id of evalTasks) {
    const own = events.filter((e) => e.nodeId === id);
    const awaiting = own.filter((e) => e.status === 'awaiting_evaluation');
    if (awaiting.length === 0) {
      f.push(`${at}/${id}: 평가 태스크인데 awaiting_evaluation 사건이 없다`);
      continue;
    }
    for (const a of awaiting) {
      const attempt = a.attempt ?? 1;
      const done = own.find((e) => e.status === 'done' && (e.attempt ?? 1) === attempt && e.atSec >= a.atSec);
      if (!done) {
        f.push(`${at}/${id}: awaiting_evaluation(attempt ${attempt}) 뒤에 done이 없다 — 평가 통과로만 종료가 성립한다`);
        continue;
      }
      const evidence = Object.keys(done.payload ?? {}).filter((k) => k !== 'criterion');
      if (evidence.length === 0) f.push(`${at}/${id}: done(attempt ${attempt})에 근거값이 없다 — 평가는 근거가 도달해야 통과다`);
    }
  }
  // 역방향 — 평가 선언 없는 태스크가 awaiting_evaluation을 지나면 안 된다.
  for (const e of events) {
    if (e.status === 'awaiting_evaluation' && !evalTasks.has(e.nodeId)) {
      f.push(`${at}/${e.nodeId}: evaluation 선언 없이 awaiting_evaluation을 지난다`);
    }
  }

  // worldTimeline — 시각 순서 · 장비는 cast 안 · drive는 비어 있지 않게.
  const wt = s.worldTimeline ?? [];
  for (let i = 0; i < wt.length; i += 1) {
    const w = wt[i];
    if (i > 0 && w.atSec < wt[i - 1].atSec) f.push(`${at}: worldTimeline 시각 역전 — atSec ${w.atSec}`);
    if (!cast.has(w.entity)) f.push(`${at}: worldTimeline의 ${w.entity}가 cast에 없다`);
    if (!registryIds.has(w.entity)) f.push(`${at}: worldTimeline의 ${w.entity}가 registry.json에 없다`);
    if (!w.drive || Object.keys(w.drive).length === 0) f.push(`${at}: worldTimeline atSec ${w.atSec}의 drive가 비었다`);
    if (w.atSec > s.durationSec) f.push(`${at}: worldTimeline atSec ${w.atSec}가 durationSec을 넘는다`);
  }

  // commands — 엔진을 실제로 통과할 명령. 카탈로그에 있어야 하고 사람이 주체면 안 된다.
  const cmds = s.commands ?? [];
  for (let i = 0; i < cmds.length; i += 1) {
    const c = cmds[i];
    if (i > 0 && c.atSec < cmds[i - 1].atSec) f.push(`${at}: commands 시각 역전 — atSec ${c.atSec}`);
    if (!cast.has(c.entity)) f.push(`${at}: commands의 ${c.entity}가 cast에 없다`);
    if (!registryIds.has(c.entity)) f.push(`${at}: commands의 ${c.entity}가 registry.json에 없다`);
    const specs = ACTION_CATALOG[c.entity] ?? [];
    if (!specs.some((spec) => spec.action === c.action)) {
      f.push(`${at}: ${c.entity}의 ACTION_CATALOG에 ${c.action}이 없다`);
    }
    if (!taskIds.has(c.taskId)) f.push(`${at}: commands의 taskId ${c.taskId}가 태스크에 없다`);
    if (c.producedBy === 'human') f.push(`${at}: commands atSec ${c.atSec}의 주체가 human이다 — 임무가 낸 명령이 사람이 누른 것처럼 남으면 안 된다`);
    if (c.atSec > s.durationSec) f.push(`${at}: commands atSec ${c.atSec}가 durationSec을 넘는다`);
  }

  // initial — 대본 시작 시 세계의 초기 조건. cast 밖 장비를 건드리면 안 된다.
  for (const id of Object.keys(s.initial ?? {})) {
    if (!cast.has(id)) f.push(`${at}: initial의 ${id}가 cast에 없다`);
  }

  // refEdges (노드 분화 260831) — 되돌아가는 참조 엣지. deps 가 아니라 별도 목록이다
  // (layout.depths() 의 순환 방지). 실재하는 태스크만 이어야 하고, deps 와 겹치면 안 된다.
  for (const edge of s.refEdges ?? []) {
    if (!taskIds.has(edge.from) || !taskIds.has(edge.to)) {
      f.push(`${at}: refEdge ${edge.from}→${edge.to} 가 태스크 밖을 가리킨다`);
    }
    if (!edge.label?.trim()) f.push(`${at}: refEdge ${edge.from}→${edge.to} 에 label 이 없다`);
    const toTask = (s.tasks ?? []).find((t) => t.id === edge.to);
    if (toTask?.deps.includes(edge.from)) {
      f.push(`${at}: refEdge ${edge.from}→${edge.to} 가 deps 에도 들어 있다 — 순환이 된다`);
    }
  }
  // nodeKind (노드 분화 260831) — 문법 5종 밖의 값이 들어오면 화면 표기가 깨진다.
  const NODE_KINDS = new Set(['sense', 'decide', 'act', 'verify', 'report']);
  for (const t of s.tasks ?? []) {
    if (t.nodeKind !== undefined && !NODE_KINDS.has(t.nodeKind)) {
      f.push(`${at}/${t.id}: nodeKind '${t.nodeKind}' 는 문법 5종 밖이다`);
    }
  }

  // map — 있으면 사각지대는 둘 이상(하나면 「다음 사각지대로」가 성립하지 않는다).
  if (s.map) {
    const cells = s.map.blind_cells ?? [];
    if (cells.length < 2) f.push(`${at}: map.blind_cells가 ${cells.length}개 — 둘 이상이어야 한다`);
    const cellIds = new Set(cells.map((c) => c.id));
    if (cellIds.size !== cells.length) f.push(`${at}: map.blind_cells id 중복`);
    if (s.map.camera && !cast.has(s.map.camera.entity)) f.push(`${at}: map.camera.entity가 cast에 없다`);
  }

  return f;
}

// ── 편별 고정 검사 — 사용자가 준 시간 값은 줄여 적지 않는다 ─────────────────────
function checkSpecifics(byId) {
  const f = [];
  const s1 = byId['MSN-260831-01'];
  const s2 = byId['MSN-260831-02'];
  const s3 = byId['MSN-260831-03'];

  // 1편 — 거리 ≤ 3 m 평가와 근거값.
  const dist = (s1.events ?? []).find((e) => e.status === 'done' && typeof e.payload?.distance_m === 'number');
  if (!dist) f.push('1편: distance_m 근거값을 남긴 done 사건이 없다');
  else if (dist.payload.distance_m > (s1.params?.stop_distance_max_m ?? 3)) {
    f.push(`1편: 거리 근거값 ${dist.payload.distance_m}가 기준 ${s1.params?.stop_distance_max_m ?? 3} m를 넘는데 통과했다`);
  }
  if ((s1.commands ?? []).length > 0) f.push('1편: 액추에이터가 등장하지 않는 편에 commands가 있다');

  // 2편 — 10분(600초) 그대로 · 파생 2회차 · 사각지대 둘 이상.
  if (s2.params?.rescan_threshold_sec !== 600) f.push('2편: 재탐색 임계가 600초가 아니다 — 10분은 대본 시각으로 600초다. 압축은 배속으로만 한다');
  if (!(s2.durationSec > 600)) f.push('2편: durationSec이 600초 이하라 10분 초과가 대본 안에서 일어날 수 없다');
  const derived = (s2.events ?? []).filter((e) => e.kind === 'derived');
  if (derived.length === 0) f.push('2편: derived 사건이 없다 — 재탐색은 파생 2회차로 적는다');
  if (!derived.some((e) => e.payload?.threshold_sec === 600)) f.push('2편: 재탐색 파생 사건에 임계 600초 근거가 없다');

  // 3편 — 30초·10초·3분 그대로, close → open 순서.
  // 태스크 id 가 아니라 **근거값 키**로 찾는다 — 노드 분화(태스크 세분화)에도 견뎌야 한다.
  const done3 = (s3.events ?? []).filter((e) => e.status === 'done' && e.payload).map((e) => e.payload);
  const rise = done3.find((p) => typeof p.rise_duration_sec === 'number');
  const hold = done3.find((p) => typeof p.hold_sec === 'number');
  const fall = done3.find((p) => typeof p.fall_duration_sec === 'number');
  if (!(rise?.rise_duration_sec >= 30)) f.push('3편: 상승 지속 근거가 30초 미만이거나 없다');
  if (!(hold?.hold_sec >= 10)) f.push('3편: 위험 수위 유지 근거가 10초 미만이거나 없다');
  if (!(fall?.fall_duration_sec >= 180)) f.push('3편: 하락 지속 근거가 180초(3분) 미만이거나 없다');
  if (typeof s3.params?.danger_level_m !== 'number') f.push('3편: params.danger_level_m이 없다 — 탭④ 위험 수위 선이 읽을 값이다');
  const actions = (s3.commands ?? []).map((c) => c.action);
  if (JSON.stringify(actions) !== JSON.stringify(['close_gate', 'open_gate'])) {
    f.push(`3편: 명령이 close_gate → open_gate 순이 아니다 — ${actions.join(', ')}`);
  }
  return f;
}

// ── 본검사 ───────────────────────────────────────────────────────────────────
const failures = [];

const byId = {};
for (let i = 0; i < scripts.length; i += 1) {
  const s = scripts[i];
  if (s.missionId !== SCRIPT_IDS[i]) failures.push(`${SCRIPT_IDS[i]}.json: missionId 불일치 — ${s.missionId}`);
  byId[s.missionId] = s;
  failures.push(...checkScript(s));
}
// 편별 고정 검사는 **그 세 편이 있으면** 돈다. 편수로 조건을 걸면 대본을 더하는 순간
// (260909 5편째) 1·2·3편의 시간값 검사가 조용히 사라진다 — 검사가 없어지는 것이 가장 나쁘다.
if (['MSN-260831-01', 'MSN-260831-02', 'MSN-260831-03'].every((id) => id in byId)) {
  failures.push(...checkSpecifics(byId));
} else {
  failures.push('편별 고정 검사를 돌릴 1·2·3편이 목록에 없다 — 시간 값 검사가 사라졌다');
}

// 옛 편 — 파일은 무수정(verify:scenario가 지킨다), 매칭 규칙은 사이드카에서.
if (legacySidecar.missionId !== legacy.missionId) failures.push('사이드카의 missionId가 옛 편과 다르다');
if (!Array.isArray(legacySidecar.match?.must) || legacySidecar.match.must.length === 0) {
  failures.push('사이드카: match.must가 비었다');
}
if ('match' in legacy || 'world' in legacy || 'cast' in legacy) {
  failures.push('MSN-260826-01.json에 새 필드가 들어갔다 — 옛 파일은 한 글자도 고치지 않는다');
}

// ── 매칭 — 각 문장이 자기 대본에만 맞는가 ─────────────────────────────────────
const library = [
  ...scripts.map((s) => ({ missionId: s.missionId, match: s.match })),
  { missionId: legacy.missionId, match: legacySidecar.match },
];

function expectOnly(sentence, wantedId) {
  const outcome = matchLibrary(sentence, library);
  if (wantedId === null) {
    if (outcome.kind !== 'none') {
      failures.push(`「${sentence}」가 거부되지 않았다 (${outcome.kind}) — 아무 대본에도 맞으면 안 된다`);
    }
    return;
  }
  if (outcome.kind !== 'matched' || outcome.entry.missionId !== wantedId) {
    const got = outcome.kind === 'matched' ? outcome.entry.missionId : outcome.kind;
    failures.push(`「${sentence}」 매칭 결과 ${got} — ${wantedId} 하나에만 맞아야 한다`);
  }
}

for (const s of scripts) expectOnly(s.utterance.text, s.missionId);
expectOnly(legacy.utterance.text, legacy.missionId);
expectOnly('안녕하세요', null);

// ── 음성 대조군 — 검사를 무력화한 사본이 실패로 잡히는가 ────────────────────────
const controls = [];
function control(name, failuresOfMutant, marker) {
  const caught = failuresOfMutant.some((msg) => msg.includes(marker));
  if (!caught) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}

{
  const m = structuredClone(byId['MSN-260831-01'] ?? scripts[0]);
  m.cast = [...(m.cast ?? []), 'robot-99'];
  control('유령 장비(cast에 robot-99)', checkScript(m), 'robot-99');
}
{
  const m = structuredClone(byId['MSN-260831-01'] ?? scripts[0]);
  if (m.events?.length >= 2) {
    const last = m.events[m.events.length - 1];
    last.atSec = -1;
  }
  control('이벤트 시각 역전', checkScript(m), '시각 역전');
}
{
  const m = structuredClone(byId['MSN-260831-01'] ?? scripts[0]);
  m.tasks[0].title = 'robot-01 이동';
  control('제목에 entity ID(robot-01)', checkScript(m), '하드웨어 어휘');
}
{
  const m = structuredClone(byId['MSN-260831-01'] ?? scripts[0]);
  m.tasks[0].title = '로봇 01 이동';
  control('제목에 display_name(로봇 01)', checkScript(m), '하드웨어 어휘');
}
{
  const m = structuredClone(byId['MSN-260831-03'] ?? scripts[2]);
  // 유지 근거(hold_sec)를 실은 평가 태스크의 done payload 를 지운다 — id 가 아니라 키로 찾아
  // 태스크 세분화에도 대조군이 유지되게 한다.
  for (const e of m.events) {
    if (e.status === 'done' && e.payload && typeof e.payload.hold_sec === 'number') delete e.payload;
  }
  control('평가 근거값 삭제', checkScript(m), '근거값');
}
{
  const m = structuredClone(byId['MSN-260831-01'] ?? scripts[0]);
  m.match.must = [];
  control('match.must 비움', checkScript(m), 'must');
}
{
  const m = structuredClone(byId['MSN-260831-02'] ?? scripts[1]);
  for (const e of m.events) {
    if (e.kind === 'derived') {
      delete e.derivedFrom;
      delete e.attempt;
    }
  }
  control('derived 사건의 derivedFrom·attempt 삭제', checkScript(m), 'derived');
}
{
  // 같은 문장에 두 편이 맞으면 억지로 고르지 않는다 — 중복 규칙 사본이 잡히는가.
  const dupLibrary = [...library, { missionId: 'MSN-FAKE', match: structuredClone(byId['MSN-260831-03'].match) }];
  const outcome = matchLibrary(byId['MSN-260831-03'].utterance.text, dupLibrary);
  if (outcome.kind !== 'ambiguous') failures.push('대조군 실패: 중복 매칭 규칙 사본이 모호로 거부되지 않았다 — 모호하면 고르지 않아야 한다');
  controls.push('중복 매칭(두 편에 맞음)');
}

// ── 결과 ─────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`❌ verify:script-library\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`✅ 대본 ${scripts.length}편 + 옛 편 사이드카 — cast·worldTimeline·commands 전부 registry.json 실재, atSec 단조, ACTION_CATALOG 대조`);
console.log('✅ 제목에 하드웨어 어휘 없음 · 평가 태스크마다 awaiting_evaluation → done + 근거값 · 파생 2회차 형식 확인');
console.log('✅ 시간 값 그대로 — 상승 30초 · 유지 10초 · 하락 3분 · 재탐색 10분(600초). 압축은 배속으로만');
console.log(`✅ 매칭 — ${scripts.length} 문장 각각 자기 대본에만, 옛 문장은 옛 편에만, 「안녕하세요」는 아무 데도 (규칙 ${library.length}편)`);
console.log(`✅ 음성 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
