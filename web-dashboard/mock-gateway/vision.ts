/**
 * mock-gateway/vision.ts
 *
 * 합성 영상 + **두 출처의 인지 결과** (VZ-I-06 · VZ-I-07 · VZ-I-09).
 *
 * **왜 합성 영상인가** — 실제 스트림 변환 지점(RTSP→WebRTC/HLS)이 아직 안 정해졌다.
 * 그걸 기다리면 "프레임 참조가 없으면 박스가 어긋난다"를 끝내 실측하지 못한다.
 * 그래서 프레임 번호가 찍힌 도형 몇 개를 15fps로 내려보내고, 브라우저가 canvas에 그린다.
 * 영상 픽셀을 보내는 것이 아니라 **그릴 재료(도형 위치)와 프레임 번호**를 보낸다 —
 * 이 검증에 필요한 것은 화질이 아니라 "몇 번째 프레임인가"이기 때문이다.
 *
 * **왜 탐지를 늦게 보내는가** — 추론이 0.2초 걸리고 영상이 15fps면, 결과가 돌아왔을 때
 * 화면은 이미 약 3프레임 앞서 있다. 그 어긋남을 재현해야 프레임 참조값이 왜 필요한지가
 * 숫자로 나온다.
 *
 * **왜 출처가 둘인가** (HW-R-04 재작성 · AI-E-04 · AI-S-02)
 *
 * 로봇 온보드는 Raspberry Pi와 카메라뿐이다. metric distance 센서를 전제하지 않으므로
 * 온디바이스는 **진행영역과 접근 변화** 같은 최소 안전 판단만 하고, **정밀 객체 분류·추적은
 * 엣지 AI**에서 온다. 급이 다른 두 결과를 한 채널로 섞어 보내면서 출처를 표기하지 않으면
 * 화면의 신뢰도 표시가 무의미해진다 — 거친 결과와 정밀한 결과가 같은 숫자처럼 보인다.
 *
 * 그리고 **엣지 정밀 인지와 다중 관측 연계는 둘 다 선택 기능이다.** 배치에 따라 아예
 * 없을 수 있고, 없다고 기본 인지가 멈춰서는 안 된다. 그래서 이 파일은 셋을 따로 끈다 —
 * 온디바이스(항상), 엣지 정밀(선택), 연계(선택).
 */

import { INTERVALS, VISION } from './config.ts';
import type { Hub } from './hub.ts';

/** 화면에 움직이는 대상 하나. 좌표는 **추론 해상도 기준 픽셀**이다. */
export type VisionObject = {
  track_id: string;
  label: string;
  /** 분류 신뢰도. 낮은 것은 화면에서 시각적으로 구분되어야 한다 (VZ-I-09). */
  confidence: number;
  shape: 'person' | 'robot';
  /** 중심 좌표(추론 해상도 기준). */
  cx: number;
  cy: number;
  w: number;
  h: number;
};

export type VideoFrame = {
  /** 프레임 번호. 탐지 결과가 이 값을 그대로 돌려준다. */
  frame_seq: number;
  /** 서버가 이 프레임을 만든 시각. */
  captured_at: string;
  fps: number;
  /** 표시 해상도 — 브라우저 canvas 크기. */
  display: { width: number; height: number };
  /**
   * 이 프레임의 도형 좌표가 어느 해상도 기준인가.
   * 탐지의 bbox_space.reference와 **같은 값을 공유해야** 둘을 같은 화면에 겹칠 수 있다.
   * 프레임과 탐지가 좌표 선언을 따로 가지면 정합 자체가 성립하지 않는다.
   */
  reference: { width: number; height: number };
  /** 이 프레임의 도형들. 브라우저는 이걸 그린다. */
  objects: VisionObject[];
};

/**
 * bbox 좌표계 선언 (VZ-I-07).
 * 이게 없으면 추론 해상도와 표시 해상도가 다를 때 환산 기준이 없다.
 */
export type BboxSpace = {
  /** normalized(0~1) 인가 absolute(픽셀) 인가. */
  format: 'normalized' | 'absolute';
  /** 원점. */
  origin: 'top-left';
  /** absolute일 때의 기준 해상도. normalized일 때도 참고용으로 함께 보낸다. */
  reference: { width: number; height: number };
};

/**
 * **이 결과를 만든 곳.** HW-R-04 재작성으로 온디바이스와 엣지의 급이 갈렸다.
 *
 * 이 표기가 없으면 화면은 거친 안전 판단과 정밀 분류를 구분할 수 없고, 두 신뢰도를
 * 같은 축으로 읽게 된다. 관제에서 위험한 이유는 단순하다 — 관제사가 "0.9면 확실하다"를
 * 두 결과에 똑같이 적용하게 된다.
 *
 * ※ VZ-C-06의 **원천 종류**(raw / simulated)와는 다른 축이다. 그쪽은 "실물인가
 *   시뮬레이션인가"이고 이쪽은 "어느 급의 인지인가"다. 이름이 비슷해 섞기 쉬우므로
 *   필드 이름을 origin_kind가 아니라 tier·kind로 갈라 둔다.
 */
export type DetectionOrigin = {
  /** device = 로봇 온보드(Pi + 카메라) · edge = 엣지 AI 노드. */
  tier: 'device' | 'edge';
  /** safety_minimal = 진행영역·접근 변화 · precise = 정밀 분류·추적. */
  kind: 'safety_minimal' | 'precise';
  /** 사람이 읽는 출처 이름. 화면에 어휘를 박지 않기 위해 서버가 준다. */
  label: string;
  /**
   * AI-E-04 — 이 인지가 **선택 기능**인가.
   * 온디바이스 최소 안전은 필수, 엣지 정밀은 선택이다. 선택 기능이 없다고
   * 기본 인지가 중단되어서는 안 된다.
   */
  optional: boolean;
};

export type Detection = {
  /**
   * 추적 식별자. **엣지 정밀 결과만 갖는다** —
   * 온디바이스는 프레임 단위 판단이라 프레임을 넘어 같은 대상을 잇지 못한다.
   */
  track_id: string | null;
  /** 온디바이스는 의미 분류를 하지 않으므로 'region' 하나뿐이다. */
  label: string;
  /** 검출 자체의 신뢰도. 두 출처 모두 갖는다. */
  confidence: number;
  /**
   * **의미 분류** 신뢰도. 온디바이스는 분류를 하지 않으므로 null이다.
   * HW-R-04가 "객체 의미 분류 하나에 안전 기능을 의존시키지 않는다"고 못 박은 지점.
   */
  class_confidence: number | null;
  /** [x, y, w, h] — bbox_space가 정하는 좌표계. */
  bbox: [number, number, number, number];
  /**
   * 접근 변화. metric distance 센서가 없으므로 **거리가 아니라 방향만** 판단한다(HW-R-04).
   * 엣지 정밀 결과는 궤적으로 표현하므로 null.
   */
  approach: 'closing' | 'steady' | 'receding' | null;
  /** 이 대상의 최근 궤적 (VZ-I-09). bbox와 같은 좌표계. 온디바이스는 빈 배열. */
  trail: Array<[number, number]>;
  /**
   * 이 탐지를 낸 관측 소스. **연계가 없을 때 소스별 추적을 구분하는 축이다.**
   * 연계가 있으면 대표 소스 하나가 오고 link에 묶인 소스 목록이 실린다.
   */
  source_id: string;
  /**
   * AI-S-02 다중 관측 연계 결과. **연계하지 못했으면 null**이고, 그때 화면은
   * 소스별 추적을 그대로 표시한다 — 연계 신뢰도를 그리지 않는다.
   */
  link: { linked_sources: string[]; link_confidence: number } | null;
};

export type DetectionResult = {
  /**
   * **되돌아온 프레임 참조값.** 이 값이 가리키는 프레임에 박스를 맞춰야 한다.
   * ※ 미결: AI와 하드웨어의 프레임 참조 형식이 다르다. 통일되지 않으면 이 기능 자체가
   *   성립하지 않는다 — 여기서는 정수 frame_seq로 가정한다.
   */
  frame_ref: number;
  /** 결과를 만들어 내보낸 시각. frame_ref 프레임보다 inference_delay_ms 늦다. */
  emitted_at: string;
  inference_delay_ms: number;
  /** 이 결과를 만든 곳과 그 급. 화면은 이걸 읽어 출처를 구분해 그린다(VZ-I-07). */
  origin: DetectionOrigin;
  /**
   * AI-S-02 — 이 배치에 **다중 관측 연계 기능이 있는가.**
   *
   * `unavailable`(기능 자체가 없다)과 개별 탐지의 `link: null`(기능은 있으나 이 대상을
   * 못 묶었다)은 **다른 뜻이다.** 둘을 섞으면 화면이 "연계가 없는 배치"와 "연계에
   * 실패한 대상"을 같게 그리게 된다.
   */
  association: 'enabled' | 'unavailable';
  /**
   * **진행영역** — 로봇이 나아갈 영역 (HW-R-04). 온디바이스 결과만 갖는다.
   * 객체 분류에 의존하지 않는 최소 안전 판단의 근거라, 분류가 없어도 이건 있다.
   */
  corridor: [number, number, number, number] | null;
  bbox_space: BboxSpace;
  detections: Detection[];
};

const TAU = Math.PI * 2;

/** 온디바이스는 대상의 정확한 외곽을 모른다 — 넉넉히 부풀린 영역으로 보고한다. */
const DEVICE_BOX_PAD = 1.25;

export class VisionEmitter {
  private readonly hub: Hub;
  readonly entity: string;

  private frameSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 열린 패널이 없으면 발행하지 않는다 (VZ-I-06 — 열린 패널만 받는다). */
  private openCount = 0;

  /** 궤적 보관 — 대상별 최근 좌표. */
  private readonly trails = new Map<string, Array<[number, number]>>();
  /** 직전 프레임의 화면 중심 거리. 접근 변화 판단의 재료(HW-R-04). */
  private readonly prevCenterDist = new Map<string, number>();

  /** 설정값. 시나리오로 바꿔가며 확인한다. */
  // 타입을 넓혀 둔다 — VISION이 as const라 그대로 두면 리터럴 타입이 되어 못 바꾼다.
  inferenceDelayMs: number = VISION.INFERENCE_DELAY_MS;
  inferenceWidth: number = VISION.INFERENCE_WIDTH;
  inferenceHeight: number = VISION.INFERENCE_HEIGHT;
  bboxFormat: BboxSpace['format'] = VISION.BBOX_FORMAT;

  /**
   * 엣지 정밀 인지가 이 배치에 있는가 (AI-E-04 — 선택 기능).
   * false면 **온디바이스 최소 안전 판단만** 내려간다. 기본 인지는 멈추지 않는다.
   */
  edgeEnabled: boolean = VISION.EDGE_ENABLED;

  /**
   * 다중 관측 연계가 이 배치에 있는가 (AI-S-02 — 선택 기능).
   * false면 같은 대상이 **소스별로 따로** 내려간다.
   */
  associationEnabled: boolean = VISION.ASSOCIATION_ENABLED;

  constructor(hub: Hub, entity: string) {
    this.hub = hub;
    this.entity = entity;
  }

  get isOpen(): boolean {
    return this.openCount > 0;
  }

  /** 패널 열기/닫기. 열린 패널만 프레임을 받는다 — 무선 대역과 디코딩을 동시에 아낀다. */
  setOpen(open: boolean): void {
    this.openCount = Math.max(0, this.openCount + (open ? 1 : -1));
    if (this.openCount > 0 && this.timer === null) this.start();
    if (this.openCount === 0 && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private start(): void {
    const tick = () => {
      this.emitFrame();
      this.timer = setTimeout(tick, INTERVALS.CAMERA_META_MS);
    };
    this.timer = setTimeout(tick, INTERVALS.CAMERA_META_MS);
  }

  /** 대상 위치는 프레임 번호의 함수다 — 그래야 "몇 번 프레임의 위치"가 결정적으로 정해진다. */
  private objectsAt(seq: number): VisionObject[] {
    const t = seq / VISION.FPS;
    const W = this.inferenceWidth;
    const H = this.inferenceHeight;

    return [
      {
        track_id: 'trk-01',
        label: 'person',
        // 높은 신뢰도.
        confidence: 0.94,
        shape: 'person',
        // 좌우로 왕복. 속도를 충분히 줘야 3프레임 어긋남이 눈에 보인다.
        cx: W * 0.5 + Math.sin(t * VISION.PERSON_SPEED_RAD) * W * 0.3,
        cy: H * 0.55,
        w: W * 0.12,
        h: H * 0.5,
      },
      {
        track_id: 'trk-02',
        label: 'robot',
        // 낮은 신뢰도 — 화면에서 구분되어야 한다.
        confidence: 0.41,
        shape: 'robot',
        cx: W * 0.5 + Math.cos(t * VISION.ROBOT_SPEED_RAD + TAU * 0.25) * W * 0.28,
        cy: H * 0.68,
        w: W * 0.18,
        h: H * 0.22,
      },
    ];
  }

  /** 진행영역 — 로봇이 나아가는 방향의 영역이다(HW-R-04). */
  private corridorRect(): [number, number, number, number] {
    const W = this.inferenceWidth;
    const H = this.inferenceHeight;
    return [W * 0.32, H * 0.42, W * 0.36, H * 0.58];
  }

  /**
   * 접근 변화 판단. **거리를 재지 않는다** — metric distance 센서가 없으므로
   * 진행영역 중심에서 멀어지는지 가까워지는지의 **방향만** 본다(HW-R-04).
   */
  private approachOf(o: VisionObject): Detection['approach'] {
    const cxCenter = this.inferenceWidth / 2;
    const dist = Math.abs(o.cx - cxCenter);
    const prev = this.prevCenterDist.get(o.track_id);
    this.prevCenterDist.set(o.track_id, dist);
    if (prev === undefined) return 'steady';
    const delta = dist - prev;
    // 프레임 간 이동이 작을 때 방향을 단정하면 매 프레임 값이 튄다.
    if (Math.abs(delta) < this.inferenceWidth * 0.002) return 'steady';
    return delta < 0 ? 'closing' : 'receding';
  }

  private bboxSpace(): BboxSpace {
    return {
      format: this.bboxFormat,
      origin: 'top-left',
      reference: { width: this.inferenceWidth, height: this.inferenceHeight },
    };
  }

  /** 좌표 환산 배율. normalized면 기준 해상도로 나눈다. */
  private scales(): { sx: number; sy: number } {
    const normalized = this.bboxFormat === 'normalized';
    return {
      sx: normalized ? 1 / this.inferenceWidth : 1,
      sy: normalized ? 1 / this.inferenceHeight : 1,
    };
  }

  private emitFrame(): void {
    this.frameSeq += 1;
    const seq = this.frameSeq;
    const objects = this.objectsAt(seq);

    const frame: VideoFrame = {
      frame_seq: seq,
      captured_at: new Date().toISOString(),
      fps: VISION.FPS,
      display: { width: VISION.DISPLAY_WIDTH, height: VISION.DISPLAY_HEIGHT },
      reference: { width: this.inferenceWidth, height: this.inferenceHeight },
      objects,
    };
    this.hub.publish(this.entity, 'video_frame', frame, { fromDevice: true });

    // 궤적 갱신. **엣지 정밀 결과에만 실린다** — 온디바이스는 추적을 유지하지 못한다.
    for (const o of objects) {
      const trail = this.trails.get(o.track_id) ?? [];
      trail.push([o.cx, o.cy]);
      if (trail.length > VISION.TRAIL_LENGTH) trail.shift();
      this.trails.set(o.track_id, trail);
    }

    const approaches = new Map(objects.map((o) => [o.track_id, this.approachOf(o)] as const));
    const trailsSnapshot = new Map(
      objects.map((o) => [o.track_id, [...(this.trails.get(o.track_id) ?? [])]] as const),
    );

    // ── 온디바이스 최소 안전 판단 — 항상 나간다 (HW-R-04) ──────────────────────
    // 엣지보다 **빠르다.** 안전 기능이 엣지 왕복을 기다리면 안 되기 때문이다.
    this.scheduleDevice(seq, objects, approaches);

    // ── 엣지 정밀 인지 — 선택 기능 (AI-E-04) ──────────────────────────────────
    if (this.edgeEnabled) this.scheduleEdge(seq, objects, trailsSnapshot);
  }

  private scheduleDevice(
    seq: number,
    objects: VisionObject[],
    approaches: Map<string, Detection['approach']>,
  ): void {
    const delay = VISION.DEVICE_DELAY_MS;
    setTimeout(() => {
      if (!this.isOpen) return;
      const { sx, sy } = this.scales();
      const [crx, cry, crw, crh] = this.corridorRect();

      const result: DetectionResult = {
        frame_ref: seq,
        emitted_at: new Date().toISOString(),
        inference_delay_ms: delay,
        origin: {
          tier: 'device',
          kind: 'safety_minimal',
          label: '온디바이스 최소 안전 판단',
          // 최소 안전은 선택 기능이 아니다 — 이게 없으면 로봇이 움직이면 안 된다.
          optional: false,
        },
        // 연계는 엣지의 일이다. 온디바이스는 자기 카메라 하나만 본다.
        association: 'unavailable',
        corridor: [crx * sx, cry * sy, crw * sx, crh * sy],
        bbox_space: this.bboxSpace(),
        detections: objects.map((o) => {
          const w = o.w * DEVICE_BOX_PAD;
          const h = o.h * DEVICE_BOX_PAD;
          return {
            // 프레임 단위 판단 — 프레임을 넘어 같은 대상을 잇지 못한다.
            track_id: null,
            label: 'region',
            confidence: 0.72,
            // 의미 분류를 하지 않는다. 여기에 숫자를 채우면 계약을 어기는 것이다.
            class_confidence: null,
            bbox: [(o.cx - w / 2) * sx, (o.cy - h / 2) * sy, w * sx, h * sy],
            approach: approaches.get(o.track_id) ?? 'steady',
            trail: [],
            source_id: this.entity,
            link: null,
          };
        }),
      };
      this.hub.publish(this.entity, 'detections', result, { fromDevice: true });
    }, delay);
  }

  private scheduleEdge(
    seq: number,
    objects: VisionObject[],
    // 스냅샷은 읽기 전용으로 받는다 — 발행부가 궤적 버퍼를 되고칠 이유가 없다.
    trailsSnapshot: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
  ): void {
    const delay = this.inferenceDelayMs;
    setTimeout(() => {
      if (!this.isOpen) return;
      const { sx, sy } = this.scales();
      const sources = [...VISION.SOURCES];
      const linked = this.associationEnabled;

      const detections: Detection[] = [];
      for (const o of objects) {
        const trail = trailsSnapshot.get(o.track_id) ?? [];

        if (linked) {
          // 연계 성립 — 여러 소스에서 본 같은 대상이 **하나로** 온다.
          detections.push({
            track_id: o.track_id,
            label: o.label,
            confidence: o.confidence,
            class_confidence: o.confidence,
            bbox: [(o.cx - o.w / 2) * sx, (o.cy - o.h / 2) * sy, o.w * sx, o.h * sy],
            approach: null,
            trail: trail.map(([x, y]) => [x * sx, y * sy] as [number, number]),
            source_id: sources[0],
            link: { linked_sources: sources, link_confidence: VISION.LINK_CONFIDENCE },
          });
          continue;
        }

        // 연계 없음 — **소스별 추적을 그대로 유지한다** (VZ-I-09).
        // 같은 대상이 소스마다 따로 뜨고, 두 추적이 같은 것인지는 아무도 말해 주지 않는다.
        sources.forEach((src, i) => {
          // 소스마다 같은 대상을 조금 다르게 본다. 0이면 "따로 뜬다"가 화면에서 안 보인다.
          const off = i * VISION.SOURCE_OFFSET_PX;
          detections.push({
            // 추적 식별자도 소스 안에서만 유효하다 — 소스를 붙이지 않으면
            // 서로 다른 추적이 같은 id로 보인다.
            track_id: src + ':' + o.track_id,
            label: o.label,
            confidence: o.confidence,
            class_confidence: o.confidence,
            bbox: [(o.cx - o.w / 2 + off) * sx, (o.cy - o.h / 2) * sy, o.w * sx, o.h * sy],
            approach: null,
            trail: trail.map(([x, y]) => [(x + off) * sx, y * sy] as [number, number]),
            source_id: src,
            link: null,
          });
        });
      }

      const result: DetectionResult = {
        frame_ref: seq,
        emitted_at: new Date().toISOString(),
        inference_delay_ms: delay,
        origin: {
          tier: 'edge',
          kind: 'precise',
          label: '엣지 정밀 분류·추적',
          // AI-E-04 — 선택 기능이다. 이 배치에 없을 수 있다.
          optional: true,
        },
        association: linked ? 'enabled' : 'unavailable',
        // 진행영역은 온디바이스 안전 판단의 산출물이다. 엣지는 내지 않는다.
        corridor: null,
        bbox_space: this.bboxSpace(),
        detections,
      };
      this.hub.publish(this.entity, 'detections', result, { fromDevice: false });
    }, delay);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  describe(): string {
    return (
      '온디바이스 ' + VISION.DEVICE_DELAY_MS + 'ms · 엣지 ' +
      (this.edgeEnabled ? this.inferenceDelayMs + 'ms' : '미배포') +
      ' · 연계 ' + (this.associationEnabled ? '있음' : '없음(소스별 추적)') +
      ' · 추론 해상도 ' + this.inferenceWidth + 'x' + this.inferenceHeight +
      ' · 표시 ' + VISION.DISPLAY_WIDTH + 'x' + VISION.DISPLAY_HEIGHT +
      ' · bbox ' + this.bboxFormat
    );
  }
}
