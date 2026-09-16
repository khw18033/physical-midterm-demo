/**
 * src/physical/deviceState.ts (260910 신설 — 장비 상태 구독)
 *
 * **로봇이 스스로 말하는 상태.** 명령 응답(uplink)과 다른 축이다.
 *
 *   uplink        「내가 시킨 명령이 어떻게 됐나」  — terminal/<id>/uplink
 *   device state  「장비가 지금 어떤가」            — zoneA/<type>/<id>/{status,state,heartbeat}
 *
 * 8/31 결정(`VZ-D-07`)은 registry 장비의 실측값을 **지어내지 않는다**였다. 그건 값을 줄
 * 채널이 없었기 때문이고, 이제 있다. 지어내지 않고 **온 것만** 적는다 — 안 온 필드는
 * 여전히 `null` 이고 화면은 그것을 자리표시로 그린다.
 *
 * ## 세 층이 여기서 갈린다
 *
 *   status.status        online | offline   — 파이가 보는 장비의 생사. 끊기면 LWT 가 offline
 *   status.link          ok | …             — **로봇 ↔ 파이 내부 링크.** 로봇 자신의 생사
 *   status.device_status ok | degraded | fault
 *
 * `ping` 은 단말까지만 증명한다고 적어 둔 자리의 답이 `link` 다 — 이제 로봇 줄을 채울 수 있다.
 */

import { useSyncExternalStore } from 'react';

/** 우리가 읽는 만큼. 스키마 전체를 옮기지 않는다 — 안 쓰는 필드를 옮기면 낡는다. */
export type DeviceState = {
  /** 하드웨어의 장비 id (`go1-001`). 화면 id 로 바꾸는 것은 `encode.ts` 의 표가 한다. */
  entityId: string;
  entityType: string;
  /** 파이가 보는 생사. 끊기면 LWT 가 `offline` 을 대신 넣는다. */
  online: boolean | null;
  /** `ok` · `degraded` · `fault`. */
  health: string | null;
  /** **로봇 ↔ 파이 내부 링크.** 로봇 자신이 붙어 있는가. */
  link: string | null;
  mode: string | null;
  inMission: boolean | null;
  batteryPct: number | null;
  position: { x: number; y: number; headingDeg: number } | null;
  /**
   * **위치·방위를 받은 시각(ms)** (260914). `lastSeenMs` 와 다르다 — 그쪽은 heartbeat 에도
   * 밀린다. 「로봇의 지금 yaw」라고 말하려면 방위 자체가 언제 왔는지를 봐야 한다.
   */
  positionAtMs: number | null;
  speedMps: number | null;
  firmware: string | null;
  /** 마지막으로 무엇이든 받은 시각(ms). 신선도 판정에 쓴다. */
  lastSeenMs: number;
  /** 장비가 찍은 시각 문자열. 우리 시계가 아니라 저쪽 시계다. */
  timestamp: string | null;
  /** 목 장비인가 (`go1-sim`). 화면이 진짜와 섞지 않게 표시한다. */
  simulated: boolean;
  /**
   * **구동 브리지가 서 있는가** (연동 가이드 §4-3). 붙어 있다고 움직일 수 있는 것이 아니다 —
   * 브리지는 기동하는 순간 로봇을 일으켜 세우므로 평시에 내려가 있다.
   *
   * **`null` 은 「아직 모른다」이지 「꺼짐」이 아니다.** 가이드가 「회색으로 두고 꺼짐으로
   * 그리지 말 것」이라고 못박았다. 지금 돌고 있는 노드(schema 1.3)는 이 필드를 아예 안
   * 실어 보내므로 실제로 계속 null 이다.
   */
  sdkReady: boolean | null;
  /** 이동 명령이 왔을 때 브리지를 알아서 띄우는가. 꺼져 있으면 이동이 거절된다. */
  sdkAutostart: boolean | null;
};

/** 토픽 하나를 뜯는다. 우리 것이 아니면 null — 남의 토픽을 지어 해석하지 않는다. */
export function parseTopic(topic: string): { zone: string; entityType: string; entityId: string; channel: string } | null {
  const parts = topic.split('/');
  if (parts.length !== 4) return null;
  const [zone, entityType, entityId, channel] = parts;
  if (!zone || !entityType || !entityId) return null;
  if (channel !== 'status' && channel !== 'state' && channel !== 'heartbeat') return null;
  return { zone, entityType, entityId, channel };
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * 한 건을 기존 상태에 얹는다. **없는 필드는 안 지운다** — `state` 는 `link` 를 안 싣고
 * `heartbeat` 는 아무것도 안 싣는다. 매번 덮어쓰면 값이 깜빡인다.
 */
export function applyDeviceMessage(
  previous: DeviceState | undefined,
  parsed: { entityType: string; entityId: string; channel: string },
  body: Record<string, unknown>,
  nowMs = Date.now(),
): DeviceState {
  const next: DeviceState = previous ?? {
    entityId: parsed.entityId,
    entityType: parsed.entityType,
    online: null, health: null, link: null, mode: null, inMission: null,
    batteryPct: null, position: null, positionAtMs: null, speedMps: null, firmware: null,
    lastSeenMs: nowMs, timestamp: null, simulated: false,
    sdkReady: null, sdkAutostart: null,
  };
  const merged: DeviceState = { ...next, lastSeenMs: nowMs };
  merged.timestamp = str(body.timestamp) ?? merged.timestamp;
  if (body.simulated === true) merged.simulated = true;

  if (parsed.channel === 'status') {
    // 끊기면 LWT 가 offline 을 대신 넣는다 — 그 사실이 이 한 줄이다.
    if (typeof body.status === 'string') merged.online = body.status === 'online';
    merged.health = str(body.device_status) ?? merged.health;
    merged.link = str(body.link) ?? merged.link;
    merged.mode = str(body.robot_mode) ?? merged.mode;
    if (typeof body.in_mission === 'boolean') merged.inMission = body.in_mission;
    merged.batteryPct = num(body.battery_pct) ?? merged.batteryPct;
    const registration = body.registration as Record<string, unknown> | undefined;
    merged.firmware = str(registration?.fw_version) ?? merged.firmware;
    // 없으면 **안 건드린다** — 「안 실렸다」가 「꺼졌다」가 되면 안 된다.
    const sdk = body.sdk as Record<string, unknown> | undefined;
    if (sdk !== undefined) {
      if (typeof sdk.ready === 'boolean') merged.sdkReady = sdk.ready;
      if (typeof sdk.autostart === 'boolean') merged.sdkAutostart = sdk.autostart;
    }
  } else if (parsed.channel === 'state') {
    merged.batteryPct = num(body.battery_pct) ?? merged.batteryPct;
    merged.health = str(body.device_status) ?? merged.health;
    merged.mode = str(body.robot_mode) ?? merged.mode;
    merged.speedMps = num(body.speed_mps) ?? merged.speedMps;
    const position = body.position as Record<string, unknown> | undefined;
    if (position !== undefined) {
      const x = num(position.x);
      const y = num(position.y);
      const headingDeg = num(position.heading_deg);
      if (x !== null && y !== null) {
        merged.position = { x, y, headingDeg: headingDeg ?? 0 };
        merged.positionAtMs = nowMs;
      }
    }
  }
  // heartbeat 는 `lastSeenMs` 만 민다 — 살아 있다는 것 말고는 아무것도 안 말한다.
  return merged;
}

/** 이 값이 낡았는가. 상태는 5초 주기라 그 세 배를 넘으면 못 믿는다. */
export const STALE_AFTER_MS = 15_000;

export function isStale(device: DeviceState, nowMs = Date.now()): boolean {
  return nowMs - device.lastSeenMs > STALE_AFTER_MS;
}

// ── 열 ───────────────────────────────────────────────────────────────────────

let devices: Readonly<Record<string, DeviceState>> = {};
const listeners = new Set<() => void>();

export function deviceStates(): Readonly<Record<string, DeviceState>> {
  return devices;
}

export function deviceState(entityId: string): DeviceState | null {
  return devices[entityId] ?? null;
}

export function receiveDeviceMessage(topic: string, body: Record<string, unknown>): boolean {
  const parsed = parseTopic(topic);
  if (parsed === null) return false;
  devices = { ...devices, [parsed.entityId]: applyDeviceMessage(devices[parsed.entityId], parsed, body) };
  for (const listener of listeners) listener();
  return true;
}

export function subscribeDevices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDeviceStates(): Readonly<Record<string, DeviceState>> {
  return useSyncExternalStore(subscribeDevices, deviceStates, deviceStates);
}

export function resetDevices(): void {
  devices = {};
  for (const listener of listeners) listener();
}
