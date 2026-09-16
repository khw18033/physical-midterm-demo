/**
 * src/physical/PhysicalClient.ts (260910 신설 — 하드웨어 연동 §2)
 *
 * **가시화 코드가 로봇을 보는 유일한 면이다.** 이 파일 밖에서 MQTT 클라이언트를 만들거나
 * 토픽 문자열을 적지 않는다 (`verify:physical-port`). `SttClient` · `LlmClient` 와 같은
 * 패턴이고 같은 이유다 — 브로커가 프로세스든 워커든, 나중에 중앙 서버 경유로 바뀌든
 * 갈아끼우는 곳이 여기 하나가 되게 하기 위한 제약이다.
 *
 * **브로커가 꺼져 있어도 화면은 뜬다.** 로봇 명령만 꺼지고 대본 재생·되감기·캔버스는
 * 그대로 돈다 (`verify:no-physical`). 그래서 이 모듈은 실패를 **상태로 돌려주고**
 * 무엇을 비활성화할지는 화면이 정한다.
 *
 * ## 채널 (하드웨어가 실제로 쏴 보고 확인한 값)
 *
 *   브로커   ws://pi7.tailcb6bfb.ts.net:9001/mqtt (WebSocket) · MQTT 5 · 인증 없음
 *   발행     terminal/go1-001/downlink  QoS 1
 *   수신     terminal/go1-001/uplink    QoS 1
 *   페이로드 protobuf 바이너리 — JSON 문자열이 아니다
 *
 * 응답 세 종(Acceptance · CommandStatus · CommandResult)이 **모두 uplink 하나로** 온다.
 * 종류는 봉투의 `oneof body` 가 구분한다.
 */

import { connectionAddress, registerConnectionDefault } from '../shared/connections.ts';
import { encodeCommand, hardwareTarget, nextCommandId, type CommandInput, type PhysicalAction } from './encode.ts';
import { physical } from './protocol.js';
import { parseScanFeed, scanFeedChannel, type ScanFeedMessage } from './scanFeed.ts';
import { decodeUplink, type UplinkMessage } from './uplink.ts';

const meta = import.meta as unknown as { env?: { VITE_PHYSICAL_WS?: string } };

/**
 * 기본 주소. **환경변수는 기본값일 뿐이고** 화면의 「연결 관리」가 덮어쓸 수 있다
 * (260904 · `VZ-C-07`). 다만 주소를 아는 면은 여기 하나여야 하므로 환경변수는 이 파일에서만
 * 읽고 연결 저장소에는 기본값만 심는다 — `SttClient` 와 같은 규칙이다.
 */
/**
 * **기본값이 Tailscale 주소다** (260913 지시).
 *
 * 전에는 `ws://pi7.local:9001` 이었다 — mDNS 라 같은 랜에 있어야 풀린다. 노트북에서
 * 돌리거나 발표장 망이 바뀌면 이름이 안 풀려서 주소부터 고쳐야 했다. Tailscale 이름은
 * 망이 바뀌어도 같다.
 *
 * `pi7.local` 은 프리셋에 남겨 둔다(`presets.ts`) — 같은 랜에 있을 때는 그쪽이 한 홉 짧다.
 */
registerConnectionDefault('physical', 'ws', meta.env?.VITE_PHYSICAL_WS ?? 'ws://pi7.tailcb6bfb.ts.net:9001/mqtt');

/** 지금 쓰는 브로커 주소. 상수가 아니라 **읽을 때마다 지금 값**이다. */
export function physicalWsUrl(): string {
  return connectionAddress('physical', 'ws');
}

/** 토픽. 장비 id 가 토픽에 들어가므로 **이 파일 밖에 적지 않는다.** */
function topics(target: string) {
  return {
    downlink: `terminal/${target}/downlink`,
    uplink: `terminal/${target}/uplink`,
  };
}

/**
 * 장비 상태 토픽 (260910). **명령 응답과 다른 축이다** — 이쪽은 「장비가 지금 어떤가」다.
 *
 * 구역의 모든 장비를 받는다(`+`). 우리 로봇만 걸러 받으면 나중에 센서·수문이 붙을 때
 * 구독을 또 늘려야 하고, 그때 한쪽만 고쳐진다. 걸러 내는 것은 화면의 몫이다.
 */
const DEVICE_TOPICS = ['zoneA/+/+/status', 'zoneA/+/+/state', 'zoneA/+/+/heartbeat'];

/**
 * **로봇 → 탐지 흐름** (260914). 탐지가 받는 것과 같은 두 토픽을 화면도 듣는다
 * (`physical_demo/detection-protocol_0914.md` §1). 뜯는 것은 `scanFeed.ts` 다.
 *
 * 탐지 그림이 안 올 때 **로봇이 안 보냈는지 탐지가 못 받았는지** 가르려면 앞의 절반을 봐야
 * 한다. 실제로 그걸 못 갈라서 원인을 한참 찾았다. QoS 1 — 규약이 그렇게 보낸다.
 */
const SCAN_FEED_TOPICS = ['zoneA/+/+/frame', 'zoneA/+/+/scan'];

/**
 * `mqtt` 모듈에서 `connect` 를 꺼낸다. **두 모양을 다 받는다.**
 *
 * 260910 에 브라우저에서만 `mqtt.connect is not a function` 으로 안 붙었다. 원인은
 * 빌드가 둘이라는 것이다 — Node 는 CJS(`build/index.js`)를 interop 해서 네임스페이스에
 * `connect` 가 붙지만, 브라우저용 ESM(`dist/mqtt.esm.js`)은 **`export default` 하나뿐**이라
 * 네임스페이스에 `connect` 가 없다. 그래서 Node 에서 돌린 검사는 통과하는데 화면만 깨졌다.
 *
 * 어느 쪽이든 같은 함수를 꺼내고, 못 찾으면 **그 사실을 말한다** — 조용히 undefined 를
 * 부르면 「mqtt.connect is not a function」이라는 남의 말로 실패한다.
 */
async function mqttConnect(): Promise<(url: string, opts: Record<string, unknown>) => unknown> {
  const mod = await import('mqtt');
  return resolveConnect(mod);
}

/** 모듈 네임스페이스에서 `connect` 찾기. 검사가 두 모양을 다 넣어 본다. */
export function resolveConnect(mod: unknown): (url: string, opts: Record<string, unknown>) => unknown {
  const namespace = mod as { connect?: unknown; default?: { connect?: unknown } };
  const found = typeof namespace.connect === 'function' ? namespace.connect : namespace.default?.connect;
  if (typeof found !== 'function') {
    throw new Error('mqtt 모듈에서 connect 를 못 찾았습니다 — 빌드 모양이 바뀌었습니다');
  }
  return found as (url: string, opts: Record<string, unknown>) => unknown;
}

/** mqtt.js 클라이언트에서 우리가 쓰는 만큼. 라이브러리 타입을 끌어오지 않는다. */
type MqttLike = {
  on(event: string, handler: (...args: never[]) => void): void;
  subscribe(topic: string, opts: { qos: number }, done?: () => void): void;
  publish(topic: string, payload: Uint8Array, opts: { qos: number }): void;
  end(force?: boolean): void;
};

export type PhysicalStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; reason: string };

export type PhysicalListener = (message: UplinkMessage) => void;
/** 장비 상태 한 건. 토픽과 본문을 그대로 넘긴다 — 뜯는 것은 `deviceState.ts` 다. */
export type DeviceListener = (topic: string, body: Record<string, unknown>) => void;
/** 로봇 → 탐지 한 건. 뜯은 값만 넘긴다 — 그림은 여기서 버린다. */
export type ScanFeedListener = (message: ScanFeedMessage) => void;
export type StatusListener = (status: PhysicalStatus) => void;

/**
 * 브로커에 붙어 명령을 쏘고 uplink 를 흘려보낸다.
 *
 * **mqtt.js 를 동적으로 불러온다** — 붙지 않는 화면(단독 빌드·브로커 없는 개발)에서는
 * 그 덩치가 번들에 실릴 이유가 없다. `verify:standalone` 이 번들을 보는 저장소라
 * 정적 import 로 두면 로봇을 안 쓰는 빌드까지 무거워진다.
 */
export class PhysicalClient {
  private client: unknown = null;
  private status: PhysicalStatus = { state: 'idle' };
  private readonly listeners = new Set<PhysicalListener>();
  private readonly deviceListeners = new Set<DeviceListener>();
  private readonly scanFeedListeners = new Set<ScanFeedListener>();
  private readonly statusListeners = new Set<StatusListener>();
  /** 붙을 대상. 화면 id 를 받아 하드웨어 id 로 바꿔 둔다. */
  private readonly target: string;

  constructor(vizEntityId = 'robot-01') {
    this.target = hardwareTarget(vizEntityId);
  }

  getStatus(): PhysicalStatus {
    return this.status;
  }

  onMessage(listener: PhysicalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 장비 상태를 듣는다. 명령 응답과 **다른 귀**다 — 섞으면 어느 축인지 흐려진다. */
  onDevice(listener: DeviceListener): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
  }

  /** 로봇 → 탐지 흐름을 듣는다. 장비 상태와 **또 다른 귀**다 — 이쪽은 한 판의 재료다. */
  onScanFeed(listener: ScanFeedListener): () => void {
    this.scanFeedListeners.add(listener);
    return () => this.scanFeedListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: PhysicalStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  /**
   * 브로커에 붙는다. **실패해도 던지지 않는다** — 화면이 죽으면 안 된다.
   *
   * **열릴 때까지 기다린다.** 260910 에 핸들러만 걸고 곧바로 돌아왔더니 부르는 쪽이
   * `connecting` 을 읽고 「못 붙었다」로 적었다 — 실제로는 붙는 중이었다. MQTT 연결은
   * WebSocket 핸드셰이크 뒤에 CONNECT/CONNACK 왕복이 더 있어서 즉시 열리지 않는다.
   *
   * 시간 안에 아무 일도 없으면 닫힌 것으로 본다. 무한정 기다리면 「확인」 버튼이 영영
   * 돌아오지 않는다.
   */
  async connect(timeoutMs = 6000): Promise<PhysicalStatus> {
    if (this.status.state === 'open') return this.status;
    if (this.status.state === 'connecting') return this.status;
    this.setStatus({ state: 'connecting' });
    try {
      const client = (await mqttConnect())(physicalWsUrl(), { protocolVersion: 5, reconnectPeriod: 0 }) as MqttLike;
      this.client = client;
      const { uplink } = topics(this.target);

      // 처음 한 번만 결론을 낸다 — 뒤이어 오는 close 가 open 을 덮어쓰면 안 된다.
      let settle: ((status: PhysicalStatus) => void) | null = null;
      const settled = new Promise<PhysicalStatus>((resolve) => { settle = resolve; });
      const finish = (status: PhysicalStatus) => {
        this.setStatus(status);
        if (settle !== null) { settle(status); settle = null; }
      };
      const timer = setTimeout(
        () => finish({ state: 'closed', reason: `${timeoutMs}ms 안에 응답이 없습니다` }),
        timeoutMs,
      );

      client.on('connect', (() => {
        // **시한을 여기서 끄지 않는다.** 붙은 것만으로는 아직 결론이 아니다 — 구독이
        // 안 서면 받을 귀가 없고, 그때 시한마저 꺼 두면 영영 안 끝난다.
        // **구독이 서기 전에 「붙었다」고 하지 않는다** (260910 실측).
        //
        // 하드웨어 팀 클라이언트로 재 보니 **첫 명령만** 응답을 놓쳤다. 붙자마자 발행하면
        // SUBACK 이 오기 전에 로봇의 답이 지나가 버린다. 「붙었다고 말하면서 아무것도 못
        // 받는다」가 정확히 이 모양이고, 시연 직전 첫 연결 확인에서 나기 딱 좋다.
        client.subscribe(uplink, { qos: 1 }, () => {
          clearTimeout(timer);
          finish({ state: 'open' });
        });
        // 장비 상태는 QoS 0 — 주기 발행이라 한 건 놓쳐도 다음 것이 온다. 이건 안 기다린다.
        for (const topic of DEVICE_TOPICS) client.subscribe(topic, { qos: 0 });
        for (const topic of SCAN_FEED_TOPICS) client.subscribe(topic, { qos: 1 });
      }) as () => void);
      client.on('message', ((topic: string, payload: Uint8Array) => {
        // 장비 상태는 **JSON** 이고 명령 응답은 **protobuf** 다. 토픽으로 가른다 —
        // 한쪽 디코더에 남의 바이트를 넣으면 조용히 null 이 되고 원인을 못 찾는다.
        if (topic !== uplink) {
          let body: unknown;
          try { body = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
          if (typeof body !== 'object' || body === null) return;
          // 로봇 → 탐지 흐름은 장비 상태가 아니다 — 다른 귀로 보낸다.
          if (scanFeedChannel(topic) !== null) {
            const feed = parseScanFeed(topic, body as Record<string, unknown>);
            if (feed !== null) for (const listener of this.scanFeedListeners) listener(feed);
            return;
          }
          for (const listener of this.deviceListeners) listener(topic, body as Record<string, unknown>);
          return;
        }
        const message = decodeUplink(payload);
        // 형식에 안 맞으면 버린다 — 지어 채우지 않는다.
        if (message === null) return;
        for (const listener of this.listeners) listener(message);
      }) as never);
      client.on('error', ((error: Error) => {
        clearTimeout(timer);
        finish({ state: 'closed', reason: error.message });
      }) as never);
      // close 는 붙은 뒤에도 온다 — 그때는 결론이 아니라 상태 갱신이다.
      client.on('close', (() => {
        clearTimeout(timer);
        finish({ state: 'closed', reason: '연결이 닫혔습니다' });
      }) as () => void);

      return await settled;
    } catch (error) {
      // mqtt 를 못 불러오거나 주소가 틀렸다 — 로봇 명령만 꺼지고 화면은 그대로 돈다.
      this.setStatus({ state: 'closed', reason: error instanceof Error ? error.message : String(error) });
    }
    return this.status;
  }

  disconnect(): void {
    const client = this.client as { end?: (force?: boolean) => void } | null;
    client?.end?.(true);
    this.client = null;
    this.setStatus({ state: 'idle' });
  }

  /**
   * 명령 하나. **바이트로 바꾸는 것은 `encode.ts`, 쏘는 것은 여기.**
   * 붙어 있지 않으면 쏘지 않고 그 사실을 돌려준다 — 조용히 삼키지 않는다.
   */
  send(action: PhysicalAction, parameters?: Record<string, number>): { sent: boolean; commandId: string; reason?: string } {
    const commandId = nextCommandId();
    if (this.status.state !== 'open') {
      return { sent: false, commandId, reason: '브로커에 붙어 있지 않습니다 — ' + this.status.state };
    }
    const input: CommandInput = { commandId, action, parameters, target: this.target };
    const client = this.client as { publish?: (t: string, p: Uint8Array, o: unknown) => void } | null;
    client?.publish?.(topics(this.target).downlink, encodeCommand(input), { qos: 1 });
    return { sent: true, commandId };
  }
}

/** 스키마의 종료 상태. 화면이 숫자 대신 이름으로 읽게 내보낸다. */
export const TERMINAL_STATUS = physical.TerminalStatus;
