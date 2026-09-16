/**
 * src/scenarios/axes.ts (260831 — 사이트 개선 요구 2 · 260901 — 축→탭 표)
 *
 * 대본이 실제로 몰아 주는 **축**의 유도 규칙과 **축→노드·패널→축 표** — 여기 하나뿐이다.
 *
 * **이 파일은 대본 목록(library.ts)을 import 하지 않는다.** 규칙과 표만 있고 「어느 편이
 * 이 축을 미는가」 같은 조회는 옆의 `scriptScope.ts` 에 있다. 그래야 `verify:node-scope` 가
 * 이 파일을 Node 에서 그대로 읽어 표를 검사할 수 있다(브라우저 번들의 JSON import 는
 * Node ESM 에서 import attribute 없이 열리지 않는다).
 *
 * 대본 파일에 축 목록을 손으로 적지 않는다. 적으면 대본을 고칠 때 한쪽만 바뀌어
 * 조용히 갈라진다 — 이 저장소가 계속 피해 온 실패다. 그래서 worldTimeline 의 drive 키와
 * commands·map 의 존재에서 **유도**한다. 대본에 값이 실려 있으면 축이 있는 것이고,
 * 없으면 없는 것이다.
 *
 * 화면은 이 축으로 「연결 예정(못 받았다)」과 「이 대본에는 해당 없음(이 이야기에 없다)」을
 * 가른다 — 그 구분이 없으면 시연에서 "왜 여긴 비었냐"에 답할 수 없다.
 */

import type { ScriptScenario } from './types.ts';

export type ScenarioAxis =
  | 'position'
  | 'speed'
  | 'water'
  | 'coverage'
  | 'video'
  | 'actuator'
  | 'command'
  // 아래 둘은 **어느 대본도 몰지 않는다** — 위험도는 AI 파트(VZ-I-08), 관측 지표는
  // 평시 ObservabilityEmitter 몫이라 대본이 몰 것이 아니다. 그 사실을 화면에 적는다.
  | 'risk'
  | 'observability';

export const AXIS_LABEL: Record<ScenarioAxis, string> = {
  position: '위치',
  speed: '속도',
  water: '수위',
  coverage: '커버리지·사각지대',
  video: '영상·탐지',
  actuator: '액추에이터',
  command: '명령',
  risk: '위험도 판정',
  observability: '관측 지표',
};

/**
 * `worldTimeline` 한 프레임의 drive 키 → 축. **키를 읽는 곳은 여기 하나다** — 대본 전체의
 * 축(axesOfScript)과 「지금 이 시각의 축」(nowPlaying)이 같은 규칙을 써야 안내줄과 접힘이
 * 어긋나지 않는다.
 */
export function axesOfDrive(drive: Record<string, unknown>): ScenarioAxis[] {
  const found: ScenarioAxis[] = [];
  if ('position' in drive) found.push('position');
  if ('speed_mps' in drive) found.push('speed');
  if ('water_level_m' in drive) found.push('water');
  if ('coverage' in drive) found.push('coverage');
  if ('in_view' in drive) found.push('video');
  return found;
}

/** 대본 하나가 몰아 주는 축 — drive 키·commands·map 에서 유도한다. */
export function axesOfScript(script: ScriptScenario): ReadonlySet<ScenarioAxis> {
  const axes = new Set<ScenarioAxis>();
  for (const frame of script.worldTimeline ?? []) {
    for (const axis of axesOfDrive(frame.drive)) axes.add(axis);
  }
  if (script.map !== undefined) axes.add('coverage');
  if ((script.commands ?? []).length > 0) {
    axes.add('actuator');
    axes.add('command');
  }
  return axes;
}

// ── 축 → 뷰 노드 종류 (260901 축→탭 · 260903 3단계에서 노드로) ──────────────────
//
// **표는 여기 하나뿐이다.** 축을 화면 세 층(팔레트 흐림 · 노드 접힘 · 안내줄의 「갈 노드」)이
// 각자 손으로 적으면 갈라진다 — 이 저장소가 계속 피해 온 실패다. `verify:node-scope` 가
// 이 표와 아래 패널 표의 아귀가 맞는지 검사한다.
//
// **탭이 사라져도 표의 구조는 그대로다.** 오른쪽 칸이 탭 id 에서 뷰 노드 종류로 바뀌었을
// 뿐이고 대응 자체는 한 글자도 바뀌지 않았다 — 탭②가 장치·위험 노드로, 탭③이 제어 노드로,
// 탭④가 지표 노드로, 탭⑤가 영상 노드로 그대로 옮겨 앉았다.
//
// 종류 id 를 여기 두는 이유: 렌더러 목록(`tabs/viewNodes.tsx`)을 가져오면 `scenarios/` 가
// `tabs/` 에 의존하게 되고, 이 파일은 `PendingSource` 를 통해 **단독 빌드의 의존 그래프
// 안**에 있다(verify:standalone). 그래서 **id 만** 여기 두고 **이름(label)은 두지 않는다** —
// 이름의 원천은 등록된 렌더러다(`VZ-N-01`). `verify:node-scope` 가 둘을 대조한다.

export type ViewNodeKindId =
  | 'device-risk' | 'control' | 'metrics' | 'video' | 'robot'
  | 'detect-cam' | 'detect-reason' | 'detect-map';

/** 표에 등장하는 종류들. 등록된 렌더러와 어긋나면 `verify:node-scope` 가 잡는다. */
export const SCENARIO_NODE_KINDS: readonly ViewNodeKindId[] =
  ['device-risk', 'control', 'metrics', 'video', 'robot', 'detect-cam', 'detect-reason', 'detect-map'];

// `robot` 은 **축 표(`AXIS_NODES`)에 없다** — 일부러다 (260910).
//
// 축 표는 「이 대본이 이 축을 안 몰면 그 노드를 접는다」를 판정하는 재료이고, 로봇 노드가
// 그리는 것은 **대본이 아니라 실물 장비의 지금 상태**다. 대본과 무관하게 늘 살아 있어야
// 하고, 실제로 `NodeGate` 는 패널이 하나도 없는 노드를 늘 그린다.
//
// 그래서 접힘 판정도 안 받고 팔레트에서 흐려지지도 않는다 — 실행 노드가 표에 없는 것과
// 같은 이유다. 탐지 셋(`detect-cam` · `detect-reason` · `detect-map`)도 마찬가지로,
// 대본이 아니라 **탐지 서비스가 미는 값**을 그린다.

/**
 * 이 축이 나타나는 뷰 노드. **실행 노드(태스크 그래프)는 이 표에 없다** — 임무 축이라
 * 어느 대본에서든 늘 살아 있고 접힘 판정의 대상이 아니다. 탭 시절 탭①이 표에 없던 것과
 * 같은 이유다.
 *
 * `risk`·`observability` 는 어느 대본도 몰지 않는 축이지만 **노드는 적는다** — 그 축을 담은
 * 패널이 어느 노드에 있는지가 이 표에서 나와야 아래 패널 표와 대조할 수 있다.
 */
export const AXIS_NODES: Record<ScenarioAxis, readonly ViewNodeKindId[]> = {
  position: ['device-risk'],
  speed: ['metrics'],
  water: ['device-risk', 'metrics'],
  coverage: ['device-risk', 'metrics'],
  video: ['video'],
  actuator: ['control'],
  command: ['control'],
  risk: ['device-risk'],
  observability: ['metrics'],
};

/**
 * 시나리오 모드에서 **접힘 판정을 받는 패널**. 화면과 검사가 같은 목록을 본다.
 *
 * 「이 패널의 축을 대본이 하나도 몰지 않으면 패널을 통째로 접는다」가 규칙이다. 제목·버튼
 * 줄·표까지 없앤다 — 안쪽 칸만 「해당 없음」으로 두면 로봇 대본을 보는 사람 앞에 수문 제목이
 * 그대로 남는다(1편의 `ControlPanel`, 8/31 이후 실제로 그랬다).
 */
export type ScenarioPanelSpec = {
  /** 화면(PanelGate)과 검사가 같이 쓰는 식별자. */
  id: string;
  /** 이 패널이 사는 뷰 노드 (260903 — `tab` 이었다). */
  node: ViewNodeKindId;
  /** 접힘 카드에 적을 이름. */
  title: string;
  /** 이 축들 중 **하나라도** 대본이 몰면 패널이 산다. */
  axes: readonly ScenarioAxis[];
  /** 접혔을 때 「왜 이 편에 없는가」 한 줄. */
  why: string;
};

export const SCENARIO_PANELS: readonly ScenarioPanelSpec[] = [
  { id: 'risk', node: 'device-risk', title: '상황 판단 · 설명가능성', axes: ['risk'], why: '위험도 판정은 AI 파트(VZ-I-08) 몫이라 어느 대본도 몰지 않습니다.' },
  { id: 'zone-map', node: 'device-risk', title: '구역 맵 미니뷰', axes: ['coverage', 'position'], why: '이 편에는 움직이는 궤적도 커버리지 맵도 없습니다.' },
  { id: 'device-grid', node: 'device-risk', title: '구역 장치 현황판', axes: ['position', 'water'], why: '이 편은 구역 장치의 값을 몰지 않습니다.' },
  { id: 'control', node: 'control', title: '제어 · 명령 결과 · 감사 이력', axes: ['actuator', 'command'], why: '이 편에는 액추에이터 명령이 없습니다.' },
  { id: 'metrics-query', node: 'metrics', title: '지표 조회', axes: ['speed', 'water', 'coverage'], why: '이 편이 미는 도메인 지표가 없습니다.' },
  { id: 'metrics-push', node: 'metrics', title: '평시 관측 지표', axes: ['observability'], why: '관측 지표는 평시 ObservabilityEmitter 몫이라 어느 대본도 몰지 않습니다.' },
  { id: 'video', node: 'video', title: '영상 · 탐지 오버레이', axes: ['video'], why: '이 편에는 카메라 시야에 드는 대상이 없습니다.' },
];

const PANEL_BY_ID = new Map(SCENARIO_PANELS.map((spec) => [spec.id, spec]));

export function scenarioPanel(id: string): ScenarioPanelSpec {
  const spec = PANEL_BY_ID.get(id);
  // 없는 id 를 참조하면 조용히 그리지 않고 즉시 터뜨린다 — 접힘이 사라지는 것이 제일 나쁘다.
  if (!spec) throw new Error(`SCENARIO_PANELS 에 없는 id: ${id}`);
  return spec;
}

/** 이 패널이 지금 대본에서 살아 있는가. 축을 하나도 안 몰면 접힌다. */
export function panelAlive(spec: ScenarioPanelSpec, axes: ReadonlySet<ScenarioAxis>): boolean {
  return spec.axes.some((axis) => axes.has(axis));
}

/**
 * 이 축들을 미는 대본이 쓰는 뷰 노드. **실행 노드는 여기 없다** — 늘 살아 있어 판정 대상이
 * 아니다(탭 시절 `tabsOfAxes()` 가 항상 얹던 `debugger` 가 사라진 자리다).
 */
export function nodeKindsOfAxes(axes: ReadonlySet<ScenarioAxis>): ReadonlySet<ViewNodeKindId> {
  const kinds = new Set<ViewNodeKindId>();
  for (const axis of axes) for (const kind of AXIS_NODES[axis]) kinds.add(kind);
  return kinds;
}

/** 대본 하나가 쓰는 뷰 노드. 옛 편(축 없음)은 하나도 없다 — 구판 세계 안내가 따로 뜬다. */
export function nodeKindsOfScript(script: ScriptScenario): ReadonlySet<ViewNodeKindId> {
  return nodeKindsOfAxes(axesOfScript(script));
}

/** 이 노드가 담은 패널들 — 노드 본문을 통째로 한 장으로 대체할지 판정할 재료. */
export function panelsOfNode(kind: ViewNodeKindId): ScenarioPanelSpec[] {
  return SCENARIO_PANELS.filter((spec) => spec.node === kind);
}
