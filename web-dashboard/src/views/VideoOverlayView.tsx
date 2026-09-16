/**
 * src/views/VideoOverlayView.tsx
 *
 * VZ-I-06 영상 · VZ-I-07 탐지 오버레이 정합 **+ 인지 출처 구분** · VZ-I-09 추적·궤적.
 *
 * **이 화면의 목적은 그림이 아니라 실측이다.**
 * 정합 on/off를 토글하면 박스가 대상에서 얼마나 뒤처지는지가 눈으로 보이고,
 * 그 거리가 화면에 픽셀 숫자로 뜬다. "프레임 참조가 없으면 어긋난다"를
 * 그림으로 주장하던 것을 여기서 숫자로 바꾼다.
 *
 * **출처가 둘이다** (HW-R-04 재작성). 온디바이스 최소 안전 판단은 진행영역과 접근 변화만
 * 내고 의미 분류를 하지 않는다. 정밀 분류·추적은 엣지 AI에서 오고 **선택 기능이라 없을
 * 수도 있다**(AI-E-04). 두 결과를 같은 모양으로 그리면 관제사가 거친 판단을 정밀 판단으로
 * 읽으므로, 색·선·라벨을 갈라 그리고 목록도 출처별로 나눈다.
 *
 * **영상은 렌더 예산의 예외다.** 상태 병합(100ms)과 별개로 requestAnimationFrame 루프를
 * 돌리되, 그 루프는 canvas만 건드리고 React 상태를 매 프레임 바꾸지 않는다 —
 * 매 프레임 setState 하면 결국 15Hz 리렌더가 되어 병합의 의미가 사라진다.
 */

import { useEffect, useRef, useState } from 'react';
import {
  CONFIDENCE_THRESHOLD,
  EDGE_SILENCE_MS,
  FrameBuffer,
  playScenario,
  resolveAlignment,
  subscribeVision,
  type AlignmentReport,
  type OriginReport,
  type VideoFrame,
} from '../data/index.ts';

const CAMERA = 'camera-02';

/** 계측 표시 갱신 주기. 매 프레임 setState 하지 않기 위한 창. */
const METRICS_REFRESH_MS = 200;

/** 출처별 색. 온디바이스는 주의색(거친 판단), 엣지는 정상색(정밀 판단). */
const ORIGIN_COLOR = {
  device: '#e8a33d',
  edge: { aligned: '#3ddc84', misaligned: '#ff6b6b' },
} as const;

export function VideoOverlayView() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufferRef = useRef(new FrameBuffer());
  /** 토글을 ref로도 들고 있다 — 프레임 루프가 매번 최신 값을 읽어야 하는데
   *  루프를 재생성하면 프레임이 끊기기 때문이다. */
  const alignedRef = useRef(true);

  const [aligned, setAligned] = useState(true);
  const [report, setReport] = useState<AlignmentReport | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [frameCount, setFrameCount] = useState(0);

  useEffect(() => {
    alignedRef.current = aligned;
  }, [aligned]);

  // 구독 + 패널 열기. 닫으면 서버가 프레임 발행을 멈춘다 (VZ-I-06).
  useEffect(() => {
    if (!panelOpen) return;
    const buffer = bufferRef.current;
    return subscribeVision(CAMERA, buffer);
  }, [panelOpen]);

  // 프레임 루프. 상태 병합과 **별개**로 돈다.
  useEffect(() => {
    if (!panelOpen) return;

    let raf = 0;
    let lastMetricsAt = 0;
    let drawn = 0;

    const draw = (now: number) => {
      const canvas = canvasRef.current;
      const buffer = bufferRef.current;
      const frame = buffer.latestFrame;

      if (canvas !== null && frame !== null) {
        const ctx = canvas.getContext('2d');
        if (ctx !== null) {
          const alignment = resolveAlignment(buffer, alignedRef.current, frame);
          drawScene(ctx, frame, alignment, alignedRef.current);
          drawn += 1;

          // 계측 표시는 200ms 창으로 묶는다 — 매 프레임 setState 하면 15Hz 리렌더가 된다.
          if (now - lastMetricsAt > METRICS_REFRESH_MS) {
            lastMetricsAt = now;
            setReport(alignment);
            setFrameCount(drawn);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [panelOpen]);

  const edge = report?.origins.find((o) => o.origin.tier === 'edge') ?? null;
  const device = report?.origins.find((o) => o.origin.tier === 'device') ?? null;

  return (
    <main className="board">
      <header className="board__head">
        <div>
          <h1 className="board__title">탐지 결과 오버레이 정합</h1>
          <p className="board__sub">
            각 탐지에 되돌아온 <strong>프레임 참조값</strong>으로 해당 프레임에 정합시켜야 박스가 대상 위에 놓인다.
            급이 다른 두 인지 결과는 <strong>출처를 구분해</strong> 그린다
          </p>
        </div>
        <div className="board__meta">
          <span>VZ-I-06 · VZ-I-07 · VZ-I-09</span>
        </div>
      </header>

      <div className="videobar">
        <label className="toggle">
          <input type="checkbox" checked={aligned} onChange={(e) => setAligned(e.target.checked)} />
          <span>
            프레임 참조 정합 <strong>{aligned ? 'ON' : 'OFF'}</strong>
          </span>
        </label>

        <button type="button" className="btn" onClick={() => setPanelOpen((v) => !v)}>
          {panelOpen ? '패널 닫기 (프레임 루프 정지)' : '패널 열기'}
        </button>

        {report !== null && (
          <span className={'lagbadge' + (report.maxLagPx > 8 ? ' lagbadge--bad' : '')}>
            뒤처짐 최대 <strong>{report.maxLagPx.toFixed(1)} px</strong> · 평균{' '}
            {report.avgLagPx.toFixed(1)} px · {report.frameLag}프레임
          </span>
        )}
      </div>

      {!panelOpen ? (
        <p className="notice">
          패널이 닫혀 있다. 프레임 루프가 멈췄고 서버도 프레임을 발행하지 않는다 — 열린 패널만 받는다(VZ-I-06).
        </p>
      ) : (
        <>
          {/*
            AI-E-04 — 엣지 정밀 인지는 선택 기능이다. 결과가 안 오는 것을 빈 화면으로 두면
            관제사는 고장으로 읽는다. 다만 "미배포인지 장애인지"는 화면이 알 수 없다 —
            capability 상태를 전달하는 경로가 계약에 없다.
          */}
          {report !== null && !report.edgeAvailable && (
            <p className="notice notice--warn">
              <strong>엣지 정밀 인지 결과가 없다</strong> — 최근 {Math.round(EDGE_SILENCE_MS / 1000)}초간 도착하지
              않았다. 온디바이스 최소 안전 판단(진행영역·접근 변화)만으로 그리는 중이며 <strong>기본 인지는
              끊기지 않았다</strong>. 정밀 분류·추적·궤적은 이 화면에 없다.
              <br />
              <span className="muted">
                미배포(AI-E-04 선택 기능)인지 장애인지는 <strong>구분할 수 없다</strong> — capability 상태를
                가시화까지 전달하는 경로가 계약에 없다. [확인 요망]
              </span>
            </p>
          )}

          {report !== null && report.association === 'unavailable' && (
            <p className="notice notice--warn">
              <strong>다중 관측 연계 없음</strong> — 관측 소스별 추적을 그대로 표시한다(VZ-I-09 / AI-S-02 선택
              기능). 같은 대상이 소스마다 따로 뜨고, <strong>연계 신뢰도는 표시하지 않는다</strong> — 묶지
              못했는데 신뢰도를 띄우면 없는 근거를 만드는 것이다.
            </p>
          )}

          <div className="videoframe">
            <canvas ref={canvasRef} width={960} height={540} className="videocanvas" />
          </div>

          {report !== null && (
            <div className="cols cols--3">
              <section className="panel">
                <header className="panel__head">
                  <h2 className="panel__title">인지 출처</h2>
                  <span className="panel__tag">VZ-I-07 / HW-R-04</span>
                </header>
                <ul className="tracklist">
                  {report.origins.map((o) => (
                    <li key={o.origin.tier} className="tracklist__item">
                      <span className={'prov__who prov__who--' + (o.origin.tier === 'edge' ? 'ai' : 'backend')}>
                        {o.origin.tier === 'edge' ? '엣지' : '온보드'}
                      </span>
                      <strong>{o.origin.label}</strong>
                      <span className="muted">{o.origin.optional ? '선택' : '필수'}</span>
                      <span className="muted">지연 {o.inferenceDelayMs}ms</span>
                      <span className="muted">{o.frameLag}프레임</span>
                    </li>
                  ))}
                  {!report.edgeAvailable && (
                    <li className="tracklist__item tracklist__item--uncertain">
                      <span className="prov__who prov__who--ai">엣지</span>
                      <strong>엣지 정밀 분류·추적</strong>
                      <span className="muted">선택</span>
                      <span className="muted">결과 없음</span>
                      <span className="muted">—</span>
                    </li>
                  )}
                </ul>
                <p className="note">
                  로봇 온보드는 <strong>Pi와 카메라뿐</strong>이라 metric distance 센서를 전제하지 않는다. 그래서
                  온디바이스는 <strong>진행영역과 접근 변화</strong>만 내고 의미 분류를 하지 않는다. 정밀 분류·추적은
                  엣지에서 온다 — 두 결과를 같은 신뢰도 축으로 읽으면 안 된다.
                </p>
              </section>

              <section className="panel">
                <header className="panel__head">
                  <h2 className="panel__title">정합 계측</h2>
                  <span className="panel__tag">VZ-I-07</span>
                </header>
                <dl className="kv">
                  <dt>표시 프레임</dt>
                  <dd>
                    <code>#{report.displayFrame}</code>
                  </dd>
                  {report.origins.map((o) => (
                    <ReportRows key={o.origin.tier} report={o} />
                  ))}
                  <dt>그린 프레임</dt>
                  <dd className="muted">{frameCount}장</dd>
                </dl>
                <p className="note">
                  {aligned
                    ? 'frame_ref가 가리키는 프레임에 맞춰 그린다. 뒤처짐이 0에 가깝다.'
                    : '도착 순서대로 현재 프레임에 그린다. 박스가 대상이 지나간 자리에 남는다.'}
                  {report.origins.some((o) => o.referenceMissing) && (
                    <>
                      {' '}
                      <strong>참조 프레임이 버퍼에 없어</strong> 현재 프레임과 비교한 값이 섞여 있다 —
                      정합된 수치가 아니다. 재접속 직후나 추론 지연이 버퍼 길이를 넘길 때 생긴다.
                    </>
                  )}
                  {device !== null && (
                    <>
                      {' '}온디바이스는 엣지보다 <strong>빠르다</strong>(
                      {device.inferenceDelayMs}ms) — 안전 판단이 엣지 왕복을 기다릴 수 없기 때문이다.
                    </>
                  )}
                </p>
              </section>

              <section className="panel">
                <header className="panel__head">
                  <h2 className="panel__title">추적 대상</h2>
                  <span className="panel__tag">VZ-I-09</span>
                </header>

                {report.origins.map((o) => (
                  <div key={o.origin.tier}>
                    <p className="footnote">
                      {o.origin.label}
                      {o.sourceIds.length > 1 && (
                        <span className="muted"> · 소스 {o.sourceIds.length}개 따로</span>
                      )}
                    </p>
                    <ul className="tracklist">
                      {o.boxes.map((b, i) => (
                        <li
                          key={(b.trackId ?? 'region') + '-' + b.sourceId + '-' + i}
                          className={'tracklist__item' + (b.uncertain ? ' tracklist__item--uncertain' : '')}
                        >
                          <code className={'trackkey' + (b.link !== null ? ' trackkey--linked' : '')}>
                            {b.trackId ?? '추적 없음'}
                          </code>
                          <strong>{b.label}</strong>
                          <span>
                            {/* 분류를 하지 않은 결과에 분류 신뢰도를 그리면 없는 값을 만드는 것이다. */}
                            {b.classConfidence === null ? '분류 없음' : b.classConfidence.toFixed(2)}
                          </span>
                          <span className="muted">
                            {b.approach !== null
                              ? APPROACH_LABEL[b.approach]
                              : b.link !== null
                                ? '연계 ' + b.link.link_confidence.toFixed(2)
                                : '연계 없음'}
                          </span>
                          <span className="muted">{b.lagPx.toFixed(1)} px</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                <p className="note">
                  신뢰도 {CONFIDENCE_THRESHOLD} 미만은 <strong>점선 + 물음표</strong>로 그린다. 확실한 것과 애매한 것이
                  똑같이 보이면 안 된다.
                  {edge !== null && edge.association === 'unavailable' && (
                    <>
                      {' '}지금은 연계가 없어 <strong>소스별 추적이 따로</strong> 뜬다 — 추적 식별자에 소스가
                      붙는 이유는 소스를 지우면 서로 다른 추적이 같은 id로 보이기 때문이다.
                    </>
                  )}
                </p>
              </section>
            </div>
          )}
        </>
      )}

      <section className="devpanel">
        <h2 className="devpanel__title">시나리오 재생 — 숫자가 바뀌는지 확인</h2>
        <div className="devpanel__row">
          <button type="button" className="btn" onClick={() => playScenario('vision-delay-200')}>
            추론 지연 200ms
          </button>
          <button type="button" className="btn" onClick={() => playScenario('vision-delay-500')}>
            추론 지연 500ms
          </button>
          <button type="button" className="btn" onClick={() => playScenario('vision-bbox-absolute')}>
            bbox 픽셀 절대
          </button>
          <button type="button" className="btn" onClick={() => playScenario('vision-bbox-normalized')}>
            bbox 정규화(0~1)
          </button>
          <button type="button" className="btn" onClick={() => playScenario('vision-inference-320')}>
            추론 해상도 320×180
          </button>
          <button type="button" className="btn" onClick={() => playScenario('vision-inference-640')}>
            추론 해상도 640×360
          </button>
        </div>
        <div className="devpanel__row">
          {/* AI-E-04 · AI-S-02 — 선택 기능을 빼 보는 것이 이 두 줄의 목적이다. */}
          <button type="button" className="btn btn--danger" onClick={() => playScenario('vision-edge-off')}>
            엣지 정밀 인지 미배포
          </button>
          <button type="button" className="btn" onClick={() => playScenario('vision-edge-on')}>
            엣지 정밀 인지 배치
          </button>
          <button type="button" className="btn btn--danger" onClick={() => playScenario('vision-link-off')}>
            다중 관측 연계 없음
          </button>
          <button type="button" className="btn" onClick={() => playScenario('vision-link-on')}>
            다중 관측 연계 있음
          </button>
        </div>
      </section>
    </main>
  );
}

const APPROACH_LABEL: Record<'closing' | 'steady' | 'receding', string> = {
  closing: '접근 중',
  steady: '변화 없음',
  receding: '멀어짐',
};

/** 출처 하나의 정합 수치. dl 안에 들어가므로 dt/dd 쌍만 낸다. */
function ReportRows({ report }: { report: OriginReport }) {
  const name = report.origin.tier === 'edge' ? '엣지' : '온보드';
  return (
    <>
      <dt>{name} frame_ref</dt>
      <dd>
        <code>#{report.detectionFrame}</code> <span className="muted">({report.frameLag}프레임 차)</span>
        {report.referenceMissing && (
          <>
            {' '}
            <span className="aggbadge aggbadge--unknown">참조 프레임 없음</span>
          </>
        )}
      </dd>
      <dt>{name} 뒤처짐</dt>
      <dd>
        <strong>{report.maxLagPx.toFixed(1)} px</strong>{' '}
        <span className="muted">평균 {report.avgLagPx.toFixed(1)} px</span>
      </dd>
      <dt>{name} bbox 환산</dt>
      <dd>
        <code>{report.bboxFormat}</code>{' '}
        <span className="muted">
          x {report.scale.x.toFixed(3)} · y {report.scale.y.toFixed(3)}
        </span>
      </dd>
    </>
  );
}

// ── canvas 합성 ──────────────────────────────────────────────────────────────

/**
 * 합성 영상과 오버레이를 그린다.
 * 실제 스트림 변환 지점이 미정이라 목 서버가 준 도형을 직접 그린다 —
 * 이 검증에 필요한 것은 화질이 아니라 "몇 번째 프레임인가"이기 때문이다.
 */
function drawScene(
  ctx: CanvasRenderingContext2D,
  frame: VideoFrame,
  alignment: AlignmentReport | null,
  aligned: boolean,
): void {
  const { width, height } = ctx.canvas;

  // 배경
  ctx.fillStyle = '#1e2227';
  ctx.fillRect(0, 0, width, height);

  // 대상 도형 — 프레임이 선언한 기준 해상도로 표시 해상도에 환산해 그린다.
  const objScaleX = width / frame.reference.width;
  const objScaleY = height / frame.reference.height;

  ctx.fillStyle = '#5b6672';
  for (const o of frame.objects) {
    const cx = o.cx * objScaleX;
    const cy = o.cy * objScaleY;
    const w = o.w * objScaleX;
    const h = o.h * objScaleY;

    if (o.shape === 'person') {
      // 머리 + 몸통
      ctx.beginPath();
      ctx.arc(cx, cy - h * 0.32, w * 0.42, 0, Math.PI * 2);
      ctx.fill();
      roundRect(ctx, cx - w / 2, cy - h * 0.12, w, h * 0.62, 8);
      ctx.fill();
    } else {
      roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 6);
      ctx.fill();
    }
  }

  if (alignment !== null) {
    // 진행영역을 먼저 깔고 그 위에 박스를 올린다 — 순서가 뒤집히면 영역이 박스를 덮는다.
    for (const o of alignment.origins) {
      if (o.corridor === null) continue;
      ctx.strokeStyle = ORIGIN_COLOR.device + 'aa';
      ctx.fillStyle = ORIGIN_COLOR.device + '14';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.fillRect(o.corridor.x, o.corridor.y, o.corridor.w, o.corridor.h);
      ctx.strokeRect(o.corridor.x, o.corridor.y, o.corridor.w, o.corridor.h);
      ctx.setLineDash([]);
      ctx.font = '600 11px "Malgun Gothic", sans-serif';
      ctx.fillStyle = ORIGIN_COLOR.device;
      ctx.fillText('진행영역 (온보드)', o.corridor.x + 6, o.corridor.y + 15);
    }

    // 출처별 박스. **모양이 달라야 한다** — 같은 모양이면 급이 다른 것이 안 보인다.
    for (const o of alignment.origins) {
      const isDevice = o.origin.tier === 'device';
      const color = isDevice
        ? ORIGIN_COLOR.device
        : aligned
          ? ORIGIN_COLOR.edge.aligned
          : ORIGIN_COLOR.edge.misaligned;

      for (const b of o.boxes) {
        ctx.strokeStyle = color;
        // 온디바이스는 외곽을 모른다 — 굵고 성긴 파선으로 "영역"임을 드러낸다.
        ctx.lineWidth = isDevice ? 2 : b.uncertain ? 2 : 3;
        ctx.setLineDash(isDevice ? [12, 6] : b.uncertain ? [7, 5] : []);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.setLineDash([]);

        // 궤적 — 엣지 정밀 결과만 갖는다.
        if (b.trail.length > 1) {
          ctx.strokeStyle = color + '88';
          ctx.lineWidth = 2;
          ctx.beginPath();
          b.trail.forEach(([tx, ty], i) => {
            if (i === 0) ctx.moveTo(tx, ty);
            else ctx.lineTo(tx, ty);
          });
          ctx.stroke();
        }

        // 라벨. 온디바이스는 분류가 없으므로 **분류 신뢰도를 쓰지 않는다.**
        const label = isDevice
          ? '영역 · ' + approachText(b.approach)
          : b.label + ' ' + b.confidence.toFixed(2) + (b.uncertain ? ' ?' : '') +
            (b.link === null ? ' · ' + b.sourceId : '') +
            (aligned ? '' : ' — ' + o.frameLag + '프레임 뒤');
        ctx.font = '600 13px "Malgun Gothic", sans-serif';
        const tw = ctx.measureText(label).width + 12;
        ctx.fillStyle = color;
        ctx.fillRect(b.x, b.y - 20, tw, 19);
        ctx.fillStyle = isDevice ? '#3a2708' : aligned ? '#0b2016' : '#3a0d0d';
        ctx.fillText(label, b.x + 6, b.y - 6);
      }
    }
  }

  // 헤더/푸터 텍스트
  ctx.font = '600 13px "Malgun Gothic", sans-serif';
  ctx.fillStyle = '#e6e9ec';
  ctx.fillText(CAMERA + ' · 합성 영상 · ' + frame.fps + ' fps', 14, 26);

  ctx.font = '12px Consolas, monospace';
  ctx.fillStyle = '#aab2ba';
  const headRight = 'frame #' + frame.frame_seq;
  ctx.fillText(headRight, width - ctx.measureText(headRight).width - 14, 26);

  if (alignment !== null) {
    // 엣지가 없으면 온디바이스 결과로 푸터를 쓴다 — 정합 설명 자체는 여전히 성립한다.
    const primary =
      alignment.origins.find((o) => o.origin.tier === 'edge') ?? alignment.origins[0];
    ctx.fillStyle = aligned ? '#8fe7b4' : '#ff9d9d';
    const foot = aligned
      ? 'detections.frame_ref = #' + primary.detectionFrame + ' → 표시 프레임 #' + alignment.displayFrame + '  일치'
      : 'frame_ref 무시 → 표시 프레임 #' + alignment.displayFrame + '에 #' + primary.detectionFrame +
        ' 결과를 그림  (' + primary.maxLagPx.toFixed(0) + 'px 어긋남)';
    ctx.fillText(foot, 14, height - 16);

    if (!alignment.edgeAvailable) {
      ctx.fillStyle = ORIGIN_COLOR.device;
      ctx.fillText('엣지 정밀 인지 결과 없음 — 온보드 최소 안전 판단만', 14, height - 34);
    }
    if (alignment.origins.some((o) => o.referenceMissing)) {
      ctx.fillStyle = ORIGIN_COLOR.device;
      ctx.fillText('참조 프레임이 버퍼에 없음 — 이 값은 정합된 수치가 아니다', 14, height - 52);
    }
  }
}

function approachText(approach: 'closing' | 'steady' | 'receding' | null): string {
  if (approach === null) return '판단 없음';
  return APPROACH_LABEL[approach];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
