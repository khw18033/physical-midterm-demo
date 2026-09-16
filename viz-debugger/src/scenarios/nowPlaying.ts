/**
 * src/scenarios/nowPlaying.ts (260901 신설 — 「지금 무엇이 어디서 보이는지」)
 *
 * 사용자의 목적은 **「실행되는 걸 보면서 확인」**이다. 그런데 지금까지 화면은 지금 시각에
 * 무슨 일이 어디서 보이는지 말하지 않았다 — 사용자가 탭을 하나씩 눌러 찾아야 했다.
 *
 * 이 파일은 **재생 머리(headSec) 기준 진행 중인 노드 한 줄**과 **그 일이 보이는 뷰 노드**를 만든다.
 * 새로 계산하는 것이 없다 — 상태는 `statusesAt()` 이 이미 접어서 돌려주고, 축은
 * `axesOfDrive()`(대본 전체의 축과 같은 규칙), 노드는 `AXIS_NODES` 표에서 나온다.
 *
 * 셸이 그린다(`AppShell`). 캔버스가 그리면 마일스톤을 옮길 때 사라진다.
 *
 * **대본을 인자로 받는다** — 여기서 `library.ts` 를 열면 JSON import 때문에 Node 에서
 * 안 열려 `verify:scenario-mode` 가 이 규칙을 돌려 볼 수 없다. 부르는 쪽(셸)이 찾아 넘긴다.
 */

import { foldStatuses } from '../data/fold.ts';
import type { MissionView } from '../data/scenario.ts';
import type { ScenarioEvent } from '../model/types.ts';
import { AXIS_NODES, axesOfDrive, axesOfScript, type ScenarioAxis, type ViewNodeKindId } from './axes.ts';
import type { ScriptScenario } from './types.ts';

export type NowPlaying = {
  /** 「지금」 한 줄. */
  text: string;
  /**
   * 그 일이 보이는 **뷰 노드 후보**. 둘이면 둘 다 적는다 (260903 — `tabs` 였다).
   * 실행 노드는 늘 캔버스에 있으므로 후보가 아니다.
   */
  nodeKinds: ViewNodeKindId[];
  /**
   * 지금 진행 중인 태스크 (260903). 안내줄의 「○○ 노드로」가 **없으면 만들어** 여기에
   * 연결한다 — 탭 시절에는 갈 곳이 이미 있었지만 노드는 캔버스에 아직 없을 수 있다.
   */
  taskId: string | null;
};

/** 아직 끝나지 않은 상태들 — 이 중 하나면 「진행 중인 노드」다. */
const ACTIVE = new Set(['running', 'rerunning', 'awaiting_evaluation']);

/** 팔레트와 같은 차례. 안내줄 버튼이 대본마다 다른 순서로 뜨면 눈으로 못 쫓는다. */
const NODE_ORDER: ViewNodeKindId[] = ['device-risk', 'control', 'metrics', 'video'];

export function nowPlaying(
  view: MissionView,
  /** 이 임무의 대본. 옛 편(구판 세계)은 null — 판정 대상이 아니다(구판 안내 띠가 따로 말한다). */
  script: ScriptScenario | null,
  headSec: number,
  playing: boolean,
  /**
   * 지금까지 흘러온 **기록 열** (260904). 대본(`view.events`)이 아니다 — 안내줄이
   * 화면과 다른 것을 접으면 「지금」이 화면과 어긋난다.
   */
  trace: readonly ScenarioEvent[],
): NowPlaying | null {
  if (script === null) return null;

  if (!playing && headSec >= view.durationSec) {
    // 재생 끝 — 마지막 상태 유지. 기존 동작 그대로다.
    return { text: '재생 끝 — 장치는 마지막 상태를 유지합니다', nodeKinds: [], taskId: null };
  }

  const first = view.milestones[0] ?? null;
  if (!playing && headSec <= 0) {
    // 정지 미리보기 — 사건이 하나도 없다. 시작 상태와 첫 마일스톤을 적는다.
    return {
      text: first === null
        ? 'T+0 · 시작 상태 — 승인하면 재생됩니다 (VZ-U-07)'
        : `T+0 · 시작 상태 — 첫 마일스톤 ${first.id} ${first.title}. 승인하면 재생됩니다 (VZ-U-07)`,
      nodeKinds: [],
      taskId: null,
    };
  }

  // 그 태스크가 **마지막으로 움직인 시각** — 「지금 창」의 시작이자 진행 중 후보의 정렬 기준.
  const lastMoveAt = new Map<string, number>();
  for (const event of trace) {
    if (event.atSec > headSec) break;
    lastMoveAt.set(event.nodeId, event.atSec);
  }

  const folded = foldStatuses(headSec, view, trace);
  const active = view.tasks
    .filter((task) => ACTIVE.has(folded.tasks[task.id]?.status ?? 'pending'))
    .sort((a, b) => (lastMoveAt.get(b.id) ?? -1) - (lastMoveAt.get(a.id) ?? -1));
  // 진행 중이 없으면(사건 사이의 틈) 마지막으로 움직인 노드를 적는다 — 비워 두지 않는다.
  const task =
    active[0] ??
    [...view.tasks].sort((a, b) => (lastMoveAt.get(b.id) ?? -1) - (lastMoveAt.get(a.id) ?? -1)).find((t) => lastMoveAt.has(t.id)) ??
    null;

  if (task === null) {
    return { text: `T+${Math.round(headSec)}s · 첫 사건 대기`, nodeKinds: [], taskId: null };
  }

  const startedAt = lastMoveAt.get(task.id) ?? 0;
  const axes = new Set<ScenarioAxis>();

  // 이 창에서 나간 명령 — 있으면 그 이름을 적고 축은 액추에이터·명령이다(제어 노드).
  let command: string | null = null;
  for (const cmd of script.commands ?? []) {
    if (cmd.taskId === task.id || (cmd.atSec >= startedAt && cmd.atSec <= headSec)) {
      axes.add('actuator');
      axes.add('command');
      command = cmd.action;
    }
  }
  // 이 창에서 몰린 세계 값 — drive 키가 곧 축이다.
  for (const frame of script.worldTimeline ?? []) {
    if (frame.atSec > headSec) break;
    if (frame.atSec >= startedAt) for (const axis of axesOfDrive(frame.drive)) axes.add(axis);
  }
  // 창 안에 아무것도 없으면(판정만 하는 노드) 대본 전체의 축으로 넓힌다 — 빈 안내는 쓸모가 없다.
  if (axes.size === 0) for (const axis of axesOfScript(script)) axes.add(axis);

  const kinds = new Set<ViewNodeKindId>();
  for (const axis of axes) for (const kind of AXIS_NODES[axis]) kinds.add(kind);

  const milestone = view.milestones.find((m) => m.id === task.milestone) ?? null;
  const head = milestone === null ? task.title : `${milestone.id} ${task.title}`;

  return {
    // 태스크 제목이 이미 그 명령을 말하고 있으면 덧붙이지 않는다 — 같은 말을 두 번 적지 않는다.
    text: command === null || head.includes(command) ? head : `${head} → ${command} 발행`,
    nodeKinds: NODE_ORDER.filter((kind) => kinds.has(kind)),
    taskId: task.id,
  };
}
