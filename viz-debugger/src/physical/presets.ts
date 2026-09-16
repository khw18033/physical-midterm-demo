/**
 * src/physical/presets.ts (260910 신설 — 하드웨어 연동 §2 · §3)
 *
 * 브로커 주소 프리셋과, **방향·거리를 정하는 자리.**
 *
 * ## 주소 프리셋
 *
 * 이름(`pi7.local`)이 안 풀릴 때를 대비해 화면에서 고를 수 있게 한다. 발표장에서 mDNS 가
 * 막히는 일은 드물지 않고, 그때 손으로 IP 를 치는 것보다 고르는 편이 빠르다.
 *
 * **발표장 핫스팟 IP 는 아직 없다.** 5GHz 대역·SSID·PW 를 전달했고 정적 IP 가 나오면 채운다.
 * 값을 지어내 넣지 않는다 — 틀린 주소가 들어 있으면 발표장에서 「왜 안 붙지」로 시간을 쓴다.
 * 빈 프리셋으로 두고, 받는 즉시 아래 한 줄만 고치면 되게 해 두었다.
 */

/**
 * **정지 명령의 이름. 상수 한 줄이다.** (`문서/정지명령_규약_260910.md`)
 *
 * 우리가 정의해 하드웨어 쪽에 넘긴 안이고 **받는 쪽이 아직 합의하지 않았다.** 그쪽이 다른
 * 이름을 쓰겠다고 하면 이 줄만 고친다 — 그래서 문자열을 여기 밖에 적지 않는다.
 * 규약의 질문 다섯 중 첫째가 「`abort` 라는 이름으로 괜찮은가」다.
 */
import { detectState } from '../detect/store.ts';

export const STOP_ACTION = 'abort';

/**
 * **일시정지가 쓰는 이름 — 정지와 같다.** (260910 실측)
 *
 * 처음엔 `abort_mission` 을 썼다. 「돌던 임무만 접는다」고 적혀 있어(가이드 §4-2) 일시정지에
 * 알맞아 보였다. **안 멈춘다.** 로봇에 직접 쏴서 잰 것:
 *
 *     0.0s  scan_mission 발행 · 수락
 *     2.5s  scan_turn step 1
 *     6.0s  abort_mission 발행 · **수락** · 결과 ABORTED {} INTERNAL
 *     6.8s  scan_turn step 2      ← 계속 돈다
 *    27.6s  scan_turn step 7      ← 끝까지 돈다
 *
 * 수락은 하고 자기는 `INTERNAL` 로 끝나면서 임무는 그대로 둔다. 같은 자리에 `abort` 를
 * 쏘면 1.5초 안에 스캔이 `ABORTED` 로 끝난다.
 *
 *     6.0s  abort 발행 · 수락 · 결과 SUCCEEDED {sdk_reached:1, had_mission:1}
 *     7.5s  scan_mission 결과 ABORTED
 *
 * 그래서 **로봇을 멈추는 방법은 하나뿐**이고, 정지와 일시정지의 차이는 전부 화면 쪽에
 * 있다 — 정지는 진행상황을 종결하고 화면을 잠그며 다시 승인을 받고, 일시정지는 아무것도
 * 안 버린다. 하드웨어가 `abort_mission` 을 고치거나 진짜 일시정지를 주는 날 이 줄만 고친다.
 */
export const PAUSE_ACTION = STOP_ACTION;

/**
 * **구동 브리지 명령의 이름들.** 여기 밖에 문자열을 안 적는 이유는 위와 같다.
 *
 * 브리지(`go1-sdk`)는 평시에 **내려가 있다** — 기동하는 순간 로봇이 일어서기 때문이다
 * (연동 가이드 §4-3). 그래서 「붙어 있다」와 「움직일 수 있다」가 다르고, 그 차이를
 * 화면이 말해야 한다.
 */
export const SDK_ACTIONS = {
  /** 브리지를 띄운다 — **로봇이 일어선다.** 임무 전에 미리 세워 둘 때. */
  start: 'sdk_start',
  /** 브리지를 내린다. 로봇은 **선 채로** 남는다. */
  stop: 'sdk_stop',
  /** 이동 명령이 왔을 때 알아서 띄울지. 끄면 `go1_sdk_not_running` 으로 거절된다. */
  auto: 'sdk_auto',
} as const;

/**
 * 정지 사유 코드. `parameters` 가 `map<string, double>` 이라 문자열을 못 넣어 숫자로 보낸다.
 * **기록용이고 로봇 동작은 값과 무관하게 같아야 한다** — 무엇이든 즉시 멈춘다.
 *
 * **`reason` 말고 다른 파라미터를 더하지 않는다** — 규약 밖으로 나가지 않는다.
 */
export const STOP_REASON = { human: 1, screen: 2, connection: 3 } as const;

/**
 * **시험에서 실제로 보내는 직진 거리(m)** (260912 지시).
 *
 * 경로 산출이 낸 것은 6.35m 다. 실험실에서 그만큼 갈 자리가 없어서 로봇을 들어 허공에서
 * 걷게 하고 있고, 지금 보는 것은 「거기까지 가는가」가 아니라 **「명령이 제대로 오가는가」**
 * 다. 그 목적에는 1m 로 충분하고, 6.35m 는 한 번에 한참을 기다려야 한다.
 *
 * **화면은 계획값을 그대로 적는다.** 버튼도 액션 아이템도 「직진 6.35m」를 보여 주고,
 * 그 옆에 실제로 나간 값을 괄호로 붙인다 — 적힌 숫자와 나간 숫자가 다른데 화면이 그
 * 사실을 안 말하면, 나중에 6.35m 를 보냈다고 착각한 채로 결과를 읽는다.
 *
 * 「테스트」를 끄면 이 값은 안 쓰이고 경로가 낸 거리가 그대로 나간다.
 */
export const TEST_FORWARD_M = 1;

/**
 * **경로 이동의 직진 속도(m/s)** (260914 지시 — 「시연 시간이 정해져 있어 약 2배 빠르게」).
 *
 * `move_forward` 에 `vx` 를 안 실으면 로봇 기본값 0.15 m/s 로 걷는다. 규약 상한이 0.30 m/s 이고
 * 그것이 정확히 두 배다(연동 가이드 §4-2 — `vx` 0.05~0.30). 6.4m 가 43초에서 21초가 된다.
 *
 * **회전 속도는 여기서 못 바꾼다** — `turn` · `scan_mission` 에 속도 파라미터가 없다. pi7 쪽 설정이다.
 */
export const APPROACH_VX = 0.3;

/**
 * **스캔 촬영 뒤 대기** (260914 — pi7 에 요청해 들어간 기능).
 *
 * `scan_mission` 에 `hold_after_capture: 1` 을 실으면 로봇이 각 촬영(/frame 전송) 뒤 서서 `scan_hold` 를 보내고,
 * 화면이 그 각도의 탐지 영상을 다 띄운 뒤 `scan_continue { rotation_deg }` 를 보내면 다음 회전으로 간다.
 * 신호가 안 오면 로봇이 `hold_timeout_s` 뒤 스스로 넘어간다 — 화면의 자체 한도(15초, `scanGate.ts`)보다 길게 둔다.
 *
 * 옛 노드는 모르는 파라미터를 무시하고 예전처럼 돈다(pi7 답변). 그때는 `scan_hold` 가 안 오고 화면은 신호를 안 보낸다.
 */
export const SCAN_HOLD_AFTER_CAPTURE = 1;
export const SCAN_HOLD_TIMEOUT_S = 20;

export type BrokerPreset = {
  id: string;
  label: string;
  /** 빈 문자열이면 **아직 값이 없다는 뜻**이다. 화면이 고를 수 없게 막는다. */
  url: string;
  why: string;
};

export const BROKER_PRESETS: readonly BrokerPreset[] = [
  // **기본값.** 망이 바뀌어도 이름이 같다 — 노트북에서 돌리든 발표장에서 돌든 한 주소다.
  { id: 'tailscale', label: 'Tailscale', url: 'ws://pi7.tailcb6bfb.ts.net:9001/mqtt', why: '기본값. 망이 바뀌어도 같은 이름으로 붙는다' },
  { id: 'name', label: '같은 랜 (mDNS)', url: 'ws://pi7.local:9001', why: '같은 랜에 있을 때. 한 홉 짧다' },
  { id: 'lab', label: '랩 Wi-Fi', url: 'ws://192.168.50.172:9001', why: '고정 IP. 이름이 안 풀릴 때' },
  // ↓ 정적 IP 를 받으면 이 줄의 url 만 채운다.
  { id: 'venue', label: '발표장 핫스팟', url: '', why: '정적 IP 미정 — 받는 즉시 채운다. 지어내 넣지 않는다' },
  { id: 'manual', label: '직접 입력', url: '', why: '사용자가 적는다' },
];

/** 고를 수 있는 프리셋인가. 값이 빈 것은 아직 없는 것이다. */
export function presetReady(preset: BrokerPreset): boolean {
  return preset.id === 'manual' || preset.url.trim() !== '';
}

/**
 * **방향과 거리를 정하는 자리. 여기 하나다.** (§3 「방향과 거리의 출처는 한 곳에」)
 *
 * 지금은 대본의 상수를 내놓는다. 하드웨어 쪽이 `door_turn` 과 `move_forward` 를 우리가
 * 산출한 경로대로 움직이게 바꿀 수 있다고 했고, 그때 **이 함수의 속만 바뀐다.**
 * 명령을 쏘는 코드는 값이 대본에서 왔는지 경로 산출에서 왔는지 몰라야 한다.
 *
 * 2D 맵은 다른 담당이라 이번 범위 밖이다 — 경로 산출이 붙는 자리가 여기라는 것만 남긴다.
 */
export type MissionGeometry = {
  /** 스캔을 몇 등분하는가. 지금은 대본의 여덟. */
  steps: number;
  /** 한 걸음의 각도. **상수로 박지 않는다** — 명령 파라미터이고 로봇도 이 값을 쓴다. */
  stepDeg: number;
  /** 접근 거리(m). 경로 산출이 붙으면 그 결과가 들어온다. */
  forwardDistanceM: number;
  /** 값이 어디서 왔는가 — 화면과 보고서가 이 사실을 적는다. */
  source: 'none' | 'path-planner';
};

/**
 * 대본 `params` 에서 읽되, **경로 산출이 와 있으면 그쪽이 이긴다** (260912).
 *
 * 대본의 `forward_distance_m: 4.2` 는 값을 줄 데가 없어서 박아 둔 숫자였다. 이제 탐지가
 * 도면 좌표로 실제 거리를 낸다 — 시료에서 `635.4cm` 였다. 대본 숫자를 그대로 쓰면 로봇이
 * 문 앞이 아니라 엉뚱한 데 선다.
 *
 * 각도는 대본이 계속 정한다 — **몇 등분해서 볼지는 우리가 정하는 것**이고, 탐지는 그
 * 각도마다 무엇을 봤는지만 말한다.
 *
 * 없으면 스캔만 돌린다 — 거리를 지어내지 않는다.
 */
export function missionGeometry(params: Record<string, unknown> | null | undefined): MissionGeometry {
  const steps = typeof params?.viewpoint_count === 'number' ? params.viewpoint_count : 8;
  const stepDeg = typeof params?.viewpoint_step_deg === 'number' ? params.viewpoint_step_deg : 360 / steps;
  const planned = detectState().path;
  if (planned !== null && Number.isFinite(planned.forward_distance_cm) && planned.forward_distance_cm > 0) {
    return { steps, stepDeg, forwardDistanceM: planned.forward_distance_cm / 100, source: 'path-planner' };
  }
  // **대본 거리(`forward_distance_m`)를 쓰지 않는다** (260914 리허설). 그 값으로 방향도 모른 채
  // 4.2m 를 걸었다. 경로가 없으면 거리도 없다 — 0 이고, 이동 버튼은 열리지 않는다.
  return { steps, stepDeg, forwardDistanceM: 0, source: 'none' };
}
