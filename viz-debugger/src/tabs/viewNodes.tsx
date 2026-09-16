/**
 * src/tabs/viewNodes.tsx (260903 — 노드 캔버스 1단계 신설 · 2단계에서 본문을 채웠다)
 *
 * **캔버스에 주입되는 뷰 노드 4종.** 이 파일이 `tabs/` 안에 있는 것이 요점이다 —
 * 통합 빌드만 이것을 등록하고(`integrated.tsx` → `registerViewNodes`), 단독 빌드는
 * 등록하지 않아 팔레트 자체가 뜨지 않는다. 캔버스 쪽(`src/canvas/`)은 이 파일을 모른다.
 *
 * 그렇게 하지 않으면 `tabs/data/` 스토어가 단독 번들에 딸려 들어와 **논문 측정축 D(계측
 * 오버헤드)가 오염된다.** `verify:standalone` 이 그 순간 실패한다 — `PlanApproval` 을
 * 프롭으로 주입하는 것과 같은 이유이고 같은 패턴이다.
 *
 * ## 요약과 확대 (2단계 · `VZ-N-05`)
 *
 * | 노드 | 접힘 = 요약 카드 | 확대 = 오버레이 |
 * |---|---|---|
 * | 장치·위험 | 4종 상태 + 3층 한 줄 + 위험도 등급 | `RiskPanel` + `DeviceGrid` |
 * | 제어 | 이 대상의 명령 수 + 마지막 명령의 4단계 위치 | `ControlPanel`(감사 이력 포함) |
 * | 지표 | 미니 스파크라인 + **요약/원본 표기** | `MetricsView` |
 * | 영상 | 대표 **정지 프레임** + 탐지 수 + 프레임 참조 유무 | `VideoOverlayView`(재생) |
 *
 * 접는 기준은 **"확대하지 않고도 이상함을 알아챌 수 있는 값"** 이다. 그래서 요약에 이름과
 * 아이콘이 아니라 **판정과 숫자**를 담는다.
 *
 * ## 요약도 자리표시 규칙을 지킨다
 *
 * 값을 `PendingSource` 로 감싼다 — 일반 모드에서는 「누가 줄 데이터인지」가 뜨고, 목·대본
 * 모드에서만 값이 뜬다. 감싸지 않으면 캔버스만 이 저장소의 중심 규칙에서 빠져나가고,
 * 시연에서 「이건 진짜 값이냐」에 답할 수 없게 된다.
 *
 * **부수 효과가 있는 요약은 `PendingSource` 의 자식으로 둔다** — 자리표시가 그려지는 동안
 * 자식은 마운트되지 않으므로 지표 폴링도 영상 구독도 **시작되지 않는다.** 카드를 넷 놓았다고
 * 일반 모드에서 폴링이 넷 도는 일이 없다.
 *
 * ## 영상 노드의 계약 — 접힘은 정지 프레임이다
 *
 * `VideoOverlayView` 를 그대로 접힌 카드에 넣으면 노드를 셋 놓는 순간 `requestAnimationFrame`
 * 루프가 셋 돈다(`VZ-I-06` — 탭에서는 떠나면 언마운트돼 멎었지만 캔버스에서는 떠나지 않는다).
 * 그래서 **접힘은 프레임 한 장을 받고 곧바로 구독을 끊는다.** 재생은 확대에서만 돈다.
 */

import { useEffect, useRef, useState } from 'react';
import { PendingSource } from '../shared/PendingSource.tsx';
import type { ViewNodeEntry, ViewScope } from '../canvas/types.ts';
import { NodeGate, PanelGate } from './ScenarioGate.tsx';
import {
  COMMAND_DISPLAY_LABEL,
  COMMAND_STAGE_LABEL,
  DISPLAY_STATUS_LABEL,
  FrameBuffer,
  RANGE_OPTIONS,
  deriveDisplayStatus,
  formatLayers,
  resolveAlignment,
  seriesExtent,
  subscribeVision,
  type MetricPoint,
} from './data/index.ts';
import { useCommands, useEntities, useMetricsQuery, useZoneSummary } from './data/hooks.ts';
import type { RiskState } from '../transport/index.ts';
import { ControlPanel } from './views/ControlPanel.tsx';
import { DeviceGrid } from './views/DeviceGrid.tsx';
import { METRICS, MetricsView } from './views/MetricsView.tsx';
import { RiskPanel } from './views/RiskPanel.tsx';
import { VideoOverlayView } from './views/VideoOverlayView.tsx';
import { ZoneMapMini } from './views/ZoneMapMini.tsx';
import { DeviceFacts, sdkWords } from '../physical/DeviceFacts.tsx';
import { useDeviceStates } from '../physical/deviceState.ts';
import { hardwareTarget } from '../physical/encode.ts';
import { useRobotSession } from '../physical/robotSession.ts';
import { DetectCam, DetectMap, DetectReason } from '../detect/views/DetectViews.tsx';

/** 화면이 쓰는 로봇 id. 하드웨어 id 로 바꾸는 것은 경계 안쪽(`hardwareTarget`) 일이다. */
const ROBOT_ENTITY = 'robot-01';

const RISK_LABEL: Record<RiskState['level'], string> = { normal: '평시', watch: '관찰', alert: '경보', recovery: '복구' };

/** 영상 노드가 보는 카메라. `VideoOverlayView` 와 같은 대상이다(구역 1개 전제). */
const VIDEO_CAMERA = 'camera-02';

// ── ① 장치 · 위험 ────────────────────────────────────────────────────────────

/**
 * 연결된 노드는 **그 태스크의 대상 장비 한 대**를, 전역 노드는 **구역 집계**를 보인다.
 * `VZ-U-03`(계층 뷰)이 이 노드에 함께 온다 — 얕은 깊이가 이 카드이고, 깊은 둘(운영자·
 * 개발자)은 확대 안 `RiskPanel` 의 표시 깊이 전환이다. 세 깊이가 요약 ↔ 확대로 갈린다.
 */
function DeviceRiskBody({ scope }: { scope: ViewScope }) {
  const entities = useEntities();
  const zone = useZoneSummary(scope.zoneId);
  const risk = ([...entities.values()].map((record) => record.riskState).find(Boolean)?.payload ?? null) as RiskState | null;
  const record = scope.deviceId === null ? null : entities.get(scope.deviceId) ?? null;
  const riskLine = risk === null
    ? <em className="vn-dim">위험도 판정 수신 대기</em>
    : <b className={`vn-risk vn-risk--${risk.level}`}>{RISK_LABEL[risk.level]} {risk.score}</b>;

  if (scope.deviceId === null) {
    // 전역 — 구역 넷의 집계가 「이상함을 알아챌 수 있는 값」이다.
    return <>
      <p className="vn-line">정상 {zone.counts.normal} · 장애 {zone.counts.fault} · 판단불가 {zone.counts.unknown} · 미배포 {zone.counts.not_deployed}</p>
      <p className="vn-line">구역 {zone.total}대 · {riskLine}</p>
    </>;
  }
  if (record === null) {
    return <p className="vn-line"><em className="vn-dim">{scope.deviceId} 는 이 구역 레지스트리에 없습니다</em></p>;
  }
  const layers = record.state?.payload ?? null;
  const status = deriveDisplayStatus(layers);
  const telemetry = record.telemetry?.payload as { battery_pct?: number } | undefined;
  return <>
    <p className="vn-line"><b className={`vn-status vn-status--${status}`}>{DISPLAY_STATUS_LABEL[status]}</b>{telemetry?.battery_pct === undefined ? null : <span> 배터리 {telemetry.battery_pct}%</span>}</p>
    {/* 3층은 뭉치지 않는다 — 판정(4종)과 원본 3층을 함께 보여야 「왜 그렇게 판정됐나」가 보인다. */}
    <p className="vn-line vn-mono">{formatLayers(layers)}</p>
    <p className="vn-line">{riskLine}</p>
  </>;
}

// ── ② 제어 ───────────────────────────────────────────────────────────────────

/**
 * 「이 태스크가 낸 명령」이 요구지만, 추적기의 명령은 **로컬 발행 시각**만 갖고 임무 시각
 * (`headSec`)과 이어져 있지 않다. 지어내서 구간으로 자르지 않고 **대상으로만** 거른다 —
 * 카드에도 그렇게 적는다. 구간까지 자르려면 명령에 임무 시각이 실려야 하고, 그건 이 작업의
 * 범위가 아니다(보고서에 남긴다).
 */
function ControlBody({ scope }: { scope: ViewScope }) {
  const commands = useCommands();
  const mine = scope.deviceId === null ? commands : commands.filter((command) => command.entity === scope.deviceId);
  const last = mine.length === 0 ? null : mine[mine.length - 1];
  if (last === null) {
    return <p className="vn-line"><em className="vn-dim">{scope.deviceId ?? '구역'} 에 발행된 명령이 없습니다</em></p>;
  }
  // 추적기는 발행 시점에 `issued` 를 넣으므로 이력이 빈 명령은 없다. 그래도 여기서 죽지는
  // 않게 둔다 — 카드 한 장 때문에 캔버스 전체가 멎으면 안 된다.
  const stage = last.stages.length === 0 ? null : last.stages[last.stages.length - 1];
  return <>
    <p className="vn-line">명령 <b>{mine.length}</b>건 · <b className={`vn-cmd vn-cmd--${last.display}`}>{COMMAND_DISPLAY_LABEL[last.display]}</b></p>
    {/* 4단계 중 어디인지가 이 카드의 핵심이다 — 「발행했는데 ACK 가 안 왔다」가 여기서 보인다. */}
    <p className="vn-line vn-mono">{stage === null ? '단계 이력 없음' : COMMAND_STAGE_LABEL[stage.stage] ?? stage.stage}</p>
    <p className="vn-line vn-dim">{last.actionLabel}{last.progressPct === null ? '' : ` · ${last.progressPct}%`}</p>
  </>;
}

// ── ③ 지표 ───────────────────────────────────────────────────────────────────

/** 이 대상이 내는 지표. 표는 `MetricsView` 하나뿐이라 여기서 베끼지 않고 가져다 쓴다. */
function metricFor(deviceId: string | null): (typeof METRICS)[number] {
  return METRICS.find((metric) => metric.source === deviceId) ?? METRICS[0];
}

/** 점 몇 개를 잇는 선 하나. `MetricsView` 와 같은 이유로 차트 라이브러리를 들이지 않는다. */
function Sparkline({ points }: { points: MetricPoint[] }) {
  if (points.length < 2) return <p className="vn-line vn-dim">점이 부족합니다</p>;
  const { min, max } = seriesExtent(points);
  const span = max - min || 1;
  const line = points
    .map((point, index) => `${(index / (points.length - 1)) * 160},${28 - ((point.value - min) / span) * 24}`)
    .join(' ');
  return <svg className="vn-spark" viewBox="0 0 160 30" preserveAspectRatio="none" aria-hidden="true">
    <polyline points={line} />
  </svg>;
}

function MetricsBody({ scope }: { scope: ViewScope }) {
  const metric = metricFor(scope.deviceId);
  // 요약만 본다 — 원본은 엣지 중계를 거치므로 카드가 주기적으로 두드릴 것이 아니다.
  const { series, loading, error } = useMetricsQuery({ entity: metric.source, metric: metric.id, mode: 'summary', rangeMin: RANGE_OPTIONS[0].min });
  if (error !== null) return <p className="vn-line vn-dim">질의 실패 — {error}</p>;
  if (series === null) return <p className="vn-line vn-dim">{loading ? '질의 중…' : '아직 값이 없습니다'}</p>;
  const { last } = seriesExtent(series.points);
  return <>
    <p className="vn-line">{metric.label} <b>{last === null ? '—' : last.toFixed(1)}</b> {metric.unit}</p>
    <Sparkline points={series.points} />
    {/* **이 화면이 존재하는 이유** — 지금 보는 값이 요약인지 원본인지가 보여야 한다 (VZ-C-03). */}
    <p className="vn-line vn-mono" title={series.badge.title}>{series.badge.short}</p>
  </>;
}

// ── ④ 영상 ───────────────────────────────────────────────────────────────────

/**
 * **정지 프레임 한 장.** 프레임을 받는 즉시 구독을 끊는다 — 캔버스에서는 노드가 떠나지
 * 않으므로 루프를 켜 두면 카드 수만큼 프레임 루프가 돈다(`VZ-I-06`).
 *
 * `scope` 를 받지 않는다 — 구역에 카메라가 하나라는 현재 전제(`VZ-C-05`)에서 연결한
 * 태스크가 무엇이든 보는 카메라가 같다. 카메라가 늘면 그때 `scope.deviceId` 로 고른다.
 */
function VideoStill() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [snap, setSnap] = useState<{ frameSeq: number; fps: number; detections: number; referenceMissing: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const buffer = new FrameBuffer();
    const stop = subscribeVision(VIDEO_CAMERA, buffer);
    let stopped = false;
    const halt = () => { if (!stopped) { stopped = true; stop(); } };
    // 한 장 잡으면 곧바로 끊는다. 200ms 마다 들여다보는 것으로 충분하다 — 실시간이 아니다.
    const timer = setInterval(() => {
      const frame = buffer.latestFrame;
      if (frame === null) return;
      const report = resolveAlignment(buffer, true, frame);
      const canvas = canvasRef.current;
      if (canvas !== null) {
        const ctx = canvas.getContext('2d');
        if (ctx !== null) {
          const scaleX = canvas.width / frame.reference.width;
          const scaleY = canvas.height / frame.reference.height;
          ctx.fillStyle = '#1d2733';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          for (const object of frame.objects) {
            ctx.fillStyle = object.shape === 'robot' ? '#3ddc84' : '#e8a33d';
            ctx.fillRect((object.cx - object.w / 2) * scaleX, (object.cy - object.h / 2) * scaleY, object.w * scaleX, object.h * scaleY);
          }
        }
      }
      setSnap({
        frameSeq: frame.frame_seq,
        fps: frame.fps,
        detections: report === null ? 0 : report.origins.reduce((sum, origin) => sum + origin.boxes.length, 0),
        // 프레임 참조 유무 — 참조가 가리키는 프레임이 버퍼에 없으면 정합된 값이 아니다.
        referenceMissing: report !== null && report.origins.some((origin) => origin.referenceMissing),
      });
      clearInterval(timer);
      halt();
    }, 200);
    return () => { clearInterval(timer); halt(); };
  }, [nonce]);

  return <>
    <canvas ref={canvasRef} className="vn-still" width={164} height={34} />
    {snap === null
      ? <p className="vn-line vn-dim">프레임 대기 중…</p>
      : <p className="vn-line">#{snap.frameSeq} · {snap.fps}fps · 탐지 <b>{snap.detections}</b>건 · {snap.referenceMissing ? <b className="vn-warn">참조 없음</b> : '참조 있음'}</p>}
    {/* 정지 프레임이라는 사실과, 다시 받는 길을 함께 적는다. 재생은 확대에서만 돈다. */}
    <p className="vn-line vn-dim">정지 프레임 <button type="button" className="vn-refresh" onPointerDown={(event) => event.stopPropagation()} onClick={() => setNonce((value) => value + 1)}>다시 받기</button></p>
  </>;
}

// ── 팔레트 네 칸 ─────────────────────────────────────────────────────────────

/**
 * **팔레트는 이 목록을 훑기만 한다** — 종류를 늘릴 때 팔레트 코드를 고치지 않는다는 것이
 * `VZ-N-01` 의 뒷문장이다.
 *
 * 확대 본문은 옛 탭의 화면 그대로이고 `PanelGate` 를 그대로 지난다 — 대본이 그 축을 몰지
 * 않으면 확대해도 「이 대본엔 없음」 카드가 뜬다. 확대라고 해서 접힘 규칙에서 빠져나가면
 * 1편(로봇)에서 수문 제어 화면이 다시 열린다.
 *
 * 260903(3단계)에 **요약과 확대 둘 다 `NodeGate` 를 지난다** — 탭 단위 접힘이 노드 단위로
 * 내려앉은 자리다. 대본이 그 노드의 축을 하나도 몰지 않으면 이미 놓인 카드가 「이 대본엔
 * 없음」으로 갈음되고, 팔레트 버튼은 흐려지되 막히지 않는다.
 */

/**
 * **로봇 노드** (260910 지시 — 「노드 그래프에서도 확인할 수 있게」).
 *
 * 하드웨어 카드에도 같은 값이 있지만 그 카드는 마일스톤 화면에만 있다. 로봇이 도는 동안
 * 태스크 그래프를 보고 있으면 배터리도 링크도 안 보인다 — 실제로 그 화면에서 시연을 본다.
 *
 * ## 자리표시로 감싸지 않는다
 *
 * 다른 네 노드는 `PendingSource` 로 감싼다. 남이 줄 데이터라 일반 모드에서는 「누가 줄
 * 값인지」를 그려야 하기 때문이다. **이 노드의 값은 지금 실제로 오고 있다** —
 * 장비 상태 채널이 5초마다 민다(주소·토픽은 `src/physical/` 경계 안에 있다). 오는 값을 가리면
 * 「연결 전 테스트처럼 보인다」는 지적으로 되돌아간다.
 *
 * 안 오는 값은 감추는 것이 아니라 **줄을 아예 안 그린다**(`DeviceFacts` 와 같은 규칙).
 */
function RobotBody() {
  const session = useRobotSession();
  const devices = useDeviceStates();
  const device = devices[hardwareTarget(ROBOT_ENTITY)] ?? null;

  // 접힘 카드는 **확대하지 않고도 이상함을 알아챌 수 있는 값**만 담는다 (VZ-N-05).
  const bad = device === null
    || device.online === false
    || (device.link !== null && device.link !== 'ok')
    || (device.batteryPct !== null && device.batteryPct < 20);

  return <div className={`robot-node${bad ? ' robot-node--bad' : ''}`}>
    <div className="robot-node-row">
      <b>{ROBOT_ENTITY}</b>
      <span>{session.connection.state === 'open' ? '브로커 ✓' : '브로커 ✕'}</span>
      {device === null
        ? <span>장비 상태 미수신</span>
        : <>
          <span>{device.online === true ? '온라인' : device.online === false ? '오프라인' : '생사 미상'}</span>
          {device.link !== null && <span>링크 {device.link}</span>}
          {/* null 은 「모른다」다 — 0% 로 그리지 않는다 (연동 가이드 §3-3). */}
          {device.batteryPct !== null && <span>배터리 {device.batteryPct}%</span>}
          {device.mode !== null && <span>{device.mode}</span>}
          <span title="구동 브리지 — 평시에는 내려가 있습니다">
            구동 {sdkWords(device.sdkReady, device.sdkAutostart)}
          </span>
        </>}
    </div>
    <div className="robot-node-row robot-node-row--sub">
      {/* 지금 무엇을 하고 있나 — 진행률과 단계. 둘 다 없으면 아무 말도 안 한다. */}
      {session.progress !== null && <span>진행 {session.progress.ack}/{session.progress.of}</span>}
      {session.stage !== null && <span>{session.stage}</span>}
      {session.paused !== null && <b className="robot-node-flag">일시정지</b>}
      {session.stopped !== null && <b className="robot-node-flag">정지됨</b>}
      {session.progress === null && session.stage === null
        && session.paused === null && session.stopped === null && <span>대기 중</span>}
    </div>
  </div>;
}

export const VIEW_NODE_RENDERERS: readonly ViewNodeEntry[] = [
  {
    // 탐지 셋 (260912) — 자리표시로 비어 있던 `video-stream` · `detections` · `zone-map`.
    // **자리표시로 감싸지 않는다** — 실제로 오는 값이다.
    kind: 'detect-cam',
    label: '탐지 영상',
    hint: '탐지가 본 그림 — 상자 입힌 프레임. 도는 동안은 마지막으로 본 각도',
    summary: () => <NodeGate kind="detect-cam"><DetectCam /></NodeGate>,
    zoom: () => <NodeGate kind="detect-cam"><DetectCam zoom /></NodeGate>,
  },
  {
    kind: 'detect-reason',
    label: '판단 근거',
    hint: '왜 문이라고 했나 — 관문 넷과 특징 여덟 점수. 판정은 점수가 아니라 관문이 정한다',
    summary: () => <NodeGate kind="detect-reason"><DetectReason /></NodeGate>,
    zoom: () => <NodeGate kind="detect-reason"><DetectReason zoom /></NodeGate>,
  },
  {
    kind: 'detect-map',
    label: '2D 맵',
    hint: '도면 위의 경로와 계산 다섯 단계 — 우리가 다시 계산하지 않는다',
    // **재생 머리를 넘긴다** (260914) — 도면은 T-A1 이 끝난 뒤에 뜨고, 되감으면 그 시각을 따른다.
    summary: (scope) => <NodeGate kind="detect-map"><DetectMap headSec={scope.headSec} /></NodeGate>,
    zoom: (scope) => <NodeGate kind="detect-map"><DetectMap zoom headSec={scope.headSec} /></NodeGate>,
  },
  {
    kind: 'robot',
    label: '로봇',
    hint: '실물 로봇의 지금 상태 — 링크·배터리·구동 브리지·진행. 대본이 아니라 장비가 미는 값이다',
    // **자리표시로 감싸지 않는다** — 지금 실제로 오고 있는 값이다.
    summary: () => <NodeGate kind="robot"><RobotBody /></NodeGate>,
    zoom: () => <NodeGate kind="robot"><DeviceFacts entityId={ROBOT_ENTITY} /></NodeGate>,
  },
  {
    kind: 'device-risk',
    label: '장치 · 위험',
    hint: 'VZ-U-01 · VZ-I-03 · VZ-I-08 · VZ-U-03 — 4종 상태와 3층, 위험도 등급',
    summary: (scope) => <NodeGate kind="device-risk"><PendingSource id="device-cards" inline entity={scope.deviceId ?? undefined}><DeviceRiskBody scope={scope} /></PendingSource></NodeGate>,
    // 구역 맵(ZoneMapMini)이 여기로 들어왔다 (260903 3단계) — 탭②가 사라지면서 갈 곳이
    // 없어졌다. 축이 coverage·position 이라 장치·위험 노드가 그 집이다. **요구는 하나도
    // 죽지 않는다**(VZ-I-03). 패널마다 축이 달라 각자 접히는 것은 그대로다.
    zoom: () => <NodeGate kind="device-risk">
      <PanelGate id="risk"><RiskPanel /></PanelGate>
      <PanelGate id="zone-map"><ZoneMapMini /></PanelGate>
      <PanelGate id="device-grid"><DeviceGrid /></PanelGate>
    </NodeGate>,
  },
  {
    kind: 'control',
    label: '제어',
    hint: 'VZ-O-01 · 02 · 05 — 이 대상의 명령 수와 마지막 명령의 4단계 위치',
    summary: (scope) => <NodeGate kind="control"><PendingSource id="command-result" inline entity={scope.deviceId ?? undefined} axis="command"><ControlBody scope={scope} /></PendingSource></NodeGate>,
    zoom: () => <NodeGate kind="control"><PanelGate id="control"><ControlPanel /></PanelGate></NodeGate>,
  },
  {
    kind: 'metrics',
    label: '지표',
    hint: 'VZ-I-04 · VZ-C-03 — 미니 스파크라인과 요약/원본 표기',
    summary: (scope) => <NodeGate kind="metrics"><PendingSource id="metrics-query" inline entity={metricFor(scope.deviceId).source}><MetricsBody scope={scope} /></PendingSource></NodeGate>,
    zoom: () => <NodeGate kind="metrics"><MetricsView /></NodeGate>,
  },
  {
    kind: 'video',
    label: '영상',
    hint: 'VZ-I-06 · 07 · 09 — 대표 정지 프레임과 탐지 수 (재생은 확대에서만)',
    // **팔레트에서 뺀다** (260914 지시) — 「탐지 영상」과 겹친다. 렌더러는 남긴다: 옛 대본의
    // 안내줄 「영상 노드로」와 이미 저장된 캔버스가 이 노드를 그린다.
    inPalette: false,
    // 카메라가 하나라 범위를 안 쓴다 — 위 VideoStill 의 주석이 그 이유다.
    summary: () => <NodeGate kind="video"><PendingSource id="video-stream" inline entity={VIDEO_CAMERA} axis="video"><VideoStill /></PendingSource></NodeGate>,
    zoom: () => <NodeGate kind="video"><PanelGate id="video"><VideoOverlayView /></PanelGate></NodeGate>,
  },
];
