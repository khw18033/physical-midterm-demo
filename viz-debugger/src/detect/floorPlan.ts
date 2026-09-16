/**
 * src/detect/floorPlan.ts (260914 신설)
 *
 * **2D 도면과 그 위의 문 자리.** `T-A1`「2D 맵에서 문 위치 확인」이 읽는 것이다.
 *
 * 둘 다 **탐지가 검출하는 값이 아니다.** 탐지 프로그램(`physical_demo`)의
 * `navigate_to_target_service.py` 에 고정돼 있는 값을 그대로 옮겼다.
 *
 *   도면     datasets/25300.png — 탐지가 `localization/map_original.jpg` 로 그대로 다시 쓴다
 *   문 자리  DOOR_PX = (1300.1, 535.8) — 25300_gt.png 의 GT 점. 「문 위치는 검출값이 아니라
 *            GT 고정값」이 그쪽 문서의 「정직한 한계」다
 *   좌표     MAP_ROOM_TOPLEFT_PX · MAP_ROOM_BOTTOMRIGHT_PX · ROOM_CM — px ↔ cm 환산
 *
 * 그래서 `T-A1` 은 **로봇이 돌기 전에 실제로 끝낼 수 있다.** 전에는 탐지의 자세 역산을
 * 기다렸는데, 탐지는 그것을 한 바퀴를 다 받은 뒤에 계산한다 — 노드는 대기인 채로 로봇이 돌았다.
 *
 * 탐지 쪽에서 이 값이 바뀌면 여기도 바꾼다. 값이 두 곳에 있는 것을 숨기지 않는다.
 */

/** 도면 그림의 화소 크기. 문 표시를 퍼센트로 얹는 데 쓴다. */
export const FLOOR_PLAN_SIZE_PX = { width: 1448, height: 1086 } as const;

/** 문의 도면 위치(px) — GT 고정값. */
export const DOOR_PX = { x: 1300.1, y: 535.8 } as const;

const ROOM_TOPLEFT_PX = { x: 156.0, y: 149.25 };
const ROOM_BOTTOMRIGHT_PX = { x: 1094.5, y: 961.75 };
const ROOM_CM = { width: 757.0, height: 689.0 };

/** 도면 px → 방 cm. 탐지의 `px_to_cm` 과 같은 식이다. */
export function pxToCm(px: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (px.x - ROOM_TOPLEFT_PX.x) / (ROOM_BOTTOMRIGHT_PX.x - ROOM_TOPLEFT_PX.x) * ROOM_CM.width,
    y: (px.y - ROOM_TOPLEFT_PX.y) / (ROOM_BOTTOMRIGHT_PX.y - ROOM_TOPLEFT_PX.y) * ROOM_CM.height,
  };
}

/** 문의 도면 위치(cm). 탐지 자세 역산의 `door_position_cm_fixed_from_gt` 와 같은 값이 나온다. */
export function doorCm(): { x: number; y: number } {
  return pxToCm(DOOR_PX);
}
