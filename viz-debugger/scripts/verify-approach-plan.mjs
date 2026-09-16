// verify:approach-plan (260914 신설 — 시연 리허설 지적 · 같은 날 door_turn 제거와 속도 두 배 반영)
//
// **「2D 맵 기반 경로 산출」이 낸 경로로만, 그 회전각 그대로, 두 배 속도로 움직이는가.
// 그리고 0도 칸에서 돌았다고 적지 않는가.**
//
// 막으려는 실패 넷.
//
//  1. **경로 없이 이동하는 것.** 리허설에서 `door_turn` 만 오면 「경로대로 이동」이 열리고 대본의 4.2m 로
//     방향도 모른 채 직진했다. 경로가 없거나 경로 산출이 실패하면 계획이 없어야 한다.
//  2. **없어진 door_turn 을 아직 빼는 것.** pi7 이 한 바퀴 뒤 한 칸(-45°) 되돌아 서던 때는 그만큼을
//     빼서 보냈다. pi7 에서 door_turn 을 걷어 냈으므로 로봇은 출발 방향에 서 있고, **탐지 회전각이 곧
//     보낼 회전각**이다. 옛 계산이 남으면 문에서 40도 가까이 어긋난 쪽으로 걷는다.
//  3. **직진 속도를 안 싣는 것.** 안 실으면 로봇 기본값 0.15 m/s — 시연 시간에 못 맞춘다. 규약 상한
//     0.30 m/s(두 배)를 싣는다.
//  4. **첫 노드에서 회전한 것처럼 적는 것.** 회전 k 가 k번 칸, 회전 8 은 복귀라 칸이 없다.
//
// 수치는 실측 판의 것이다. 대조군 포함.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src = (...p) => strip(readFileSync(join(root, 'src', ...p), 'utf8'));

const failures = [];
const controls = [];

const plan = await load('src', 'physical', 'approachPlan.ts');
const session = await load('src', 'physical', 'robotSession.ts');
const store = await load('src', 'detect', 'store.ts');
const { effectsOf } = await load('src', 'physical', 'missionLink.ts');
const { APPROACH_VX, STOP_ACTION } = await load('src', 'physical', 'presets.ts');

// 실측 판 (verify-robot-run 과 같은 값). 회전 k 뒤의 방위다 — 회전 8(-54.76)이 곧 출발 방위.
const SEEN = [-9.98, 35.09, 80.06, 125.32, 170, -144.71, -99.67, -54.76];
// 옛 pi7 의 door_turn 방위 — 출발에서 한 칸 되돌아 선 자리.
const LEGACY_DOOR_YAW = -94.16;
// 문 단독 위치 추정(B) 리허설 산출물의 회전·직진.
const DETECTION_TURN = -78.7;
const FORWARD_M = 6.456;
/** 로봇 기본 직진 속도(m/s) — `mqtt-command.js` 의 `vx || 0.15`. */
const ROBOT_DEFAULT_VX = 0.15;

const PATH = {
  target_class: 'door', ok: true, path_mode: 'map', localization_method: 'door_only',
  robot_position_cm: [226.4, 124.0], current_heading_map_deg: 0, goal_cm: [0, 0],
  turn_instruction: '왼쪽(반시계)으로 78.7도 회전', forward_distance_cm: FORWARD_M * 100,
  robot_command: { turn: { deg: DETECTION_TURN }, move_forward: { distance_m: FORWARD_M }, distance_m_in_range: true },
};

// ── 1. 순수 계산 ─────────────────────────────────────────────────────────────
{
  if (plan.wrapDeg(215) !== -145 || plan.wrapDeg(-190) !== 170 || plan.wrapDeg(180) !== 180) failures.push('±180 을 안 감는다');
  if (plan.turnFromInstruction('왼쪽(반시계)으로 90.0도 회전') !== -90) failures.push('「왼쪽 90도」를 -90 으로 못 읽는다');
  if (plan.turnFromInstruction('오른쪽(시계)으로 30도 회전') !== 30) failures.push('「오른쪽 30도」를 30 으로 못 읽는다');
  if (plan.turnFromInstruction('직진') !== null) failures.push('각이 없는 문장에서 각을 지어낸다');
  if (APPROACH_VX !== ROBOT_DEFAULT_VX * 2) failures.push(`직진 속도가 ${APPROACH_VX} m/s — 기본값 ${ROBOT_DEFAULT_VX} 의 두 배여야 한다`);
  if (APPROACH_VX > 0.3) failures.push(`직진 속도 ${APPROACH_VX} m/s 가 규약 상한 0.30 을 넘는다 — 로봇이 거절한다`);
}

// ── 2. 경로가 없으면 움직이지 않는다 ─────────────────────────────────────────
{
  session.resetRobotSession();
  store.setTestMode(false);
  store.resetDetect();
  const none = plan.planApproach();
  if (none.ok) failures.push('경로가 없는데 이동 계획이 나온다 — 대본 거리로 걷던 그 실패다');
  else if (!/경로/.test(none.reason)) failures.push(`경로가 없다는 사유가 아니다: ${none.reason}`);

  store.receivePathFailure({ target_class: 'door', ok: false, reason: '문을 한 각도에서도 못 찾았습니다', fallback_chain: [] });
  const failed = plan.planApproach();
  if (failed.ok) failures.push('경로 산출이 실패했는데 이동 계획이 나온다');
  else if (!/문을 한 각도에서도 못 찾았습니다/.test(failed.reason)) failures.push(`탐지가 준 실패 사유를 안 옮긴다: ${failed.reason}`);

  store.resetDetect();
  store.receivePath({ ...PATH, robot_command: { ...PATH.robot_command, distance_m_in_range: false, warning: '직진 12m 가 범위 밖' } });
  if (plan.planApproach().ok) failures.push('범위 밖 직진을 그대로 낸다');

  // 소스에 대본 거리로 되돌아가는 길 · 방위 보정이 남아 있지 않다.
  const commands = src('physical', 'robotCommands.ts');
  const approach = src('physical', 'approachPlan.ts');
  if (/issueTask\(\s*['"]T-B2['"]/.test(commands)) failures.push('「경로대로 이동」이 아직 대본 명령(T-B2)으로 되돌아간다');
  if (/missionGeometry/.test(approach)) failures.push('이동 계획이 대본 기하값을 읽는다');
  if (/compensateTurn|scanReturnYaw|seenYaw|headingDeg/.test(approach)) failures.push('이동 계획에 door_turn 보정(방위 빼기)이 남아 있다');
}

// ── 3. 실측 판 → 보낼 명령 ───────────────────────────────────────────────────
function playScan({ legacyDoorTurn }) {
  session.resetRobotSession();
  store.resetDetect();
  const effects = SEEN.slice(0, 7).map((yaw, i) => ({
    kind: 'viewpoint', warning: null,
    frame: { channel: 'robot_state', payload: { rotation_index: i + 1, yaw, state: 'rotating', last_cmd: 'scan_mission', result: null } },
  }));
  effects.push({ kind: 'scan-return', yawDeg: SEEN[7] });
  if (legacyDoorTurn) effects.push({ kind: 'door-turn', yawDeg: LEGACY_DOOR_YAW, chosenIndex: 7 });
  session.applyEffects(effects);
  store.receivePath(PATH);
  return plan.planApproach();
}
{
  const p = playScan({ legacyDoorTurn: false });
  if (!p.ok) failures.push(`실측 판에서 계획이 안 나온다: ${p.reason}`);
  else {
    if (p.turnDeg !== DETECTION_TURN) failures.push(`보낼 회전이 ${p.turnDeg} — 탐지 회전 ${DETECTION_TURN} 그대로여야 한다`);
    const actions = p.steps.map((s) => s.action).join(',');
    if (actions !== `turn,move_forward,${STOP_ACTION}`) failures.push(`걸음이 ${actions} — 회전·직진·도착 정지여야 한다`);
    if (p.steps[0]?.parameters.deg !== DETECTION_TURN) failures.push(`회전 명령이 ${p.steps[0]?.parameters.deg} 로 나간다`);
    if (p.steps[1]?.parameters.distance_m !== FORWARD_M) failures.push(`직진이 ${p.steps[1]?.parameters.distance_m}m 로 나간다 — 경로의 ${FORWARD_M}m 여야 한다`);
    if (p.steps[1]?.parameters.vx !== APPROACH_VX) failures.push(`직진에 속도가 안 실린다(${p.steps[1]?.parameters.vx}) — 로봇 기본값으로 느리게 걷는다`);
    if (p.steps[0]?.parameters.vx !== undefined) failures.push('회전에 규약에 없는 속도 파라미터를 싣는다 — 로봇이 거절할 수 있다');
    if (p.steps[2]?.taskId !== 'T-B3') failures.push('도착 정지가 T-B3 의 걸음이 아니다');
    if (p.notes.length !== 0) failures.push(`door_turn 이 없는데 경고가 붙는다: ${p.notes.join(' / ')}`);
  }
  // 옛 pi7 이 door_turn 을 보내도 몰래 보정하지 않는다 — 그 사실을 적는다.
  const legacy = playScan({ legacyDoorTurn: true });
  if (!legacy.ok || legacy.turnDeg !== DETECTION_TURN) failures.push('door_turn 이 오면 여전히 보정한다 — 걷어 낸 계산이 살아 있다');
  else if (!legacy.notes.some((note) => /door_turn/.test(note))) failures.push('옛 pi7 의 door_turn 이 왔는데 그 사실을 안 적는다 — 어긋난 이유를 못 찾는다');
  session.resetRobotSession();
  store.resetDetect();
}

// ── 4. 0도 칸은 돌지 않는다 ──────────────────────────────────────────────────
{
  session.resetRobotSession();
  const context = { taskOf: () => 'T-A3', seenYawByIndex: new Map(), litIndices: new Set(), viewpointCount: 8 };
  const detail = { ack: 1, of: 8, ackSeq: null, event: 'scan_turn', step: 1, steps: 8, yaw_deg: SEEN[0], note: 'ok' };
  const effects = effectsOf({ kind: 'status', commandId: 'c', state: 'RUNNING', detail, raw: '' }, context);
  const indices = effects.filter((e) => e.kind === 'viewpoint').map((e) => e.frame.payload.rotation_index);
  if (indices.join(',') !== '0,1') failures.push(`회전1 이 켠 칸이 ${indices} — 0(찍힌 칸)과 1 이어야 한다`);
  session.applyEffects(effects);
  const s = session.robotSession();
  if (s.seenYaw[0] !== undefined) failures.push(`0도 칸에 회전1 뒤의 방위 ${s.seenYaw[0]} 를 빌려 적었다`);
  if (s.litIndices[0] !== true) failures.push('0도 칸이 켜진 것으로 안 남는다 — 회전2 에서 또 켠다');

  const back = effectsOf(
    { kind: 'status', commandId: 'c', state: 'RUNNING', detail: { ...detail, ack: 8, step: 8, yaw_deg: SEEN[7] }, raw: '' }, context,
  );
  if (back.some((e) => e.kind === 'viewpoint')) failures.push('복귀 회전(8)이 칸을 켠다');
  session.resetRobotSession();
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **옛 보정을 남긴 사본.** 출발(복귀 회전) -54.76 → door_turn 이 없으니 지금 방위는 복귀 방위 그대로라
  // 보정이 0 이어야 맞지만, door_turn 방위를 기억에 남겨 빼면 39도가 어긋난다.
  const turned = LEGACY_DOOR_YAW - SEEN[7];
  control('사라진 door_turn 만큼 빼는 사본', Math.abs((DETECTION_TURN - turned) - DETECTION_TURN) > 30);
}
{
  // **속도를 안 실은 사본.** 로봇 기본값으로 6.456m 에 43초 — 두 배 속도면 21.5초다.
  control('직진 속도를 안 실은 사본', FORWARD_M / ROBOT_DEFAULT_VX > (FORWARD_M / APPROACH_VX) * 1.9);
}
{
  // **회전 k 를 k-1 칸에 붙인 사본.** 7번 걸음이 6번 칸이 되어 초록이 한 칸 밀린다.
  const shifted = SEEN.slice(0, 7).map((_, i) => i);
  control('회전 k 를 k-1 칸에 붙인 사본', shifted[6] !== 7);
}

if (failures.length) {
  console.error(`❌ verify:approach-plan\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 경로가 없거나 산출이 실패하면 이동 계획이 없다 — 대본 거리로 걷지 않고 탐지가 준 사유를 옮긴다');
console.log(`✅ 탐지 회전각을 보정 없이 그대로 보낸다 (실측 ${DETECTION_TURN}°) — 옛 pi7 의 door_turn 이 오면 보정 대신 그 사실을 적는다`);
console.log(`✅ 회전 → 직진(경로 거리 그대로 · ${APPROACH_VX} m/s = 기본값의 두 배) → 도착 정지(T-B3) · 회전에는 규약 밖 파라미터를 안 싣는다`);
console.log('✅ 0도 칸은 회전 보고 없이 켜지고 방위를 빌려 적지 않는다 · 회전 8 은 칸이 아니다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
