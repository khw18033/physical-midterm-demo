// scripts/score-generation.mjs (260904 신설 — 마일스톤 분리 지시서 §2)
//
// 생성 결과를 **네 축으로 따로** 잰다. 합산 점수 하나로 뭉치지 않는다.
//
// | 축 | 무엇을 | G-01 | G-02 |
// |---|---|---|---|
// | 스키마     | mission.schema.json 을 통과하는가         | ○ | ○ |
// | 마일스톤   | 개수 · 순서 · 장소 어휘가 정답과 맞는가     | ○ | — |
// | 장소 위반  | places.json 밖 장소를 지어낸 건수          | ○ | — |
// | 장비 위반  | 정답셋 밖 장비 id — **지어냄**과 **오선택**을 가른다 (장소의 대조군) | ○ | — |
// | 추상 위반  | 기종·좌표·속도가 제목에 새어 든 건수         | ○ | — |
// | 노드 문법  | node_kind 라벨이 정답과 맞는가             | — | ○ |
// | 그래프     | deps 가 만드는 DAG 가 동형인가 · 순환 없나   | — | ○ |
//
// **축을 섞으면 실패 원인을 못 가른다.** 「형식 오류인가 내용 오류인가」가 학습 판단의
// 근거이므로(지시서 §학습 판단 관문) 여기서 갈라 두지 않으면 4단계에서 가를 수 없다.
//
// 위반 축 둘은 260906(§4 베이스라인)에 붙었다. 그전에는 「없는 장소를 지어냈는가」를
// 잴 자리가 없었다 — 재현율만 있었고, 재현율은 **빠뜨린 것**을 재지 **지어낸 것**을
// 재지 않는다. 학습 판단표의 두 줄(「없는 장소를 지어냄」·「추상 위반」)이 바로 이 둘이라
// 자리가 없으면 그 판단 자체가 성립하지 않는다.
//
// ## 재는 것이 아니라 못 재는 것도 적는다
//
// 「장소 어휘」는 `places.json` 이 원본인데 그 파일은 아직 비어 있다(Unity 미연결).
// 그래서 이 축은 **0이 아니라 `null` 이고 사유가 붙는다** — 자체 관측 패널과 같은 규칙이다.
//
// ## 실행
//
//   node scripts/score-generation.mjs                 정답셋을 자기 자신으로 채점 + 대조군
//   node scripts/score-generation.mjs --candidate x   생성 결과 파일(또는 폴더)을 채점
//   node scripts/score-generation.mjs --json          기계가 읽는 형태로
//
// 이것은 **측정 도구**다(`measure:representation` 과 같은 성질). 점수가 낮다고 실패로
// 끝내지 않는다 — 낮은 것 자체가 결과다. 다만 **대조군**은 다르다: 망가뜨린 사본이
// 축에 안 걸리면 그 축은 무의미하므로 그때만 1로 끝낸다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContracts, validate } from './lib/json-schema.mjs';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(vizRoot, '..');
const goldDir = join(repoRoot, 'gen-lab', 'goldset', 'missions');
const contracts = loadContracts(join(repoRoot, 'contracts'));
const missionSchema = contracts.get('mission.schema.json');

const args = process.argv.slice(2);
const candidateArg = args.includes('--candidate') ? args[args.indexOf('--candidate') + 1] : null;
const asJson = args.includes('--json');

// ── 정답셋 ───────────────────────────────────────────────────────────────────

const gold = readdirSync(goldDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(goldDir, name), 'utf8')))
  .sort((a, b) => a.mission_id.localeCompare(b.mission_id));

if (gold.length === 0) {
  console.error('❌ 정답셋이 비어 있다 — 먼저 `npm run goldset:extract` 를 돌려라');
  process.exit(1);
}

/**
 * 장소 어휘의 원본. **비어 있으면 그 축은 못 잰다** — 지어내지 않는다.
 * Unity 맵 추출(지시서 §1)이 채운다.
 */
function placeVocabulary() {
  try {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'places', 'places.json'), 'utf8'));
    const names = [];
    for (const place of raw.places ?? []) {
      names.push(place.label, ...(place.aliases ?? []));
    }
    return names.filter((name) => typeof name === 'string' && name.length > 0);
  } catch {
    return [];
  }
}

/**
 * 지어낸 장소를 세는 데 쓰는 **닫힌 축 둘** — 방 번호와 층.
 *
 * 자유 문장에서 임의의 장소를 집어내는 것은 장소 인식기가 할 일이고 이 채점기의 몫이
 * 아니다. 대신 **틀렸을 때 확실히 틀린 두 가지**만 센다: `places.json` 에 없는 방 번호와
 * 없는 층. 이 둘은 정규식으로 확실히 잡히고, 「지어냈다」의 가장 흔한 모양이다
 * (모델이 없는 방을 만들면 거의 항상 번호로 만든다).
 *
 * **못 세는 것을 적어 둔다** — 없는 시설 이름(「중앙 계단실」)은 이 방법으로 못 잡는다.
 */
function placeAxes() {
  try {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'places', 'places.json'), 'utf8'));
    const rooms = new Set();
    const floors = new Set();
    for (const place of raw.places ?? []) {
      for (const name of [place.label, ...(place.aliases ?? [])]) {
        const room = String(name).match(/^(\d{3})\s*호?$/);
        if (room) rooms.add(room[1]);
      }
      if (typeof place.floor === 'number') floors.add(place.floor);
    }
    return { rooms, floors, ok: rooms.size > 0 };
  } catch {
    return { rooms: new Set(), floors: new Set(), ok: false };
  }
}

// ── 정답셋 → 계약 모양 ────────────────────────────────────────────────────────

/**
 * 정답셋을 `mission.schema.json` 이 요구하는 모양으로 편다.
 *
 * 정답셋은 **모델이 내야 하는 것**만 담고 있어서 계약의 필수 항목(status·attempt·
 * action_items·evaluation)이 없다. 그것들은 실행이 채우는 값이라 정답이 아니고, 그래서
 * 여기서 **계약이 요구하는 최소값으로 채운다** — 생성기도 같은 자리를 같은 값으로 낸다.
 */
export function toContract(mission) {
  return {
    mission_id: mission.mission_id,
    utterance: {
      audio_ref: mission.utterance.audio_ref,
      text: mission.utterance.text,
      engine: mission.utterance.engine,
      confidence: mission.utterance.confidence,
    },
    milestones: mission.milestones.map((milestone) => ({
      milestone_id: milestone.milestone_id,
      title: milestone.title,
      order: milestone.order,
      status: 'pending',
      assigned_targets: milestone.assigned_targets,
      tasks: mission.tasks
        .filter((task) => task.milestone_id === milestone.milestone_id)
        .map((task) => ({
          task_id: task.task_id,
          title: task.title,
          deps: task.deps,
          status: 'pending',
          attempt: 1,
          derived_from: milestone.milestone_id,
          action_items: [],
          evaluation: null,
          // 노드 문법 라벨. **계약의 선택 필드다** (§5 에서 올렸다) — 없는 편도 있다.
          ...(task.node_kind === null ? {} : { node_kind: task.node_kind }),
          // 대상 장비. 260907 에 같은 이유로 계약에 올렸다(선택 필드) — 정답셋에는 있는데
          // 계약에 없어서 생성된 태스크를 계약으로 검증할 수 없었다. `null` 은 「장비가
          // 필요 없는 태스크」이므로 값이고, 빼는 것이 아니다.
          ...(task.target === undefined ? {} : { target: task.target }),
        })),
    })),
  };
}

/**
 * 발화가 분기·되풀이를 요구하는 표지. **`src/generate/planShape.ts` 와 같은 목록이다.**
 *
 * 화면이 경고하는 자리와 채점이 세는 자리가 갈라지면, 화면은 「못 만들었다」고 하는데
 * 표는 「지어냈다」고 하는 일이 생긴다. 같은 목록인지는 `verify:plan-shape` 가 대조한다.
 */
const LOOP_MARKERS = ['때까지', '반복', '계속', '재탐색', '주기적', '다시 시도', '재시도', '할 때마다', '매번'];
const BRANCH_MARKERS = ['없으면', '아니면', '그렇지 않으면', '안 되면', '못 하면', '실패하면', '중 하나'];

// ── 문자열 비교 — 한국어라 어절이 아니라 글자 2-gram 이다 ────────────────────

function bigrams(text) {
  const clean = String(text).replace(/[\s·,.()→\-]/g, '');
  if (clean.length <= 1) return new Set([clean]);
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

/** 0~1. 어절 나눔이 들쭉날쭉한 한국어 제목에는 어절 집합보다 2-gram 이 안정적이다. */
function similarity(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return a === b ? 1 : 0;
  let hit = 0;
  for (const gram of left) if (right.has(gram)) hit += 1;
  return (2 * hit) / (left.size + right.size);
}

/**
 * 정답 목록과 후보 목록을 **순서를 지키며** 짝짓는다 (단조 정렬).
 * 순서를 무시하고 최적 매칭을 하면 「순서가 틀렸다」를 영영 못 잰다.
 */
function alignInOrder(goldItems, gotItems, key, threshold = 0.4) {
  const pairs = [];
  let cursor = 0;
  for (let g = 0; g < goldItems.length; g += 1) {
    let best = -1;
    let bestScore = threshold;
    for (let c = cursor; c < gotItems.length; c += 1) {
      const score = similarity(key(goldItems[g]), key(gotItems[c]));
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best >= 0) {
      pairs.push({ gold: goldItems[g], got: gotItems[best], score: bestScore });
      cursor = best + 1;
    } else {
      pairs.push({ gold: goldItems[g], got: null, score: 0 });
    }
  }
  return pairs;
}

const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const round = (value, digits = 3) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

// ── 축 넷 ────────────────────────────────────────────────────────────────────

/** 축 1 — 스키마. 강제 디코딩이 실제로 듣는가. */
function axisSchema(candidate) {
  const result = validate(candidate, missionSchema, contracts);
  return {
    pass: result.ok,
    errors: result.errors.slice(0, 6),
    error_count: result.errors.length,
    unsupported: result.unsupported.slice(0, 3),
  };
}

/** 축 2 — 마일스톤 (G-01 본문). 개수 · 순서 · 장소 어휘. */
function axisMilestone(goldMission, candidate, vocabulary) {
  const goldList = goldMission.milestones;
  const gotList = candidate.milestones ?? [];
  const pairs = alignInOrder(goldList, gotList, (item) => item.title);
  const matched = pairs.filter((pair) => pair.got !== null);
  /**
   * 장소 어휘 — **정답 마일스톤이 말한 장소를 후보도 말했는가.**
   *
   * 「없는 장소를 지어냈는가」(위반 건수)는 여기가 아니라 `axisPlaceViolation` 이 센다.
   * 260906 까지 그 자리가 없어서 「빠뜨린 것」만 재고 「지어낸 것」은 못 쟀다 — 학습 판단표의
   * 한 줄이 그 숫자를 요구하므로 축을 갈라 붙였다. 여기는 재현율 하나다.
   */
  const placePairs = vocabulary.length === 0 ? [] : matched.map((pair) => {
    const want = vocabulary.filter((name) => String(pair.gold.title).includes(name));
    if (want.length === 0) return null;
    const got = want.filter((name) => String(pair.got.title).includes(name));
    return got.length / want.length;
  }).filter((value) => value !== null);
  return {
    count: { gold: goldList.length, got: gotList.length, match: goldList.length === gotList.length },
    order_recall: round(matched.length / Math.max(1, goldList.length)),
    title_similarity: round(mean(matched.map((pair) => pair.score))),
    place_recall: vocabulary.length === 0 ? null : round(mean(placePairs)),
    place_vocab_note: vocabulary.length === 0
      ? '해당 없음 — places/places.json 이 비어 있다 (Unity 맵 추출 §1 대기). 빈칸에 0을 넣지 않는다'
      : '이 축은 재현율이다 — 「지어냈는가」는 옆의 장소 위반 축이 센다 (260906 신설)',
    unmatched: pairs.filter((pair) => pair.got === null).map((pair) => pair.gold.milestone_id),
  };
}

/**
 * 축 2b — **장소 어휘 위반.** `places.json` 밖 장소를 지어낸 건수 (지시서 §4-4).
 *
 * 재현율(축 2)과 방향이 반대다. 재현율은 **빠뜨린 것**을 재고 이 축은 **지어낸 것**을
 * 잰다. 그라운딩이 듣는지는 이쪽이 답한다 — 목록을 줬는데도 없는 방을 만들면 0이 아니다.
 */
function axisPlaceViolation(candidate, axes) {
  if (!axes.ok) {
    return { count: null, items: [], note: '해당 없음 — places/places.json 을 읽지 못했다. 빈칸에 0을 넣지 않는다' };
  }
  const items = [];
  for (const milestone of candidate.milestones ?? []) {
    const title = String(milestone.title ?? '');
    for (const [, room] of title.matchAll(/(\d{3})\s*호/g)) {
      if (!axes.rooms.has(room)) items.push({ milestone_id: milestone.milestone_id, kind: 'room', found: `${room}호`, title });
    }
    for (const [, floor] of title.matchAll(/(\d+)\s*층/g)) {
      if (!axes.floors.has(Number(floor))) items.push({ milestone_id: milestone.milestone_id, kind: 'floor', found: `${floor}층`, title });
    }
  }
  return {
    count: items.length,
    items: items.slice(0, 8),
    note: '방 번호와 층만 센다 — 없는 시설 이름(「중앙 계단실」)은 이 방법으로 못 잡는다',
  };
}

/**
 * 축 2d — **장비 어휘 위반.** `assigned_targets` 에 정답셋 밖의 장비 id 를 지어낸 건수.
 *
 * ## 왜 이 축을 더 붙였나 — 대조군이 공짜로 생긴다
 *
 * 지시서는 축 넷을 적었고 장비 어휘는 거기 없다. 그런데 260906 실측에서 **장소 위반이
 * 세 모델 모두 0건**으로 나왔고, 그 0이 「그라운딩이 들었다」인지 「모델이 원래 장소를
 * 안 지어낸다」인지 가릴 방법이 없었다.
 *
 * 장비가 그 대조군이다. **같은 모델 · 같은 프롬프트 · 같은 디코딩인데 장소는 목록을 주고
 * 장비는 안 준다.** 두 축의 차이가 곧 목록의 효과다 — 이보다 깨끗한 대조는 만들기 어렵고,
 * 이미 있는 데이터로 잴 수 있다.
 *
 * 어휘의 원천은 **정답셋 4편의 `assigned_targets` 합집합**이다. 게이트웨이의
 * `registry.json` 을 읽지 않는다 — 채점기가 대시보드 계층에 의존하면 단독으로 못 돈다
 * (`verify:standalone` 이 지키는 것과 같은 경계). few-shot 예시가 실제로 보여주는
 * 어휘가 이 합집합이므로, 재는 것도 그것이 맞다.
 */
function targetVocabulary(missions) {
  const known = new Set();
  for (const mission of missions) {
    for (const milestone of mission.milestones) {
      for (const target of milestone.assigned_targets ?? []) known.add(target);
    }
  }
  return known;
}

/**
 * 저장소가 아는 장비 전부 (`equipment/equipment.json`).
 *
 * **채점 어휘와 다른 것이다.** 채점 어휘는 정답셋이 실제로 고른 것이고, 이쪽은 이 건물에
 * 실재하는 장비다. 둘을 가르는 것이 아래 축 2d 의 요점이다.
 *
 * `placeAxes()` 와 같은 성질의 의존이다 — 저장소 루트의 어휘 파일을 읽지, 대시보드
 * 계층(`registry.json`)을 읽지 않는다. 못 읽으면 **0이 아니라 null 이다.**
 */
function equipmentVocabulary() {
  try {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'equipment', 'equipment.json'), 'utf8'));
    const ids = new Set((raw.equipment ?? []).map((entry) => entry.equipment_id));
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

function axisTargetVocabulary(candidate, known, real) {
  const items = [];
  let total = 0;
  for (const milestone of candidate.milestones ?? []) {
    for (const target of milestone.assigned_targets ?? []) {
      total += 1;
      if (known.has(target)) continue;
      // **지어낸 것과 잘못 고른 것을 가른다.** 뭉치면 그라운딩이 들었는지를 못 읽는다.
      const kind = real === null ? 'unknown' : (real.has(target) ? 'mischosen' : 'invented');
      items.push({ milestone_id: milestone.milestone_id, found: target, kind });
    }
  }
  const of = (kind) => items.filter((item) => item.kind === kind).length;
  return {
    count: items.length,
    total,
    // **지어냄** — 이 건물에 없는 장비다. 그라운딩이 막아야 하는 것이 이것이다.
    invented: real === null ? null : of('invented'),
    // **오선택** — 실재하는 장비인데 정답이 고른 것이 아니다. 어휘 문제가 아니라 배정 문제다.
    mischosen: real === null ? null : of('mischosen'),
    items: items.slice(0, 8),
    note: real === null
      ? '어휘는 정답셋의 assigned_targets 합집합이다. equipment/equipment.json 을 못 읽어 지어냄/오선택을 못 갈랐다 — 빈칸에 0을 넣지 않는다'
      : '어휘는 정답셋의 assigned_targets 합집합이다. **지어냄**(equipment.json 에도 없다)과 **오선택**(실재하는데 정답이 아니다)을 가른다 — 260907 실측에서 목록을 주자 지어냄이 20건에서 0건이 됐고 남은 것은 전부 오선택이었다',
  };
}

/**
 * 축 2c — **추상 위반.** 마일스톤 제목에 기종·좌표·속도가 새어 든 건수 (지시서 §4-4).
 *
 * ## 「수치가 나오면 실패」로 짜지 않았다 — 정답셋이 그것을 반증한다
 *
 * 지시서는 한 곳에서 「기종·수치가 새어 들어온 횟수」라고 적었지만, 그대로 구현하면
 * **정답셋 4편 중 3편이 위반으로 잡힌다**:
 *
 *   MSN-260831-01 MS-E  「엘리베이터와의 거리를 계산하여 3 m 이내면 정지」
 *   MSN-260831-02 MS-F  「… 마지막 탐지 시각이 10분 초과 시 재탐색」
 *   MSN-260831-03 MS-B  「하천 수위가 30초 이상 상승 곡선을 그릴 시 …」
 *
 * 사람이 쓴 정답이 위반이면 규칙이 틀린 것이다(`verify:dep-rules` 와 같은 논리).
 * 그래서 지시서의 **다른 쪽 문장**을 따른다 — 「로봇 기종·좌표·속도가 나오면 실패다」.
 * 가르는 선은 이렇다.
 *
 *   임무의 조건 (발화가 요구한 것: 시간·수위·거리 임계)  → 위반 아니다
 *   구현 파라미터 (기종·절대 좌표·속도·장비 식별자)      → 위반이다
 *
 * 「이 임무가 무엇을 이루는가」는 마일스톤의 내용이고, 「어느 기계가 어떻게」는 아래
 * 계층의 것이다. 그 선이 곧 `VZ-G-01` 이 말하는 추상이다.
 */
const ABSTRACTION_RULES = [
  // 장비 식별자는 assigned_targets 의 자리다. 제목에 나오면 마일스톤이 그 장비 전용이 된다.
  { kind: 'target_id', pattern: /\b(robot|camera|sensor|actuator|arm|cam|go1|drone)-\w+/gi },
  // 기종·제품군 이름. 닫힌 목록이다 — 분류기가 아니라 낱말 목록이라는 것을 적어 둔다.
  { kind: 'model_name', pattern: /(unitree|go1|go2|스팟|spot|사족보행|4족보행|이족보행|드론|쿼드콥터)/gi },
  // 절대 좌표. (x, y) · (x, y, z) · x= 꼴.
  { kind: 'coordinate', pattern: /\(\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?(\s*,\s*-?\d+(\.\d+)?)?\s*\)|[xyz]\s*=\s*-?\d|좌표/gi },
  // 속도·회전. 실행이 정하는 값이다.
  { kind: 'velocity', pattern: /\d+(\.\d+)?\s*(m\/s|km\/h|rad\/s|rpm)|선속도|각속도|주행\s*속도/gi },
];

function axisAbstraction(candidate) {
  const items = [];
  for (const milestone of candidate.milestones ?? []) {
    const title = String(milestone.title ?? '');
    for (const rule of ABSTRACTION_RULES) {
      for (const match of title.matchAll(rule.pattern)) {
        items.push({ milestone_id: milestone.milestone_id, kind: rule.kind, found: match[0], title });
      }
    }
  }
  return {
    count: items.length,
    items: items.slice(0, 8),
    note: '임무 조건(시간·수위·거리 임계)은 위반이 아니다 — 정답셋 4편 중 3편이 그것을 담고 있다',
  };
}

/**
 * 마일스톤 정렬을 받아 태스크까지 짝짓는다. 축 3·4 가 같은 정렬을 써야
 * 「라벨이 틀린 것」과 「자리가 밀린 것」이 섞이지 않는다.
 */
function alignTasks(goldMission, candidate) {
  const pairs = alignInOrder(goldMission.milestones, candidate.milestones ?? [], (item) => item.title);
  const taskPairs = [];
  for (const pair of pairs) {
    const goldTasks = goldMission.tasks.filter((task) => task.milestone_id === pair.gold.milestone_id);
    const gotTasks = pair.got === null ? [] : pair.got.tasks ?? [];
    for (const [index, task] of goldTasks.entries()) {
      taskPairs.push({ gold: task, got: gotTasks[index] ?? null });
    }
  }
  return taskPairs;
}

/** 축 3 — 노드 문법. 라벨이 없는 편(옛 편)은 잴 수 없다. */
function axisNodeGrammar(goldMission, taskPairs) {
  if (!goldMission.shape.labeled) {
    return {
      accuracy: null,
      note: `해당 없음 — ${goldMission.mission_id} 의 대본에 node_kind 라벨이 없다 (노드 분화 이전 편)`,
    };
  }
  const scored = taskPairs.filter((pair) => pair.gold.node_kind !== null);
  const hit = scored.filter((pair) => pair.got !== null && pair.got.node_kind === pair.gold.node_kind);
  const confusion = {};
  for (const pair of scored) {
    const got = pair.got?.node_kind ?? '(없음)';
    if (got === pair.gold.node_kind) continue;
    const key = `${pair.gold.node_kind}→${got}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  return { accuracy: round(hit.length / Math.max(1, scored.length)), scored: scored.length, confusion, note: null };
}

/**
 * 축 8 — **계획의 모양** (분기와루프 3단계). 배타 분기와 되풀이.
 *
 * ## `deps` 를 보지 않는다 — 볼 수 없다
 *
 * 2단계가 규칙을 세우고 나서 알게 된 것이다. 규칙은 배타 분기를 「같은 판정에 나란히 +
 * 뒤에서 합류」로 만드는데, **그 `deps` 모양이 병렬과 똑같다**(병렬도 제약이 없어 나란히
 * 남는다). 「둘 다 한다」와 「둘 중 하나」가 엣지로는 구별되지 않으므로, 이 축은 반드시
 * **주석 자체**(`branch`·`repeat_of`)를 봐야 한다.
 *
 * ## 정답과 대조하지 않는다 — 대조할 정답이 없다
 *
 * 정답셋에 배타 분기가 **한 건도 없다**(1단계에서 확인 — 갈라지는 자리 셋은 전부 병렬).
 * 그리고 **정답셋 발화 15개에 분기·되풀이 표지가 하나도 없다**(3단계에서 확인). 2편의
 * 정답 되풀이는 발화가 아니라 대본 저자의 도메인 지식(「10분 초과 시 재탐색」)에서 왔다.
 *
 * 그래서 이 축이 재는 것은 **정확도가 아니라 절제**다.
 *
 * | 칸 | 뜻 |
 * |---|---|
 * | `declared` | 모델이 적은 주석 수 |
 * | `invented` | **발화가 요구하지 않았는데 적은 수.** 정답셋에서는 declared 와 같다 |
 * | `malformed` | 앞에 없는 마일스톤을 가리킨 수 — 규칙이 무시하는 것 |
 *
 * `invented` 가 이 판의 채택 여부를 가른다. 8단계 D 판이 「새 자리를 열면 모델은 그
 * 자리를 채운다」를 보였고, 분기는 그쪽이 더 나쁘다 — **빈 단계는 사람이 보면 알지만
 * 없어야 할 갈래는 그럴듯해 보인다.**
 *
 * 「요구했을 때 내는가」는 여기서 못 잰다. 정답셋 밖 발화로 따로 본다(보고서).
 */
function axisPlanShape(candidate, utterance) {
  const milestones = candidate.milestones ?? [];
  const ids = milestones.map((milestone) => milestone.milestone_id);
  // 발화가 요구했는가 — 판별은 `src/generate/planShape.ts` 와 **같은 표지**를 쓴다.
  // 두 벌로 적으면 화면이 경고하는 자리와 채점이 세는 자리가 갈라진다.
  const asked = {
    branch: BRANCH_MARKERS.some((marker) => utterance.includes(marker)),
    loop: LOOP_MARKERS.some((marker) => utterance.includes(marker)),
  };
  const count = (kind) => {
    const items = milestones.filter((milestone) => milestone[kind] !== undefined);
    const malformed = items.filter((milestone) => {
      const target = kind === 'branch' ? milestone.branch.from : milestone.repeat_of.to;
      const at = ids.indexOf(target);
      return at < 0 || at >= ids.indexOf(milestone.milestone_id);
    }).length;
    const wanted = kind === 'branch' ? asked.branch : asked.loop;
    return { declared: items.length, invented: wanted ? 0 : items.length, malformed };
  };
  return {
    asked,
    branch: count('branch'),
    repeat: count('repeat_of'),
    note: '정답과 대조하지 않는다 — 정답셋에 배타 분기가 없고 발화 15개에 표지도 없다. 재는 것은 정확도가 아니라 **절제**다',
  };
}

/** 축 4 — 그래프. deps 가 만드는 DAG 가 동형인가 · 순환이 없는가. */
function axisGraph(goldMission, candidate, taskPairs) {
  const map = new Map();
  for (const pair of taskPairs) if (pair.got !== null) map.set(pair.got.task_id, pair.gold.task_id);

  const goldEdges = new Set();
  for (const task of goldMission.tasks) for (const dep of task.deps) goldEdges.add(`${dep}→${task.task_id}`);

  const gotEdges = new Set();
  const gotTasks = (candidate.milestones ?? []).flatMap((milestone) => milestone.tasks ?? []);
  for (const task of gotTasks) {
    for (const dep of task.deps ?? []) {
      // 정렬로 정답 id 를 알아낸 것만 비교할 수 있다. 못 찾으면 그대로 두어 **틀린 엣지로 남긴다.**
      gotEdges.add(`${map.get(dep) ?? dep}→${map.get(task.task_id) ?? task.task_id}`);
    }
  }

  let hit = 0;
  for (const edge of gotEdges) if (goldEdges.has(edge)) hit += 1;
  const precision = gotEdges.size === 0 ? (goldEdges.size === 0 ? 1 : 0) : hit / gotEdges.size;
  const recall = goldEdges.size === 0 ? 1 : hit / goldEdges.size;

  return {
    exact: hit === goldEdges.size && gotEdges.size === goldEdges.size,
    precision: round(precision),
    recall: round(recall),
    f1: round(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)),
    has_cycle: hasCycle(gotTasks),
    missing: [...goldEdges].filter((edge) => !gotEdges.has(edge)).slice(0, 8),
    extra: [...gotEdges].filter((edge) => !goldEdges.has(edge)).slice(0, 8),
  };
}

function hasCycle(tasks) {
  const deps = new Map(tasks.map((task) => [task.task_id, task.deps ?? []]));
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'open') return true;
    state.set(id, 'open');
    for (const dep of deps.get(id) ?? []) if (deps.has(dep) && visit(dep)) return true;
    state.set(id, 'done');
    return false;
  };
  return [...deps.keys()].some((id) => visit(id));
}

// ── 채점 ─────────────────────────────────────────────────────────────────────

export function score(candidates, vocabulary = placeVocabulary(), axes = placeAxes()) {
  return gold.map((goldMission) => {
    const candidate = candidates.find((item) => item.mission_id === goldMission.mission_id) ?? null;
    if (candidate === null) {
      return { mission_id: goldMission.mission_id, missing: true };
    }
    const taskPairs = alignTasks(goldMission, candidate);
    return {
      mission_id: goldMission.mission_id,
      missing: false,
      schema: axisSchema(candidate),
      milestone: axisMilestone(goldMission, candidate, vocabulary),
      place_violation: axisPlaceViolation(candidate, axes),
      target_violation: axisTargetVocabulary(candidate, targetVocabulary(gold), equipmentVocabulary()),
      abstraction: axisAbstraction(candidate),
      node_grammar: axisNodeGrammar(goldMission, taskPairs),
      graph: axisGraph(goldMission, candidate, taskPairs),
      // 발화는 **후보의 것**을 본다 — 채점 대상 편의 원본이 아니라 그 건에 실제로 넣은
      // 문장이어야 「요구했는가」가 맞는다(변형 발화가 다섯이다). 후보가 utterance 를
      // 안 들면(옛 실행) 정답 원본으로 물러선다.
      plan_shape: axisPlanShape(candidate, candidate.utterance?.text ?? goldMission.utterance.text),
    };
  });
}

function loadCandidates(target) {
  // 절대 경로도 받는다 — 부르는 쪽(`run-baseline.mjs`)이 절대 경로를 넘긴다.
  const path = isAbsolute(target) ? target : join(process.cwd(), target);
  const stat = statSync(path);
  const files = stat.isDirectory()
    ? readdirSync(path).filter((name) => name.endsWith('.json')).map((name) => join(path, name))
    : [path];
  return files.flatMap((file) => {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [parsed];
  });
}

const selfCandidates = gold.map(toContract);
const candidates = candidateArg === null ? selfCandidates : loadCandidates(candidateArg);
const results = score(candidates);

// ── 대조군 — 축이 실제로 잡는가 ──────────────────────────────────────────────
//
// 정답을 그대로 넣으면 네 축이 다 만점이라, 그것만으로는 **채점기가 아무것도 안 하는
// 경우**와 구별되지 않는다. 그래서 축마다 하나씩 망가뜨려 그 축만 떨어지는지 본다.

function damaged(kind) {
  const copy = JSON.parse(JSON.stringify(selfCandidates));
  const target = copy.find((mission) => mission.mission_id === 'MSN-260831-01');
  if (kind === 'schema') target.milestones[0].order = '첫째';           // 타입 위반
  if (kind === 'milestone') target.milestones.splice(2, 1);              // 마일스톤 하나 삭제
  if (kind === 'node_grammar') target.milestones[0].tasks[0].node_kind = 'report'; // 라벨 오염
  if (kind === 'place_violation') target.milestones[0].title += ' (601호 경유)';       // 없는 방을 지어냄
  if (kind === 'target_violation') target.milestones[0].assigned_targets = ['system-01']; // 없는 장비를 지어냄
  // **가른 두 칸이 각각 잡히는지 따로 본다.** 뭉쳐서 잡히면 가른 의미가 없다 —
  // 260907 에 A 판은 전부 지어냄이고 B·C 판은 전부 오선택이었다.
  if (kind === 'target_mischosen') target.milestones[0].assigned_targets = ['robot-03']; // 실재하지만 정답이 아님
  if (kind === 'abstraction') target.milestones[0].title += ' — robot-01 을 0.8 m/s 로'; // 구현 파라미터 유입
  // 지어낸 갈래 — 발화가 요구하지 않았는데 마일스톤에 branch 를 붙인다.
  // **8단계 D 판이 보인 실패의 이 층 판**이다: 새 자리를 열면 모델이 그 자리를 채운다.
  if (kind === 'plan_shape' && target.milestones.length > 1) {
    target.milestones[1].branch = { from: target.milestones[0].milestone_id, when: 'pass' };
  }
  if (kind === 'graph') {
    // 순환을 만든다 — 모델이 deps 를 직접 내면 실제로 나는 실패다.
    const tasks = target.milestones[0].tasks;
    tasks[0].deps = [tasks[tasks.length - 1].task_id];
  }
  return copy;
}

const controlFailures = [];
const controls = [];
// **기준선은 언제나 정답셋 자기 채점이다** — 채점 대상이 무엇이든 상관없다. 대조군이
// 보는 것은 「채점기의 축이 망가진 입력을 잡는가」이지 「이번 후보가 어떤가」가 아니다.
// (--candidate 로 임무 일부만 넘기면 그 임무가 후보에 없어 대조군이 통째로 죽는다.)
const controlBaseline = score(selfCandidates);
for (const kind of ['schema', 'milestone', 'place_violation', 'target_violation', 'target_mischosen', 'abstraction', 'node_grammar', 'graph', 'plan_shape']) {
  const before = controlBaseline.find((item) => item.mission_id === 'MSN-260831-01');
  const after = score(damaged(kind)).find((item) => item.mission_id === 'MSN-260831-01');
  const caught = {
    // **기준선이 이미 통과하지 않아도 잡아야 한다.** 「통과 → 실패」로만 재면 다른 이유로
    // 이미 실패 중일 때 이 대조군이 조용히 무의미해진다 (지금이 그 상황이다 — node_kind).
    schema: () => after.schema.error_count > before.schema.error_count,
    milestone: () => before.milestone.count.match && !after.milestone.count.match,
    place_violation: () => (after.place_violation.count ?? 0) > (before.place_violation.count ?? 0),
    target_violation: () => after.target_violation.count > before.target_violation.count
      && (after.target_violation.invented ?? 0) > (before.target_violation.invented ?? 0),
    target_mischosen: () => after.target_violation.count > before.target_violation.count
      && (after.target_violation.mischosen ?? 0) > (before.target_violation.mischosen ?? 0)
      && (after.target_violation.invented ?? 0) === (before.target_violation.invented ?? 0),
    abstraction: () => after.abstraction.count > before.abstraction.count,
    node_grammar: () => (after.node_grammar.accuracy ?? 1) < (before.node_grammar.accuracy ?? 0),
    graph: () => !before.graph.has_cycle && after.graph.has_cycle,
    plan_shape: () => after.plan_shape.branch.invented > before.plan_shape.branch.invented,
  }[kind]();
  if (caught) controls.push(kind);
  else controlFailures.push(`${kind} 축이 망가뜨린 사본을 잡지 못했다 — 그 축은 무의미하다`);
}

// ── 탐지기의 타당성 조건 — 정답셋이 위반으로 잡히면 탐지기가 틀린 것이다 ──────
//
// `verify:dep-rules` 가 「규칙이 사람이 만든 정답 DAG 를 복원하지 못하면 규칙이 틀린 것」
// 이라고 적은 것과 같은 논리다. 위반 축 둘은 **사람이 쓴 정답을 통과시켜야** 의미가 있다.
// 실제로 이 검사가 초안을 한 번 되돌렸다 — 「수치가 나오면 추상 위반」으로 짰더니
// 정답 4편 중 3편이 걸렸다(위 ABSTRACTION_RULES 머리말).
{
  const selfViolations = [];
  for (const row of controlBaseline) {
    if (row.missing) continue;
    if ((row.place_violation.count ?? 0) > 0) {
      selfViolations.push(`${row.mission_id}: 정답셋이 장소 위반으로 잡혔다 — ${JSON.stringify(row.place_violation.items)}`);
    }
    if (row.abstraction.count > 0) {
      selfViolations.push(`${row.mission_id}: 정답셋이 추상 위반으로 잡혔다 — ${JSON.stringify(row.abstraction.items)}`);
    }
    if (row.target_violation.count > 0) {
      selfViolations.push(`${row.mission_id}: 정답셋이 장비 어휘 위반으로 잡혔다 — ${JSON.stringify(row.target_violation.items)}`);
    }
  }
  controlFailures.push(...selfViolations);
  if (selfViolations.length === 0) controls.push('정답셋이 위반 축 둘을 통과함 (탐지기의 타당성 조건)');
}

// ── 출력 ─────────────────────────────────────────────────────────────────────

if (asJson) {
  console.log(JSON.stringify({ source: candidateArg ?? '(정답셋 자기 채점)', results, controls, controlFailures }, null, 2));
} else {
  console.log(`채점 대상 — ${candidateArg ?? '정답셋 자기 채점 (축이 연결돼 있는지 보는 기준선)'}`);
  console.log('');
  const cell = (value, width) => (value === null ? '해당없음' : value.toFixed(2)).padStart(width);
  const head = (text, width) => text.padStart(width);
  console.log('  ' + '임무'.padEnd(16) + head('스키마', 10) + head('마일 개수', 11) + head('마일 순서', 10) + head('장소위반', 9) + head('장비 지/오/총', 14) + head('추상위반', 9) + head('문법', 9) + head('그래프 F1', 10) + head('순환', 7));
  for (const row of results) {
    if (row.missing) { console.log('  ' + row.mission_id.padEnd(16) + '(결과 없음)'); continue; }
    console.log('  ' + row.mission_id.padEnd(16) +
      (row.schema.pass ? '통과' : `실패 ${row.schema.error_count}`).padStart(10) +
      `${row.milestone.count.got}/${row.milestone.count.gold}${row.milestone.count.match ? '' : ' ✗'}`.padStart(11) +
      cell(row.milestone.order_recall, 10) +
      (row.place_violation.count === null ? '해당없음' : String(row.place_violation.count)).padStart(9) +
      `${row.target_violation.invented ?? '?'}/${row.target_violation.mischosen ?? '?'}/${row.target_violation.total}`.padStart(14) +
      String(row.abstraction.count).padStart(9) +
      cell(row.node_grammar.accuracy, 9) +
      cell(row.graph.f1, 10) +
      (row.graph.has_cycle ? '있음' : '없음').padStart(7));
  }
  console.log('');
  console.log('축별로 못 잰 것 — 0이 아니라 「해당 없음」이다');
  const seen = new Set();
  for (const row of results) {
    if (row.missing) continue;
    for (const note of [row.milestone.place_vocab_note, row.place_violation.note, row.target_violation.note, row.abstraction.note, row.node_grammar.note]) {
      if (note && !seen.has(note)) { seen.add(note); console.log('  - ' + note); }
    }
  }
  for (const row of results) {
    if (row.missing || row.schema.pass) continue;
    console.log('');
    console.log(`스키마 실패 — ${row.mission_id} (${row.schema.error_count}건, 앞 ${row.schema.errors.length}건)`);
    for (const error of row.schema.errors) console.log('    ' + error);
  }
  console.log('');
  console.log(`대조군 ${controls.length} 검출 — ${controls.join(' · ')}`);
}

if (controlFailures.length > 0) {
  console.error(`❌ 대조군 실패:\n- ${controlFailures.join('\n- ')}`);
  process.exit(1);
}
