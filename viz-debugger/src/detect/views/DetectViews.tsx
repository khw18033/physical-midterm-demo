/**
 * src/detect/views/DetectViews.tsx (260912 신설)
 *
 * **탐지가 채우는 세 자리** — 영상 · 근거 · 2D 맵.
 *
 * 셋 다 지금까지 자리표시(`video-stream` · `detections` · `zone-map`)로 비어 있던 곳이다.
 * 값을 줄 데가 없어서 비워 둔 것이었고, 이제 생겼다.
 *
 * ## 자리표시로 감싸지 않는다
 *
 * 다른 뷰 노드는 `PendingSource` 로 감싼다 — 남이 줄 데이터라 일반 모드에서는 「누가 줄
 * 값인지」를 그려야 하기 때문이다. **이 셋의 값은 실제로 온다.** 아직 안 왔으면 감추는
 * 것이 아니라 **안 왔다고 적는다.** 로봇 노드와 같은 규칙이다.
 *
 * ## 점수를 퍼센트로 안 쓴다
 *
 * `final_score` 는 특징 여덟 중 최고값이지 확률이 아니다. 0.27 을 「27%」로 적으면 보는
 * 사람은 「거의 못 찾았다」로 읽는데, 실제로는 관문 넷을 다 통과한 판정이다.
 * 이름을 `특징 최고값` 으로 적는 것만으로 그 오독이 사라진다 (`parse.ts` 의 `SCORE_LABEL`).
 */

import { useEffect, useState } from 'react';
import { displayMission, useMission } from '../../data/scenario.ts';
import { foldStatuses } from '../../data/fold.ts';
import { usePrepStage } from '../../physical/prepStage.ts';
import { floorPlanUrls, frameImageUrl, pathImageUrl, roundedImageUrl, viewSourceOf } from '../DetectClient.ts';
import { DETECT_TASKS } from '../detectLog.ts';
import { DOOR_PX, FLOOR_PLAN_SIZE_PX } from '../floorPlan.ts';
import { chosenFrame, gateWords, indexOfRotation, SCORE_LABEL, usableDistanceCm } from '../parse.ts';
import { sweepDone } from '../detectBridge.ts';
import { useDetect } from '../store.ts';
import { noteScanImageFailed, noteScanImageShown, registerScanImageView } from '../../physical/scanGate.ts';
import type { DetectFrame } from '../types.ts';

/**
 * 아직 아무것도 안 왔을 때. **감추지 않고 적는다.**
 *
 * 시료로 읽는지 실제 서비스로 읽는지는 **노드에 적지 않는다** (260914 지시). 무대 화면에서
 * 「테스트」가 보이면 연결 전 시험처럼 읽힌다 — 어디서 읽는지는 연결 관리가 말한다.
 */
function Waiting({ what }: { what: string }) {
  const { staleFrames } = useDetect();
  return <p className="detect-wait">
    {what}
    {/* **지난 판을 거르고 있으면 그렇다고 적는다** (260914). 안 적으면 탐지 서비스는 결과를
        내주고 있는데 화면만 비어 있어, 「연결이 안 된다」로 읽힌다. */}
    {staleFrames !== null && <small>탐지 서비스에 남은 지난 판 결과({staleFrames}각도)는 쓰지 않습니다 — 새 스캔이 시작되면 받습니다</small>}
  </p>;
}

/**
 * **도는 동안은 마지막으로 본 각도, 다 돌면 고른 각도** (260914 고침).
 *
 * 전에는 도는 중에도 「지금까지 찾은 것 중 최고」를 먼저 보여 줘서, 90도에서 문이 한 번 찾히면 뒤 각도들이
 * 와도 탐지 영상이 90도에 붙어 있었다. 각도 칸은 그 각도의 그림이 뜬 뒤에 넘어가므로(`physical/scanGate.ts`)
 * 뷰가 최신 각도를 따라가야 칸과 로봇이 같이 간다.
 */
function focusFrame(frames: readonly DetectFrame[], score: (f: DetectFrame) => number, count: number): DetectFrame | null {
  if (frames.length < count) return frames.at(-1) ?? null;
  return chosenFrame(frames, score) ?? frames.at(-1) ?? null;
}

/** 이 임무의 각도 칸 수. */
function viewpointCountOf(): number {
  const count = displayMission().view.params?.viewpoint_count;
  return typeof count === 'number' ? count : 8;
}

// ── 영상 ─────────────────────────────────────────────────────────────────────

/**
 * **탐지가 본 그림.** 고른 각도의 상자 입힌 프레임이다.
 *
 * 스캔이 도는 동안에는 **마지막으로 본 각도**를 보여 준다 — 그래야 「지금 어디를 보고
 * 있나」가 화면에 남는다. 다 돌고 나면 고른 각도에 머문다.
 */
export function DetectCam({ zoom = false }: { zoom?: boolean }) {
  const state = useDetect();
  const source = viewSourceOf(state);
  const score = (f: DetectFrame) => state.evidence[f.frame]?.final_score ?? 0;
  const focus = focusFrame(state.frames, score, viewpointCountOf());
  /**
   * **아래 작은 각도를 누르면 그 각도를 크게** (260914 지시). 고른 것이 없거나 그 판에 더는 없는 각도면
   * 원래대로(도는 동안 최신 · 다 돌면 고른 각도). 같은 칸을 한 번 더 누르거나 「원래대로」로 푼다.
   */
  const [pickedFrame, setPickedFrame] = useState<string | null>(null);
  const picked = pickedFrame === null ? null : state.frames.find((item) => item.frame === pickedFrame) ?? null;
  const frame = picked ?? focus;
  // **이 뷰가 떠 있다고 문지기에 알린다** — 각도 칸은 여기 그림이 다 그려진 뒤에 넘어간다.
  useEffect(() => registerScanImageView(), []);
  if (frame === null) return <Waiting what="탐지 영상이 아직 없습니다" />;

  // 찾은 각도는 상자 입힌 것을, 못 찾은 각도는 원본을 — 없는 상자를 그린 척하지 않는다.
  const urlOf = (item: DetectFrame) => roundedImageUrl(frameImageUrl(source, item.frame, item.found ? 'target_overlay' : 'original'), state.imageRound);
  const url = urlOf(frame);
  const toggle = (item: DetectFrame) => setPickedFrame((current) => (current === item.frame ? null : item.frame));
  return <div className={`detect-cam${zoom ? ' detect-cam--zoom' : ''}`}>
    <img src={url} alt={`${frame.rotation_deg}도 프레임`} onLoad={() => noteScanImageShown(url)} onError={() => noteScanImageFailed(url)} />
    <span className="detect-cam__at">
      {frame.rotation_deg}도 · {frame.found ? '문 있음' : '문 없음'}
      {picked !== null && picked.frame !== focus?.frame && <>
        {' '}· 골라 본 각도
        <button type="button" className="detect-cam__back" onClick={() => setPickedFrame(null)}>원래대로 ({focus?.rotation_deg ?? '-'}도)</button>
      </>}
    </span>
    {zoom && <div className="detect-strip">
      {state.frames.map((item) => {
        const thumb = urlOf(item);
        return <figure key={item.frame}
          className={`${item.found ? 'is-found' : ''}${item.frame === frame.frame ? ' is-shown' : ''}`}
          role="button" tabIndex={0} title={`${item.rotation_deg}도를 크게 보기`}
          onClick={() => toggle(item)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(item); } }}>
          {/* 작은 그림도 화면에 뜬 것이다 — 큰 자리를 다른 각도로 골라 둬도 문지기가 멈추지 않는다. */}
          <img src={thumb} alt={`${item.rotation_deg}도`} onLoad={() => noteScanImageShown(thumb)} />
          <figcaption>{item.rotation_deg}도</figcaption>
        </figure>;
      })}
    </div>}
  </div>;
}

// ── 근거 ─────────────────────────────────────────────────────────────────────

/**
 * **왜 문이라고 했나.** 관문 넷과 특징 여덟 점수, 그리고 잘라낸 그림.
 *
 * 찾았다는 판정은 **점수가 아니라 관문이 정한다.** 그래서 관문을 먼저, 점수를 뒤에 적는다.
 */
export function DetectReason({ zoom = false, count = 8 }: { zoom?: boolean; count?: number }) {
  const state = useDetect();
  const source = viewSourceOf(state);
  const score = (f: DetectFrame) => state.evidence[f.frame]?.final_score ?? 0;
  /**
   * **근거는 판정 뒤에 나온다** (260912 지시). 도는 동안에는 아직 고른 것이 없다 —
   * 세 각도만 보고 근거를 띄우면 다섯째에서 답이 바뀌었을 때 근거도 같이 바뀐다.
   */
  if (!sweepDone(count)) {
    return state.frames.length === 0
      ? <Waiting what="판단 근거가 아직 없습니다" />
      : <p className="detect-wait">탐색 중입니다 — {state.frames.length}/{count} 각도
        <small>여덟을 다 본 뒤에 판정과 근거가 나옵니다</small></p>;
  }
  const frame = chosenFrame(state.frames, score);
  if (frame === null) {
    return <p className="detect-wait">여덟 각도에서 문을 못 찾았습니다<small>임의로 한 방향을 고르지 않습니다</small></p>;
  }
  const evidence = state.evidence[frame.frame] ?? null;
  const gates = Object.entries(evidence?.mandatory_gates ?? {});

  return <div className="detect-reason">
    <div className="detect-reason__head">
      <b>{frame.rotation_deg}도</b>
      {evidence !== null && <span className="detect-score">{SCORE_LABEL} {evidence.final_score.toFixed(3)}</span>}
    </div>
    <ul className="detect-gates">
      {gates.map(([name, gate]) => <li key={name} className={gate.passed ? 'is-pass' : 'is-fail'}>
        {gate.passed ? '✓' : '✕'} {gateWords(name, gate)}
      </li>)}
      {gates.length === 0 && <li>관문 근거 미수신</li>}
    </ul>
    {zoom && <>
      {evidence !== null && <img className="detect-crop"
        src={roundedImageUrl(frameImageUrl(source, frame.frame, 'target_crop'), state.imageRound)} alt="잘라낸 목표" />}
      {/* 특징 여덟 — 무엇을 문이라고 물었고 각각 얼마나 닮았나. */}
      {evidence !== null && <table className="detect-features">
        <tbody>
          {Object.entries(evidence.feature_similarities)
            .sort((a, b) => b[1] - a[1])
            .map(([feature, value]) => <tr key={feature}>
              <th>{feature}</th><td>{value.toFixed(4)}</td>
            </tr>)}
        </tbody>
      </table>}
      {/* 도면 기준 **실제 방위**는 여기에만 적는다 — 화면이 가리키는 각도는 스캔 시작 기준이다. */}
      {frame.absolute_bearing_deg !== undefined && <p className="detect-note">
        도면 기준 방위 {frame.absolute_bearing_deg}도 · 화면의 {frame.rotation_deg}도는 스캔 시작 기준입니다
      </p>}
      {usableDistanceCm(frame) === null && frame.distance_cm !== undefined && <p className="detect-note">
        깊이 추정은 보정범위 밖이라 거리로 쓰지 않습니다 — 거리는 도면 좌표로 냅니다
      </p>}
      {state.features !== null && <p className="detect-note">
        물어본 특징 {state.features.features_compared.length}개
        {state.features.is_localization_landmark && ' · 자세 역산 기준점'}
      </p>}
    </>}
  </div>;
}

// ── 2D 맵 ────────────────────────────────────────────────────────────────────

/**
 * **도면, 그리고 그 위의 경로.** 그림 한 장이 두 얼굴을 갖는다.
 *
 *   경로 산출 전   아무것도 안 그린 도면 — 임무 내내 있는 것이라 비워 두지 않는다
 *   경로 산출 후   탐지가 그려 준 경로 (`T-B1` 이 완료로 뜨는 바로 그때다)
 *
 * 바뀌는 시점이 `T-B1` 의 완료와 **같은 값에 걸려 있다**(`state.path !== null`). 두 군데서
 * 따로 판단하면 노드는 초록인데 그림은 그대로인 날이 온다.
 *
 * `path_calculation` 은 식과 대입값이 문자열로 들어 있다 — **우리가 다시 계산하지 않는다.**
 * 그대로 늘어놓는 것이 「왜 90도를 돌았나」에 대한 답이 된다.
 */
export function DetectMap({ zoom = false, headSec }: { zoom?: boolean; headSec?: number }) {
  const state = useDetect();
  const source = viewSourceOf(state);
  const path = state.path;
  const prep = usePrepStage();
  useMission();                                          // 노드 상태가 바뀌면 다시 그린다
  const display = displayMission();

  /**
   * **도면은 「2D 맵에서 문 위치 확인」(T-A1)이 끝난 뒤에 뜬다** (260914 지시).
   *
   * 전에는 처음부터 떠 있었다. 그러면 노드는 대기인데 맵은 이미 떠 있어, 그 걸음이 무엇을
   * 했는지 화면에서 안 보였다. 노드 상태를 그대로 읽는다 — 로봇이 몰 때는 `prepStage` 가,
   * 대본 재생에서는 대본이 칠한 같은 상태다. 되감으면 그 시각의 상태를 따른다.
   *
   * 이 임무에 T-A1 이 없으면(다른 편) 기다리지 않는다.
   */
  const hasMapTask = display.view.tasks.some((task) => task.id === DETECT_TASKS.map);
  const mapDone = !hasMapTask
    || foldStatuses(headSec ?? display.headSec, display.view, display.trace).tasks[DETECT_TASKS.map]?.status === 'done';

  // 준비 단계가 실제로 받아 온 주소가 있으면 그것을 그린다 — 받은 그림과 그린 그림이 같아야 한다.
  // 다시보기면 그 판의 기록 폴더 → 저장소 사본 순서다 — 기록에 도면이 없어도 빈 상자가 안 된다.
  const planUrls = source.kind !== 'record' && prep.map.url !== null ? [prep.map.url] : floorPlanUrls(source);

  // **경로가 없어도 도면은 있다.** 전에는 이 자리가 통째로 비어서, 발표 초반 내내
  // 2D 맵 뷰 노드가 빈 상자였다.
  if (path === null) {
    if (!mapDone) {
      return <p className="detect-wait">
        2D 맵은 「2D 맵에서 문 위치 확인」이 끝나면 뜹니다
        {prep.map.step === 'failed' && prep.map.reason !== null && <small>{prep.map.reason}</small>}
      </p>;
    }
    return <div className="detect-map detect-map--plain">
      <FloorPlan urls={planUrls} />
      <div className="detect-map__facts">
        <span>문 도면 위치 ({prep.map.doorCm.x.toFixed(1)}, {prep.map.doorCm.y.toFixed(1)}) cm</span>
        {/* **실패도 적는다** (260914). 대체 경로(A 단상 → B 문만 위치 → C 문 관측만)가 다 안 되면
            경로가 없고 이동도 안 한다 — 그 사유가 여기와 T-B1 액션 아이템에 있다. */}
        {state.pathFailure !== null
          ? <span className="detect-map__failed">경로 산출 실패 — {state.pathFailure}</span>
          : <span>경로는 스캔이 끝난 뒤에 그려집니다</span>}
      </div>
    </div>;
  }
  const steps = Object.entries(path.path_calculation ?? {});
  /**
   * **도면 위 경로 그림이 없는 경로가 있다** (260914 — C, 문 관측만). 로봇의 도면 자리를 모르면
   * 선을 그을 자리가 없다. 그때는 도면과 문 자리만 두고 「얼마나 돌고 얼마나 가나」를 적는다.
   */
  const overlay = path.path_overlay_available !== false;
  /**
   * **C 에서도 그림이 온다** (260914 지시 「C로 나와도 산출된 경로를 역추적해서 2D 맵에」). 탐지가 명령(문 방위·거리)을
   * 문에서 거꾸로 따라가 그린다. **시연에서는 역추적이라고 적지 않는다**(같은 날 지시) — 그 사실은 탐지 근거
   * (`path_overlay_kind` · `backtrace`)와 임무 기록에만 남는다.
   */
  const backtrace = path.path_overlay_kind === 'backtraced' ? path.backtrace ?? null : null;

  return <div className="detect-map">
    {overlay ? <img src={roundedImageUrl(pathImageUrl(source), state.imageRound)} alt="도면 위의 경로" /> : <FloorPlan urls={planUrls} />}
    <div className="detect-map__facts">
      <span><b>{path.turn_instruction}</b></span>
      <span>직진 {(path.forward_distance_cm / 100).toFixed(2)}m</span>
      <span>정지거리 {(path.standoff_cm / 100).toFixed(2)}m</span>
      {path.path_mode_words !== undefined && <span className={overlay ? '' : 'detect-map__failed'}>{path.path_mode_words}</span>}
    </div>
    {zoom && <>
      <dl className="detect-map__rows">
        <div><dt>로봇 위치</dt><dd>{path.robot_position_cm !== null ? `${path.robot_position_cm.map((n) => n.toFixed(1)).join(', ')} cm`
          : backtrace !== null ? `${backtrace.start_position_cm.map((n) => n.toFixed(1)).join(', ')} cm`
            : '모름 — 문 관측만으로 산출'}</dd></div>
        <div><dt>로봇 방위</dt><dd>{path.current_heading_map_deg !== null ? `${path.current_heading_map_deg}도 (도면 기준)`
          : backtrace !== null ? `${backtrace.start_heading_map_deg}도 (도면 기준)` : '모름'}</dd></div>
        <div><dt>목표 위치</dt><dd>{path.target_position_cm.map((n) => n.toFixed(1)).join(', ')} cm{path.target_resolution !== undefined && ` · ${path.target_resolution.source}`}</dd></div>
        <div><dt>목표까지</dt><dd>{(path.distance_to_target_cm / 100).toFixed(2)} m</dd></div>
        <div><dt>도착점</dt><dd>{path.goal_cm !== null ? `${path.goal_cm.map((n) => n.toFixed(1)).join(', ')} cm`
          : backtrace !== null ? `${backtrace.goal_cm.map((n) => n.toFixed(1)).join(', ')} cm` : '모름'}</dd></div>
      </dl>
      {/* **식과 대입값을 그대로.** 우리가 다시 계산하지 않는다 — 계산이 두 곳에 있으면
          하나만 고쳐지는 날이 온다. */}
      <ol className="detect-steps">
        {steps.map(([name, step]) => <li key={name}>
          <code>{step.formula}</code>
          <small>{step.substituted}</small>
        </li>)}
      </ol>
    </>}
  </div>;
}

/**
 * **도면 한 장과 그 위의 문 자리.** 앞 주소가 안 뜨면 뒤 주소로 넘어간다 — 탐지 창구에 아직
 * 도면이 없으면(새 판 직후 404) 저장소의 같은 도면으로 대신한다(`floorPlanUrls`).
 *
 * 문 표시는 **GT 고정값**이다(`floorPlan.ts`). 탐지가 검출한 자리가 아니다.
 */
function FloorPlan({ urls }: { urls: readonly string[] }) {
  const [at, setAt] = useState(0);
  const url = urls[Math.min(at, urls.length - 1)] ?? '';
  const left = (DOOR_PX.x / FLOOR_PLAN_SIZE_PX.width) * 100;
  const top = (DOOR_PX.y / FLOOR_PLAN_SIZE_PX.height) * 100;
  return <div className="detect-map__plan">
    <img src={url} alt="2D 도면" onError={() => { if (at < urls.length - 1) setAt(at + 1); }} />
    <span className="detect-map__door" style={{ left: `${left}%`, top: `${top}%` }} title="문 — 도면 GT 고정 위치">문</span>
  </div>;
}

/** 지금 탐지가 고른 칸 번호. 태스크 노드가 「몇 번째 방향」을 적을 때 쓴다. */
export function useChosenIndex(stepDeg: number, count: number): number | null {
  const state = useDetect();
  const best = chosenFrame(state.frames, (f) => state.evidence[f.frame]?.final_score ?? 0);
  return best === null ? null : indexOfRotation(best.rotation_deg, stepDeg, count);
}
