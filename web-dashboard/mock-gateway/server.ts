/**
 * mock-gateway/server.ts
 *
 * 목 게이트웨이 진입점. **별도 프로세스**로 도는 WebSocket 서버다.
 *
 * 목 데이터를 브라우저 안에 두지 않는 이유: 진짜 백엔드 게이트웨이가 나왔을 때
 * **접속 주소만 바꿔** 붙일 수 있어야 하기 때문이다. 브라우저 안의 가짜 데이터는
 * 옮길 때 전부 버려지고, 그 사이 화면 코드가 "값이 항상 즉시 있다"는 가정에 물든다.
 *
 * 한 포트에서 둘을 서빙한다.
 *   - HTTP : GET /registry, /scenarios, /audit, /actions, /role, /metrics/query, /health
 *   - WS   : 구독 · 데이터 푸시 · 역할 조회 · 명령 · 계획 승인 중계 · 시나리오 트리거
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';

import {
  AGGREGATION,
  CACHE_POLICY,
  CACHEABLE_CHANNELS,
  INTERVALS,
  METRICS_QUERY,
  PLACEHOLDERS,
  ROLES,
  SCALE_ASSUMPTIONS,
  SCENARIO_TIMING,
  SERVER,
  THRESHOLDS,
} from './config.ts';
import { ackControl, commandLatency, roleState } from './controls.ts';
import { Hub, loadRegistry, type ClientConn } from './hub.ts';
import { createFleet } from './devices.ts';
import { CommandEngine, type PermissionVerdict } from './commands.ts';
import { PlanEngine } from './plans.ts';
import { VisionEmitter } from './vision.ts';
import { SCENARIOS, runScenario } from './scenarios.ts';
import { PipelineEditorEngine, validateGraph, type PipelineContract } from './pipeline-editor.ts';
import { deriveCatalog } from './pipeline-catalog.ts';
import type { NodeLayout } from '../shared/pipeline-contract.ts';
import type {
  ClientMessage,
  CommandRequest,
  MetricsQueryResult,
  RoleInfo,
  ScopeSpec,
  Selector,
} from './protocol.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = 'mock-gateway/0.3';

/** 감사 조회가 몇 번 들어왔는지. 주기 폴링이 없다는 것을 숫자로 확인하기 위한 계측값. */
let auditQueryCount = 0;

const hub = new Hub(loadRegistry());
const fleet = createFleet(hub);
const commands = new CommandEngine(hub);
const plans = new PlanEngine(hub);
const vision = new VisionEmitter(hub, 'camera-02');
// REQ-1007 — 허브를 넘겨 발행 흐름에 붙인다. 반영된 그래프의 실제 수신을 세기 위해서다.
const pipelineEditor = new PipelineEditorEngine(hub);

/** VZ-O-04 검증용 수신 실물. 실제 배치에서는 이 경로가 OTel Collector가 된다. */
const clientMetrics: unknown[] = [];
let currentRiskLevel: 'normal' | 'watch' | 'alert' | 'recovery' = 'normal';

function publishRisk(level: 'normal' | 'watch' | 'alert' | 'recovery'): void {
  currentRiskLevel = level;
  const now = new Date().toISOString();
  const values = {
    normal: { score: 18, reasons: [{ label: '수위', value: '1.2m · 안정', contribution: 0.42 }], recommendation: '정기 감시 유지' },
    watch: { score: 56, reasons: [{ label: '강우', value: '시간당 32mm', contribution: 0.58 }, { label: '수위 상승', value: '+0.18m/10분', contribution: 0.31 }], recommendation: '503 구역 센서와 배수 경로 확인' },
    alert: { score: 87, reasons: [{ label: '수위', value: '경보선 92%', contribution: 0.64 }, { label: '유입량', value: '평시 대비 2.3배', contribution: 0.27 }], recommendation: '수문 개방 계획 검토 후 승인' },
    recovery: { score: 41, reasons: [{ label: '수위', value: '정점 대비 -0.34m', contribution: 0.55 }], recommendation: '복구 추세 확인, 즉시 평시 전환 금지' },
  }[level];
  // zone 자체는 레지스트리 entity가 아니므로, 구역 판단을 담당하는 엣지 노드에 싣는다.
  hub.publish('edge-node-a', 'risk_state', { level, ...values, decided_at: now }, { fromDevice: false });
}

function publishAiFailure(): void {
  const now = new Date().toISOString();
  hub.publish('edge-node-a', 'ai_failure', {
    event_id: 'aif-' + Date.now(),
    component: 'edge-vision-tracker',
    model_version: 'tracker-2.4.1',
    input_ref: 'camera-02/frame-' + Math.floor(Date.now() / 1000),
    error_code: 'INFERENCE_TIMEOUT',
    detail: '추론 제한 500ms 초과 — 온디바이스 최소 안전 판단은 계속 동작',
    occurred_at: now,
  }, { fromDevice: false });
}

// ── 역할·권한 범위 (VZ-C-01 · VZ-C-04 / BE-Q-04) ──────────────────────────────
//
// **화면 차단은 사용자 편의이고 실제 강제는 백엔드다.** 그래서 이 값은 화면에 내려주는
// 동시에 명령 접수 경로에서도 검사된다 — 화면을 우회해 명령을 보내도 서버가 막는다.

function currentRole(): RoleInfo {
  const mock = ROLES[roleState.key] ?? ROLES.full;
  return {
    role: mock.role,
    display_name: mock.display_name,
    scope: { zones: [...mock.scope.zones] },
    issued_at: new Date().toISOString(),
    source: 'mock-gateway role API (BE-Q-04 대체 구현)',
  };
}

/** 이 대상이 현재 역할의 담당 범위 안인가. 기준 계층은 Zone(BE-C-02). */
function checkPermission(entity: string): PermissionVerdict {
  const role = currentRole();
  if (role.scope.zones.includes('*')) return { allowed: true, reason: null };

  const zone = hub.runtime.get(entity)?.zone ?? null;
  if (zone !== null && role.scope.zones.includes(zone)) return { allowed: true, reason: null };

  return {
    allowed: false,
    reason:
      '권한 범위 밖 — 현재 역할(' + role.display_name + ')의 담당 구역은 ' +
      role.scope.zones.join(', ') + ' 이고 이 대상은 ' + (zone ?? '구역 미지정') + ' 에 있다',
  };
}

commands.permissionCheck = checkPermission;

// 명령 시작·종료 시 액추에이터 발행 주기를 대기 1초 <-> 동작 중 100ms 로 전환한다.
commands.onActivityChange = (entity) => fleet.actuators.get(entity)?.rearm();
for (const actuator of fleet.actuators.values()) actuator.attach(commands);

hub.startLoops();

// 기동 시 계획 하나를 승인 대기로 올려 둔다 — 화면을 열자마자 승인 절차를 볼 수 있게.
plans.propose();
publishRisk('normal');
// risk_state는 BE-T-06 캐시 허용 목록 밖이다. 재접속한 화면도 현재 판정을 받도록
// 판정 주체가 5초마다 현재값을 다시 발행한다. 단계 변경은 위 함수 호출 즉시 별도 발행된다.
setInterval(() => publishRisk(currentRiskLevel), 5_000);

// ── HTTP ─────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

/**
 * VZ-I-04 / BE-Q-01 — 지표 질의 프록시. **두 갈래다.**
 *
 *  - 요약(summary) : 백엔드가 15초 페더레이션으로 이미 당겨 둔 구역 요약. 즉시 응답.
 *  - 원본(raw)     : raw는 엣지에 남아 있으므로 프록시가 사설망 엣지로 **중계**한다(BE-T-05).
 *                    의도적으로 느리다 — 화면이 "가져오는 중"을 그릴 이유가 여기서 생긴다.
 */
async function metricsQuery(params: URLSearchParams): Promise<MetricsQueryResult> {
  const entity = params.get('entity') ?? 'edge-node-a';
  const metric = params.get('metric') ?? 'cpu_pct';
  const mode = params.get('mode') === 'raw' ? 'raw' : 'summary';
  const rangeMin = Math.max(1, Math.min(360, Number(params.get('range_min') ?? 15)));
  const requestedAt = new Date().toISOString();

  const emitter = fleet.observability.get(entity) ?? null;
  const heavy = mode === 'raw' && rangeMin > METRICS_QUERY.HEAVY_RANGE_MIN;

  if (mode === 'summary') {
    const stepSec = INTERVALS.OBSERVABILITY_MS / 1000;
    const count = Math.min(METRICS_QUERY.MAX_POINTS, Math.floor((rangeMin * 60) / stepSec));
    const nowMs = Date.now();
    // 요약 시계열은 백엔드가 이미 당겨 둔 값이므로 저장소를 읽기만 한다.
    const source = emitter?.readRaw(metric, rangeMin, METRICS_QUERY.MAX_POINTS) ?? [];
    const points = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const t = nowMs - i * stepSec * 1000;
      const window = source.filter((s) => s.t > t - stepSec * 1000 && s.t <= t);
      const value =
        window.length > 0
          ? Math.round((window.reduce((a, s) => a + s.value, 0) / window.length) * 10) / 10
          : Math.round((24 + Math.random() * 8) * 10) / 10;
      points.push({ t: new Date(t).toISOString(), value });
    }
    return {
      query: { entity, metric, mode, range_min: rangeMin, requested_at: requestedAt },
      // 평시 조회는 구역 요약이다. 화면은 이 표기를 읽어 재집약을 막는다.
      aggregation: AGGREGATION.ZONE_SUMMARY,
      route: { via: '백엔드 질의 프록시 (BE-Q-01) — 페더레이션으로 이미 당겨 둔 구역 요약', relay_ms: 0 },
      heavy: false,
      heavy_reason: null,
      point_interval_sec: stepSec,
      points,
    };
  }

  // 원본 질의 — 엣지 중계. 실제로 기다리게 만든다.
  const relayMs =
    METRICS_QUERY.RAW_RELAY_MIN_MS +
    Math.round(Math.random() * (METRICS_QUERY.RAW_RELAY_MAX_MS - METRICS_QUERY.RAW_RELAY_MIN_MS)) +
    // 범위가 넓을수록 중계도 오래 걸린다. 무거운 질의라는 것이 체감돼야 안내가 의미를 갖는다.
    (heavy ? 400 : 0);
  await new Promise((resolve) => setTimeout(resolve, relayMs));

  const raw = emitter?.readRaw(metric, rangeMin, METRICS_QUERY.MAX_POINTS) ?? [];
  const truncated = raw.length >= METRICS_QUERY.MAX_POINTS;

  return {
    query: { entity, metric, mode, range_min: rangeMin, requested_at: requestedAt },
    aggregation: 'raw',
    route: {
      via: '백엔드 질의 프록시 (BE-Q-01) → 엣지 원본 저장소 중계 (BE-T-05)',
      relay_ms: relayMs,
    },
    heavy: heavy || truncated,
    heavy_reason: heavy
      ? '조회 범위 ' + rangeMin + '분 — 원본은 ' + METRICS_QUERY.RAW_POINT_INTERVAL_SEC +
        '초 간격이라 요약보다 점이 약 ' + Math.round(INTERVALS.OBSERVABILITY_MS / 1000 / METRICS_QUERY.RAW_POINT_INTERVAL_SEC) +
        '배 많고, 엣지 중계까지 거친다'
      : truncated
        ? '점 개수 상한 ' + METRICS_QUERY.MAX_POINTS + '개에서 잘렸다'
        : null,
    point_interval_sec: METRICS_QUERY.RAW_POINT_INTERVAL_SEC,
    points: raw.map((s) => ({ t: new Date(s.t).toISOString(), value: s.value })),
  };
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'));
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify(body, null, 2));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (url.pathname === '/observability/client-metrics' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const metric = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        clientMetrics.push(metric);
        if (clientMetrics.length > 20) clientMetrics.shift();
        log('가시화 자체 지표 수신 (VZ-O-04)');
        json(202, { accepted: true });
      } catch {
        json(400, { accepted: false, error: 'invalid json' });
      }
    });
    return;
  }

  if (url.pathname === '/pipelines/catalog' && req.method === 'GET') {
    // REQ-1003 — 매 요청마다 등록처를 다시 읽는다. 예시 파일을 하나 넣으면 코드를
    // 고치지 않고도 노드가 하나 늘어야 하고, 캐시하면 그 조건이 확인되지 않는다.
    const derived = deriveCatalog();
    json(200, {
      nodes: derived.nodes,
      port_types: derived.portTypes,
      registration_sources: derived.registrationSources,
      note: '목 등록처 — contracts/examples/ 아래 valid-*.json 에서 파생했다. 실물 레지스트리가 생기면 읽는 곳만 바뀐다.',
    });
    return;
  }
  if (url.pathname === '/pipelines/observation' && req.method === 'GET') {
    json(200, pipelineEditor.observations());
    return;
  }
  if (url.pathname === '/pipelines/state' && req.method === 'GET') {
    json(200, pipelineEditor.state());
    return;
  }
  if (url.pathname === '/pipelines/validate' && req.method === 'POST') {
    void readJsonBody(req).then((body) => json(200, { issues: validateGraph((body as { graph: PipelineContract }).graph) }), () => json(400, { error: 'invalid json' }));
    return;
  }
  if (url.pathname === '/pipelines/test' && req.method === 'POST') {
    void readJsonBody(req).then((body) => json(200, pipelineEditor.test((body as { graph: PipelineContract }).graph)), () => json(400, { error: 'invalid json' }));
    return;
  }
  if (url.pathname === '/pipelines/commit' && req.method === 'POST') {
    void readJsonBody(req).then((body) => {
      // 좌표는 계약과 나란히, 계약 **바깥**으로 온다 (REQ-1002).
      const input = body as { graph: PipelineContract; token: string; layout?: Record<string, NodeLayout> };
      const result = pipelineEditor.commit(input.graph, input.token, input.layout);
      log('파이프라인 반영 — ' + result.message);
      json(result.ok ? 200 : 409, result);
    }, () => json(400, { error: 'invalid json' }));
    return;
  }
  if (url.pathname === '/pipelines/rollback' && req.method === 'POST') {
    const result = pipelineEditor.rollback();
    log('파이프라인 되돌리기 — ' + result.message);
    json(result.ok ? 200 : 409, result);
    return;
  }

  if (url.pathname.startsWith('/insight/') && (req.method === 'POST' || req.method === 'GET')) {
    const name = decodeURIComponent(url.pathname.slice('/insight/'.length));
    if (name === 'ai-failure') publishAiFailure();
    else if (name === 'risk-normal' || name === 'risk-watch' || name === 'risk-alert' || name === 'risk-recovery') {
      publishRisk(name.slice('risk-'.length) as 'normal' | 'watch' | 'alert' | 'recovery');
    } else {
      json(404, { ok: false, error: 'unknown insight' });
      return;
    }
    json(200, { ok: true, name });
    return;
  }

  // VZ-I-03 / REQ-304·305 — 레지스트리는 정적 파일을 그대로 서빙한다.
  // 값을 발행하지 않는 미배포 대상(robot-03)도 여기에 반드시 있어야 화면이 그릴 수 있다.
  if (url.pathname === '/registry') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...CORS });
    res.end(readFileSync(join(HERE, 'registry.json'), 'utf-8'));
    return;
  }

  if (url.pathname === '/scenarios') {
    json(200, SCENARIOS.map((s) => ({ name: s.name, title: s.title, expect: s.expect })));
    return;
  }

  if (url.pathname.startsWith('/scenario/') && (req.method === 'POST' || req.method === 'GET')) {
    const name = decodeURIComponent(url.pathname.slice('/scenario/'.length));
    const result = runScenario(name, { hub, fleet, commands, plans, vision });
    log((result.ok ? '시나리오 재생' : '시나리오 실패') + ' — ' + name + ': ' + result.message);
    json(result.ok ? 200 : 404, result);
    return;
  }

  /**
   * VZ-I-05 — 감사 이력 조회.
   *
   * **command_id 조회가 1차 경로다** — 상관 키가 요청부터 감사까지 사슬을 잇는다는 것이
   * BE-X-01의 정의이므로, 화면도 그 키로 되짚어야 계약이 검증된다.
   * entity 조회는 "이 대상을 마지막으로 조작한 사람"을 묻는 보조 경로로 남긴다.
   *
   * **패널을 열 때만** 부르는 경로다. 감사는 확정된 과거 기록이라 폴링해도 새 값이 없고,
   * 진행 중인 명령의 변화는 command_result 푸시로 이미 도달한다.
   */
  if (url.pathname === '/audit') {
    const commandId = url.searchParams.get('command_id');
    const entity = url.searchParams.get('entity');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    auditQueryCount += 1;
    json(200, {
      records: commands.queryAudit({ commandId, entity }, Math.min(100, Math.max(1, limit))),
      /** 어느 키로 조회됐는지 되돌려 준다 — 화면이 "command_id로 조회했다"를 표시할 근거. */
      queried_by: commandId ? 'command_id' : entity ? 'entity' : 'all',
      queried_key: commandId ?? entity ?? null,
      // 주기 폴링이 없는지 검증할 때 쓰는 계측값. 실제 계약에는 없다.
      _query_count: auditQueryCount,
    });
    return;
  }

  /**
   * 액션 카탈로그. 화면이 액션 어휘를 하드코딩하지 않게 서버가 내려준다 —
   * 장비가 바뀌어도 화면을 고치지 않는다는 VZ-O-01의 전제가 여기서 성립한다.
   */
  if (url.pathname === '/actions') {
    const entity = url.searchParams.get('entity') ?? '';
    json(200, { entity, actions: commands.actionsFor(entity) });
    return;
  }

  /** VZ-C-01 · VZ-C-04 — 역할·범위 조회. WS의 role 메시지와 같은 값을 준다. */
  if (url.pathname === '/role') {
    json(200, currentRole());
    return;
  }

  /** VZ-I-04 / BE-Q-01 — 지표 질의 프록시. 요약과 원본이 서로 다른 경로다. */
  if (url.pathname === '/metrics/query') {
    void metricsQuery(url.searchParams).then(
      (result) => {
        log(
          '지표 질의 ' + result.query.metric + ' mode=' + result.query.mode +
          ' range=' + result.query.range_min + '분 → ' + result.points.length + '점' +
          ' (' + result.route.relay_ms + 'ms · ' + result.route.via + ')',
        );
        json(200, result);
      },
      (e: unknown) => json(500, { error: String(e) }),
    );
    return;
  }

  if (url.pathname === '/health') {
    json(200, {
      ok: true,
      server_time: new Date().toISOString(),
      protocol: PROTOCOL_VERSION,
      clients: hub.clientCount,
      entities: hub.runtime.size,
      audit_query_count: auditQueryCount,
      vision: { open: vision.isOpen, config: vision.describe() },
      stale_threshold_ms: THRESHOLDS.STALE_MS,
      scale_assumptions: SCALE_ASSUMPTIONS,
      role: currentRole(),
      ack_control: { ...ackControl },
      command_latency: { ...commandLatency },
      client_metrics: { received: clientMetrics.length, latest: clientMetrics.at(-1) ?? null },
      pipelines: pipelineEditor.state(),
      /**
       * BE-T-06 — 정책과 **실물**을 함께 낸다.
       * 선언만 보면 지켜지는지 알 수 없다. violations가 비어 있지 않으면 그 자체가 버그다.
       */
      cache: {
        policy: CACHE_POLICY,
        cacheable_channels: CACHEABLE_CHANNELS,
        cached_keys: hub.cachedKeys(),
        violations: hub.cachedKeys().filter((k) => {
          const channel = k.split('|')[1] as keyof typeof CACHE_POLICY;
          return CACHE_POLICY[channel]?.cache !== true;
        }),
      },
    });
    return;
  }

  json(404, {
    error: 'not found',
    paths: ['/registry', '/scenarios', '/scenario/:name', '/insight/:name', '/observability/client-metrics', '/pipelines/catalog', '/pipelines/state', '/pipelines/observation', '/pipelines/validate', '/pipelines/test', '/pipelines/commit', '/pipelines/rollback', '/audit', '/actions', '/role', '/metrics/query', '/health'],
  });
});

// ── WebSocket ────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: http });
let clientSeq = 0;

// 포트 충돌은 http에서 나지만 ws가 되받아 던지는 경우가 있어 양쪽에 건다.
wss.on('error', (err) => onStartupError(err as NodeJS.ErrnoException));
http.on('error', onStartupError);

function isSelector(v: unknown): v is Selector {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s.entity === 'string' && typeof s.node === 'string' && typeof s.channel === 'string';
}

/** VZ-I-11 — 현 단계는 'all' 고정이지만, 값을 **버리지 않고** 그대로 되돌려 준다. */
function normalizeScope(v: unknown): ScopeSpec {
  if (v === 'all') return 'all';
  if (typeof v === 'object' && v !== null) return v as ScopeSpec;
  return PLACEHOLDERS.DEFAULT_SCOPE;
}

wss.on('connection', (ws) => {
  clientSeq += 1;
  const conn: ClientConn = {
    id: 'c' + clientSeq,
    subs: new Map(),
    send(msg) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  hub.addClient(conn);
  log('접속 ' + conn.id + ' (총 ' + hub.clientCount + ')');

  /**
   * 이 접속이 열어 둔 영상 패널.
   *
   * 없으면 브라우저가 `video:false`를 못 보내고 끊길 때(탭 종료·새로고침·네트워크 단절)
   * 서버가 **아무도 안 보는 15fps를 영원히 발행한다.** 접속 0인데 프레임이 흐르는 상태는
   * VZ-I-06("열린 패널만 받는다")의 정반대다. 같은 이유로 같은 접속이 open을 두 번
   * 보내도 한 번만 센다 — 안 그러면 close에서 다시 못 닫는다.
   */
  const openVideos = new Set<string>();

  conn.send({
    type: 'hello',
    server_time: new Date().toISOString(),
    // 클라이언트는 이 값을 **표시에만** 쓴다. stale 판정 자체는 서버가 이미 끝냈다.
    stale_threshold_ms: THRESHOLDS.STALE_MS,
    protocol: PROTOCOL_VERSION,
  });

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      conn.send({ type: 'error', message: 'JSON 파싱 실패' });
      return;
    }

    switch (msg.type) {
      case 'subscribe': {
        if (!isSelector(msg.selector)) {
          conn.send({ type: 'error', message: '구독은 계약 축 {entity, node, channel}로 표현해야 한다' });
          return;
        }
        const scope = normalizeScope(msg.scope);
        // 구독 즉시 최신값 1회 푸시 (VZ-I-02) — 없으면 평시 센서는 최대 1분간 빈 화면이 된다.
        const snapshot = hub.subscribe(conn, msg.id, msg.selector, scope);
        conn.send({
          type: 'subscribed',
          id: msg.id,
          selector: msg.selector,
          scope,
          snapshot_count: snapshot,
        });
        log(
          '구독 ' + conn.id + '/' + msg.id + ' ' + JSON.stringify(msg.selector) +
          ' scope=' + JSON.stringify(scope) + ' → 스냅샷 ' + snapshot + '건',
        );
        return;
      }
      case 'unsubscribe':
        hub.unsubscribe(conn, msg.id);
        conn.send({ type: 'unsubscribed', id: msg.id });
        return;
      case 'command': {
        const cmd = msg.command as CommandRequest | undefined;
        if (!cmd || typeof cmd.client_request_id !== 'string' || typeof cmd.entity !== 'string') {
          conn.send({ type: 'error', message: '명령에는 client_request_id와 entity가 필요하다 (VZ-O-01)' });
          return;
        }

        // **명령은 여기서 끝난다.** 실제 디바이스로 나가는 경로는 만들지 않는다.
        // 상관 키(command_id)는 submit 안에서, 즉 **명령 조립 단계**에서 발급된다(BE-X-01).
        const outcome = commands.submit(cmd);

        // ACK — **두 키를 함께 내려주는 유일한 메시지.** 이게 도착해야 화면이
        // client_request_id로 걸어 둔 낙관적 UI를 command_id 사슬에 이어 붙인다.
        const ack = {
          type: 'command_ack' as const,
          client_request_id: outcome.clientRequestId,
          command_id: outcome.commandId,
          accepted: outcome.accepted,
          reason_code: outcome.reasonCode,
          message: outcome.message,
        };

        if (ackControl.dropNext) {
          ackControl.dropNext = false;
          log(
            '명령 ' + cmd.entity + '/' + cmd.action + ' (' + outcome.commandId + ') → ' + outcome.message +
            ' · **ACK 미발신(주입)** — 화면은 client_request_id만으로 만료 정리해야 한다',
          );
        } else if (ackControl.delayNextMs > 0) {
          const delay = ackControl.delayNextMs;
          ackControl.delayNextMs = 0;
          setTimeout(() => conn.send(ack), delay);
          log(
            '명령 ' + cmd.entity + '/' + cmd.action + ' (' + outcome.commandId + ') → ' + outcome.message +
            ' · **ACK ' + delay + 'ms 지연 발신(주입)** — 진행 이벤트가 매핑보다 먼저 도착한다',
          );
        } else if (commandLatency.oneWayMs > 0) {
          // 주입된 왕복 지연. ACK는 게이트웨이 회신이라 **한 방향**만 겪고,
          // 말단 응답(stage=ack)은 commands.ts에서 두 방향을 겪는다.
          setTimeout(() => conn.send(ack), commandLatency.oneWayMs);
          log(
            '명령 ' + cmd.entity + '/' + cmd.action + ' (' + outcome.commandId + ') → ' + outcome.message +
            ' · 왕복 지연 주입 한 방향 ' + commandLatency.oneWayMs + 'ms (말단 응답은 ' +
            commandLatency.oneWayMs * 2 + 'ms)',
          );
        } else {
          conn.send(ack);
          log('명령 ' + cmd.entity + '/' + cmd.action + ' (' + outcome.commandId + ') → ' + outcome.message);
        }
        return;
      }
      case 'plan_decision': {
        // VZ-U-07 / BE-X-04 — **승인 왕복의 중계자는 백엔드다.**
        // 가시화는 AI와 직접 주고받지 않는다. 승인도 거부도 이 채널로 들어와,
        // 승인된 계획만 백엔드가 엣지·로봇으로 발행한다.
        const outcome = plans.decide(msg.plan_id, msg.decision, msg.reason);
        conn.send({
          type: 'plan_decision',
          plan_id: msg.plan_id,
          accepted: outcome.ok,
          message: outcome.message,
          relayed_by: outcome.relayedBy,
        });
        log('계획 ' + msg.plan_id + ' ' + msg.decision + ' → ' + outcome.message + ' [' + outcome.relayedBy + ']');
        return;
      }
      case 'video': {
        // VZ-I-06 — **열린 패널만** 프레임을 받는다.
        // 전 카메라 상시 재생은 무선 대역폭과 브라우저 디코딩을 동시에 낭비한다.
        // 같은 접속의 중복 요청은 무시한다 — 열림 수를 접속별로 정확히 세야 닫을 수 있다.
        const changed = msg.open ? !openVideos.has(msg.entity) : openVideos.delete(msg.entity);
        if (msg.open && changed) openVideos.add(msg.entity);
        if (changed) vision.setOpen(msg.open);
        log(
          '영상 패널 ' + msg.entity + ' ' + (msg.open ? '열림' : '닫힘') +
          (changed ? '' : ' (중복 요청 무시)') + ' · ' + vision.describe(),
        );
        return;
      }
      case 'role': {
        // VZ-C-04 / BE-Q-04 — 역할과 **그 역할이 적용되는 범위**를 함께 내려준다.
        // 로그인 시 1회 + 토큰 갱신 시 재조회이므로 주기 발행이 아니다.
        const role = currentRole();
        conn.send({ type: 'role', ...role });
        log('역할 조회 ' + conn.id + ' → ' + role.display_name + ' scope=' + JSON.stringify(role.scope));
        return;
      }
      case 'scenario': {
        const result = runScenario(msg.name, { hub, fleet, commands, plans, vision });
        conn.send({ type: 'scenario', name: msg.name, accepted: result.ok, message: result.message });
        log('시나리오 ' + msg.name + ': ' + result.message);
        return;
      }
      case 'ping':
        conn.send({ type: 'pong', t: msg.t, server_time: new Date().toISOString() });
        return;
      default:
        conn.send({ type: 'error', message: '알 수 없는 메시지 타입' });
    }
  });

  ws.on('close', () => {
    hub.removeClient(conn);
    // **열려 있던 패널을 여기서 닫는다.** 브라우저는 탭이 닫힐 때 video:false를 보낼
    // 기회가 없다. 이걸 빼면 접속이 0인데도 서버가 계속 프레임을 만든다.
    const leaked = openVideos.size;
    for (let i = 0; i < leaked; i += 1) vision.setOpen(false);
    openVideos.clear();
    log(
      '종료 ' + conn.id + ' (총 ' + hub.clientCount + ')' +
      (leaked > 0 ? ' · 열린 영상 패널 ' + leaked + '개 회수 → ' + (vision.isOpen ? '아직 열림' : '발행 중지') : ''),
    );
  });
});

function log(line: string): void {
  process.stdout.write('[mock-gateway] ' + new Date().toISOString() + ' ' + line + '\n');
}

/**
 * 기동 실패 안내.
 *
 * 가장 흔한 실패는 **이전 목 게이트웨이가 안 죽고 남아 있는 것**이다(터미널을 Ctrl+C 없이
 * 닫았거나, 검증 스크립트가 띄운 프로세스가 남은 경우). 생 스택 트레이스만 뜨면 원인을
 * 짐작할 수 없으므로 무엇을 하면 되는지까지 적는다.
 *
 * http와 wss 양쪽에 건다 — 같은 포트 오류가 어느 쪽에서 터질지는 ws 구현에 달려 있고,
 * 한쪽만 걸어 두면 나머지 한쪽이 처리되지 않은 예외로 그대로 튀어나온다.
 */
function onStartupError(err: NodeJS.ErrnoException): void {
  if (err.code === 'EADDRINUSE') {
    log('기동 실패 — 포트 ' + SERVER.PORT + ' 이 이미 사용 중이다.');
    log('  이전 목 게이트웨이가 살아 있을 가능성이 높다. 둘 중 하나로 해결한다:');
    log('  1) 남은 프로세스 종료 — PowerShell:');
    log('     Get-NetTCPConnection -LocalPort ' + SERVER.PORT + ' -State Listen |');
    log('       ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
    log('  2) 다른 포트로 기동 — MOCK_PORT=8788 npm run dev:mock');
    log('     (이때 .env.local 의 VITE_GATEWAY_WS / VITE_GATEWAY_HTTP 도 같이 바꾼다)');
  } else {
    log('기동 실패 — ' + err.message);
  }
  process.exit(1);
}

http.listen(SERVER.PORT, SERVER.HOST, () => {
  const base = 'http://' + SERVER.HOST + ':' + SERVER.PORT;
  log('기동 — WS ws://' + SERVER.HOST + ':' + SERVER.PORT + ' / 레지스트리 ' + base + '/registry');
  log(
    '규모 가정(VZ-C-05) 구역 ' + SCALE_ASSUMPTIONS.ZONE_COUNT +
    ' · 장치 상한 ' + SCALE_ASSUMPTIONS.MAX_ENTITIES +
    ' · 동시 사용자 ' + SCALE_ASSUMPTIONS.CONCURRENT_OPERATORS +
    ' / 등록 대상 ' + hub.runtime.size + '개',
  );
  log(
    'stale 임계 ' + THRESHOLDS.STALE_MS + 'ms · 재판정 ' + INTERVALS.AVAILABILITY_SWEEP_MS +
    'ms · 상태 정기 발행 ' + INTERVALS.ZONE_STATE_REFRESH_MS + 'ms',
  );
  log(
    '상관키(BE-X-01) 발급 주체 = 백엔드(이 서버). 가시화는 client_request_id만 붙여 보내고 ' +
    'ACK로 두 키를 함께 받는다. ACK 지연 주입 ' + SCENARIO_TIMING.ACK_LATE_MS + 'ms.',
  );
  log(
    '역할(BE-Q-04) ' + currentRole().display_name + ' scope=' + JSON.stringify(currentRole().scope) +
    ' — 범위 밖 명령은 화면이 막지 못해도 서버가 out_of_scope로 거부한다',
  );
  log(
    '캐시 범위(BE-T-06) ' + CACHEABLE_CHANNELS.length + '개 채널만 구독 즉시 푸시 — ' +
    CACHEABLE_CHANNELS.join(', ') + '. command_result·video_frame·detections는 캐시하지 않는다',
  );
  log('시나리오: ' + SCENARIOS.map((s) => s.name).join(', '));
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('종료 신호 수신 — 정리 중');
    fleet.stopAll();
    wss.close();
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500);
  });
}
