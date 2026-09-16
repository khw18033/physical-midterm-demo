/**
 * src/shared/pendingSources.ts
 *
 * **화면이 남에게서 기다리는 것의 목록.** 자리표시 문구를 화면마다 하드코딩하지 않고
 * 여기 표 하나에 모은다 — 상대 요구사항이 또 바뀔 것이기 때문이다.
 * 화면은 `<PendingSource id="…" />` 로 ID만 참조한다.
 *
 * ## 출처
 *
 * 상대 ID는 **`피지컬팀 프로젝트 mk2 요구사항 정의서.xlsx` 김현우 시트의 `연관점` 열**에서
 * 그대로 읽었다(2026-08-31 현행판). 옛 문서에 적힌 ID를 베끼지 않았고, 제목은 상대 시트
 * (조병현=하드웨어 · 이대규=백엔드 · 진나영=AI)에서 가져왔다.
 *
 * **ID를 지어내지 않는다.** 현행 엑셀에 없으면 `missing` 에 사유를 적고 상대를 비운다.
 * **사람 이름을 쓰지 않는다.** 파트 이름으로만 적는다.
 *
 * ## 네 가지가 다 있어야 한다
 *
 *   what   무엇을 기다리는가 — 사람 말로
 *   from   누가 보내는가 — 파트와 상대 ID. 여럿을 거치면 **순서대로**
 *   ours   우리 쪽 자리 (VZ-*) — 이게 있어야 "안 만든 게 아니라 못 받은 것"이 증명된다
 *   plane  어느 평면으로 오는가 — 세 평면을 나눈 이유가 여기서 드러난다 (DF-1b)
 *
 * `verify:placeholder-default` 가 넷이 다 찼는지 검사한다.
 */

/** 어느 평면으로 오는가 (DF-1b). */
export type Plane = 'business' | 'control' | 'observability' | 'media';

export const PLANE_LABEL: Record<Plane, string> = {
  business: '업무 평면',
  control: '업무 평면 (제어)',
  observability: '관측 평면',
  media: '미디어 평면',
};

export const PLANE_NOTE: Record<Plane, string> = {
  business: 'MQTT/Kafka 업무 데이터 경로',
  control: '업무 데이터이되 전달 보장·순서·책임 추적이 필요한 별도 정책 (AI-C-14)',
  observability: 'OTLP 관측 경로 — 업무 브로커와 섞지 않는다',
  media: '업무·관측 브로커에 싣지 않는다 (AI-C-14 · HW-R-07)',
};

export type Sender = {
  /** 파트 이름. **사람 이름을 쓰지 않는다.** */
  part: '하드웨어' | 'AI' | '백엔드';
  /** 상대 요구사항 ID. 현행 엑셀에 실재하는 것만 쓴다. */
  id: string;
  /** 상대 시트의 소분류 제목. */
  title: string;
};

export type PendingSourceSpec = {
  id: string;
  /** 자리표시 제목. "…연결 예정" 형태. */
  title: string;
  /** 무엇을 기다리는가. */
  what: string;
  /** 누가 보내는가. **거치는 순서대로** 적는다. */
  from: Sender[];
  /** 우리 쪽 자리. */
  ours: string[];
  plane: Plane;
  /**
   * 상대가 아직 없을 때의 사유. 있으면 화면에 「상대 없음 — 회의 안건」이 크게 붙는다.
   * **없는 것을 있는 것처럼 적는 쪽이 훨씬 나쁘다.**
   */
  missing?: string;
};

const HW = (id: string, title: string): Sender => ({ part: '하드웨어', id, title });
const AI = (id: string, title: string): Sender => ({ part: 'AI', id, title });
const BE = (id: string, title: string): Sender => ({ part: '백엔드', id, title });

export const PENDING_SOURCES: PendingSourceSpec[] = [
  // ── 공유 계층 ──────────────────────────────────────────────────────────────
  {
    id: 'registry',
    title: '구성(레지스트리) 연결 예정',
    what: '대상 목록 · 소속 구역 · 노드 매핑 · 선언 채널',
    from: [
      HW('HW-C-04', '장치 상태·구역 등록 관리'),
      HW('HW-C-07', 'device_id 기반 장치 식별·엣지노드 매핑'),
      BE('BE-C-02', '식별자 계층(Entity/Node/Zone) 규약'),
      BE('BE-T-04', '장치 등록·구역 소속 및 가용성 관리(Birth/Death)'),
      BE('BE-Q-03', '구성(레지스트리) 조회 API'),
    ],
    ours: ['VZ-I-03'],
    plane: 'business',
  },
  {
    id: 'role-scope',
    title: '역할·권한 범위 연결 예정',
    what: '로그인 사용자의 역할과 담당 구역 범위',
    from: [
      BE('BE-Q-04', '역할·범위 조회 및 권한 강제(RBAC)'),
      BE('BE-C-02', '식별자 계층(Entity/Node/Zone) 규약'),
    ],
    ours: ['VZ-C-01', 'VZ-C-04'],
    plane: 'business',
  },
  {
    id: 'ai-failure-alert',
    title: '외부 AI 실패 알림 연결 예정',
    what: 'AI 구성요소의 오류·이상 사건 (지연·추론 실패·모델 이상)',
    from: [
      AI('AI-O-02', 'AI 오류·이상 사건 기록'),
      BE('BE-X-05', 'AI 실패 이벤트 중계'),
    ],
    ours: ['VZ-I-10'],
    plane: 'observability',
  },

  // ── 탭② 구역 현황판 ───────────────────────────────────────────────────────
  {
    id: 'zone-summary',
    title: '구역 상태 집계 연결 예정',
    what: '구역 안 대상들의 상태 4종 집계 (정상·장애·미배포·판단 불가)',
    from: [
      HW('HW-R-02', '하트비트 전송'),
      HW('HW-S-05', '센서노드(라즈베리파이) 하트비트'),
      HW('HW-S-07', '오프라인 감지 및 상태 반영'),
      HW('HW-C-04', '장치 상태·구역 등록 관리'),
      BE('BE-T-04', '장치 등록·구역 소속 및 가용성 관리'),
      BE('BE-C-05', '계약 축·미배포 대상 표현 규약'),
    ],
    ours: ['VZ-U-01'],
    plane: 'business',
  },
  {
    id: 'device-cards',
    title: '장치 상태 연결 예정',
    what: '대상별 상태 3층(기기 자기보고 · 가용성 · 배포 여부)과 도메인 계측값(배터리 · 수위 · fps · CPU · 개도율)',
    from: [
      HW('HW-R-03', '상태 데이터 전달'),
      HW('HW-S-02', '계측 데이터 전달(평시)'),
      HW('HW-A-01', '액추에이터 상태 수집'),
      HW('HW-S-07', '오프라인 감지 및 상태 반영'),
      BE('BE-C-01', '공통 메시지 스키마·필드 규약'),
      BE('BE-T-03', '가시화 클라이언트 실시간 채널 게이트웨이(WebSocket)'),
      BE('BE-T-06', '재접속 시 현재값 즉시 제공(백엔드 캐시)'),
    ],
    ours: ['VZ-I-01', 'VZ-I-02', 'VZ-U-01'],
    plane: 'business',
  },
  {
    // 대본 재생(260831) 신설 — 탭② 구역 맵 미니뷰. 지금 scenario 모드에서 그리는 커버리지는
    // 대본이 만든 **합성본**이고, 실제로는 아래 백엔드 디지털 트윈이 줄 데이터다(A).
    // 가상 맵 본체는 Unity 트윈(VZ-U-02 · 별도 앱) 몫이며 이 미니뷰는 웹 시연용 축소판이다.
    id: 'zone-map',
    title: '구역 맵 커버리지 연결 예정',
    what: '구역 평면 위 카메라 커버리지(FOV 투영) · 사각지대 칸 · 칸별 마지막 관측 시각(시의성)',
    from: [
      BE('DT-04', '커버리지 맵·사각지대 산출'),
      BE('DT-05', '트윈 시의성(staleness) 판정'),
    ],
    ours: ['VZ-U-01', 'VZ-U-02'],
    plane: 'business',
  },
  {
    id: 'risk-state',
    title: '환경 위험도 판정 연결 예정',
    what: '위험 수준 · 점수 · 판단 근거와 기여도 · 권고 조치',
    from: [
      HW('HW-S-03', '이벤트 모드 고주기 보고'),
      AI('AI-R-02', '위험도·근거 상태 산정'),
      AI('AI-R-03', '위험 판단 결과·권고 출력'),
      BE('BE-A-04', '위험 판정 기반 제어 발행'),
    ],
    ours: ['VZ-I-08'],
    plane: 'business',
  },

  // ── 탭③ 제어 패널 ─────────────────────────────────────────────────────────
  {
    id: 'actuator-state',
    title: '액추에이터 상태 연결 예정',
    what: '동작 단계 · 개도율 · 제어 잠금과 잠금 사유',
    from: [
      HW('HW-A-01', '액추에이터 상태 수집'),
      HW('HW-A-05', '통신 두절·비정상 상태 안전 처리'),
      HW('HW-S-07', '오프라인 감지 및 상태 반영'),
      BE('BE-T-04', '장치 등록·구역 소속 및 가용성 관리'),
    ],
    ours: ['VZ-O-05', 'VZ-U-01'],
    plane: 'business',
  },
  {
    id: 'command-result',
    title: '명령 결과 연결 예정',
    what: '접수 확인 · 상관 키 · 수행 진행률 · 확정 결과 (4단계)',
    from: [
      HW('HW-C-06', '제어 명령 수신 및 ACK 응답'),
      HW('HW-A-03', '제어 명령 수신 확인(ACK)'),
      HW('HW-A-04', '실제 수행 결과 확인'),
      BE('BE-X-01', '상관키(command_id) 발급·매핑'),
      BE('BE-X-03', '명령 결과 4단계 승격'),
    ],
    ours: ['VZ-O-01', 'VZ-O-02'],
    plane: 'control',
  },
  {
    id: 'audit-history',
    title: '감사 이력 연결 예정',
    what: '누가 · 언제 · 무엇을 · 어떤 입력 수단과 판단 주체로 조작했는가',
    from: [
      HW('HW-C-06', '제어 명령 수신 및 ACK 응답'),
      BE('BE-X-02', '감사 기록 작성(actor·시각 주입)'),
      BE('BE-S-05', '감사 중앙 저장(MySQL 직행 예외)'),
      BE('BE-Q-02', '감사 이력 조회 API'),
    ],
    ours: ['VZ-I-05'],
    plane: 'business',
  },
  {
    id: 'action-catalog',
    title: '실행 가능 액션 목록 연결 예정',
    what: '이 대상에 지금 낼 수 있는 추상 액션과 되돌릴 수 없는 것의 표시',
    from: [
      HW('HW-A-02', '액추에이터 제어 명령 수신'),
      HW('HW-R-05', '임무(서브태스크) 수신'),
      BE('BE-A-01', '제어 명령 조립·발행'),
      BE('BE-A-02', '명령 유효성·안전 조건 검사'),
    ],
    ours: ['VZ-O-01'],
    plane: 'control',
  },

  // ── 탭④ 지표 조회 ─────────────────────────────────────────────────────────
  {
    id: 'metrics-query',
    title: '지표 질의 응답 연결 예정',
    what: '대상·지표·구간으로 물은 시계열 (요약 / 원본 두 경로)',
    from: [
      HW('HW-C-05', '관측 데이터(OpenTelemetry) 계측'),
      AI('AI-O-01', '실행 성능·자원 관측'),
      BE('BE-S-02', 'OTel 관측 파이프라인(Agent+Gateway)'),
      BE('BE-S-01', '시계열·상태 이력 저장'),
      BE('BE-S-03', '관측 저장 계층화(엣지 로컬 + 페더레이션 요약)'),
      BE('BE-Q-01', '지표 질의 프록시'),
      BE('BE-T-05', '사설 IP 라우팅·프록시 중계'),
    ],
    ours: ['VZ-I-04', 'VZ-C-03'],
    plane: 'observability',
  },
  {
    id: 'client-metrics-sink',
    title: '자체 관측 지표 발행 연결 예정',
    what: '가시화가 스스로 잰 60초 집계(기록 발생률 · 열 용량 · 접기 시간 · 수신 지연)를 받아 줄 관측 수집기',
    from: [
      BE('BE-S-02', 'OTel 관측 파이프라인(Agent+Gateway)'),
      BE('BE-S-01', '시계열·상태 이력 저장'),
    ],
    ours: ['VZ-O-04'],
    plane: 'observability',
  },
  {
    id: 'metrics-push',
    title: '평시 지표 푸시 연결 예정',
    what: '질의 없이 주기로 올라오는 관측 지표와 그 집약 계층 표기',
    from: [
      HW('HW-C-05', '관측 데이터(OpenTelemetry) 계측'),
      BE('BE-S-03', '관측 저장 계층화(엣지 로컬 + 페더레이션 요약)'),
      BE('BE-S-06', '집약 계층 경계 표기'),
    ],
    ours: ['VZ-I-04', 'VZ-C-03'],
    plane: 'observability',
  },

  // ── 탭⑤ 영상 오버레이 ─────────────────────────────────────────────────────
  {
    id: 'video-stream',
    title: '영상 스트림 연결 예정',
    what: '관제용 영상 픽셀과 프레임 식별자',
    from: [
      HW('HW-R-07', '관제용 고해상도 영상 스트림(온디맨드)'),
      HW('HW-S-06', '고정 비전센서(CCTV) 영상 전달'),
      AI('AI-C-08', '미디어 입력 관리'),
      AI('AI-C-14', '데이터 유형별 경로 분리'),
      BE('BE-T-05', '사설 IP 라우팅·프록시 중계'),
    ],
    ours: ['VZ-I-06'],
    plane: 'media',
  },
  {
    id: 'detections',
    title: '탐지 결과 연결 예정',
    what: '탐지 박스 · 분류 · 신뢰도와 **그 박스가 어느 프레임의 것인지**(프레임 참조값)',
    from: [
      HW('HW-R-04', '환경인식용 이미지 및 온디바이스 인식'),
      AI('AI-N-01', '로컬 안전 판단'),
      AI('AI-E-01', '인지'),
      AI('AI-E-04', '선택형 보조 기능 실행'),
      AI('AI-C-03', '프레임 참조·시간 규약'),
      BE('BE-C-03', '프레임 참조·시간 동기 규약'),
    ],
    ours: ['VZ-I-07'],
    plane: 'business',
  },
  {
    id: 'tracking',
    title: '객체 추적·궤적 연결 예정',
    what: '추적 식별자 · 궤적 · 다중 관측 연계 여부',
    from: [
      AI('AI-S-01', '객체 추적'),
      AI('AI-S-02', '다중 관측 객체 연계'),
      AI('AI-S-03', '불확실성·근거 충분도 평가'),
      BE('DT-01', '트윈 좌표 위치 융합(불확실도 가중)'),
      BE('DT-02', '클래스 베이지안 융합'),
    ],
    ours: ['VZ-I-09'],
    plane: 'business',
  },

  // 탭⑥(파이프라인 편집기)의 `node-catalog`·`pipeline-runner` 항목은 2026-08-31에 지웠다.
  // 먼저 실행기(유일한 「상대 없음」)를 없앴고, 같은 날 탭 자체를 제거했다 —
  // 노드 에디터의 구현 방향이 탭①로 확정됐기 때문(전회의). 원형은 web-dashboard(기준선)에 있다.

  // ── 임무 이력 ─────────────────────────────────────────────────────────────
  {
    id: 'mission-history',
    title: '임무 이력 연결 예정',
    what: '지난 임무 목록과 결과 — 백엔드가 보관하고 우리는 조회해 보여준다 (2026-08-31 결정). 현재 임무의 실행 기록 열(되감기 원자료)은 우리 것이라 여기 해당하지 않는다',
    from: [
      BE('BE-S-01', '시계열·상태 이력 저장'),
      BE('BE-Q-01', '지표 질의 프록시'),
    ],
    ours: ['VZ-D-04'],
    plane: 'business',
  },

  // ── 탭① 임무 설계 및 디버깅 — **장비 실측값만** ────────────────────────────
  {
    id: 'robot-status-strip',
    title: '배정 장비 실측 상태 연결 예정',
    what: '배터리 · 통신 세기 · 지연 · IP · 펌웨어 · 관절 온도 · 하트비트',
    from: [
      HW('HW-R-02', '하트비트 전송'),
      HW('HW-R-03', '상태 데이터 전달'),
      HW('HW-C-04', '장치 상태·구역 등록 관리'),
      HW('HW-C-07', 'device_id 기반 장치 식별·엣지노드 매핑'),
      BE('BE-T-04', '장치 등록·구역 소속 및 가용성 관리'),
    ],
    ours: ['VZ-D-07'],
    plane: 'business',
  },
  {
    id: 'hardware-pool-status',
    title: '배정 풀 대상 상태 연결 예정',
    what: '배정 후보 장비의 연결 상태 · 배터리 · 통신 세기',
    from: [
      HW('HW-C-04', '장치 상태·구역 등록 관리'),
      HW('HW-S-07', '오프라인 감지 및 상태 반영'),
      HW('HW-A-05', '통신 두절·비정상 상태 안전 처리'),
      AI('AI-O-04', '실행 가용성 신호 연계'),
      BE('BE-C-02', '식별자 계층(Entity/Node/Zone) 규약'),
    ],
    ours: ['VZ-D-07'],
    plane: 'business',
  },
];

const BY_ID = new Map(PENDING_SOURCES.map((spec) => [spec.id, spec]));

export function pendingSource(id: string): PendingSourceSpec {
  const spec = BY_ID.get(id);
  // 화면이 없는 ID를 참조하면 조용히 빈 자리를 그리는 대신 즉시 터뜨린다 —
  // 자리표시가 사라지는 것이 이 작업에서 제일 나쁜 실패다.
  if (!spec) throw new Error(`pendingSources 에 없는 id: ${id}`);
  return spec;
}
