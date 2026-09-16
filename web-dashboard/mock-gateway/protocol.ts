/**
 * mock-gateway/protocol.ts
 *
 * 목 게이트웨이가 말하는 **와이어 계약**. 프런트엔드의 src/transport/types.ts 와 짝을 이룬다.
 * 두 파일이 의도적으로 중복되어 있는 이유: 프로세스 경계를 넘는 계약이므로 한쪽의
 * 타입을 import 하면 "서버를 갈아끼우면 프런트가 깨진다"는 결합이 생긴다.
 * 진짜 백엔드 게이트웨이가 나오면 이 파일은 버려지고 src/transport/types.ts 만 남는다.
 */

/** 구독은 전송 프로토콜의 토픽 문자열이 아니라 **계약 축**으로 표현한다 (VZ-I-01 / REQ-704). */
export type Selector = {
  /** Entity 식별자 또는 '*'. */
  entity: string;
  /**
   * Node 식별자 또는 '*'.
   * 편의상 Zone 식별자도 받는다 — 레지스트리로 해석해 그 Zone에 속한 모든 Node에 매칭한다.
   * (`{ node: "zone-503", channel: "state" }` 같은 구독이 성립하게 하기 위함)
   * ※ 미결: 정식 계약이 zone 축을 따로 둘지, node 축의 계층 매칭으로 둘지 결정 필요.
   */
  node: string;
  /** 채널 이름 또는 '*'. */
  channel: string;
};

export type Channel =
  | 'state'
  | 'telemetry'
  | 'heartbeat'
  | 'video_meta'
  | 'actuator_state'
  | 'command_result'
  | 'control_lock'
  | 'plan'
  | 'plan_progress'
  | 'video_frame'
  | 'detections'
  | 'metrics'
  | 'risk_state'
  | 'ai_failure';

export type RiskState = {
  level: 'normal' | 'watch' | 'alert' | 'recovery';
  score: number;
  reasons: Array<{ label: string; value: string; contribution: number }>;
  recommendation: string;
  decided_at: string;
};

export type AiFailure = {
  event_id: string;
  component: string;
  model_version: string;
  input_ref: string;
  error_code: string;
  detail: string;
  occurred_at: string;
};

/**
 * VZ-I-11 — 구독 범위(관심 영역) 한정. **현 단계 'all' 고정.**
 * 화면 병합은 그리는 부하만 줄이고 받는 양은 그대로이므로, 대상이 늘면 구독에서 좁혀야 한다.
 * 지금 자리를 남기는 비용은 필드 하나지만, 나중에 구독 프로토콜을 바꾸는 비용은
 * 게이트웨이와 전 화면에 전파된다.
 */
export type ScopeSpec = 'all' | { zones?: string[]; nodes?: string[] };

/**
 * VZ-C-03 — 집약 계층 경계 표기. **자리 확보가 아니라 실사용이다.**
 *
 * BE-S-03이 정한 구조상 **평시에 백엔드로 올라오는 것은 구역 요약뿐**이고 raw는 엣지에 남는다.
 * 따라서 화면이 평시에 받는 지표는 이미 집약된 값이며, BE-S-06에 따라 값마다
 * 원본/집약 여부와 집약 계층이 표기되어 온다. 표기를 읽지 않으면 화면이 요약값을
 * 다시 평균 내는 **재집약 오류**가 발생하고, 그 오류는 화면상으로 드러나지 않는다.
 *
 * 원본 측정은 문자열 raw 축약형으로, 집약값은 계층을 담은 객체형으로 내려간다.
 * ※ 미결: 정식 계약이 축약형/객체형 중 무엇을 쓸지 결정 필요. 수신 측은 둘 다 받아 정규화한다.
 */
export type AggregationSpec =
  | 'raw'
  | {
      kind: 'raw' | 'aggregated';
      /** 어느 계층에서 집약되었는가. 평시 지표는 구역(zone) 요약이다. */
      level?: 'device' | 'edge' | 'zone' | 'server';
      method?: 'mean' | 'sum' | 'max' | 'min' | 'count' | 'rate';
      /** 집약 창 크기(초). 평시 요약은 페더레이션 주기와 같은 15초. */
      window_sec?: number;
    };

/**
 * 표본 자체의 품질 — "이 값을 지금 값으로 믿어도 되는가".
 * - `good`     : 현재값으로 신뢰 가능
 * - `degraded` : 값은 있으나 원천이 스스로 이상을 보고함 (device_status = fault 등)
 * - `unknown`  : 서버가 현재값임을 확인할 수 없음 (availability = stale / offline)
 *
 * availability(상태 3층)와 값이 겹쳐 보이지만 층이 다르다 — availability는 **대상**의 상태이고
 * quality는 **이 봉투 한 건**의 신뢰도다. 집약값이 섞이기 시작하면 둘은 갈라진다.
 * ※ 미결: quality의 정식 enum이 계약에 없다. 위 세 값은 이번 구현의 잠정 정의.
 */
export type Quality = 'good' | 'degraded' | 'unknown';

/** 서버 → 클라이언트 메시지 봉투. 필드 구성은 고정이다. */
export type Envelope = {
  /** Zone은 선택 계층이다(REQ-301). 지정되지 않으면 null. */
  zone: string | null;
  node: string;
  entity: string;
  channel: Channel;
  /** **서버 시각** ISO-8601. 클라이언트 시계를 신뢰하지 않는다. */
  ts: string;
  /** 대상별 단조 증가 시퀀스. 유실·역전 감지용. */
  seq: number;
  payload: unknown;
  quality: Quality;
  aggregation: AggregationSpec;
  /** 이 봉투가 어느 구독 범위 요청에 대한 응답인지 되돌려 준다(VZ-I-11 왕복 확인). */
  scope: ScopeSpec;
  /**
   * BE-C-04 — 좌표를 담은 payload의 기준 좌표계. 좌표를 담지 않는 채널은 null.
   * **변환은 백엔드 단독 책임이다.** 가시화는 이 표기를 읽어 표시만 하고 변환하지 않는다.
   */
  coordinate_frame: string | null;
};

/** 상태 3층 원본 (REQ-205). 단일 값으로 뭉치지 않는다. */
export type StateLayers = {
  /** 기기 자기보고. */
  device_status: 'ok' | 'fault' | 'unknown' | null;
  /** 서버 판정. **stale 판정은 서버가 last_seen과 서버 시각으로 수행한다.** */
  availability: 'online' | 'offline' | 'stale' | null;
  /** 오케스트레이터 파생 (REQ-201). */
  deployment: 'deployed' | 'not_deployed';
  /**
   * 마지막 수신 시각(서버 시각 기준 ISO-8601). 발행한 적이 없으면 null.
   * 화면의 "최근 수신 N초 전"은 `envelope.ts - last_seen` 으로 구한다 —
   * **둘 다 서버 시각이므로 클라이언트 시계가 개입하지 않는다.**
   */
  last_seen: string | null;
  /** 화면이 "임계 60초" 같은 문구를 그릴 수 있도록 판정에 쓴 임계를 함께 내려 준다. */
  stale_threshold_ms: number;
  /** 상태 변화의 사람이 읽는 사유. 없으면 null. */
  reason: string | null;
};

/** 액추에이터 도메인 어휘 (VZ-U-01). 표준 3층과 별개로 다룬다. */
export type ActuatorState = {
  /** 대기 / 동작 중 / 완료 / 오류 / 확인 불가 */
  phase: 'idle' | 'moving' | 'completed' | 'error' | 'unverified';
  /** 0~100. phase가 moving일 때만 의미 있음. */
  progress_pct: number | null;
  /** 개도율 등 현재 물리량. */
  position_pct: number | null;
  /** 제어 잠금 여부와 사유 (VZ-O-05). */
  control_locked: boolean;
  lock_reason: string | null;
  /** 이 상태를 유발한 명령의 상관 키 (BE-X-01 — **백엔드가 발급**). */
  command_id: string | null;
};

// ── 제어 명령 (VZ-O-01 · VZ-O-02 · VZ-O-05) ──────────────────────────────────

/**
 * 가시화가 발행하는 **추상 명령**. 디바이스 명령(levee:open 등)으로의 번역은
 * 백엔드가 어휘집으로 수행하므로 여기에는 장비 어휘가 없다 (VZ-O-01).
 *
 * **상관 키가 여기 없다.** BE-X-01에 따라 command_id는 백엔드가 명령 조립 단계에서
 * 발급한다. 가시화는 자기 요청을 가리킬 client_request_id만 붙여 보내고,
 * ACK로 내려오는 command_id를 받아 그때부터 결과·감사를 잇는다.
 */
export type CommandRequest = {
  /**
   * 가시화가 만드는 **요청 식별자**. 상관 키가 아니다.
   * 발급받은 상관 키가 도착하기 전 구간에서 화면이 "이 요청"을 가리키는 유일한 수단이다.
   */
  client_request_id: string;
  entity: string;
  /** 추상 action. 장비 명령이 아니다. */
  action: string;
  params: Record<string, unknown>;
  /** REQ-909 — 만료 후 실행 금지. 서버가 서버 시각으로 검사한다. */
  expires_at: string;
  /**
   * VZ-O-03 — 책임소재 필드. **필드 이름이 확정 전이라 통째로 넘긴다.**
   * 목 서버는 내용을 해석하지 않고 감사 저장소에 그대로 적재하며,
   * 화면 표시용 해석은 클라이언트의 auditFieldMap 한 곳에서만 한다.
   */
  audit?: Record<string, unknown>;
};

/**
 * 명령 결과. **네 단계**로 온다 (VZ-O-02).
 *   ack → executing(200ms 진행 보고) → physical_state_changed → completed/failed
 * 화면은 이걸 진행중·확정·실패 3종으로 접어 표시한다.
 *
 * **command_id만 달고 온다.** 요청 식별자는 여기 실리지 않는다 —
 * ACK 이후 구간의 사슬은 백엔드가 발급한 상관 키 하나로 이어지는 것이 BE-X-01의 정의다.
 * 그래서 수신 측은 ACK로 받은 매핑이 있어야 이 이벤트를 자기 요청에 붙일 수 있다.
 */
export type CommandResult = {
  command_id: string;
  entity: string;
  action: string;
  /** REQ-903 — 5값. 백엔드가 디바이스 ack를 completed로 승격해 내려준다. */
  status: 'accepted' | 'completed' | 'rejected' | 'timeout' | 'failed';
  stage: 'ack' | 'executing' | 'physical_state_changed' | 'settled';
  /** 수행 중 진행률(0~100). stage=executing일 때만. */
  progress_pct: number | null;
  detail: string;
  /** 실패·거부 사유 코드. 화면이 문구를 고르는 근거. */
  reason_code: string | null;
  expires_at: string;
  /** 실패 시 이전 상태로 복원했는가. */
  restored: boolean;
  ts: string;
};

/**
 * 제어 잠금 (VZ-O-05).
 * 통신이 돌아와도 **실제 상태 재확인이 끝나기 전까지는 잠금을 유지한다.**
 */
export type ControlLock = {
  locked: boolean;
  /** unlocked / comm_lost(두절) / rechecking(복구 후 재확인 중) */
  phase: 'unlocked' | 'comm_lost' | 'rechecking';
  reason: string | null;
  /** 잠금 동안 안전 상태를 유지하고 있는가. */
  safe_state_held: boolean;
  since: string;
};

/**
 * 감사 기록 1건 (VZ-I-05 조회용).
 *
 * **필드 이름이 확정 전이다.** 입력 수단·판단 주체를 두 축으로 나누는 안을
 * 백엔드에 요청 중이라, 여기 이름이 그대로 남는다는 보장이 없다.
 * 그래서 클라이언트는 이 타입을 직접 쓰지 않고 auditFieldMap을 거친다.
 */
export type AuditRecord = Record<string, unknown>;

// ── 권한 범위 (VZ-C-01 · VZ-C-04 / BE-Q-04) ──────────────────────────────────

/**
 * 역할이 적용되는 범위. BE-Q-04가 역할과 함께 내려주며 기준 계층은 Zone(BE-C-02)이다.
 * `zones: ['*']` 이면 전 범위.
 */
export type RoleScope = {
  zones: string[];
};

export type RoleInfo = {
  role: string;
  /** 화면에 보여줄 역할 이름. */
  display_name: string;
  scope: RoleScope;
  /** 이 역할·범위를 언제 받았는가(서버 시각). 토큰 갱신 시 재조회하면 갱신된다. */
  issued_at: string;
  /** 어느 API가 준 값인지. 화면이 "화면 차단은 편의, 강제는 백엔드"를 설명하는 근거. */
  source: string;
};

// ── 지표 질의 (VZ-I-04 / BE-Q-01) ────────────────────────────────────────────

/**
 * 지표 질의 응답. **두 갈래다.**
 *  - 요약 질의 : 백엔드가 15초 페더레이션으로 이미 당겨 둔 구역 요약. 즉시 응답.
 *  - 원본 질의 : raw는 엣지에 남아 있으므로 질의 프록시가 엣지로 **중계**한다. 느리다.
 */
export type MetricsQueryResult = {
  query: {
    entity: string;
    metric: string;
    mode: 'summary' | 'raw';
    range_min: number;
    requested_at: string;
  };
  /** 이 시계열이 원본인지 요약인지. 화면은 이 표기를 읽어 재집약을 막는다. */
  aggregation: AggregationSpec;
  /** 어느 경로로 왔는가. 원본 질의는 엣지 중계를 경유하므로 지연이 붙는다. */
  route: {
    via: string;
    relay_ms: number;
  };
  /** 조회 범위가 넓어 무거운 질의인가. 화면이 안내를 띄우는 근거. */
  heavy: boolean;
  heavy_reason: string | null;
  point_interval_sec: number;
  points: Array<{ t: string; value: number }>;
};

// ── 클라이언트 → 서버 ────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'subscribe'; id: string; selector: Selector; scope?: ScopeSpec }
  | { type: 'unsubscribe'; id: string }
  | { type: 'role' }
  | { type: 'scenario'; name: string }
  /** VZ-O-01 — 제어 명령 발행. **목 서버 안에서만 왕복한다.** */
  | { type: 'command'; command: CommandRequest }
  /** VZ-U-07 — 계획 승인/거부. **백엔드 채널로 회신된다**(BE-X-04). */
  | { type: 'plan_decision'; plan_id: string; decision: 'approve' | 'reject'; reason?: string }
  /** VZ-I-06 — 영상 패널 열기/닫기. 열린 패널만 프레임을 받는다. */
  | { type: 'video'; entity: string; open: boolean }
  | { type: 'ping'; t: number };

// ── 서버 → 클라이언트 ────────────────────────────────────────────────────────

export type ServerMessage =
  | { type: 'hello'; server_time: string; stale_threshold_ms: number; protocol: string }
  | { type: 'subscribed'; id: string; selector: Selector; scope: ScopeSpec; snapshot_count: number }
  | { type: 'unsubscribed'; id: string }
  | ({ type: 'role' } & RoleInfo)
  | { type: 'scenario'; name: string; accepted: boolean; message: string }
  /**
   * 명령 수신 확인. **두 키를 함께 내려주는 유일한 메시지다.**
   * 이 메시지가 도착해야 화면이 client_request_id로 걸어 둔 낙관적 UI를
   * command_id 사슬에 이어 붙일 수 있다. 거부(만료·잠금·범위 밖)여도 두 키를 모두 싣는다.
   */
  | {
      type: 'command_ack';
      client_request_id: string;
      /** 백엔드가 명령 조립 단계에서 발급한 상관 키 (BE-X-01). */
      command_id: string;
      accepted: boolean;
      reason_code: string | null;
      message: string;
    }
  | { type: 'plan_decision'; plan_id: string; accepted: boolean; message: string; relayed_by: string }
  | { type: 'pong'; t: number; server_time: string }
  | { type: 'data'; sub: string; envelope: Envelope }
  | { type: 'error'; message: string };
