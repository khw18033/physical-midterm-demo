/**
 * src/shell/ConnectionLamp.tsx (260910 신설 — 연결 관리 통합 §4)
 *
 * **시연 화면의 읽기 전용 표시등.**
 *
 * 연결을 **바꾸는** 자리는 「연결 관리」 하나다. 다만 연결이 끊긴 것을 **시연 중에 알아야
 * 한다** — 팝업을 열어야만 알 수 있으면 늦는다. 그래서 표시등 하나만 머리줄에 둔다.
 *
 *  - **읽기 전용이다.** 주소 입력도 프리셋도 확인 버튼도 여기 없다
 *  - **무엇이 끊겼는지 보인다** — 「로봇 연결 끊김」처럼 대상과 줄 이름을 적는다
 *  - **누르면 연결 관리가 열린다.** 고치는 것은 거기서 한다
 *
 * 머리줄에 둔 이유는 정지 버튼과 같다 — 마일스톤을 열었든 뷰 노드를 열었든 늘 떠 있다.
 * 시연 화면의 `RobotPanel` 은 마일스톤 화면에만 있어서 이 조건을 못 지킨다.
 *
 * ## 「모른다」와 「빨갛다」는 다르다
 *
 * 아직 확인 버튼을 안 눌러 봤으면 회색이다. 안 눌러 본 것을 빨갛게 칠하면 발표 직전에
 * 「원래 저런가」가 되고, 진짜 빨강이 묻힌다.
 */

import { CHECKED_TARGETS, firstBroken, targetOk, useConnectionHealth } from '../shared/connectionHealth.ts';
import { CONNECTION_TARGETS } from '../shared/connections.ts';

const LABEL_OF = new Map(CONNECTION_TARGETS.map((target) => [target.id, target.label]));

export function ConnectionLamp({ onOpen }: { onOpen(): void }) {
  const health = useConnectionHealth();
  const checked = CHECKED_TARGETS.filter((target) => (health[target]?.lines.length ?? 0) > 0);
  const broken = firstBroken(CHECKED_TARGETS);

  // 아무것도 안 눌러 봤다 — 「모른다」다. 빨갛게 칠하지 않는다.
  if (checked.length === 0) {
    return <button type="button" className="conn-lamp conn-lamp--unknown" onClick={onOpen}>
      연결 미확인 — 누르면 연결 관리
    </button>;
  }
  if (broken !== null) {
    return <button type="button" className="conn-lamp conn-lamp--bad" onClick={onOpen}>
      {LABEL_OF.get(broken.target) ?? broken.target} {broken.line.label} 끊김 — 누르면 연결 관리
    </button>;
  }
  // 빨간 줄은 없지만 「모르는」 줄이 남아 있을 수 있다 — 초록이라고 말하지 않는다.
  const unknown = CHECKED_TARGETS.filter((target) => targetOk(target) === null && (health[target]?.lines.length ?? 0) > 0);
  if (unknown.length > 0) {
    return <button type="button" className="conn-lamp conn-lamp--unknown" onClick={onOpen}>
      연결 {checked.length - unknown.length}/{CHECKED_TARGETS.length} · 미확인 {unknown.length}
    </button>;
  }
  return <button type="button" className="conn-lamp conn-lamp--ok" onClick={onOpen}>
    연결 {checked.length}/{CHECKED_TARGETS.length} 확인됨
  </button>;
}
