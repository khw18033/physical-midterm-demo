/**
 * src/scenarios/types.ts
 *
 * 시나리오 대본(`scenarios/MSN-260831-0N.json`)의 형식.
 *
 * `src/model/types.ts`의 `Scenario` 위에 **얹는** 확장이다 — 대체가 아니다.
 * 새 필드는 전부 선택이라 옛 파일(`MSN-260826-01.json`)은 한 글자도 안 고치고 유효하다.
 * 옛 파일과 대본이 갈라지는 지점:
 *   - `world: 'registry'` — cast·worldTimeline·commands 가 registry.json 세계의 ID 를 쓴다.
 *     없으면 legacy (구판 세계 — 탭②~⑤와 연결되지 않는다).
 *   - 마일스톤에 정적 `status` 를 적지 않는다 — 상태는 태스크 상태를 접은 결과다.
 *     옛 파일의 정적 status 는 무시하되 지우지 않는다.
 *   - `utterance.engine: 'script'` — 이 문장은 인식이 아니라 저작이다. confidence 는
 *     정의상 1이고 audioRef 는 null (음성이 없다 — 계약의 audio_ref: string|null 과 같다).
 *
 * 게이트웨이·브라우저·검증 스크립트가 **같은 이 파일**을 본다. 두 벌이면 갈라진다.
 */

import type { ActionItem, TaskStatus } from '../model/types.ts';

/**
 * 키워드 대조 규칙. **이것은 LLM이 아니다** — 바깥 배열은 AND, 안쪽 배열은
 * OR(동의어·오인식 변형)이고, any 는 하나라도 맞으면 된다.
 */
export type ScriptMatch = {
  must: string[][];
  any?: string[];
  /** 사람이 읽는 정규화 규칙 설명. 실제 규칙은 matcher.ts 의 normalize() 하나다. */
  normalize?: string;
};

export type ScriptUtterance = {
  text: string;
  /** 'script' = 저작된 문장. 실제 STT 발화의 세 수치는 명령의 voice 감사 필드에 실린다. */
  engine: string;
  confidence: number;
  audioRef: string | null;
};

export type ScriptMilestone = {
  id: string;
  title: string;
  assignedTargets: string[];
  /** 옛 파일 호환용. 대본에는 적지 않는다 — 태스크 상태를 접은 결과가 마일스톤 상태다. */
  status?: TaskStatus;
};

export type ScriptTaskEvaluation = {
  /** 평가 기준 문장. 근거값은 이벤트 payload 에 실린다 (REQ-1403 · REQ-1505). */
  criteria: string[];
  judgedBy: 'ai' | 'backend' | 'human';
};

/**
 * 노드 문법 5종 (260831 — 노드 분화). 마일스톤을 임의로 쪼개지 않기 위한 규칙 —
 * 한 마일스톤은 이 다섯의 작은 부분그래프로 **펴진다.** 단계를 더하거나 빼는 것이 아니다.
 *  - sense  : 값을 받아 온다 (telemetry · coverage · vision)
 *  - decide : 조건이 참인가 (evaluation.judgedBy)
 *  - act    : 명령을 낸다 (commands[] · CommandEngine)
 *  - verify : 구동 결과가 의도대로인가 (evaluation.criteria)
 *  - report : 기록·발행 (trace_event · 감사)
 */
export type NodeKind = 'sense' | 'decide' | 'act' | 'verify' | 'report';

export type ScriptTask = {
  id: string;
  title: string;
  /** 노드 문법 (260831). 옛 파일에는 없다 — 없으면 화면이 칩을 그리지 않는다. */
  nodeKind?: NodeKind;
  /** 이 태스크가 접히는 마일스톤. 옛 파일에는 없다(전부 MS-C 암묵). */
  milestone: string;
  deps: string[];
  /** 대상 장비. 장비가 없는 태스크(임무 종료 처리)는 null — 지어 넣지 않는다. */
  target: string | null;
  actionItems: ActionItem[];
  /** 있으면 「평가로 끝나는 태스크」 — awaiting_evaluation → done 전이가 있어야 한다. */
  evaluation?: ScriptTaskEvaluation;
};

/**
 * 되돌아가는 참조 엣지 (260831 — 2편 재탐색 루프).
 *
 * **`deps` 가 아니다.** `graph/layout.ts` 의 depths() 에 순환이 들어가면 무한 재귀한다.
 * 그런데 루프를 안 그리면 사용자는 이 대본이 되돌아간다는 것을 모른다 — 시각화의 의미가
 * 사라진다. 그래서 레이아웃·깊이 계산에는 넣지 않고 **점선으로 그리기만 하는** 별도 목록이다.
 */
export type ScriptRefEdge = {
  from: string;
  to: string;
  /** 그래프에 붙는 짧은 문구. */
  label: string;
  /** 왜 deps 가 아닌지 — 파일을 여는 사람에게 남기는 근거. */
  note?: string;
};

export type ScriptEvent = {
  seq: number;
  atSec: number;
  nodeId: string;
  status: TaskStatus;
  kind: string;
  producedBy: 'ai' | 'backend' | 'human';
  attempt?: number;
  /** kind: 'derived' 일 때 — 어느 태스크의 2회차인가. */
  derivedFrom?: string;
  /** 평가 근거값(distance_m 등)·파생 사유. trace-event.schema 의 payload 와 같은 자리다. */
  payload?: Record<string, unknown>;
};

/** 탭②~⑤용 세계 채널 값. 봉투를 직접 적지 않는다 — 장치의 평소 발행 경로로 나간다. */
export type WorldDrive = {
  atSec: number;
  entity: string;
  drive: Record<string, unknown>;
};

/** CommandEngine.submit() 을 실제로 통과하는 명령. 발행 주체는 사람이 아니다. */
export type ScriptCommand = {
  atSec: number;
  entity: string;
  action: string;
  producedBy: 'backend';
  taskId: string;
};

/** 2편 구역 맵. 좌표계는 로봇 telemetry 와 같은 site-global — 화면에 변환이 없어야 한다. */
export type ScriptMap = {
  frame: string;
  room: { id: string; x_min: number; x_max: number; z_min: number; z_max: number };
  camera: {
    entity: string;
    position: { x: number; y: number; z: number };
    fov_polygon: Array<[number, number]>;
  };
  blind_cells: Array<{
    id: string;
    x_min: number;
    x_max: number;
    z_min: number;
    z_max: number;
    reason: string;
  }>;
};

export type ScriptScenario = {
  missionId: string;
  title: string;
  world: 'registry';
  utterance: ScriptUtterance;
  match: ScriptMatch;
  /** 탭②~⑤에서 그려도 되는 장비. 전부 registry.json 에 실재해야 한다(verify:script-library). */
  cast: string[];
  durationSec: number;
  /** 편별 상수 — 위험 수위 선(탭④)·정지 거리·재탐색 임계 등. 화면이 읽는다. */
  params?: Record<string, unknown>;
  /** 대본 시작 시 세계의 초기 조건 (예: 수문 열림 100%). 재생기가 시작 시 1회 반영한다. */
  initial?: Record<string, Record<string, unknown>>;
  milestones: ScriptMilestone[];
  tasks: ScriptTask[];
  events: ScriptEvent[];
  /** 되돌아가는 참조 엣지 — deps 와 분리돼 있다 (위 ScriptRefEdge 주석). */
  refEdges?: ScriptRefEdge[];
  worldTimeline?: WorldDrive[];
  commands?: ScriptCommand[];
  map?: ScriptMap;
  /**
   * 8분할 뷰포인트 묶음 (260909 시연 대본 §4). **배치 특례가 걸리는 유일한 자리다** —
   * 이 선언이 없는 편은 배치가 지금까지와 한 픽셀도 다르지 않다. 태스크 id 를 배치
   * 코드에 적어 두는 대신 대본이 선언한다(`src/graph/fanLayout.ts`).
   */
  viewpoints?: ScriptViewpoints;
  /**
   * 뷰포인트 채널의 대본 (260909 §6). **라이브 채널과 같은 형식이다** — 로봇이 붙는 날
   * 이 줄들을 게이트웨이 수신으로 갈아끼우면 노드 갱신 코드는 한 줄도 안 고친다.
   * 가르는 자리는 `src/viewpoint/source.ts` 하나다.
   */
  viewpointTimeline?: ScriptViewpointFrame[];
};

/** 뷰포인트 채널 한 줄. 봉투가 아니라 값이다 — 봉투는 재생기가 만든다. */
export type ScriptViewpointFrame = {
  atSec: number;
  /** 'robot_state' 또는 'detection'. 실제 채널 이름과 같다. */
  channel: string;
  payload: Record<string, unknown>;
};

/** 여덟이 한 부모에 매달려 원 둘레에 서는 묶음. 배열 차례가 곧 각도 차례다. */
export type ScriptViewpoints = {
  parentTaskId: string;
  taskIds: string[];
  startAngleDeg?: number;
  stepDeg?: number;
};

/**
 * 라이브러리 항목. 옛 편(MSN-260826-01)은 파일 무수정 제약 때문에 match 를
 * 사이드카(`MSN-260826-01.match.json`)에 두고, script 는 legacy 형식 그대로 든다.
 */
export type ScriptLibraryEntry = {
  missionId: string;
  world: 'registry' | 'legacy';
  match: ScriptMatch;
  /** registry 세계 대본만 담는다. legacy 편은 화면이 기존 경로(번들 Scenario)로 그린다. */
  script: ScriptScenario | null;
};
