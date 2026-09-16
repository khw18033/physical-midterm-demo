/**
 * mock-gateway/scenarios.ts
 *
 * 상태 전이 재생 스크립트. 화면이 "정상일 때 잘 보인다"만으로는 검증이 안 되고,
 * **전이하는 순간**이 맞는지를 봐야 하므로 전이를 손으로 재생할 수 있어야 한다.
 *
 * 실행: `npm run scenario -- camera-silence`  또는  WS로 { type: 'scenario', name: ... }
 */

import { CACHE_POLICY, CACHEABLE_CHANNELS, INTERVALS, NON_CACHEABLE_CHANNELS, ROLES, SCENARIO_TIMING, THRESHOLDS } from './config.ts';
import { ackControl, commandLatency, roleState } from './controls.ts';
import type { Fleet } from './devices.ts';
import type { Hub } from './hub.ts';
import type { CommandEngine } from './commands.ts';
import type { PlanEngine } from './plans.ts';
import type { VisionEmitter } from './vision.ts';

export type ScenarioCtx = {
  hub: Hub;
  fleet: Fleet;
  commands: CommandEngine;
  plans: PlanEngine;
  vision: VisionEmitter;
};

export type Scenario = {
  name: string;
  title: string;
  /** 사람이 화면에서 무엇을 봐야 하는가. */
  expect: string;
  run(ctx: ScenarioCtx): string;
};

const seconds = (ms: number) => Math.round(ms / 1000);

export const SCENARIOS: Scenario[] = [
  {
    name: 'camera-silence',
    title: 'camera-02 침묵 → stale 전이',
    expect:
      'camera-02 카드가 ' + seconds(THRESHOLDS.STALE_MS) + '초 뒤 "판단 불가"로 바뀐다. ' +
      'availability만 stale이 되고 device_status는 마지막 자기보고(ok)가 그대로 남아 있어야 한다 — ' +
      '두 층이 각각 다른 주체의 말이라는 근거.',
    run({ fleet }) {
      const cam = fleet.cameras.get('camera-02');
      if (!cam) return 'camera-02 없음';
      cam.silent = true;
      return (
        'camera-02 발행 중지. 서버가 ' + seconds(INTERVALS.AVAILABILITY_SWEEP_MS) +
        '초마다 재판정하므로 약 ' + seconds(THRESHOLDS.STALE_MS) + '초 뒤 stale 전이가 푸시된다. ' +
        '되돌리려면 scenario camera-resume.'
      );
    },
  },
  {
    name: 'camera-resume',
    title: 'camera-02 발행 재개',
    expect: 'camera-02가 다시 15fps로 발행하며 다음 재판정에서 online으로 돌아온다.',
    run({ fleet }) {
      const cam = fleet.cameras.get('camera-02');
      if (!cam) return 'camera-02 없음';
      cam.silent = false;
      return 'camera-02 발행 재개.';
    },
  },
  {
    name: 'sensor-offline',
    title: 'sensor-02 연결 끊김 → offline 후 복구',
    expect:
      'sensor-02가 즉시 "장애"로 바뀌고(오프라인 감지는 5초 정기 발행을 기다리지 않는다), ' +
      seconds(SCENARIO_TIMING.SENSOR_OFFLINE_RECOVER_MS) + '초 뒤 "정상"으로 복구된다.',
    run({ hub, fleet }) {
      const sensor = fleet.sensors.get('sensor-02');
      const rt = hub.runtime.get('sensor-02');
      if (!sensor || !rt) return 'sensor-02 없음';

      sensor.silent = true;
      rt.forcedOffline = true;
      rt.note = 'LWT로 연결 단절 감지';
      hub.sweepAvailability(); // 전이를 즉시 밀어낸다.

      setTimeout(() => {
        sensor.silent = false;
        rt.forcedOffline = false;
        rt.note = null;
        // 복구 직후에는 last_seen이 오래되어 stale로 보일 수 있으므로 실제 값 하나를 먼저 낸다.
        sensor.surge(0);
        hub.sweepAvailability();
      }, SCENARIO_TIMING.SENSOR_OFFLINE_RECOVER_MS);

      return (
        'sensor-02 연결 두절 주입. ' +
        seconds(SCENARIO_TIMING.SENSOR_OFFLINE_RECOVER_MS) + '초 뒤 자동 복구.'
      );
    },
  },
  {
    name: 'sensor-surge',
    title: 'sensor-01 급변 → 즉시 발행 + 이벤트 모드(1초)',
    expect:
      '평시 1분 주기를 기다리지 않고 수위가 즉시 뛴다. 이후 ' +
      seconds(INTERVALS.SENSOR_EVENT_HOLD_MS) + '초 동안 1초 주기로 갱신되고 report_mode가 event로 표시된다.',
    run({ fleet }) {
      const sensor = fleet.sensors.get('sensor-01');
      if (!sensor) return 'sensor-01 없음';
      sensor.surge(0.62);
      return (
        'sensor-01 수위 +0.62m 급변, 즉시 발행. 이벤트 모드 ' +
        seconds(INTERVALS.SENSOR_EVENT_HOLD_MS) + '초(' +
        INTERVALS.SENSOR_EVENT_MS + 'ms 주기) 유지.'
      );
    },
  },
  {
    name: 'command-fail',
    title: '다음 명령 1건을 실패시킨다 (VZ-O-02)',
    expect:
      '다음에 누르는 수문 명령이 진행 60% 지점에서 실패하고, **이전 상태로 복원**되며 ' +
      '사유가 표시된다. 진행 중에 실패해야 복원이 눈에 보인다.',
    run({ commands }) {
      commands.failNext = true;
      return '다음 명령 1건 실패 예약. 제어 패널에서 수문 명령을 눌러 확인할 것.';
    },
  },
  {
    name: 'ack-late',
    title: 'ACK를 진행 이벤트보다 늦게 보낸다 (VZ-O-01 상관키 매핑)',
    expect:
      '다음 명령 1건의 ACK가 ' + SCENARIO_TIMING.ACK_LATE_MS + 'ms 지연 발신되어, ' +
      'command_id만 달고 오는 진행 이벤트가 **매핑보다 먼저** 도착한다. ' +
      '화면은 그 이벤트를 잃지 않아야 한다 — 데이터 레이어가 보류했다가 매핑이 오면 흡수한다. ' +
      '제어 패널 타임라인에 "보류 후 흡수 N건"이 뜨면 통과.',
    run() {
      ackControl.delayNextMs = SCENARIO_TIMING.ACK_LATE_MS;
      return (
        '다음 명령 1건의 ACK를 ' + SCENARIO_TIMING.ACK_LATE_MS + 'ms 지연 발신하도록 예약했다. ' +
        '제어 패널에서 수문 명령을 눌러 확인할 것.'
      );
    },
  },
  {
    name: 'ack-drop',
    title: 'ACK를 아예 보내지 않는다 → 만료 정리 (VZ-O-01)',
    expect:
      '다음 명령 1건의 ACK가 오지 않아 **command_id가 끝내 도착하지 않는다.** ' +
      '화면은 client_request_id만으로 그 요청을 정리하고 만료 사유를 표시해야 한다. ' +
      '제어 패널의 "ACK 없이 만료시키기" 체크박스가 이 시나리오를 짧은 TTL과 함께 건다.',
    run() {
      ackControl.dropNext = true;
      return '다음 명령 1건의 ACK 미발신을 예약했다. 만료 시각이 지나면 화면이 스스로 정리해야 한다.';
    },
  },
  {
    name: 'agg-unlabeled',
    title: '집약 표기에서 kind를 빼고 발행한다 (VZ-C-03 가드)',
    expect:
      '지표 봉투가 { level: "zone", window_sec: 15 } 로, **kind 없이** 내려간다 — 필드 이름이 ' +
      '어긋난 백엔드를 흉내 낸 것이다. 화면 뱃지가 "원본"이 아니라 **"표기 불명"** 으로 떠야 하고, ' +
      '평균을 적용하면 계산이 수행되지 않으면서 사유가 "표기를 읽을 수 없음"으로 갈려야 한다. ' +
      '되돌리려면 scenario agg-normal.',
    run({ fleet }) {
      const obs = fleet.observability.get('edge-node-a');
      if (!obs) return 'edge-node-a 관측 노드 없음';
      obs.malformedAggregation = 'unlabeled';
      obs.republish();
      return ' 집약 표기에서 kind를 제거하고 즉시 재발행했다. 지표 조회 탭에서 확인할 것.'.trim();
    },
  },
  {
    name: 'agg-odd-string',
    title: "집약 표기를 문자열 'aggregated' 로 발행한다 (VZ-C-03 가드)",
    expect:
      "축약형을 'raw' 아닌 문자열로 쓰는 백엔드를 흉내 낸다. 계약이 정의한 축약형은 'raw' 하나뿐이므로 " +
      '화면은 이 값을 **판단 불가**로 다뤄야 한다 — agg-unlabeled와 같은 결과가 나와야 한다. ' +
      '되돌리려면 scenario agg-normal.',
    run({ fleet }) {
      const obs = fleet.observability.get('edge-node-a');
      if (!obs) return 'edge-node-a 관측 노드 없음';
      obs.malformedAggregation = 'odd-string';
      obs.republish();
      return "집약 표기를 문자열 'aggregated' 로 바꾸고 즉시 재발행했다.";
    },
  },
  {
    name: 'agg-normal',
    title: '집약 표기를 정식 계약값으로 되돌린다 (VZ-C-03)',
    expect: '뱃지가 다시 "요약 · 구역 · 15초" 로 돌아오고, 평균 적용 시 사유가 "이미 집약된 값"으로 바뀐다.',
    run({ fleet }) {
      const obs = fleet.observability.get('edge-node-a');
      if (!obs) return 'edge-node-a 관측 노드 없음';
      obs.malformedAggregation = null;
      obs.republish();
      return '집약 표기를 정식 계약값으로 복귀시키고 즉시 재발행했다.';
    },
  },
  {
    name: 'role-narrow',
    title: '역할을 503 구역 담당으로 좁힌다 (VZ-C-04 / BE-Q-04)',
    expect:
      '역할을 다시 조회하면(토큰 갱신 상황) 범위가 ' + JSON.stringify(ROLES['zone-503-only'].scope.zones) +
      ' 로 좁혀진다. zone-504의 actuator-02는 **범위 밖**이 되어 제어 버튼이 잠기고 사유가 뜬다. ' +
      '화면 잠금을 우회해 명령을 보내도 서버가 out_of_scope로 거부한다.',
    run() {
      roleState.key = 'zone-503-only';
      return (
        '역할 → ' + ROLES['zone-503-only'].display_name + '. ' +
        '화면에서 "역할 다시 조회"를 눌러야 반영된다 — 역할은 로그인·토큰 갱신 시점에만 조회되기 때문이다.'
      );
    },
  },
  {
    name: 'role-full',
    title: '역할을 전 구역으로 되돌린다 (VZ-C-04)',
    expect: '역할을 다시 조회하면 범위가 ["*"]로 돌아오고 두 수문 모두 제어 가능해진다.',
    run() {
      roleState.key = 'full';
      return '역할 → ' + ROLES.full.display_name + '. 화면에서 "역할 다시 조회"를 누를 것.';
    },
  },
  {
    name: 'control-lock',
    title: 'actuator-01 통신 두절 → 제어 잠금 (VZ-O-05)',
    expect:
      '수문 제어 버튼이 즉시 잠기고 사유가 표시된다. 잠긴 동안 명령을 보내도 ' +
      '서버가 거부한다 — 화면 차단은 편의이고 실제 차단은 서버가 한다.',
    run({ commands }) {
      commands.lockForCommLoss(
        'actuator-01',
        '제어노드 하트비트 ' + THRESHOLDS.HEARTBEAT_MISS_COUNT + '회 연속 미수신 — 원격 제어 차단, 안전 상태 유지',
      );
      return 'actuator-01 제어 잠금. 해제는 scenario control-unlock.';
    },
  },
  {
    name: 'control-unlock',
    title: 'actuator-01 통신 복구 → 재확인 후 해제 (VZ-O-05)',
    expect:
      '통신이 돌아와도 **바로 풀리지 않는다.** ' + seconds(SCENARIO_TIMING.CONTROL_RECHECK_MS) +
      '초 재확인 구간을 거친 뒤에야 버튼이 열린다.',
    run({ commands }) {
      commands.beginRecheck('actuator-01');
      return (
        '통신 복구 — 실제 상태 재확인 시작. ' +
        seconds(SCENARIO_TIMING.CONTROL_RECHECK_MS) + '초 뒤 잠금 해제.'
      );
    },
  },
  {
    name: 'plan-propose',
    title: '계획 하나를 승인 대기로 내려보낸다 (VZ-U-07)',
    expect:
      '임무 탭에 계획이 나타나고 근거(임무 → 구역 → 구간 → 검증)가 펼쳐진다. ' +
      '**승인하기 전에는 구간이 하나도 진행되지 않는다.**',
    run({ plans }) {
      plans.failSegment = null;
      const plan = plans.propose();
      return '계획 ' + plan.plan_id + ' 승인 대기. 승인 전까지 진행 이벤트를 발행하지 않는다.';
    },
  },
  {
    name: 'plan-propose-failing',
    title: '구간 4/5에서 실패하는 계획 (VZ-U-05)',
    expect:
      '승인하면 구간 1~3이 완료되고 **구간 4에서 실패**한다. 실패 노드를 펼치면 ' +
      '하달 → ACK → 실패 시각과 사유가 나오고, 뒤 구간은 하달되지 않아 건너뜀으로 표시된다.',
    run({ plans }) {
      plans.failSegment = 4;
      const plan = plans.propose();
      return '계획 ' + plan.plan_id + ' 승인 대기 (구간 4/5 실패 예약).';
    },
  },
  {
    name: 'vision-delay-200',
    title: '추론 지연 200ms (기본 · AI-P-01)',
    expect: '15fps에서 0.2초면 결과가 돌아올 때 화면은 약 3프레임 앞서 있다.',
    run({ vision }) {
      vision.inferenceDelayMs = 200;
      return '추론 지연 200ms. ' + vision.describe();
    },
  },
  {
    name: 'vision-delay-500',
    title: '추론 지연 500ms — 어긋남이 커지는지 확인',
    expect: '정합 OFF에서 뒤처진 픽셀 거리가 200ms일 때보다 뚜렷하게 커져야 한다.',
    run({ vision }) {
      vision.inferenceDelayMs = 500;
      return '추론 지연 500ms. ' + vision.describe();
    },
  },
  {
    name: 'vision-bbox-normalized',
    title: 'bbox를 정규화 좌표(0~1)로 전환',
    expect: '좌표계가 바뀌어도 박스가 제자리에 온다. 환산 기준은 bbox_space 선언이다.',
    run({ vision }) {
      vision.bboxFormat = 'normalized';
      return 'bbox 정규화 좌표. ' + vision.describe();
    },
  },
  {
    name: 'vision-bbox-absolute',
    title: 'bbox를 픽셀 절대 좌표로 전환',
    expect: '추론 해상도 기준 픽셀로 온다. 표시 해상도가 다르므로 환산이 필요하다.',
    run({ vision }) {
      vision.bboxFormat = 'absolute';
      return 'bbox 픽셀 절대 좌표. ' + vision.describe();
    },
  },
  {
    name: 'vision-inference-320',
    title: '추론 해상도를 320x180으로 낮춤',
    expect: '표시 해상도(960x540)와 3배 차이가 나도 박스가 제자리여야 한다.',
    run({ vision }) {
      vision.inferenceWidth = 320;
      vision.inferenceHeight = 180;
      return '추론 해상도 320x180. ' + vision.describe();
    },
  },
  {
    name: 'vision-inference-640',
    title: '추론 해상도를 640x360으로 되돌림',
    expect: '기본값. 표시 해상도와 1.5배 차이.',
    run({ vision }) {
      vision.inferenceWidth = 640;
      vision.inferenceHeight = 360;
      return '추론 해상도 640x360. ' + vision.describe();
    },
  },
  {
    name: 'vision-edge-off',
    title: '엣지 정밀 인지를 이 배치에서 뺀다 (AI-E-04 선택 기능)',
    expect:
      '온디바이스 최소 안전 판단만 남는다 — **기본 인지가 멈추지 않아야 한다.** ' +
      '화면에서 정밀 분류·추적·궤적이 사라지고 진행영역과 접근 변화만 남으며, ' +
      '"엣지 정밀 인지 결과 없음"이 표시돼야 한다. 값이 안 오는 것을 빈 화면으로 두면 ' +
      '관제사는 고장으로 읽는다. 되돌리려면 scenario vision-edge-on.',
    run({ vision }) {
      vision.edgeEnabled = false;
      return '엣지 정밀 인지 미배포. ' + vision.describe();
    },
  },
  {
    name: 'vision-edge-on',
    title: '엣지 정밀 인지를 되돌린다 (AI-E-04)',
    expect: '정밀 분류·추적·궤적이 다시 온다. 온디바이스 결과는 그동안 끊기지 않았어야 한다.',
    run({ vision }) {
      vision.edgeEnabled = true;
      return '엣지 정밀 인지 배치. ' + vision.describe();
    },
  },
  {
    name: 'vision-link-off',
    title: '다중 관측 연계를 뺀다 → 소스별 추적 유지 (AI-S-02 선택 기능)',
    expect:
      '같은 대상이 **관측 소스마다 따로** 뜬다(추적 id가 `소스:trk-01` 형태로 갈린다). ' +
      '연계 신뢰도는 **그리지 않는다** — 묶지 못했는데 신뢰도를 띄우면 없는 근거를 만드는 것이다. ' +
      '화면이 "연계 없음 · 소스별 추적 유지"를 말해야 한다. 되돌리려면 scenario vision-link-on.',
    run({ vision }) {
      vision.associationEnabled = false;
      return '다중 관측 연계 미배포 — 소스별 추적 유지. ' + vision.describe();
    },
  },
  {
    name: 'vision-link-on',
    title: '다중 관측 연계를 되돌린다 (AI-S-02)',
    expect: '두 소스가 하나로 묶이고 연계 신뢰도가 다시 표시된다. 추적 id가 소스 접두어 없이 돌아온다.',
    run({ vision }) {
      vision.associationEnabled = true;
      return '다중 관측 연계 배치. ' + vision.describe();
    },
  },
  {
    name: 'cache-policy-audit',
    title: '캐시 정책과 실물을 대조한다 (BE-T-06 회신 자체 검증)',
    expect:
      '지금 캐시에 실제로 들어 있는 채널이 회신한 7개 안에만 있어야 한다. ' +
      '**금지 3개(command_result·video_frame·detections)가 하나라도 있으면 위반이다** — ' +
      '남에게 요구한 것을 내 목 서버가 어기고 있는 상태다. 결과가 이 메시지에 그대로 나온다.',
    run({ hub }) {
      const keys = hub.cachedKeys();
      const seen = [...new Set(keys.map((k) => k.split('|')[1]))].sort();
      const violations = seen.filter((c) => CACHE_POLICY[c as keyof typeof CACHE_POLICY]?.cache !== true);
      const lines = [
        '캐시 키 ' + keys.length + '건 · 채널 ' + seen.join(', '),
        '허용(회신) ' + CACHEABLE_CHANNELS.join(', '),
        '금지·불필요 ' + NON_CACHEABLE_CHANNELS.join(', '),
        violations.length === 0
          ? '→ 위반 0건. 회신한 정책과 실물이 일치한다.'
          : '→ 위반 ' + violations.length + '건: ' + violations.join(', '),
      ];
      return lines.join(' | ');
    },
  },
  {
    name: 'command-roundtrip-slow',
    title: '명령 경로에 왕복 지연을 주입한다 (전송 문서 §5-6 Kafka 10~50ms)',
    expect:
      'ACK가 ' + SCENARIO_TIMING.COMMAND_ONE_WAY_SLOW_MS + 'ms, 말단 응답이 ' +
      SCENARIO_TIMING.COMMAND_ONE_WAY_SLOW_MS * 2 + 'ms 늦게 온다. ' +
      '즉시 ACK를 전제로 정한 expires_at 기본값과 "ACK 없이 만료" 임계가 ' +
      '실제 경로에서 견디는지 확인한다. 되돌리려면 scenario command-roundtrip-zero.',
    run() {
      commandLatency.oneWayMs = SCENARIO_TIMING.COMMAND_ONE_WAY_SLOW_MS;
      return (
        '왕복 지연 주입 — 한 방향 ' + commandLatency.oneWayMs + 'ms (말단 응답 ' +
        commandLatency.oneWayMs * 2 + 'ms). 제어 패널에서 수문 명령을 눌러 확인할 것.'
      );
    },
  },
  {
    name: 'command-roundtrip-zero',
    title: '왕복 지연을 되돌린다',
    expect: 'ACK가 다시 즉시 온다. 목 서버 기본 동작.',
    run() {
      commandLatency.oneWayMs = 0;
      return '왕복 지연 주입 해제.';
    },
  },
  {
    name: 'robot-idle',
    title: 'robot-01 임무 종료 → 대기(5초 주기)',
    expect: 'robot-01 갱신이 50ms에서 5초로 떨어지고 1초 하트비트가 시작된다.',
    run({ fleet }) {
      const robot = fleet.robots.get('robot-01');
      if (!robot) return 'robot-01 없음';
      robot.mission = false;
      return 'robot-01 대기 모드. 상태 ' + INTERVALS.ROBOT_IDLE_MS + 'ms / 하트비트 ' + INTERVALS.ROBOT_HEARTBEAT_IDLE_MS + 'ms.';
    },
  },
  {
    name: 'robot-mission',
    title: 'robot-01 임무 시작 → 50ms(20Hz)',
    expect: 'robot-01이 다시 20Hz로 올라온다. 화면 리렌더는 초당 10회를 넘지 않아야 한다.',
    run({ fleet }) {
      const robot = fleet.robots.get('robot-01');
      if (!robot) return 'robot-01 없음';
      robot.mission = true;
      return 'robot-01 임무 모드. 상태 ' + INTERVALS.ROBOT_MISSION_MS + 'ms.';
    },
  },
];

export function runScenario(name: string, ctx: ScenarioCtx): { ok: boolean; message: string } {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) {
    return { ok: false, message: '알 수 없는 시나리오: ' + name + ' (사용 가능: ' + SCENARIOS.map((x) => x.name).join(', ') + ')' };
  }
  return { ok: true, message: s.run(ctx) };
}
