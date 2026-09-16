/**
 * src/views/DeviceStrip.tsx (260904 — 추가 개선 2)
 *
 * **배정 장비 실측 상태 일곱 칸.** `ActionModal` 안에 인라인으로 있던 것을 그대로 꺼냈다 —
 * 하드웨어 카드 더블클릭(`VZ-D-07` 의 미구현분)이 같은 것을 보여야 하기 때문이다.
 * 두 곳에 다른 상태 화면을 만들면 **어휘가 갈린다**: 한쪽은 「관절 온도」, 다른 쪽은 「온도」가
 * 되고, 한쪽에만 하트비트가 있는 식으로 벌어진다.
 *
 * 일곱 칸의 값은 여전히 **남이 줄 데이터**다 — 이 부품은 감싸지 않는다. 부르는 쪽이
 * `<PendingSource id="robot-status-strip">` 로 감싸고, 기본 모드에서는 이 부품이 아예 그려지지
 * 않는다(자리표시 카드가 대신 뜬다). 그것이 8/31 결정이다.
 */

import type { Hardware } from '../model/types.ts';

export function DeviceStrip({ device }: { device: Hardware }) {
  return <div className="device-strip">
    <b>{device.id}<small>{device.kind} · {device.connection}</small></b>
    <span>배터리<strong>{device.battery}%</strong></span>
    <span>네트워크<strong>{device.rssi} dBm · {device.latency} ms</strong></span>
    <span>IP<strong>{device.ip}</strong></span>
    <span>펌웨어<strong>{device.firmware}</strong></span>
    <span>관절 온도<strong>{device.temperature} °C</strong></span>
    <span>하트비트<strong>{device.heartbeat}</strong></span>
  </div>;
}
