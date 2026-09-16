// scripts/extract-goldset.mjs (260904 신설 — 마일스톤 분리 지시서 §2)
//
// **정답셋은 이미 저장소에 있다.** 대본 4편에 발화 · 마일스톤 · 태스크(deps · nodeKind ·
// target)가 한 파일에 다 들어 있으므로 새로 만들 것이 없다. 이 스크립트는 그것을
// `gen-lab/goldset/` 으로 **뽑아 옮기기만** 한다.
//
// ## 대본을 고치지 않는다. 읽기만 한다.
//
// 쓰기는 `gen-lab/goldset/` 안에서만 일어난다. 특히 `MSN-260826-01`(HCI 전달본)은
// `verify:scenario` 가 자리 수까지 검사하므로 한 글자도 건드리지 않는다.
//
// ## 왜 옮기나 — 대본을 그대로 쓰면 안 되는 이유
//
// 대본에는 정답이 아닌 것이 섞여 있다. `events`(실행 기록) · `worldTimeline`(세계 값) ·
// `params`(편별 상수) 는 **생성기가 만들어야 할 것이 아니라 실행이 만드는 것**이다.
// 그것을 정답으로 두면 「생성기가 실행 결과를 맞혀야 한다」가 되어 축이 통째로 어긋난다.
// 그래서 뽑는 것은 셋뿐이다 — **발화 · 마일스톤 · 태스크(구조)**.
//
// ## 발화 변형은 손으로 적는다
//
// `goldset/utterances.json` 은 이 스크립트가 만들지 않는다. 같은 임무를 다른 말로 한
// 문장은 대본에 없기 때문이다. 여기서는 그 파일을 **검사만** 한다 —
// 임무 id 가 실재하는가, 그 문장이 대본 매처(`matcher.ts`)로도 같은 편에 붙는가.
// 붙지 않는 변형은 「같은 임무의 다른 말투」가 아니라 다른 임무일 수 있다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(vizRoot, '..');
const scenarioDir = join(vizRoot, 'scenarios');
const outDir = join(repoRoot, 'gen-lab', 'goldset');

/** 뽑는 편. 순서는 보고서 표의 순서다. */
const MISSIONS = ['MSN-260831-01', 'MSN-260831-02', 'MSN-260831-03'];

/**
 * **뺀 편과 그 이유.** 지운 것이 아니라 뽑지 않는 것이다 —
 * `viz-debugger/scenarios/MSN-260826-01.json` 은 그대로 있고 화면에서도 그대로 재생된다
 * (HCI 전달본 · `verify:scenario` 무수정).
 *
 * 뺀 이유는 **우리 지도에 4층이 없어서**다(2026-09-07). 그 편의 임무는 415호에서
 * 503호로 층을 이동하는데, `places.json` 에는 5층과 503호뿐이라 모델에게 415호는
 * 어디로도 이어지지 않은 섬이다. 층 이동을 낼 근거가 프롬프트 안에 없다.
 *
 * **그 상태로 채점하면 우리 지도의 구멍이 모델의 점수로 찍힌다.** 실제로 6단계의
 * 「8B 45% 대 EXAONE 20%」가 이 편 하나에서 나온 차이였고, 빼면 둘 다 27% 로 같아진다
 * (`reports/2026-09-06_마일스톤분리_6단계.md` §11).
 *
 * 4층을 재면 이 배열에 다시 넣는다. 그때까지는 **없는 것을 없는 대로 둔다.**
 */
const WITHHELD = [{ id: 'MSN-260826-01', reason: '4층 맵 데이터 없음 — 415→503 층 이동을 그라운딩할 수 없다 (260907)' }];

const { matchesRule } = await import(pathToFileURL(join(vizRoot, 'src', 'scenarios', 'matcher.ts')).href);

const readScenario = (id) => JSON.parse(readFileSync(join(scenarioDir, id + '.json'), 'utf8'));
/** 옛 편의 match 규칙은 사이드카에 있다 — 원본을 못 고치기 때문이다. */
const readMatch = (id, raw) => {
  if (raw.match) return raw.match;
  try {
    return JSON.parse(readFileSync(join(scenarioDir, id + '.match.json'), 'utf8')).match;
  } catch {
    return null;
  }
};

// ── 모양 재기 ────────────────────────────────────────────────────────────────

/**
 * 그래프의 모양. `graph/shape.ts` 가 화면 머리줄에 쓰는 것과 **같은 뜻의 숫자**이지만,
 * 여기서는 대본 파일에서 직접 센다 — 채점기가 화면 코드에 의존하면 안 된다.
 */
/**
 * 대본의 **태스크 단위 되돌아감**을 마일스톤 단위 주석으로 올린다 (260908 · 3단계).
 *
 * ## 왜 올리나 — 안 올리면 예시가 그것을 못 보인다
 *
 * 이 파일은 260904 부터 `refEdges` 를 **일부러 안 뽑았다** — 「사람이 대본에 적은 것이고
 * 생성 대상이 아니다(§5)」. 그 사유가 지금 바뀌었다: **발화가 명시적으로 요구한 되풀이는
 * 지어내는 것이 아니라 받아 적는 것**이고, 계약(`milestone.schema.json`)이 그 자리를
 * 열었으며 규칙(`solveDeps`)이 그것을 태스크 엣지로 편다.
 *
 * 그리고 10단계 E 판이 배운 것이 있다 — **규칙만 바꾸고 예시를 그대로 두면 예시가 이긴다**
 * (15건 중 10건). 모델에게 되풀이를 내라고 하려면 예시가 그것을 보여야 하고, 예시는
 * 정답셋에서 나온다.
 *
 * ## `to` 는 뽑고 `when` 은 **관례로 채운다** — 그 사실을 감추지 않는다
 *
 * `to` 는 엣지에서 그대로 나온다(엣지가 가리키는 태스크의 마일스톤). `when` 은 대본의
 * 참조 엣지에 없다. **`fail` 로 채운다** — 되돌아감은 판정이 어긋났을 때 일어나기 때문이고,
 * 2편이 그 예다(`T-27b` 의 기준이 「경과 ≤ 600초」이고 **초과**가 재탐색 조건이다).
 *
 * **이것은 추론이다.** 지금 되돌아감이 있는 편이 하나뿐이라 관례가 곧 그 한 편이고,
 * 편이 늘면 그때 다시 봐야 한다. 관례가 틀린 편이 생기면 이 함수가 아니라 대본이
 * `repeat_of` 를 직접 들어야 한다.
 */
function repeatOfMilestone(raw, tasks) {
  const milestoneOf = new Map(tasks.map((task) => [task.id, task.milestone]));
  const out = new Map();
  for (const edge of raw.refEdges ?? []) {
    const from = milestoneOf.get(edge.from);
    const to = milestoneOf.get(edge.to);
    if (from === undefined || to === undefined) continue; // 태스크를 못 찾으면 지어내지 않는다
    out.set(from, { to, when: 'fail' });
  }
  return out;
}

function shapeOf(tasks, refEdges) {
  const ids = new Set(tasks.map((task) => task.id));
  const deps = new Map(tasks.map((task) => [task.id, (task.deps ?? []).filter((id) => ids.has(id))]));
  const roots = tasks.filter((task) => (deps.get(task.id) ?? []).length === 0);
  const joins = tasks.filter((task) => (deps.get(task.id) ?? []).length > 1);
  const successors = new Map(tasks.map((task) => [task.id, 0]));
  for (const list of deps.values()) for (const id of list) successors.set(id, (successors.get(id) ?? 0) + 1);
  const sinks = tasks.filter((task) => successors.get(task.id) === 0);
  const depth = new Map();
  const depthOf = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return Number.POSITIVE_INFINITY; // 순환 — 대본에는 없어야 한다
    seen.add(id);
    const own = deps.get(id) ?? [];
    const value = own.length === 0 ? 0 : 1 + Math.max(...own.map((next) => depthOf(next, seen)));
    depth.set(id, value);
    return value;
  };
  const depths = tasks.map((task) => depthOf(task.id));
  return {
    tasks: tasks.length,
    edges: [...deps.values()].reduce((sum, list) => sum + list.length, 0),
    roots: roots.length,
    sinks: sinks.length,
    joins: joins.length,
    max_depth: depths.length === 0 ? 0 : Math.max(...depths),
    has_cycle: depths.some((value) => !Number.isFinite(value)),
    ref_edges: (refEdges ?? []).length,
    node_kinds: [...new Set(tasks.map((task) => task.nodeKind).filter((kind) => kind !== undefined))].sort(),
    labeled: tasks.every((task) => task.nodeKind !== undefined),
  };
}

// ── 뽑기 ─────────────────────────────────────────────────────────────────────

const table = [];
const missions = [];

for (const id of MISSIONS) {
  const raw = readScenario(id);
  // 옛 편은 태스크에 milestone 필드가 없다 — 적재 규칙(`data/scenario.ts`)과 같이 MS-C 로 채운다.
  const legacy = raw.cast === undefined;
  const tasks = raw.tasks.map((task) => ({ ...task, milestone: task.milestone ?? 'MS-C' }));
  const shape = shapeOf(tasks, raw.refEdges);
  const repeats = repeatOfMilestone(raw, tasks);
  const byMilestone = new Map();
  for (const task of tasks) {
    if (!byMilestone.has(task.milestone)) byMilestone.set(task.milestone, []);
    byMilestone.get(task.milestone).push(task.id);
  }

  const mission = {
    mission_id: raw.missionId,
    world: legacy ? 'legacy' : 'registry',
    source: `viz-debugger/scenarios/${id}.json (읽기 전용)`,
    utterance: {
      text: raw.utterance.text,
      engine: raw.utterance.engine,
      confidence: raw.utterance.confidence,
      audio_ref: raw.utterance.audioRef ?? null,
    },
    /** 대본 매처의 규칙. 발화 변형이 같은 편에 붙는지 검사하는 데 쓴다. */
    match: readMatch(id, raw),
    milestones: raw.milestones.map((milestone, order) => ({
      milestone_id: milestone.id,
      order,
      title: milestone.title,
      assigned_targets: milestone.assignedTargets ?? [],
      task_ids: byMilestone.get(milestone.id) ?? [],
      // 되돌아감을 **마일스톤 단위로 올린다** (260908 · 3단계). 아래 `repeatOfMilestone` 참조.
      ...(repeats.get(milestone.id) === undefined ? {} : { repeat_of: repeats.get(milestone.id) }),
    })),
    // **모델이 내야 하는 것만** 남긴다 — 상태·액션 아이템·실행 기록은 정답이 아니다.
    tasks: tasks.map((task) => ({
      task_id: task.id,
      title: task.title,
      milestone_id: task.milestone,
      node_kind: task.nodeKind ?? null,
      target: task.target ?? null,
      deps: task.deps ?? [],
    })),
    shape,
    /** 뽑지 않은 것과 그 이유. 나중에 「왜 없지」를 다시 묻지 않게 파일에 적어 둔다. */
    not_extracted: {
      events: '실행 기록 — 생성기가 만들 것이 아니라 실행이 만든다',
      worldTimeline: '세계 값 — 위와 같다',
      params: '편별 상수(위험 수위 등) — 임무 설계가 아니라 환경 설정이다',
      actionItems: '어댑터 전개 결과 — VZ-G-04 의 몫이다',
      refEdges: '태스크 단위 참조 엣지는 안 뽑는다 — **마일스톤 단위(milestones[].repeat_of)로 올렸다** (260908). 태스크 엣지는 규칙(solveDeps)이 그 주석에서 편다',
    },
  };
  missions.push(mission);
  table.push({
    mission_id: mission.mission_id,
    utterance: mission.utterance.text,
    milestones: mission.milestones.length,
    ...shape,
  });
}

// ── 발화 변형 검사 ───────────────────────────────────────────────────────────

const findings = [];
let variants = { missions: [] };
try {
  variants = JSON.parse(readFileSync(join(outDir, 'utterances.json'), 'utf8'));
} catch {
  findings.push('goldset/utterances.json 이 없다 — 발화 변형 축(G-01 표현 강건성)을 잴 수 없다');
}

const variantTable = [];
for (const entry of variants.missions ?? []) {
  const mission = missions.find((item) => item.mission_id === entry.mission_id);
  if (mission === undefined) {
    findings.push(`utterances.json: 모르는 임무 ${entry.mission_id}`);
    continue;
  }
  const all = [mission.utterance.text, ...entry.variants];
  let matchedElsewhere = 0;
  let unmatched = 0;
  for (const text of all) {
    // 이 문장이 **어느 편에** 붙는가. 대본 매처는 둘 이상 맞으면 고르지 않는다(모호 = 거부).
    const hits = missions.filter((item) => item.match !== null && matchesRule(text, item.match));
    if (hits.length === 0) unmatched += 1;
    else if (hits.length !== 1 || hits[0].mission_id !== mission.mission_id) matchedElsewhere += 1;
  }
  if (unmatched > 0) {
    findings.push(`${mission.mission_id}: 변형 ${unmatched}개가 대본 매처에 안 붙는다 — 「같은 임무의 다른 말투」인지 확인할 것 (매처는 키워드 대조라 붙지 않는 것 자체는 정상일 수 있다)`);
  }
  if (matchedElsewhere > 0) {
    findings.push(`${mission.mission_id}: 변형 ${matchedElsewhere}개가 다른 편에도 붙는다 — 모호한 문장이다`);
  }
  variantTable.push({
    mission_id: mission.mission_id,
    original: 1,
    variants: entry.variants.length,
    total: all.length,
    matcher_exact: all.length - unmatched - matchedElsewhere,
    matcher_none: unmatched,
    matcher_other: matchedElsewhere,
  });
}

// ── 쓰기 ─────────────────────────────────────────────────────────────────────

mkdirSync(join(outDir, 'missions'), { recursive: true });
for (const mission of missions) {
  writeFileSync(join(outDir, 'missions', `${mission.mission_id}.json`), JSON.stringify(mission, null, 2) + '\n', 'utf8');
}
const index = {
  generated_at: new Date().toISOString(),
  generated_by: 'viz-debugger/scripts/extract-goldset.mjs',
  withheld: WITHHELD,
  note: '대본 4편에서 뽑았다. 대본은 읽기만 한다 — 이 폴더 밖으로는 아무것도 쓰지 않는다.',
  missions: table,
  utterances: variantTable,
  findings,
};
writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

// ── 사람이 읽는 표 (보고서에 그대로 들어간다) ────────────────────────────────

const pad = (value, width) => String(value).padEnd(width);
const num = (value, width) => String(value).padStart(width);
console.log('임무 4편의 모양 — gen-lab/goldset/index.json');
console.log('  ' + pad('임무', 15) + num('마일', 5) + num('태스크', 7) + num('엣지', 5) + num('루트', 5) + num('말단', 5) + num('합류', 5) + num('깊이', 5) + num('ref', 4) + '  문법 라벨');
for (const row of table) {
  console.log('  ' + pad(row.mission_id, 15) + num(row.milestones, 5) + num(row.tasks, 7) + num(row.edges, 5) +
    num(row.roots, 5) + num(row.sinks, 5) + num(row.joins, 5) + num(row.max_depth, 5) + num(row.ref_edges, 4) +
    '  ' + (row.labeled ? `${row.node_kinds.length}종 (${row.node_kinds.join('·')})` : '없음'));
}
console.log('');
console.log('발화 변형 — gen-lab/goldset/utterances.json');
for (const row of variantTable) {
  console.log('  ' + pad(row.mission_id, 15) + `원본 1 + 변형 ${row.variants} = ${row.total}문장 · 매처 일치 ${row.matcher_exact} · 무매칭 ${row.matcher_none} · 타편 ${row.matcher_other}`);
}
if (findings.length > 0) {
  console.log('');
  console.log('짚어 둘 것 (실패가 아니다 — 판단이 필요한 자리다)');
  for (const line of findings) console.log('  - ' + line);
}
console.log('');
console.log(`✅ ${missions.length}편을 gen-lab/goldset/ 에 썼다 (missions/*.json · index.json). 대본은 읽기만 했다.`);
