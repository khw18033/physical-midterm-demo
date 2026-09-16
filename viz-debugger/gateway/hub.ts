// 이식: web-dashboard/mock-gateway/hub.ts @ 700ed91 — registry.json 을 경로로 참조 · 임무 대상 등록 지점 추가
/**
 * mock-gateway/hub.ts
 *
 * 구독 매칭 · 마지막 값 캐시 · 상태 3층 조합을 담당하는 서버 코어.
 *
 * 여기서만 하는 일이 셋 있다.
 *  1. 구독을 **계약 축 {entity, node, channel}** 로 받아 와일드카드로 매칭한다 (VZ-I-01).
 *  2. 대상별 마지막 값을 캐시했다가 **구독 즉시 1회 푸시**한다 (VZ-I-02).
 *     이게 없으면 평시 1분 주기 센서는 최대 1분간 빈 화면이 된다.
 *     단 **캐시 대상은 채널마다 갈린다** (BE-T-06 / config.ts CACHE_POLICY) —
 *     전 채널을 캐시하면 재접속 때 화면이 거짓말을 한다.
 *  3. **stale 판정을 서버가 한다** (REQ-205). 클라이언트가 계산하면 사용자 PC 시계에 의존한다.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AGGREGATION, CACHE_POLICY, INTERVALS, THRESHOLDS, PLACEHOLDERS } from './config.ts';
import type {
  AggregationSpec,
  Channel,
  Envelope,
  Quality,
  ScopeSpec,
  Selector,
  StateLayers,
} from './protocol.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// **registry.json 을 복사하지 않는다.** web-dashboard 의 원본을 경로로 참조한다 —
// stt/vocab.py 가 같은 파일을 읽어 hotwords 를 만들기 때문에(REQ-305), 두 벌이 되면
// 화면의 장치 목록과 음성 인식 어휘가 조용히 갈라진다. 경로는 VIZ_REGISTRY 로 바꿀 수 있다.
const REGISTRY_DIR = process.env.VIZ_REGISTRY_DIR
  ?? join(HERE, '..', '..', 'web-dashboard', 'mock-gateway');

// ── 레지스트리 ───────────────────────────────────────────────────────────────

export type RegistryEntity = {
  id: string;
  node: string;
  zone: string | null;
  entity_type: string;
  display_name: string;
  aliases: string[];
  channels: string[];
  /**
   * 이 대상이 구현하는 **컴포넌트 디스크립터(F1) id**.
   * 디스크립터 스키마가 `id`를 "Zone/Node/Entity 레지스트리(F3)에서 참조되는 키"라고
   * 정의하므로, 그 참조를 레지스트리 쪽에 적는다. 파이프라인 sink의 `componentRef`가
   * 어느 실물 대상을 가리키는지를 이 값 하나로 풀 수 있다 (REQ-1007).
   */
  component?: string;
  note?: string;
};

export type Registry = {
  registry_version: string;
  zones: Array<{ id: string; display_name: string; aliases: string[]; nodes: string[] }>;
  nodes: Array<{ id: string; zone: string | null; display_name: string; aliases: string[]; origin: unknown }>;
  entities: RegistryEntity[];
};

export function loadRegistry(): Registry {
  return JSON.parse(readFileSync(join(REGISTRY_DIR, 'registry.json'), 'utf-8')) as Registry;
}

// ── 대상별 런타임 상태 ───────────────────────────────────────────────────────

export type EntityRuntime = {
  id: string;
  node: string;
  zone: string | null;
  entityType: string;
  /** 오케스트레이터 파생 (REQ-201). */
  deployment: 'deployed' | 'not_deployed';
  /** 기기 자기보고. */
  deviceStatus: 'ok' | 'fault' | 'unknown' | null;
  /** 서버가 마지막으로 이 대상의 메시지를 받은 시각(서버 시계, epoch ms). */
  lastSeenMs: number | null;
  /** LWT·시나리오로 주입된 연결 두절. availability 판정에서 최우선. */
  forcedOffline: boolean;
  /**
   * 대상 고유의 사유 메모(미배포 안내, fault 원인, LWT 감지 등).
   * availability에서 파생되는 문구는 여기 쓰지 않고 reasonFor()가 만든다.
   */
  note: string | null;
  /** 직전에 내려보낸 availability. **전이 감지는 sweepAvailability만 소유한다.** */
  lastAvailability: StateLayers['availability'];
  /** 한 번이라도 상태를 내보냈는가. 전이가 없는 대상(미배포)도 첫 발행은 해야 한다. */
  everPublished: boolean;
};

export type ClientConn = {
  id: string;
  send(msg: unknown): void;
  subs: Map<string, { selector: Selector; scope: ScopeSpec }>;
};

// ── Hub ──────────────────────────────────────────────────────────────────────

export class Hub {
  readonly registry: Registry;
  readonly runtime = new Map<string, EntityRuntime>();

  private readonly clients = new Set<ClientConn>();
  private readonly seq = new Map<string, number>();
  /**
   * 대상×채널별 마지막 봉투. 구독 즉시 푸시(VZ-I-02)의 재료.
   * **CACHE_POLICY가 허용한 채널만 들어온다** — 담기 전에 거르지 않으면
   * 나중에 꺼내는 쪽에서 거를 수밖에 없고, 그러면 경로가 둘로 갈린다.
   */
  private readonly cache = new Map<string, Envelope>();
  /** zone id → 그 zone에 속한 node id 집합. node 축의 계층 매칭에 쓴다. */
  private readonly zoneNodes = new Map<string, Set<string>>();
  /**
   * 발행 관찰자 (REQ-1007). 반영된 파이프라인이 **지금 무엇을 받고 있는지**를 알려면
   * 실제 발행 흐름에 붙어야 한다. 구독 팬아웃과 별개로 두는 이유는, 관찰이
   * 클라이언트 구독 유무와 무관하게 성립해야 하기 때문이다.
   */
  private readonly publishListeners = new Set<(env: Envelope) => void>();

  constructor(registry: Registry) {
    this.registry = registry;

    for (const z of registry.zones) this.zoneNodes.set(z.id, new Set(z.nodes));
    for (const n of registry.nodes) {
      if (n.zone) {
        if (!this.zoneNodes.has(n.zone)) this.zoneNodes.set(n.zone, new Set());
        this.zoneNodes.get(n.zone)!.add(n.id);
      }
    }

    for (const e of registry.entities) {
      this.runtime.set(e.id, {
        id: e.id,
        node: e.node,
        zone: e.zone,
        entityType: e.entity_type,
        deployment: 'deployed',
        deviceStatus: null,
        lastSeenMs: null,
        forcedOffline: false,
        note: null,
        lastAvailability: null,
        everPublished: false,
      });
    }
  }

  // ── 클라이언트 관리 ────────────────────────────────────────────────────────

  addClient(c: ClientConn): void {
    this.clients.add(c);
  }

  removeClient(c: ClientConn): void {
    this.clients.delete(c);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * 구독 등록 후 **즉시 현재값을 1회 푸시**한다 (VZ-I-02).
   * 반환값은 푸시한 스냅샷 건수.
   */
  subscribe(client: ClientConn, id: string, selector: Selector, scope: ScopeSpec): number {
    client.subs.set(id, { selector, scope });

    let count = 0;
    for (const env of this.cache.values()) {
      if (!this.matches(selector, env)) continue;
      // 캐시된 봉투의 scope는 발행 시점 값이므로, 이 구독이 요청한 scope로 덮어 보낸다.
      //
      // **ts는 건드리지 않는다** (BE-T-06 회신). 푸시 시점으로 다시 찍으면 stale 판정이
      // 리셋돼 1분 전 값이 방금 값으로 보이고, 직후 서버가 stale을 내리면
      // "방금 왔는데 판단 불가"라는 앞뒤 안 맞는 상태가 된다. 원래 발행 시각을 그대로
      // 주면 화면은 ts만 보고 정확히 그린다 — "캐시에서 왔음" 표시는 필요 없다.
      client.send({ type: 'data', sub: id, envelope: { ...env, scope } });
      count += 1;
    }
    return count;
  }

  unsubscribe(client: ClientConn, id: string): void {
    client.subs.delete(id);
  }

  // ── 매칭 ───────────────────────────────────────────────────────────────────

  /**
   * 계약 축 매칭. `*` 는 전부 허용.
   * node 축은 Node 식별자뿐 아니라 **Zone 식별자**도 받아 그 Zone의 모든 Node에 매칭한다
   * (`{ node: "zone-503", channel: "state" }` 형태의 구독을 성립시키기 위함).
   */
  private matches(sel: Selector, env: Envelope): boolean {
    if (sel.entity !== '*' && sel.entity !== env.entity) return false;
    if (sel.channel !== '*' && sel.channel !== env.channel) return false;
    if (sel.node !== '*' && sel.node !== env.node) {
      const nodes = this.zoneNodes.get(sel.node);
      if (!nodes || !nodes.has(env.node)) return false;
    }
    return true;
  }

  // ── 발행 ───────────────────────────────────────────────────────────────────

  /**
   * 봉투를 만들어 캐시하고 매칭되는 모든 구독에 팬아웃한다.
   * `fromDevice`가 false가 아니면 이 발행이 곧 생존 신호이므로 last_seen을 갱신한다.
   */
  publish(
    entity: string,
    channel: Channel,
    payload: unknown,
    opts: {
      quality?: Quality;
      aggregation?: AggregationSpec;
      fromDevice?: boolean;
      /**
       * BE-C-04 — 이 payload의 좌표가 어느 기준계인가.
       * 좌표를 담는 채널만 넘긴다. **변환은 백엔드가 이미 끝냈고** 여기서는 표기만 붙인다.
       */
      coordinateFrame?: string;
    } = {},
  ): void {
    const rt = this.runtime.get(entity);
    if (!rt) throw new Error('레지스트리에 없는 entity: ' + entity);

    const nowMs = Date.now();
    if (opts.fromDevice !== false) rt.lastSeenMs = nowMs;

    const key = entity + '|' + channel;
    const seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);

    const env: Envelope = {
      zone: rt.zone,
      node: rt.node,
      entity,
      channel,
      ts: new Date(nowMs).toISOString(),
      seq,
      payload,
      quality: opts.quality ?? 'good',
      // VZ-C-03 — 표기가 없으면 화면이 집약값을 다시 평균 내는 사고가 난다.
      // 기본값은 장치 원본(raw)이고, 이미 집약된 채널(지표)은 발행부가 표기를 넘긴다.
      aggregation: opts.aggregation ?? AGGREGATION.DEVICE_RAW,
      // VZ-I-11 — 발행 시점의 기본 범위. 구독별 요청 scope로 아래에서 덮어쓴다.
      scope: PLACEHOLDERS.DEFAULT_SCOPE,
      // BE-C-04 — 좌표를 담지 않는 채널은 null. 화면은 이 값을 **읽기만** 한다.
      coordinate_frame: opts.coordinateFrame ?? null,
    };

    // BE-T-06 — **채널 단위로 갈린다.** 금지 채널(command_result·video_frame·detections)을
    // 캐시하면 재접속 때 지난 명령 결과가 방금 온 것처럼, 옛 프레임이 현재 영상처럼,
    // 버퍼에 없는 프레임을 가리키는 박스가 엉뚱한 자리에 뜬다.
    if (CACHE_POLICY[channel].cache) this.cache.set(key, env);

    this.fanout(env);
    for (const listen of this.publishListeners) listen(env);
  }

  /** 발행 관찰 등록. 돌려주는 함수를 부르면 해제된다. */
  onPublish(listener: (env: Envelope) => void): () => void {
    this.publishListeners.add(listener);
    return () => {
      this.publishListeners.delete(listener);
    };
  }

  private fanout(env: Envelope): void {
    for (const client of this.clients) {
      for (const [subId, sub] of client.subs) {
        if (!this.matches(sub.selector, env)) continue;
        // 구독 요청에 실려 온 scope를 그대로 되돌려 준다 — 왕복이 살아 있어야 한다.
        client.send({ type: 'data', sub: subId, envelope: { ...env, scope: sub.scope } });
      }
    }
  }

  // ── 상태 3층 조합 (REQ-205) ────────────────────────────────────────────────

  /**
   * **stale 판정은 여기서만 한다.** 마지막 수신 시각과 **서버 시각**을 비교한다.
   * 클라이언트는 이 값을 받아 쓰기만 하고 스스로 계산하지 않는다.
   */
  computeAvailability(rt: EntityRuntime, nowMs: number): StateLayers['availability'] {
    if (rt.deployment !== 'deployed') return null;
    if (rt.forcedOffline) return 'offline';
    if (rt.lastSeenMs === null) return 'stale';
    return nowMs - rt.lastSeenMs > THRESHOLDS.STALE_MS ? 'stale' : 'online';
  }

  /**
   * 사유 문구는 **현재 상태에서 파생**시킨다.
   * 전이 순간에 한 번 써 넣는 방식이면, 그 전이를 다른 발행 경로가 먼저 가져갔을 때
   * 문구가 영영 비어 버린다. 파생이면 언제 발행되든 항상 맞는다.
   */
  private reasonFor(rt: EntityRuntime, availability: StateLayers['availability']): string | null {
    if (rt.deployment !== 'deployed') return rt.note;
    if (availability === 'offline') {
      return rt.note ?? '하트비트 ' + THRESHOLDS.HEARTBEAT_MISS_COUNT + '회 연속 미수신 — 연결 두절';
    }
    if (availability === 'stale') {
      const sec = Math.round(THRESHOLDS.STALE_MS / 1000);
      return '마지막 수신 이후 ' + sec + '초 경과 — 연결은 유지되나 값이 오래됨';
    }
    if (rt.deviceStatus === 'fault') return rt.note;
    return null;
  }

  buildStateLayers(rt: EntityRuntime, nowMs: number): StateLayers {
    const availability = this.computeAvailability(rt, nowMs);
    return {
      // 미배포 대상은 기기가 자기보고를 할 리 없으므로 device_status도 비운다.
      device_status: rt.deployment === 'deployed' ? rt.deviceStatus : null,
      availability,
      deployment: rt.deployment,
      last_seen: rt.lastSeenMs === null ? null : new Date(rt.lastSeenMs).toISOString(),
      stale_threshold_ms: THRESHOLDS.STALE_MS,
      reason: this.reasonFor(rt, availability),
    };
  }

  private qualityForState(layers: StateLayers): Quality {
    if (layers.availability === 'stale' || layers.availability === 'offline') return 'unknown';
    if (layers.device_status === 'fault') return 'degraded';
    return 'good';
  }

  /**
   * state 채널 발행. 장치 발행이 아니라 **서버 조합값**이므로 last_seen을 건드리지 않는다.
   * 전이 기록(lastAvailability)은 여기서 갱신하지 않는다 — 5초 정기 발행이 전이를 먼저
   * 가져가 버리면 sweepAvailability가 그 전이를 놓치고, 즉시 반영이 최대 5초 늦어진다.
   */
  publishState(entityId: string): void {
    const rt = this.runtime.get(entityId);
    if (!rt) return;
    const layers = this.buildStateLayers(rt, Date.now());
    rt.everPublished = true;
    this.publish(entityId, 'state', layers, {
      quality: this.qualityForState(layers),
      fromDevice: false,
    });
  }

  publishAllStates(): void {
    for (const id of this.runtime.keys()) this.publishState(id);
  }

  /**
   * availability 재판정 루프.
   * 발행이 끊긴 대상은 아무도 메시지를 보내지 않으므로, 서버가 스스로 훑어야
   * stale/offline 전이를 감지해 내려보낼 수 있다.
   * **전이가 감지되면 5초 정기 발행을 기다리지 않고 즉시 발행한다** (오프라인 감지는 즉시).
   */
  sweepAvailability(): void {
    const nowMs = Date.now();
    for (const rt of this.runtime.values()) {
      const next = this.computeAvailability(rt, nowMs);
      // 전이가 없어도 **첫 발행은 반드시 한다** — 미배포처럼 availability가 계속 null인
      // 대상은 전이가 영원히 일어나지 않으므로, 없으면 화면에 카드 근거가 안 간다.
      if (rt.everPublished && next === rt.lastAvailability) continue;
      rt.lastAvailability = next;
      this.publishState(rt.id);
    }
  }

  /**
   * 지금 캐시에 실제로 들어 있는 `entity|channel` 키 목록.
   * 정책과 실물이 어긋나는지는 **선언이 아니라 실물**을 봐야 알 수 있으므로,
   * /health와 cache-policy 시나리오가 이 값을 읽어 위반을 찾는다.
   */
  cachedKeys(): string[] {
    return [...this.cache.keys()].sort();
  }

  startLoops(): Array<ReturnType<typeof setInterval>> {
    return [
      setInterval(() => this.sweepAvailability(), INTERVALS.AVAILABILITY_SWEEP_MS),
      setInterval(() => this.publishAllStates(), INTERVALS.ZONE_STATE_REFRESH_MS),
    ];
  }
}
