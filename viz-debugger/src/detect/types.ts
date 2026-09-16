/**
 * src/detect/types.ts (260912 신설 — 탐지 연동 2단계-B)
 *
 * **탐지 담당이 실제로 내놓는 모양.** 우리가 그려 보낸 규약(`문서/탐지_명령규약_260910.md`)과
 * 다른 자리가 여럿이라, **우리 쪽을 저쪽에 맞췄다**(260912 결정).
 *
 * | 규약 초안 | 실제 | 어떻게 |
 * |---|---|---|
 * | `index` 0~7 | 없음 · `rotation_deg` | 우리가 유도 (`rotation_deg / step_deg`) |
 * | `door` | `found` | 이름만 다르다 |
 * | `confidence` 0~1 | `final_score` **0.27** | 확률이 아니다 — 「특징 최고값」으로 적는다 |
 * | `bbox [x,y,w,h]` | `box_xyxy [x1,y1,x2,y2]` | **우리가 변환한다** |
 * | `reason` 한 문장 | 없음 | **우리가 조립한다** (관문 넷에서) |
 *
 * 여기 적힌 것은 **받는 모양 그대로**다. 화면이 읽는 모양으로 바꾸는 것은 `parse.ts` 하나가
 * 한다 — 두 곳에서 바꾸면 한쪽만 고쳐지는 날이 온다.
 */

/** 한 각도에서 무엇을 봤나. `target_summary.json` 의 `frames[]` 한 칸. */
export type DetectFrame = {
  /** `frame_000113.jpg`. 우리 `step` 과 잇는 유일한 이름이다. */
  frame: string;
  /** **스캔 시작이 0도.** 오른쪽(시계)으로 45도씩 (0·45·…·315). */
  rotation_deg: number;
  found: boolean;
  /** 도면 기준 절대 방위. 받침대로 자세를 역산해야 나온다 — 없을 수 있다. */
  absolute_bearing_deg?: number;
  /** 깊이 추정. **문에서는 못 쓴다** — 아래 `in_valid_calibration_range` 참고. */
  rel_depth?: number;
  distance_cm?: number;
  /** `false` 면 위 `distance_cm` 은 거리가 아니다. 그리면 안 된다. */
  in_valid_calibration_range?: boolean;
  /**
   * 찾은 각도의 특징 최고값. 스키마에는 없고 탐지 창구(`detect_api_server.py`)가 덧붙여 준다 —
   * **로그에만 쓴다.** 판정은 근거(`evidence.final_score`)로 한다. 없을 수 있다.
   */
  final_score?: number;
};

/** 한 각도의 통과 관문. **찾았다는 판정은 점수가 아니라 이 넷이 정한다.** */
export type DetectGate = {
  required: boolean;
  passed: boolean;
  /** 색·모양 관문은 후보 중 이긴 것을 적어 준다. */
  winning_color?: string;
  winning_shape?: string;
  /** 기준영상 관문은 유사도와 임계를 적어 준다. */
  similarity?: number;
  threshold_min?: number;
  /** 채도 관문. */
  median_saturation?: number;
  min_saturation?: number;
};

/** 한 각도의 근거. `frame_0000NN/evidence.json`. */
export type DetectFrameEvidence = {
  target_class: string;
  frame: string;
  rotation_deg: number;
  /** **`[x1,y1,x2,y2]` 다.** 화면이 쓰는 `[x,y,w,h]` 로는 `parse.ts` 가 바꾼다. */
  box_xyxy: readonly number[];
  feature_similarities: Readonly<Record<string, number>>;
  /** 특징 여덟 중 **최고값**이다. 확률이 아니다. */
  final_score: number;
  mandatory_gates: Readonly<Record<string, DetectGate>>;
};

/** 한 클래스의 요약. `target_summary.json`. */
export type DetectSummary = {
  target_class: string;
  localization_ok: boolean;
  frames: readonly DetectFrame[];
  distance_note?: string;
};

/** 경로 산출. `evidence.json`. 스캔이 끝나야 나온다. */
/** 대체 경로의 한 걸음 (260914). A 단상 → B 문만 위치 → C 문 관측만 경로. */
export type FallbackStep = { step: string; ok: boolean; detail: string };

/** 문 겉보기 크기로 어림한 거리의 근거 (260914 — 받침대 없이 거리를 구하는 자리). */
export type DoorDistanceEstimate = {
  method: string;
  formula: string;
  substituted?: string;
  distance_cm?: number;
  estimates_cm?: readonly number[];
  reason?: string;
  per_frame: ReadonlyArray<{
    frame: string; rotation_deg: number; box_w_px: number; box_h_px: number;
    width_clipped?: boolean; height_clipped?: boolean;
    distance_from_width_cm?: number; distance_from_height_cm?: number; skipped_reason?: string;
  }>;
};

/** 로봇이 바로 쓰는 명령 두 개 — `detection-protocol_0914.md` §4. turn 은 **스캔 시작 방향 기준**, 오른쪽 +. */
export type RobotCommandPlan = {
  turn: { deg: number };
  move_forward: { distance_m: number };
  distance_m_in_range: boolean;
  warning?: string;
};

export type DetectPath = {
  target_class: string;
  ok: boolean;
  /**
   * **어느 길로 나온 경로인가** (260914). `map` 은 도면 위 로봇 자리에서(A 단상 · B 문만 위치),
   * `door_relative` 는 자리 없이 문 관측만으로(C) — 도면 경로 그림이 없다.
   */
  path_mode?: 'map' | 'door_relative' | null;
  path_mode_words?: string;
  localization_method?: 'pedestal' | 'door_only' | null;
  localization_reason?: string | null;
  fallback_chain?: readonly FallbackStep[];
  /** 경로 그림(`/detect/path_overlay`)이 있는가. */
  path_overlay_available?: boolean;
  /**
   * **그림이 무엇인가** (260914). `map` 은 추정한 로봇 자리에서 그린 것(A·B), `backtraced` 는 자리를 못 잡은 C 에서
   * 명령(문 방위·거리)을 문에서 거꾸로 따라가 **가정한 출발 자리**로 그린 것이다. 옛 산출물에는 없다.
   */
  path_overlay_kind?: 'map' | 'backtraced' | null;
  /** `backtraced` 일 때 — 가정과 식. `robot_position_cm` 은 여전히 null 이다(추정한 자리가 아니다). */
  backtrace?: {
    assumption: string;
    start_position_cm: readonly number[];
    start_heading_map_deg: number;
    goal_cm: readonly number[];
    start_inside_pedestal?: boolean;
    calculation: Readonly<Record<string, { formula: string; substituted: string }>>;
    note?: string;
  } | null;
  /** 실패일 때만 — 왜 경로가 안 나왔나. */
  reason?: string;
  target_resolution?: { position_cm: readonly number[] | null; source: string; detail: string };
  /** C(문 관측만)에서는 null — 도면 위 자리를 모른다. */
  robot_position_cm: readonly number[] | null;
  current_heading_map_deg: number | null;
  target_position_cm: readonly number[];
  map_bearing_to_target_deg?: number;
  turn_instruction: string;
  turn_deg?: number;
  distance_to_target_cm: number;
  standoff_cm: number;
  forward_distance_cm: number;
  forward_distance_m?: number;
  robot_command?: RobotCommandPlan;
  goal_cm: readonly number[] | null;
  /** 식과 대입값이 문자열로 들어 있다 — **우리가 다시 계산하지 않는다.** */
  path_calculation: Readonly<Record<string, { formula: string; substituted: string; note?: string }>>;
  bearing_refinement?: Record<string, unknown> | null;
  door_distance_estimate?: DoorDistanceEstimate | null;
  pedestal_obstacle_clear?: boolean;
};

/** 무엇을 그 클래스라고 물었나. `features_sent.json`. */
export type DetectFeatures = {
  target_class: string;
  requested_by_command: boolean;
  is_localization_landmark: boolean;
  features_compared: readonly string[];
};

/**
 * **자세 역산.** `unidepth_localization/localization_evidence.json`.
 *
 * 스캔을 돌기 **전에** 나와야 하는 둘이 여기 있다 — 도면상 문의 자리(`T-A1`)와 로봇 자신의
 * 자리·방위(`T-A2`). 받침대를 기준점으로 삼아 역산한 결과라, 문 자신의 관측각으로 구하면
 * 순환 논리가 된다(파일의 `step3` 주석이 그 말을 한다).
 */
export type DetectLocalization = {
  ok: boolean;
  /** 도면상 문의 자리. 이것이 와야 `T-A1` 이 끝난다. */
  door_position_cm_fixed_from_gt?: readonly number[];
  /** 로봇 자신의 자리와 방위. 이 둘이 와야 `T-A2` 가 끝난다. */
  robot_position_cm?: readonly number[];
  current_heading_map_deg?: number;
  /** 무엇으로 잡았나 (260914) — 단상(A) · 문만(B). */
  method?: 'pedestal' | 'door_only';
  pedestal_surface_point_cm?: readonly number[];
  pedestal_distance_avg_cm?: number;
  map_bearing_to_pedestal_deg?: number;
  /** 식과 대입값. **우리가 다시 계산하지 않는다.** */
  rotation_calculation?: Readonly<Record<string, { formula: string; substituted: string; note?: string }>>;
};
