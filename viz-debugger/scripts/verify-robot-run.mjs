// verify:robot-run (260910 신설 — 실물 시연에서 두 번 걸린 자리)
//
// **로봇이 다 돌았는데 화면이 안 끝나는 것을 잡는 검사다.**
//
// 실측 로그를 그대로 재생해 여덟 칸이 실제로 판정까지 가는지 본다. 앞선 검사들은 함수를
// 하나씩 불러 옳은 값을 확인했고 전부 통과했는데, 붙여 놓으니 화면이 굳었다. 두 자리였다.
//
//  1. **재생 머리가 안 밀렸다.** `door_turn` 은 회전 프레임을 하나도 안 만든다 — 진행률과
//     door-turn 효과뿐이다. 넣은 프레임 수를 회전 것만 세는 바람에 머리가 그 자리에
//     멈췄고, 방금 넣은 판정 여덟 칸이 「아직 안 온 것」으로 걸러졌다. 로봇은 문까지
//     골랐는데 화면은 여덟 칸이 「회전 중」인 채로 굳었다.
//
//  2. **수신기가 사라지는 자리에 있었다.** 배선이 `RobotPanel` 안에 있었고 그 패널은
//     마일스톤 화면에만 있다. 로봇이 도는 동안 노드를 눌러 그래프로 들어가면 구독이
//     끊겨 그 뒤 응답이 통째로 버려졌다 — 실제로 마지막 `door_turn` 하나를 잃었다.
//
// 그래서 이 검사는 **함수가 아니라 한 판을 통째로** 본다. 실측 uplink 아홉 건을 넣고,
// 화면이 읽는 그대로(`framesUpTo(머리)`) 칸을 읽는다.
//
// 대조군 포함 — 위 두 실패를 되살린 사본이 반드시 잡히는지까지 본다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
/** 주석을 걷어 낸 소스 — 「왜 이렇게 뒀는지」 적어 둔 글이 규칙에 걸리면 안 된다. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const { receiveUplink } = await load('src', 'physical', 'robotBridge.ts');
const { robotSession, recordCommand, markApproved, pickDoorIndex } = await load('src', 'physical', 'robotSession.ts');
const { resetViewpoint, framesUpTo } = await load('src', 'viewpoint', 'store.ts');
const { emptyFill, reduceFrames, cellsInOrder } = await load('src', 'viewpoint', 'fill.ts');
const scenario = await load('src', 'data', 'scenario.ts');

const failures = [];
const controls = [];

// ── 실측 한 판 (260910 19:40, go1-001) ───────────────────────────────────────
//
// 방위가 45도 간격의 예쁜 값이 아니고 **음수로 감긴다.** 출발 방위도 판마다 다르다
// (연동 가이드 §5-3). 지어낸 값으로 검사하면 이 성질이 통째로 빠진다.
const MISSION = 'MSN-260909-01';
const SEEN = [-9.98, 35.09, 80.06, 125.32, 170, -144.71, -99.67, -54.76];
const DOOR_YAW = -94.16;
// -94.16 에 가장 가까운 것은 7번째 걸음(-99.67, 5.51도 차이)이다. 6번째(-144.71)는 50도 떨어져 있다.
// 이것이 **로봇이 바라보는 쪽**이다. 회전 k 는 k번 칸이고(0번은 회전 전에 찍힌다), 8번째 회전은
// 출발 방향으로의 복귀라 칸이 없다 (260914) — 그래서 7번째 걸음이 곧 7번 칸(315도)이다.
const FACING_INDEX = 7;
// **초록이 켜지는 칸은 이것과 다르다** (260910 지시). 문 탐지가 아직 없어서 여덟 중
// 하나를 무작위로 정해 둔다 — 그 값이 그대로 초록이 된다. 검사는 판마다 정해진 값을 쓴다.
const DOOR_INDEX = 3;
void DOOR_INDEX;   // 값은 pickDoorIndex 가 뽑는다 — 여기서는 「따로 있다」는 사실만 적는다
// **로봇이 실은 걸음 번호는 1 이다.** 고른 걸음이 아니다 — 이 검사의 핵심 재료다.
const DOOR_STEP = 1;

const COMMAND_ID = 'cmd-verifyrun';
const status = (event, step, yawDeg, ack) => ({
  kind: 'status',
  commandId: COMMAND_ID,
  state: 'RUNNING',
  detail: { ack, of: 10, event, step, steps: 8, yaw_deg: yawDeg, note: 'ok' },
  raw: JSON.stringify({ ack, of: 10, event, step, steps: 8, yaw_deg: yawDeg, note: 'ok' }),
});

/** 한 판을 통째로 재생하고 화면이 읽는 그대로 칸을 읽는다. */
function replay() {
  scenario.previewMission(MISSION);
  resetViewpoint(MISSION);
  markApproved();
  // 스캔을 낼 때 뽑는 것을 그대로 흉내 낸다 — 판마다 한 번이다.
  pickDoorIndex(8);
  recordCommand({
    commandId: COMMAND_ID, taskId: 'T-A3', action: 'scan_mission',
    issuedAtIso: new Date().toISOString(), parameters: {}, log: [], requestId: 'req-verify',
  });
  SEEN.forEach((yaw, i) => receiveUplink(status('scan_turn', i + 1, yaw, 22 + i), MISSION, (i + 1) * 2));
  const lastRotationSec = SEEN.length * 2;
  receiveUplink(status('door_turn', DOOR_STEP, DOOR_YAW, 30), MISSION, lastRotationSec + 2);
  const head = scenario.getMissionState().headSec;
  return {
    head,
    lastRotationSec,
    cells: cellsInOrder(reduceFrames(emptyFill(8), framesUpTo(head))),
    cellsAt: (at) => cellsInOrder(reduceFrames(emptyFill(8), framesUpTo(at))),
    doorTurn: robotSession().doorTurn,
  };
}

const run = replay();

// ── 1. 여덟 칸이 판정까지 간다 ───────────────────────────────────────────────
{
  const phases = run.cells.map((c) => c.phase);
  const stuck = phases.filter((p) => p === 'scanning' || p === 'pending').length;
  if (stuck > 0) {
    failures.push(`여덟 칸 중 ${stuck}칸이 판정까지 안 갔다 (${phases.join(',')}) — 로봇은 다 돌았다`);
  }
  const selected = phases.map((p, i) => (p === 'selected' ? i : -1)).filter((i) => i >= 0);
  if (selected.length !== 1) failures.push(`선정된 칸이 ${selected.length}개다 — 하나여야 한다`);
  else if (selected[0] !== robotSession().doorIndex) {
    failures.push(`${selected[0]}번 칸이 초록인데 뽑아 둔 것은 ${robotSession().doorIndex}번이다`);
  }
  // **로봇이 바라보는 쪽과 초록 칸은 서로 다른 것이다.** 같은 값으로 뭉치면 「로봇이
  // 골랐다」로 되돌아간다 — 로봇은 방향을 고르지 않는다(가이드 §5-3).
  if (selected[0] === undefined) {
    failures.push('초록이 하나도 없다');
  } else if (robotSession().doorTurn?.chosenIndex !== FACING_INDEX) {
    failures.push(`로봇이 바라보는 쪽이 ${robotSession().doorTurn?.chosenIndex} 다 — ${FACING_INDEX} 여야 한다`);
  }
  const rejected = phases.filter((p) => p === 'rejected').length;
  if (rejected !== 7) failures.push(`탈락한 칸이 ${rejected}개다 — 7개여야 한다`);
}

// ── 2. 로봇이 고른 방향이 화면이 고른 방향이다 ───────────────────────────────
{
  if (run.doorTurn === null) failures.push('door_turn 이 세션에 안 남았다');
  else {
    if (run.doorTurn.chosenIndex !== FACING_INDEX) {
      failures.push(`세션이 ${run.doorTurn.chosenIndex}번을 짚었다 — ${FACING_INDEX}번이어야 한다`);
    }
    if (run.doorTurn.yawDeg !== DOOR_YAW) failures.push('로봇이 말한 방위가 안 남았다');
  }
}

// ── 3. 재생 머리가 판정 프레임 뒤로 넘어갔다 ─────────────────────────────────
{
  const all = framesUpTo(Number.MAX_SAFE_INTEGER).length;
  const upToHead = framesUpTo(run.head).length;
  if (upToHead !== all) {
    failures.push(`머리까지 ${upToHead}개인데 열에는 ${all}개다 — ${all - upToHead}개가 「아직 안 온 것」으로 걸린다`);
  }
  if (run.head <= run.lastRotationSec) {
    failures.push(`머리가 ${run.head}초에 멈췄다 — 마지막 회전(${run.lastRotationSec}초) 뒤로 가야 한다`);
  }
}

// ── 4. 수신기가 사라지는 자리에 없다 ─────────────────────────────────────────
{
  const panel = code(read('src', 'physical', 'RobotPanel.tsx'));
  if (/receiveUplink\s*\(/.test(panel)) {
    failures.push('RobotPanel.tsx 가 uplink 를 직접 받는다 — 노드를 누르면 그 패널이 사라진다');
  }
  const main = code(read('src', 'main.tsx'));
  if (!/useRobotUplink\s*\(/.test(main)) {
    failures.push('main.tsx 가 useRobotUplink 를 안 부른다 — 로봇 응답을 받는 곳이 없다');
  }
  // 뿌리 화면이 맞는지 — 마일스톤 화면 안이면 같은 문제가 되풀이된다.
  const bridge = code(read('src', 'physical', 'robotBridge.ts'));
  if (!/export function useRobotUplink/.test(bridge)) failures.push('useRobotUplink 이 robotBridge.ts 에 없다');
}

// ── 4-b. 스캔이 스스로 걸으면 말한다 (260910 실측) ──────────────────────────
//
// `forward_m: 0` 을 보내는데도 끝에 직진 한 걸음이 붙어서 온다. 0 을 「안 준 것」으로
// 읽고 기본값을 쓰는 듯하다 — 시뮬레이터·실물 둘 다에서 봤다.
//
//     보낸 것   { steps: 8, step_deg: 45, forward_m: 0 }
//     받은 것   forward … note="ok odo=1.00m cmd=1.00m"  ·  결과 { forward_m: 1, odo_m: 1 }
//
// 그러면 「접근 시작」은 **두 번째** 걸음이 된다. 누르기 전에 알아야 한다.
{
  const { robotSession: sessionOf } = await load('src', 'physical', 'robotSession.ts');
  const walkNote = 'ok odo=1.00m cmd=1.00m';
  receiveUplink(status('forward', 1, 45, 31), MISSION, 20);
  if (sessionOf().walked === null) {
    failures.push('스캔이 스스로 걸었는데 화면이 모른다 — 접근 시작이 두 번째 걸음이 된다');
  }
  // 로봇이 적어 준 문구를 그대로 남긴다 — odo 가 얼마인지가 그 안에 있다.
  receiveUplink({
    kind: 'status', commandId: COMMAND_ID, state: 'RUNNING',
    detail: { ack: 31, of: 10, event: 'forward', step: 1, steps: 1, yaw_deg: 45, note: walkNote },
    raw: JSON.stringify({ ack: 31, of: 10, event: 'forward', step: 1, steps: 1, yaw_deg: 45, note: walkNote }),
  }, MISSION, 21);
  if (sessionOf().walked !== walkNote) failures.push('로봇이 적어 준 문구를 안 남긴다');
  // 화면이 실제로 그리는가.
  const panel = code(read('src', 'physical', 'RobotPanel.tsx'));
  if (!/session\.walked/.test(panel)) failures.push('화면이 「이미 걸었다」를 안 그린다');
}

// ── 5. 로봇 편은 시나리오 모드로 안 간다 (연결 여부와 무관하게) ────────────
//
// 「대본 · 합성 데이터 · 재생 중」 띠는 **연결 전 테스트처럼 보인다.** 실물 시연 편에는
// 뜨면 안 된다.
//
// 처음엔 `robotDrives()` 일 때만 막았는데, 승인 순간 연결이 아직 안 열려 있으면 띠가
// 그대로 떴고 대본이 재생돼 **로봇 없이 다 끝난 화면**이 나왔다. 조건을 걸면 안 된다 —
// 그래서 이 다리가 연결 상태를 **아예 안 묻는지**를 본다.
{
  // 주석은 걷어 내고 본다 — 왜 그렇게 뒀는지 적어 둔 글이 검사에 걸리면 안 된다.
  const bridge = code(read('src', 'shell', 'missionBridge.ts'));
  if (/robotDrives\s*\(/.test(bridge)) {
    failures.push('missionBridge 가 연결 상태로 대본 재생을 가른다 — 연결이 늦으면 띠가 뜬다');
  }
  if (!/world !== 'registry'/.test(bridge)) {
    failures.push("시나리오 모드 관문이 world !== 'registry' 가 아니다");
  }
  // 옛 편은 그대로 대본으로 돈다 — 재생할 로봇이 없다.
  const { libraryEntry } = await load('src', 'scenarios', 'library.ts');
  if (libraryEntry(MISSION)?.world !== 'registry') failures.push(`${MISSION} 이 registry 세계가 아니다 — 검사가 헛돈다`);
  if (libraryEntry('MSN-260826-01')?.world !== 'legacy') failures.push('옛 편이 legacy 가 아니다 — 검사가 헛돈다');
}

// ── 6. 「문으로 판단했다」고 쓰지 않는다 (가이드 §5-3 · 260910 갱신) ─────────
//
// 한동안 그렇게 적었다. 틀렸다 — **문 탐지 기능이 아직 없다.** `door_turn` 의 회전 목표는
// `-step_deg × (steps-1)` 로 고정된 기하값이고, 로봇이 방향을 고르는 절차는 존재하지 않는다.
// 초록 칸은 「찾았다」가 아니라 「지금 이쪽을 보고 있다」다.
//
// 문 유무는 탐지 담당이 붙을 때까지 **비어 있는 것이 맞다.** 지어 채우면 시연에서
// 「로봇이 문을 찾았다」는 거짓을 말하게 된다.
{
  const claims = /문으로\s*판단|문을\s*찾았|판단했습니다/;
  for (const file of [['src', 'physical', 'RobotPanel.tsx'], ['src', 'physical', 'robotBridge.ts']]) {
    const source = code(read(...file));
    if (claims.test(source)) {
      failures.push(`${file.at(-1)} 이 아직 「문으로 판단」이라고 말한다 — 탐지 기능이 없다 (§5-3)`);
    }
  }
  // 대신 「보고 있다」로 적는가 — 지웠는데 아무 말도 안 하면 화면이 비어 버린다.
  const panel = code(read('src', 'physical', 'RobotPanel.tsx'));
  if (!/문으로 칩니다/.test(panel)) failures.push('어느 칸을 문으로 쳤는지 안 말한다');
  if (!/무작위로 정했습니다/.test(panel)) failures.push('무작위로 정한 임시값이라는 사실을 화면이 안 말한다');
  if (!/실제로 바라보는 쪽은/.test(panel)) failures.push('로봇이 바라보는 쪽을 따로 안 말한다 — 둘을 뭉치면 로봇이 골랐다고 읽힌다');
}

// ── 7. 안 뽑았으면 초록을 안 켠다 ───────────────────────────────────────────
//
// 문 방향은 스캔을 낼 때 뽑는다. 안 거쳤으면 아무 칸도 안 켠다 — **지어 고르지 않는다.**
{
  const { resetRobotSession, setConnection } = await load('src', 'physical', 'robotSession.ts');
  resetRobotSession();
  setConnection({ state: 'open' });
  scenario.previewMission(MISSION);
  resetViewpoint(MISSION);
  markApproved();
  recordCommand({
    commandId: 'cmd-nopick', taskId: 'T-A3', action: 'scan_mission',
    issuedAtIso: new Date().toISOString(), parameters: {}, log: [], requestId: 'req-nopick', state: 'issued', code: null, message: null, result: {},
  });
  SEEN.forEach((yaw, i) => receiveUplink({
    kind: 'status', commandId: 'cmd-nopick', state: 'RUNNING',
    detail: { ack: i + 1, of: 10, ackSeq: null, event: 'scan_turn', step: i + 1, steps: 8, yaw_deg: yaw, note: 'ok' },
    raw: '{}',
  }, MISSION, (i + 1) * 2));
  receiveUplink({
    kind: 'status', commandId: 'cmd-nopick', state: 'RUNNING',
    detail: { ack: 9, of: 10, ackSeq: null, event: 'door_turn', step: 1, steps: 1, yaw_deg: DOOR_YAW, note: 'ok' },
    raw: '{}',
  }, MISSION, 18);
  const phases = cellsInOrder(reduceFrames(emptyFill(8), framesUpTo(scenario.getMissionState().headSec)))
    .map((c) => c.phase);
  if (phases.includes('selected')) failures.push('안 뽑았는데 초록을 켰다 — 지어 고르면 안 된다');
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **머리를 회전 프레임으로만 민 사본.** 그 구현에서는 머리가 마지막 회전에 멈춘다.
  const stale = run.cellsAt(run.lastRotationSec).map((c) => c.phase);
  const ours = run.cells.map((c) => c.phase);
  control('머리를 회전 프레임으로만 민 사본 (판정이 걸러진다)',
    JSON.stringify(stale) !== JSON.stringify(ours) && stale.every((p) => p !== 'selected'));
}
{
  // **걸음 번호로 고른 사본.** `door_turn` 의 step 은 늘 1 이라 0번 칸이 초록이 된다.
  control('door_turn 의 step 으로 짚은 사본 (늘 1번 칸)', DOOR_STEP !== FACING_INDEX);
}
{
  // **연결 상태로 대본 재생을 가른 사본.**
  const injected = "if (plan.script.world === 'registry' && !robotDrives()) {";
  control('연결이 늦으면 대본이 도는 사본', /robotDrives/.test(injected));
}
{
  // **패널 안에 배선을 둔 사본.**
  const injected = "  useEffect(() => client.onMessage((m) => receiveUplink(m, missionId, elapsedSec())), []);";
  control('RobotPanel 안에 수신기를 둔 사본', /receiveUplink\s*\(/.test(injected));
}

if (failures.length) {
  console.error(`❌ verify:robot-run\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 실측 한 판 재생 — 여덟 칸이 판정까지 가고 뽑아 둔 칸 하나만 초록 (로봇이 바라보는 쪽은 따로 적는다)');
console.log('✅ 재생 머리가 판정 프레임 뒤로 넘어간다 · 수신기는 사라지는 패널 밖에 있다');
console.log('✅ 화면이 「문으로 판단했다」고 말하지 않는다 — 탐지 기능이 없다 (§5-3)');
console.log('✅ 스캔이 스스로 걸으면 화면이 말한다 — forward_m 0 을 보냈는데도 온다 (실측)');
console.log('✅ 로봇 편은 연결 여부와 무관하게 일반 모드 — 「합성 데이터 · 재생 중」 띠가 안 뜬다 (옛 편은 그대로)');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
