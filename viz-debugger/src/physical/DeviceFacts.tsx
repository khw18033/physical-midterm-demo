/**
 * src/physical/DeviceFacts.tsx (260910 신설 — 오는 값만 적는다)
 *
 * 장비 하나의 **실제로 도착한 값**. 안 오는 칸은 자리표시로 채우지 않고 **아예 안 그린다** —
 * 「연결 예정」이 시연 화면에서 연결 전 테스트처럼 보인다는 지적이 있었다.
 *
 * ## 링크가 끊기면 값이 멈춘 채로 계속 온다 (연동 가이드 §3-3)
 *
 * 알려진 문제다 — 로봇 링크가 끊겨도 마지막 배터리·위치가 계속 발행된다. 그대로 그리면
 * **멈춘 값을 살아 있는 값으로 보여 준다.** `link` 가 `ok` 가 아니면 「마지막 수신」을 붙인다.
 *
 * 배터리의 `null` 은 **모른다**는 뜻이고 `0%` 로 그리면 안 된다 — 방전 직전과 구별되지 않는다.
 */

import { hardwareTarget } from './encode.ts';
import { isStale, useDeviceStates } from './deviceState.ts';

export function DeviceFacts({ entityId }: { entityId: string }) {
  const devices = useDeviceStates();
  const device = devices[hardwareTarget(entityId)] ?? null;

  if (device === null) {
    return <p className="device-facts device-facts--none">아직 이 장비의 상태가 오지 않았습니다.</p>;
  }
  const stale = isStale(device);
  // 링크가 성하지 않거나 값이 낡았으면 **마지막 수신**이다 — 현재가 아니다.
  const held = stale || (device.link !== null && device.link !== 'ok');
  const rows: Array<[string, string]> = [];

  if (device.online !== null) rows.push(['연결', device.online ? '온라인' : '오프라인']);
  if (device.link !== null) rows.push(['로봇 링크', device.link]);
  if (device.health !== null) rows.push(['상태', device.health]);
  if (device.mode !== null) rows.push(['모드', device.mode]);
  // **null 은 「모른다」다** — 회색으로 두고 꺼짐으로 그리지 않는다 (연동 가이드 §4-3).
  rows.push(['구동 브리지', sdkWords(device.sdkReady, device.sdkAutostart)]);
  if (device.inMission !== null) rows.push(['임무 중', device.inMission ? '예' : '아니오']);
  // null 은 「모른다」다 — 0% 로 그리지 않는다.
  if (device.batteryPct !== null) {
    rows.push(['배터리', held ? `${device.batteryPct}% (마지막 수신)` : `${device.batteryPct}%`]);
  }
  if (device.position !== null) {
    rows.push(['위치', `x ${device.position.x.toFixed(2)} · y ${device.position.y.toFixed(2)} · ${device.position.headingDeg}°${held ? ' (마지막 수신)' : ''}`]);
  }
  if (device.speedMps !== null) rows.push(['속도', `${device.speedMps} m/s`]);
  if (device.firmware !== null) rows.push(['펌웨어', device.firmware]);
  if (device.simulated) rows.push(['종류', '모의 장비']);
  rows.push(['마지막 수신', `${Math.round((Date.now() - device.lastSeenMs) / 1000)}초 전${device.timestamp === null ? '' : ` · ${device.timestamp}`}`]);

  return <dl className="device-facts">
    {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

/**
 * 구동 브리지의 상태를 한 줄로. **`null` 을 「꺼짐」으로 그리지 않는다** (연동 가이드 §4-3).
 *
 * 지금 돌고 있는 노드(schema 1.3)는 이 필드를 아예 안 실어 보낸다. 그래서 실제로 계속
 * 「모름」이고, 그것이 사실이다 — 「내려감」이라고 적으면 거짓을 그리는 것이다.
 */
export function sdkWords(ready: boolean | null, autostart: boolean | null): string {
  const state = ready === null ? '모름 (상태를 안 보내옵니다)' : ready ? '서 있음' : '내려감';
  if (autostart === null) return state;
  return `${state} · 자동 기동 ${autostart ? '켜짐' : '꺼짐'}`;
}

/**
 * 로봇 패널의 한 칸짜리 표시. 브리지가 서 있는지를 **버튼 옆에** 둔다 — 눌러야 할지
 * 말지를 그 자리에서 알아야 한다.
 */
export function SdkState({ entityId }: { entityId: string }) {
  const devices = useDeviceStates();
  const device = devices[hardwareTarget(entityId)] ?? null;
  const ready = device?.sdkReady ?? null;
  return <em
    className={`robot-sdk-dot robot-sdk-dot--${ready === null ? 'unknown' : ready ? 'ok' : 'down'}`}
    title="구동 브리지(go1-sdk). 평시에는 내려가 있습니다 — 기동하면 로봇이 일어섭니다"
  >{sdkWords(ready, device?.sdkAutostart ?? null)}</em>;
}
