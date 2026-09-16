/**
 * src/data/vision.ts
 *
 * 프레임 버퍼와 **탐지 정합** (VZ-I-06 · VZ-I-07 · VZ-I-09).
 *
 * 이 파일이 두 가지 주장을 코드로 만든다.
 *
 *  1. *"각 탐지에 되돌아온 프레임 참조값으로 해당 프레임에 정합시켜야 박스가 대상 위에 놓인다."*
 *     정합 on/off를 한 함수 안에서 갈라 두는 이유: 두 경로가 멀리 떨어져 있으면
 *     "무엇이 달라서 어긋나는가"가 코드에서 안 보인다. 여기서는 딱 한 줄 차이다 —
 *     **어느 프레임의 도형과 비교하느냐.**
 *
 *  2. *"급이 다른 두 인지 결과를 한 화면에 섞어 그리면 신뢰도 표시가 무의미해진다."*
 *     온디바이스 최소 안전 판단(HW-R-04)과 엣지 정밀 분류·추적은 **출처별로 갈라서**
 *     보관·환산한다. 하나의 배열에 합쳐 두면 화면이 출처를 구분해 그릴 방법이 없다.
 *
 * 영상은 렌더 예산의 예외다. 상태 병합(100ms)과 별개로 프레임 루프가 돌지만,
 * 그 루프는 화면 컴포넌트가 소유하고 이 파일은 **버퍼와 계산만** 한다.
 */

import { getTransport } from '../transport/index.ts';

export type VisionObject = {
  track_id: string;
  label: string;
  confidence: number;
  shape: 'person' | 'robot';
  cx: number;
  cy: number;
  w: number;
  h: number;
};

export type VideoFrame = {
  frame_seq: number;
  captured_at: string;
  fps: number;
  display: { width: number; height: number };
  /** 도형 좌표의 기준 해상도. 탐지의 bbox_space.reference와 같은 값이어야 한다. */
  reference: { width: number; height: number };
  objects: VisionObject[];
};

export type BboxSpace = {
  format: 'normalized' | 'absolute';
  origin: 'top-left';
  reference: { width: number; height: number };
};

/**
 * 이 결과를 만든 곳 (HW-R-04 · AI-E-04).
 *
 * ※ VZ-C-06의 **원천 종류**(raw / simulated)와 다른 축이다. 그쪽은 "실물인가
 *   시뮬레이션인가"이고 이쪽은 "어느 급의 인지인가"다.
 */
export type DetectionOrigin = {
  tier: 'device' | 'edge';
  kind: 'safety_minimal' | 'precise';
  label: string;
  /** 선택 기능인가 (AI-E-04). 없는 배치가 있을 수 있다는 뜻이다. */
  optional: boolean;
};

export type DetectionLink = { linked_sources: string[]; link_confidence: number };

export type Detection = {
  /** 온디바이스는 프레임 단위 판단이라 null. */
  track_id: string | null;
  label: string;
  confidence: number;
  /** 의미 분류 신뢰도. 온디바이스는 분류를 하지 않으므로 null. */
  class_confidence: number | null;
  bbox: [number, number, number, number];
  /** 접근 변화 방향. 거리가 아니다 — 온디바이스에 metric distance 센서가 없다. */
  approach: 'closing' | 'steady' | 'receding' | null;
  trail: Array<[number, number]>;
  source_id: string;
  /** 연계 결과. 못 묶었으면 null이고 그때는 소스별 추적을 그대로 표시한다. */
  link: DetectionLink | null;
};

export type DetectionResult = {
  frame_ref: number;
  emitted_at: string;
  inference_delay_ms: number;
  origin: DetectionOrigin;
  /** 이 배치에 연계 **기능**이 있는가. 개별 탐지의 link: null과 뜻이 다르다. */
  association: 'enabled' | 'unavailable';
  /** 진행영역 (HW-R-04). 온디바이스 결과만 갖는다. */
  corridor: [number, number, number, number] | null;
  bbox_space: BboxSpace;
  detections: Detection[];
};

/**
 * 신뢰도 임계 — 이보다 낮으면 화면에서 **다르게 그린다** (VZ-I-09).
 * 확실한 것과 애매한 것이 똑같이 보이면 안 된다.
 * ※ 미결: 임계값은 AI와 합의해야 한다. 여기 0.6은 시연용 잠정값이다.
 */
export const CONFIDENCE_THRESHOLD = 0.6;

/**
 * 프레임 버퍼 길이.
 * 정합을 하려면 **지나간 프레임을 들고 있어야** 한다 — 추론 결과가 도착할 때
 * 그 프레임은 이미 화면에서 지나갔기 때문이다. 추론 지연 0.5초 × 15fps ≈ 8프레임이므로
 * 여유를 두고 잡는다. 이 버퍼가 곧 "프레임 참조를 쓸 수 있는 최대 지연"이다.
 */
export const FRAME_BUFFER_SIZE = 48;

/**
 * 엣지 정밀 결과가 이만큼 오지 않으면 **"없다"고 표시한다** (AI-E-04).
 *
 * 값이 안 오는 것을 빈 화면으로 두면 관제사는 고장으로 읽는다. 다만 여기서 알 수 있는
 * 것은 "안 온다"까지이고 **미배포인지 장애인지는 구분할 수 없다** —
 * capability 상태(DISABLED / DEGRADED)를 가시화까지 전달하는 경로가 계약에 없다.
 * 그 경로가 생기면 이 추정은 서버 선언으로 대체된다. **[확인 요망]**
 */
export const EDGE_SILENCE_MS = 2_000;

/** 표시 좌표계로 환산된 박스. */
export type ResolvedBox = {
  /** 온디바이스 결과는 추적 식별자가 없다. */
  trackId: string | null;
  label: string;
  confidence: number;
  classConfidence: number | null;
  approach: Detection['approach'];
  sourceId: string;
  link: DetectionLink | null;
  /** 표시 해상도 기준 픽셀. */
  x: number;
  y: number;
  w: number;
  h: number;
  trail: Array<[number, number]>;
  /** 신뢰도가 임계 미만인가. 분류 신뢰도가 없는 결과는 검출 신뢰도로 판단한다. */
  uncertain: boolean;
  /**
   * 이 박스가 **대상에서 얼마나 뒤처졌는가** (표시 픽셀).
   * 정합 on이면 0에 가깝고, off면 추론 지연만큼 벌어진다.
   */
  lagPx: number;
};

export type ResolvedRect = { x: number; y: number; w: number; h: number };

/** 출처 하나에 대한 정합 보고. 출처가 둘이면 이 구조가 둘 온다. */
export type OriginReport = {
  origin: DetectionOrigin;
  /** 탐지 결과가 가리키는 프레임 번호. */
  detectionFrame: number;
  /** 표시 프레임과의 차이. 추론 지연 ÷ 프레임 간격. */
  frameLag: number;
  inferenceDelayMs: number;
  bboxFormat: BboxSpace['format'];
  /** 추론 해상도 → 표시 해상도 환산 배율. */
  scale: { x: number; y: number };
  /** 진행영역 (온디바이스만). */
  corridor: ResolvedRect | null;
  association: DetectionResult['association'];
  boxes: ResolvedBox[];
  maxLagPx: number;
  avgLagPx: number;
  /** 이 출처가 실어 보낸 관측 소스들. 연계가 없으면 둘 이상이 된다. */
  sourceIds: string[];
  /**
   * **`frame_ref`가 가리키는 프레임이 버퍼에 없다.**
   *
   * 정합을 켰는데도 맞출 대상이 없는 상태다. 이때 아래 계산은 현재 프레임과 비교한
   * 값이므로 **정합된 값이 아니다.** 구분하지 않으면 "정합 ON인데 뒤처짐이 크다"가
   * 정합 실패로 읽히고, 실제 원인(참조 프레임이 버퍼를 벗어남)이 가려진다.
   *
   * 재접속 직후나 추론 지연이 버퍼 길이를 넘길 때 일어난다.
   */
  referenceMissing: boolean;
};

export type AlignmentReport = {
  /** 지금 그리는 프레임 번호. */
  displayFrame: number;
  /** 출처별 보고. **없는 출처는 배열에 없다** — 엣지 정밀이 미배포면 하나만 온다. */
  origins: OriginReport[];
  /** 뱃지용 종합값. 정밀 결과가 있으면 그것, 없으면 온디바이스 값. */
  maxLagPx: number;
  avgLagPx: number;
  frameLag: number;
  /**
   * 엣지 정밀 결과가 지금 오고 있는가 (AI-E-04).
   * false면 화면이 "정밀 인지 결과 없음"을 말해야 한다 — 빈 화면으로 두면 고장으로 읽힌다.
   */
  edgeAvailable: boolean;
  /**
   * 다중 관측 연계 상태 (AI-S-02).
   * `unknown`은 엣지 결과가 없어 판단할 근거조차 없는 상태다.
   */
  association: DetectionResult['association'] | 'unknown';
};

/**
 * 프레임 버퍼.
 *
 * 지나간 프레임을 들고 있어야 `frame_ref`가 가리키는 프레임을 되찾을 수 있다.
 * 탐지는 **출처별로** 보관한다 — 하나의 슬롯에 덮어쓰면 온디바이스 결과가 엣지 결과를
 * 지우고, 급이 다른 둘 중 하나가 매 프레임 사라진다.
 */
export class FrameBuffer {
  private frames: VideoFrame[] = [];
  private readonly detections = new Map<DetectionOrigin['tier'], DetectionResult>();
  private readonly receivedAt = new Map<DetectionOrigin['tier'], number>();

  pushFrame(frame: VideoFrame): void {
    this.frames.push(frame);
    if (this.frames.length > FRAME_BUFFER_SIZE) this.frames.shift();
  }

  pushDetection(result: DetectionResult): void {
    // 출처 표기가 없는 결과는 옛 계약이거나 표기를 빼먹은 발신자다.
    // 조용히 device로 취급하면 거친 결과가 정밀 결과처럼 보이므로, 판단 불가로 둔다.
    const tier = result.origin?.tier;
    if (tier !== 'device' && tier !== 'edge') return;
    this.detections.set(tier, result);
    this.receivedAt.set(tier, Date.now());
  }

  get latestFrame(): VideoFrame | null {
    return this.frames.length === 0 ? null : this.frames[this.frames.length - 1];
  }

  detectionOf(tier: DetectionOrigin['tier']): DetectionResult | null {
    return this.detections.get(tier) ?? null;
  }

  /** 이 출처의 결과가 최근에 왔는가. 안 오면 화면이 "없다"를 표시할 근거가 된다. */
  isFresh(tier: DetectionOrigin['tier'], withinMs: number): boolean {
    const at = this.receivedAt.get(tier);
    return at !== undefined && Date.now() - at <= withinMs;
  }

  frameAt(seq: number): VideoFrame | null {
    return this.frames.find((f) => f.frame_seq === seq) ?? null;
  }

  get bufferedCount(): number {
    return this.frames.length;
  }

  clear(): void {
    this.frames = [];
    this.detections.clear();
    this.receivedAt.clear();
  }
}

/**
 * 출처 하나의 정합 계산.
 *
 * `aligned = true`  — `frame_ref`가 가리키는 프레임의 도형과 비교한다. 박스가 대상 위에 온다.
 * `aligned = false` — 도착 순서대로 **현재 프레임**의 도형과 비교한다.
 *                     박스는 몇 프레임 전 위치에 그려지므로 대상 뒤에 남는다.
 *
 * 두 경우 모두 **박스 좌표 자체는 같다.** 달라지는 것은 "무엇과 비교하는가"뿐이고,
 * 그 차이가 곧 화면에서 보이는 어긋남이다.
 */
function resolveOrigin(
  buffer: FrameBuffer,
  detection: DetectionResult,
  aligned: boolean,
  displayFrame: VideoFrame,
): OriginReport {
  const space = detection.bbox_space;
  const display = displayFrame.display;

  // bbox 좌표계 환산 (VZ-I-07).
  // normalized면 표시 해상도를 곱하고, absolute면 기준 해상도 대비 배율을 곱한다.
  // **이 선언이 계약에 없으면 여기서 무엇을 곱할지 정할 수 없다.**
  const scaleX = space.format === 'normalized' ? display.width : display.width / space.reference.width;
  const scaleY = space.format === 'normalized' ? display.height : display.height / space.reference.height;

  // 정합 on이면 결과가 가리키는 프레임을, off면 지금 그리는 프레임을 기준으로 삼는다.
  const referenced = aligned ? buffer.frameAt(detection.frame_ref) : null;
  const referenceFrame = referenced ?? displayFrame;
  // 정합을 켰는데 참조 프레임이 없으면 **정합한 것이 아니다.** 조용히 현재 프레임으로
  // 떨어지면 그 값이 정합 결과로 읽힌다.
  const referenceMissing = aligned && referenced === null;
  const objScaleX = display.width / referenceFrame.reference.width;
  const objScaleY = display.height / referenceFrame.reference.height;

  const boxes: ResolvedBox[] = detection.detections.map((d) => {
    const [bx, by, bw, bh] = d.bbox;
    const x = bx * scaleX;
    const y = by * scaleY;
    const w = bw * scaleX;
    const h = bh * scaleY;

    // 박스 중심과, 비교 기준 프레임에서의 같은 대상 중심 사이 거리.
    const boxCx = x + w / 2;
    const boxCy = y + h / 2;
    // 온디바이스 결과는 추적 식별자가 없어 대상을 이름으로 짚을 수 없다.
    // 그래서 **가장 가까운 도형**과 비교한다 — 추적이 없다는 사실 자체가
    // 뒤처짐 계산을 거칠게 만든다는 것을 여기서 드러낸다.
    const obj =
      d.track_id === null
        ? nearestObject(referenceFrame, boxCx, boxCy, objScaleX, objScaleY)
        : referenceFrame.objects.find((o) => d.track_id === o.track_id || d.track_id?.endsWith(':' + o.track_id)) ?? null;
    const lagPx =
      obj === null ? 0 : Math.hypot(boxCx - obj.cx * objScaleX, boxCy - obj.cy * objScaleY);

    // 분류를 하지 않는 결과에 분류 임계를 적용하면 전부 "불확실"이 된다.
    // 온디바이스는 검출 신뢰도로 판단한다.
    const judged = d.class_confidence ?? d.confidence;

    return {
      trackId: d.track_id,
      label: d.label,
      confidence: d.confidence,
      classConfidence: d.class_confidence,
      approach: d.approach,
      sourceId: d.source_id,
      link: d.link,
      x,
      y,
      w,
      h,
      trail: d.trail.map(([tx, ty]) => [tx * scaleX, ty * scaleY] as [number, number]),
      uncertain: judged < CONFIDENCE_THRESHOLD,
      lagPx,
    };
  });

  const lags = boxes.map((b) => b.lagPx);
  const corridor = detection.corridor;

  return {
    origin: detection.origin,
    detectionFrame: detection.frame_ref,
    frameLag: displayFrame.frame_seq - detection.frame_ref,
    inferenceDelayMs: detection.inference_delay_ms,
    bboxFormat: space.format,
    scale: { x: scaleX, y: scaleY },
    corridor:
      corridor === null
        ? null
        : { x: corridor[0] * scaleX, y: corridor[1] * scaleY, w: corridor[2] * scaleX, h: corridor[3] * scaleY },
    association: detection.association,
    boxes,
    maxLagPx: lags.length === 0 ? 0 : Math.max(...lags),
    avgLagPx: lags.length === 0 ? 0 : lags.reduce((a, b) => a + b, 0) / lags.length,
    sourceIds: [...new Set(detection.detections.map((d) => d.source_id))],
    referenceMissing,
  };
}

/** 추적 식별자가 없는 결과를 도형에 짚어 주는 보조. 가장 가까운 도형을 고른다. */
function nearestObject(
  frame: VideoFrame,
  cx: number,
  cy: number,
  scaleX: number,
  scaleY: number,
): VisionObject | null {
  let best: VisionObject | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const o of frame.objects) {
    const d = Math.hypot(cx - o.cx * scaleX, cy - o.cy * scaleY);
    if (d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  return best;
}

/**
 * **정합 계산 — 출처별로 따로 낸다.**
 *
 * 온디바이스 최소 안전 판단과 엣지 정밀 분류는 지연도 다르고 담는 필드도 다르다.
 * 하나의 보고로 합치면 화면이 "이 박스가 어느 급인가"를 알 수 없고, 그러면
 * 신뢰도 표시가 무의미해진다(HW-R-04 재작성으로 생긴 요구).
 */
export function resolveAlignment(
  buffer: FrameBuffer,
  aligned: boolean,
  displayFrame: VideoFrame | null,
): AlignmentReport | null {
  if (displayFrame === null) return null;

  const origins: OriginReport[] = [];
  // 표시 순서를 고정한다 — 온디바이스가 먼저다. 안전 판단이 목록 아래로 밀리면 안 된다.
  for (const tier of ['device', 'edge'] as const) {
    const detection = buffer.detectionOf(tier);
    if (detection === null) continue;
    if (!buffer.isFresh(tier, EDGE_SILENCE_MS)) continue;
    origins.push(resolveOrigin(buffer, detection, aligned, displayFrame));
  }

  if (origins.length === 0) return null;

  const edge = origins.find((o) => o.origin.tier === 'edge') ?? null;
  // 뱃지에는 정밀 결과의 숫자를 우선 쓴다 — 사람이 보는 "박스가 맞나"는 그쪽이다.
  const primary = edge ?? origins[0];

  return {
    displayFrame: displayFrame.frame_seq,
    origins,
    maxLagPx: primary.maxLagPx,
    avgLagPx: primary.avgLagPx,
    frameLag: primary.frameLag,
    edgeAvailable: edge !== null,
    association: edge === null ? 'unknown' : edge.association,
  };
}

/**
 * 영상 구독 + 패널 열기를 한 번에 처리한다.
 *
 * 화면이 transport를 직접 부르지 않게 하려고 여기서 감싼다. 반환된 함수를 부르면
 * 구독 해제와 **패널 닫기**가 함께 일어나므로, 패널을 떠나면 서버가 프레임 발행을 멈춘다
 * (VZ-I-06 — 열린 패널만 받는다).
 *
 * 프레임은 store를 거치지 않고 버퍼로 직접 들어간다. 15fps × 프레임마다 store 스냅샷을
 * 갈면 100ms 병합 창의 의미가 사라지고 상태 화면까지 같이 리렌더되기 때문이다.
 */
export function subscribeVision(entity: string, buffer: FrameBuffer): () => void {
  const transport = getTransport();

  const unsubscribe = transport.subscribe(
    { entity, node: '*', channel: '*' },
    (envelope) => {
      if (envelope.channel === 'video_frame') buffer.pushFrame(envelope.payload as VideoFrame);
      else if (envelope.channel === 'detections') buffer.pushDetection(envelope.payload as DetectionResult);
    },
    'all',
  );

  transport.setVideoPanel(entity, true);

  return () => {
    transport.setVideoPanel(entity, false);
    unsubscribe();
    buffer.clear();
  };
}
