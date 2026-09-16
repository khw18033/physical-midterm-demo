/**
 * src/shared/connectionCheck.ts (260910 신설 — 연결 관리 통합 §2 · §3)
 *
 * **눌러서 실제로 왕복시키는 자리.** 대상마다 확인 방법이 다르고, 그 다름이 여기 한 곳에 있다.
 *
 * | 대상 | 확인 |
 * |---|---|
 * | `physical` | 브로커 연결 + `ping` 왕복 — **두 줄로 나눈다** |
 * | `detect` | `GET /health` — 2단계-B 에서 잇는다. 지금은 자리만 |
 * | `stt` | `SttClient.probe()` — 기존 |
 * | `generate` | `LlmClient.probe()` — 기존 |
 *
 * `stt`·`generate` 는 **기존 동작을 바꾸지 않는다**(§7). 이미 있는 `probe()` 를 부르기만 한다.
 */

import { probe as generateProbe } from '../generate/LlmClient.ts';
import { probe as sttProbe } from '../stt/SttClient.ts';
import type { ConnectionTargetId } from './connections.ts';
import { line, setChecking, setHealth, type HealthLine } from './connectionHealth.ts';
import { probeDetect, sourceOf } from '../detect/DetectClient.ts';
import { detectState } from '../detect/store.ts';

/**
 * `physical` 을 확인할 때 쓸 것. 로봇 경계를 이 파일이 직접 열지 않는다 —
 * 주소·토픽을 아는 면은 `src/physical/` 하나여야 한다(`verify:physical-port`).
 * 화면이 클라이언트를 넘긴다.
 */
export type PhysicalProbe = {
  connect(): Promise<{ state: string; reason?: string }>;
  getStatus(): { state: string; reason?: string };
  ping(): Promise<{ ok: boolean; roundTripMs: number | null; message: string }>;
};

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await run();
  return { value, ms: Date.now() - startedAt };
}

/**
 * **`physical` 은 줄이 셋이다** (260910 — 재 보고 하나 늘렸다).
 *
 * 처음에 둘로 나눴다: 브로커와 로봇. 그런데 로봇을 꺼 놓고 눌렀는데 「로봇 ✓」가 떴다.
 * 실제로 uplink 를 떠 보니 **답한 것은 라즈베리파이의 단말 에이전트**였다 —
 * `ping` 의 결과가 `{ uptime_s }` 이고 그건 단말의 가동 시간이다.
 *
 *   브로커  WebSocket 이 서 있는가        실패 → 주소·포트·망
 *   단말    ping 왕복이 도는가            실패 → 라즈베리파이 전원·에이전트
 *   로봇    **ping 으로는 못 본다**       → 「모른다」. 빨강도 초록도 아니다
 *
 * 로봇 줄을 초록으로 칠하면 「로봇이 살아 있다」는 거짓말이고, 빨갛게 칠하면 「로봇이
 * 죽었다」는 없는 사실이다. 둘 다 틀렸으므로 **모른다고 말한다.**
 *
 * 로봇을 증명하려면 로봇을 움직이는 명령을 보내야 하는데, 그건 연결 확인이 할 일이 아니다.
 * 단말이 로봇 상태를 실어 주면 그때 이 줄이 채워진다 — 하드웨어 쪽에 물어볼 것이다.
 */
/** 로봇 줄이 읽는 것. 장비 상태에서 온 값만 담는다 — 이 파일은 토픽을 모른다. */
export type RobotFacts = {
  online: boolean | null;
  link: string | null;
  health: string | null;
  batteryPct: number | null;
  stale: boolean;
  staleSec: number;
};

/**
 * 장비 상태를 **잠깐 기다린다.** 붙자마자 누르면 아직 한 건도 안 와 있는데, 그때 「모른다」로
 * 끝내면 발표 직전 점검에서 늘 한 번 더 눌러야 한다. 상태는 5초 주기라 그만큼만 기다린다.
 *
 * 기다려도 안 오면 그대로 「모른다」다 — 없는 것을 지어내지 않는다.
 */
async function waitForRobot(get: (() => RobotFacts | null) | null, timeoutMs = 6000): Promise<RobotFacts | null> {
  if (get === null) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const facts = get();
    if (facts !== null) return facts;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function checkPhysical(
  client: PhysicalProbe | null,
  robotSource: RobotFacts | (() => RobotFacts | null) | null = null,
): Promise<readonly HealthLine[]> {
  if (client === null) {
    return [line('broker', '브로커', false, { reason: '클라이언트가 없습니다' })];
  }
  const status = client.getStatus().state === 'open'
    ? client.getStatus()
    : (await timed(() => client.connect())).value;

  const broker = status.state === 'open'
    ? line('broker', '브로커', true)
    : line('broker', '브로커', false, { reason: status.reason ?? status.state });

  // 브로커가 안 붙었으면 아래 둘은 **확인할 수 없다** — 실패가 아니라 못 물어본 것이다.
  if (broker.ok !== true) {
    return [
      broker,
      line('agent', '단말', null, { reason: '브로커가 없어 물어보지 못했습니다' }),
      line('robot', '로봇', null, { reason: '브로커가 없어 물어보지 못했습니다' }),
    ];
  }

  const { value: ping, ms } = await timed(() => client.ping());
  const agent = ping.ok
    ? line('agent', '단말', true, { roundTripMs: ping.roundTripMs ?? ms })
    : line('agent', '단말', false, { reason: ping.message });

  // **붙은 뒤에 기다린다.** 붙기 전에 기다리면 구독이 없어 아무것도 안 오고, 그 시간만
  // 버린 채 「모른다」로 끝난다 — 실제로 그랬다.
  const robot = typeof robotSource === 'function' ? await waitForRobot(robotSource) : robotSource;
  return [broker, agent, robotLine(agent, robot)];
}

/**
 * 로봇 줄 — **`ping` 이 아니라 장비 상태가 채운다** (260910).
 *
 * `ping` 은 단말까지만 증명한다. 로봇 자신이 붙어 있는지는 `zoneA/.../status` 의 `link`
 * (로봇 ↔ 파이 내부 링크)가 말한다. 그 값이 안 왔으면 여전히 「모른다」다 —
 * 안 온 것을 초록으로도 빨강으로도 칠하지 않는다.
 */
function robotLine(agent: HealthLine, robot: RobotFacts | null): HealthLine {
  if (agent.ok !== true) return line('robot', '로봇', null, { reason: '단말이 답하지 않아 물어보지 못했습니다' });
  if (robot === null) return line('robot', '로봇', null, { reason: '장비 상태가 아직 안 왔습니다' });
  if (robot.stale) return line('robot', '로봇', null, { reason: `${robot.staleSec}초째 소식이 없습니다 — 마지막 값을 현재로 보지 않습니다` });
  if (robot.online === false) return line('robot', '로봇', false, { reason: '파이가 오프라인으로 봅니다' });
  if (robot.link !== null && robot.link !== 'ok') return line('robot', '로봇', false, { reason: `내부 링크 ${robot.link}` });
  if (robot.link === null) return line('robot', '로봇', null, { reason: '내부 링크 값이 안 왔습니다' });
  const extra = robot.batteryPct === null ? '' : ` · 배터리 ${robot.batteryPct}%`;
  return line('robot', '로봇', true, { reason: robot.health === 'ok' ? null : `${robot.health}${extra}` });
}

/**
 * `detect` — **자리만 만든다** (§7 「detect 의 실제 확인 로직 — 2단계-B에서 잇는다」).
 *
 * 여기서 `GET /health` 를 지금 부르면, 붙을 곳이 없는 주소에 매번 실패 로그가 쌓이고
 * 「빨간 줄」이 늘 하나 켜져 있게 된다. 그러면 발표 직전 점검에서 「넷 다 초록」이
 * 애초에 불가능해진다. **못 물어봤다고 말한다.**
 */
/**
 * 탐지 확인 (260912 — 자리만이던 것을 실제로 이었다).
 *
 * **「테스트」가 켜져 있으면 시료를 실제로 한 번 읽어 본다.** 「켰는데 파일이 없다」를
 * 그때 잡는다 — 무대에서 체크만 하고 아무것도 안 오면 원인을 못 찾는다.
 */
export async function checkDetect(): Promise<readonly HealthLine[]> {
  const source = sourceOf(detectState().testMode);
  if (source.kind === 'sample') {
    const { value, ms } = await timed(() => probeDetect(source));
    return [value.alive
      ? line('sample', '테스트 자료', true, { roundTripMs: ms, reason: value.reason })
      : line('sample', '테스트 자료', false, { reason: value.reason })];
  }
  if (source.base.trim() === '') {
    return [line('health', 'GET /health', null, { reason: '주소가 비어 있습니다 — 테스트로 먼저 볼 수 있습니다' })];
  }
  const { value, ms } = await timed(() => probeDetect(source));
  return [value.alive
    ? line('health', 'GET /health', true, { roundTripMs: ms })
    : line('health', 'GET /health', false, { reason: value.reason })];
}

export async function checkStt(): Promise<readonly HealthLine[]> {
  const { value, ms } = await timed(() => sttProbe());
  return [value.alive
    ? line('probe', '서비스', true, { roundTripMs: ms })
    : line('probe', '서비스', false, { reason: value.reason })];
}

export async function checkGenerate(): Promise<readonly HealthLine[]> {
  const { value, ms } = await timed(() => generateProbe());
  return [value.alive
    ? line('probe', '서비스', true, { roundTripMs: ms })
    : line('probe', '서비스', false, { reason: value.reason })];
}

/**
 * 대상 하나를 확인한다. **던지지 않는다** — 여기서 예외가 새면 팝업이 통째로 날아간다.
 * 예외도 결과이고, 그 사유가 화면에 남아야 한다.
 */
export async function checkTarget(
  target: ConnectionTargetId,
  physical: PhysicalProbe | null,
  robot: RobotFacts | (() => RobotFacts | null) | null = null,
): Promise<void> {
  setChecking(target, true);
  try {
    if (target === 'physical') setHealth(target, await checkPhysical(physical, robot));
    else if (target === 'detect') setHealth(target, await checkDetect());
    else if (target === 'stt') setHealth(target, await checkStt());
    else if (target === 'generate') setHealth(target, await checkGenerate());
    else setHealth(target, [line('none', '확인', false, { reason: '이 대상은 확인 방법이 없습니다' })]);
  } catch (error) {
    setHealth(target, [line('error', '확인', false, {
      reason: error instanceof Error ? error.message : String(error),
    })]);
  }
}
