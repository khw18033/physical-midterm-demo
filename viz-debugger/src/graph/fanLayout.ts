/**
 * src/graph/fanLayout.ts (260909 신설 · 260910 원형 → 세로 나열)
 *
 * **8분할 뷰포인트의 세로 나열 배치.** 깊이 배치(`layout.ts`)의 결과를 **덮는 한 겹**이고,
 * 배치 엔진 자체는 한 줄도 고치지 않는다.
 *
 * ## 왜 특례가 필요한가
 *
 * `dagLayout` 은 깊이로 열을 만든다. `T-A4-0`~`T-A4-7` 여덟은 **전부 `T-A3` 하나에**
 * 매달리므로 깊이가 같고, 그래서 한 열에 세로로 쌓인다. 쌓이는 것 자체는 맞는데 간격이
 * `ROW`(150) 고정이라 1,200px 기둥이 되고 첫 화면에 안 들어온다.
 *
 * ## 원형이었다가 세로로 왔다 (260910)
 *
 * 9/9 에는 여덟을 부모 아래 **원 둘레**에 놓았다. 시연 화면을 띄워 보니 못 쓴다 —
 * 부모에서 여덟으로 나가는 화살표가 서로 겹쳤다. 원 위의 여덟은 부모를 기준으로 방향이
 * 제각각이라 선이 부챗살처럼 포개지고, 캔버스에 남는 공간은 쓰지도 못했다.
 *
 * **세로 한 열 + 분기선 하나**로 바꿨다. 부모에서 가로선이 하나 나가 세로 spine 을
 * 만들고, spine 에서 각 노드로 가로 화살표 여덟이 붙는다. 여덟 화살표는 y 가 다 달라
 * **서로 만나지 않는다** — 그것이 이 배치의 합격 기준이고 `verify:viewpoint-layout` 이
 * 좌표로 잰다. 원형 코드는 지웠다. 토글로 남기지 않는다.
 *
 * ## 노드가 작아진다
 *
 * 여덟을 세우면 길어지므로 뷰포인트 노드만 **낮은 카드**로 줄인다(`VIEWPOINT_NODE_HEIGHT`).
 * 확대율로 맞출 수는 없다 — 이 앱에는 줌이 없다(`layout.ts` 머리말: 자동 정렬·확대축소·
 * 미니맵은 만들지 않는다). 크기와 간격이 유일한 손잡이다.
 *
 * 화면(`.task-node.viewpoint`)과 이 파일이 **같은 높이를 봐야** 「한 화면에 들어온다」는
 * 계산이 실제 그림과 맞는다. `NODE_WIDTH`·`NODE_HEIGHT` 를 `layout.ts` 가 내보내는 것과
 * 같은 이유다.
 */

import { NODE_HEIGHT, NODE_WIDTH, type Position } from './layout.ts';

/**
 * 대본이 선언하는 8분할 묶음 (`scenarios/<id>.json` 의 `viewpoints`).
 * 배치가 이 선언 하나만 보고 열을 세운다.
 *
 * `startAngleDeg`·`stepDeg` 는 **각도이지 배치가 아니다** — 노드 제목에 이미 각도가 적혀
 * 있고 세로 나열은 각도를 좌표로 쓰지 않는다. 대본 형식이라 읽기만 하고 배치는 무시한다
 * (대본은 이번 범위 밖이다).
 */
export type ViewpointGroup = {
  /** 여덟이 매달린 부모. 분기선이 이 노드에서 나간다. */
  parentTaskId: string;
  /** 세로로 세울 태스크. **배열 차례가 곧 위에서 아래 차례다.** */
  taskIds: readonly string[];
  startAngleDeg?: number;
  stepDeg?: number;
};

/**
 * 뷰포인트 노드의 상자 크기 (260910).
 *
 * 폭은 태스크 노드와 **같다** — 한 열에 서므로 폭이 다르면 열이 들쭉날쭉해진다.
 * 높이는 여덟이 한 화면에 들어오도록 줄인 값이다: 기본 110 이면 여덟에 세로 간격까지
 * 1,200px 이 넘어 시연에서 스크롤이 생긴다. 52 + 간격 8 이면 여덟이 472px 다.
 *
 * 카드에서 id 줄과 장비 줄을 뺐다(`.task-node.viewpoint` CSS) — 여덟이 다 같은 장비이고,
 * id(`T-A4-3`)가 말하는 것을 제목(`135도 방향 탐색`)이 이미 말한다. 뺀 만큼이 높이다.
 */
export const VIEWPOINT_NODE_WIDTH = NODE_WIDTH;
export const VIEWPOINT_NODE_HEIGHT = 52;
/** 뷰포인트 노드 사이 세로 간격. 가로 화살표 여덟이 서로 붙지 않을 만큼은 벌어져야 한다. */
export const VIEWPOINT_GAP = 8;
/** 한 칸이 차지하는 세로 몫. */
const ROW = VIEWPOINT_NODE_HEIGHT + VIEWPOINT_GAP;

/**
 * 열의 x 는 **배치 엔진이 이미 정한 자리**를 그대로 쓴다 (260910).
 *
 * 처음에 부모 오른쪽에서 폭을 직접 재서 열을 세웠더니 `T-A5`(다음 깊이 열)와 4px 겹쳤다 —
 * `verify:viewpoint-layout` 이 잡았다. 열 간격은 `layout.ts` 의 `COL` 이 정하는 값이고
 * 여기서 다시 재면 두 벌이 된다. 여덟은 어차피 깊이가 같아 `dagLayout` 이 한 열에 세워
 * 두었으므로, **x 는 그대로 두고 y 만 다시 잡는다.** 겹치지 않는 것이 계산이 아니라
 * 구조로 보장된다.
 *
 * spine 은 부모 오른쪽 변과 그 열 사이 통로 한가운데다.
 */
function spineXOf(parent: Position, columnX: number): number {
  return Math.round((parent.x + NODE_WIDTH + columnX) / 2);
}

/** 여덟이 차지하는 세로 전체. 마지막 칸은 간격이 없다. */
export function viewpointColumnHeight(count: number): number {
  return count <= 0 ? 0 : count * ROW - VIEWPOINT_GAP;
}

/** 배치가 그린 분기선의 기하. 화면과 검사가 **같은 값**을 봐야 겹침 계산이 그림과 맞는다. */
export type FanGeometry = {
  /** 여덟이 서는 열의 x. 배치 엔진이 대표 하나에 준 자리다. */
  columnX: number;
  /** 부모에서 나온 가로선이 꺾이는 x — 세로 spine 의 x. */
  spineX: number;
  /** 부모 오른쪽 변 중앙. 가로선이 여기서 시작한다. */
  parent: Position;
  /** spine 의 위·아래 끝 y. 첫 노드와 마지막 노드의 중앙이다. */
  spineTop: number;
  spineBottom: number;
  /** 노드마다 가로 화살표 한 구간. `y` 가 다 달라 서로 만나지 않는다. */
  arrows: Array<{ id: string; y: number; fromX: number; toX: number }>;
};

/**
 * 세로 나열을 **덮어씌운다.** 선언이 없거나 묶음의 태스크가 지금 화면에 없으면
 * 입력을 그대로 돌려준다 — 「이 마일스톤」 범위에서 여덟이 안 보일 때가 그렇다.
 *
 * 부모가 화면에 없으면 열을 걸 자리가 없으므로 역시 그대로 둔다. 그때는 여덟이
 * 깊이 열 하나에 서고, 그것이 원래 배치의 정답이다.
 */
export function applyFanLayout(
  base: Record<string, Position>,
  group: ViewpointGroup | null | undefined,
): Record<string, Position> {
  const geometry = fanGeometry(base, group);
  if (geometry === null || !group) return base;
  const moved: Record<string, Position> = { ...base };
  const columnX = geometry.columnX;
  const top = columnTop(base[group.parentTaskId], group.taskIds.length);
  group.taskIds.forEach((id, index) => {
    moved[id] = { x: columnX, y: top + index * ROW };
  });
  return moved;
}

/**
 * 열의 첫 칸 y. 여덟의 **세로 한가운데가 부모 중앙에 오도록** 건다 — 부모가 열의 위나
 * 아래에 치우치면 분기선이 한쪽으로 길게 늘어져 어디서 갈라지는지 안 보인다.
 *
 * 캔버스 위로 넘치지 않게 바닥을 둔다. 좌표가 음수면 노드가 잘린다.
 */
function columnTop(parent: Position, count: number): number {
  const centered = parent.y + NODE_HEIGHT / 2 - viewpointColumnHeight(count) / 2;
  return Math.max(parent.y, Math.round(centered));
}

/**
 * 분기선의 기하. **화면이 그리는 선과 검사가 재는 선이 같은 함수에서 나온다** —
 * 두 벌이면 「겹치지 않는다」가 그림과 다른 것을 말하게 된다.
 *
 * 묶음이 성립하지 않으면 null 이고, 그때 화면은 기본 엣지를 그린다.
 */
export function fanGeometry(
  base: Record<string, Position>,
  group: ViewpointGroup | null | undefined,
): FanGeometry | null {
  if (!group) return null;
  const parent = base[group.parentTaskId];
  if (parent === undefined) return null;
  if (group.taskIds.length === 0) return null;

  // 열의 x — **대표 하나만 있으면 된다.**
  //
  // 배치 엔진에는 여덟 중 대표만 넘긴다(`TaskGraph`) — 여덟을 다 넘기면 엔진이 그 열을
  // `ROW`(150) × 8 = 1,200px 로 보고, 세로가 모자란다고 판단해 **밴드를 접는다.** 그러면
  // 오른쪽의 판단·근거 노드가 다음 밴드로 내려가 첫 화면에서 사라진다. 실제로 그랬다 —
  // 좌표 검사는 통과했는데 화면 캡처에서 드러났다.
  //
  // 대표의 열에 나머지 일곱을 세운다. 엔진은 그 열을 노드 하나짜리로 알고 있으면 된다.
  const present = group.taskIds.filter((id) => base[id] !== undefined);
  if (present.length === 0) return null;
  const columnX = base[present[0]].x;
  if (present.some((id) => base[id].x !== columnX)) return null;
  // 부모가 열 왼쪽에 있어야 왼→오 분기선이 그려진다. 줄바꿈으로 부모가 오른쪽에 오면 접는다.
  if (columnX <= parent.x + NODE_WIDTH) return null;

  const spineX = spineXOf(parent, columnX);
  const top = columnTop(parent, group.taskIds.length);
  const centreOf = (index: number) => top + index * ROW + VIEWPOINT_NODE_HEIGHT / 2;
  return {
    columnX,
    spineX,
    parent: { x: parent.x + NODE_WIDTH, y: parent.y + NODE_HEIGHT / 2 },
    spineTop: centreOf(0),
    spineBottom: centreOf(group.taskIds.length - 1),
    arrows: group.taskIds.map((id, index) => ({
      id,
      y: centreOf(index),
      fromX: spineX,
      toX: columnX,
    })),
  };
}
