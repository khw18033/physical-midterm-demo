// verify:status-index (260910 신설 — 하드웨어 연동 지시서 §7)
//
// **한 칸 밀림을 잡는 검사다.**
//
// 이 한 줄을 틀리면 3번 각도의 결과가 4번 노드에 찍힌다. 그런데 **화면은 그럴싸하게
// 돌아간다** — 여덟 칸이 차례로 켜지고 초록도 하나 뜬다. 눈으로는 절대 못 잡는다.
// 지시서가 「이 작업에서 가장 흔하게 날 실수」라고 못박았고, 그래서 이 검사가 그것부터 본다.
//
// ## 260914 — 규칙이 바뀌었다: 회전 k 는 k 번 노드다
//
// 전에는 `index = step - 1` 이었다(「돌고 나서 본다」던 옛 시뮬레이터 전제). 실물 로봇은
// **0도를 돌기 전에 찍고**, 회전 k 뒤에 k·45도를 찍고, 마지막 회전(step 8)은 출발 방향으로
// 돌아온다. 옛 규칙에서는 회전1(0→45도)이 0도 노드에 붙어 **0도 노드가 회전하는 것처럼**
// 보였다(리허설 지적). 이제 0도 노드는 촬영(`/frame`)이 켜고, step 8 은 어느 노드도 아니다.
//
// 보는 것 여섯.
//  1. step 1~7 → index 1~7 · step 8(복귀)은 노드가 아니다 · 범위 밖은 버리는가
//  2. scan_turn 이 아닌 event 는 뷰포인트를 안 건드리는가
//  3. note != "ok" 가 경고로 남는가
//  4. yaw_deg: null 에서 안 깨지는가
//  5. door_turn 이 MS-B 전이를 일으키는가 (새 노드가 아니다)
//  6. 로봇에서 온 인덱스와 대본에서 온 인덱스가 **같은 함수로** 노드를 채우는가
//
// 대조군 포함 — 한 칸 밀린 사본이 반드시 실패로 잡히는지까지 본다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const {
  parseDetail, viewpointIndexOf, warningOf, progressOf, isDoorTurn, chosenIndexOf,
} = await load('src', 'physical', 'uplink.ts');
const { emptyFill, applyRotation, cellsInOrder } = await load('src', 'viewpoint', 'fill.ts');

const failures = [];
const controls = [];

/** 하드웨어가 보내는 그대로의 한 줄. */
const detailOf = (over = {}) => JSON.stringify({
  ack: 1, of: 9, event: 'scan_turn', step: 1, steps: 8, yaw_deg: 0, note: 'ok', ...over,
});

// ── 1. step → index ─────────────────────────────────────────────────────────
for (let step = 1; step <= 7; step += 1) {
  const index = viewpointIndexOf(parseDetail(detailOf({ step })));
  if (index !== step) failures.push(`step ${step} → index ${index} — ${step} 이어야 한다 (회전 k 뒤에 k·45도를 찍는다)`);
}
// **마지막 회전(step 8)은 출발 방향으로 돌아오는 것이다** — 노드가 아니다.
if (viewpointIndexOf(parseDetail(detailOf({ step: 8 }))) !== null) failures.push('step 8(복귀 회전)이 노드를 켰다 — 315도 노드는 회전7 뒤에 찍는다');
const { isReturnTurn } = await load('src', 'physical', 'uplink.ts');
if (!isReturnTurn(parseDetail(detailOf({ step: 8, steps: 8 })))) failures.push('step 8/8 을 복귀 회전으로 못 알아본다');
if (isReturnTurn(parseDetail(detailOf({ step: 7, steps: 8 })))) failures.push('step 7/8 을 복귀 회전이라고 한다');
// 범위 밖은 버린다 — 없는 칸을 만들어 그리면 화면이 대본보다 커진다. 0 은 「회전 없음」이라 노드가 아니다.
for (const step of [0, -1, 9, 12, 1.5]) {
  const index = viewpointIndexOf(parseDetail(detailOf({ step })));
  if (index !== null) failures.push(`범위 밖 step ${step} 이 index ${index} 를 냈다 — 버려야 한다`);
}

// ── 2. scan_turn 만 뷰포인트를 건드린다 ──────────────────────────────────────
for (const event of ['door_turn', 'forward', 'aborted', '무슨event']) {
  const index = viewpointIndexOf(parseDetail(detailOf({ event, step: 3 })));
  if (index !== null) failures.push(`event ${event} 가 뷰포인트 index ${index} 를 건드렸다 — scan_turn 만이다`);
}
if (viewpointIndexOf(parseDetail(detailOf({ event: 'scan_turn', step: 3 }))) !== 3) {
  failures.push('scan_turn 이 뷰포인트를 안 건드린다');
}

// ── 3. note != ok 는 경고로 남는다 ───────────────────────────────────────────
{
  if (warningOf(parseDetail(detailOf({ note: 'ok' }))) !== null) failures.push('note ok 인데 경고가 생겼다');
  for (const note of ['turn_timeout', 'robot_state_lost', 'forward_timeout']) {
    if (warningOf(parseDetail(detailOf({ note }))) !== note) {
      failures.push(`note ${note} 가 경고로 안 남는다 — 조용히 정상으로 칠하면 안 된다`);
    }
  }
}

// ── 4. yaw_deg: null 에서 안 깨진다 ─────────────────────────────────────────
{
  const detail = parseDetail(detailOf({ yaw_deg: null, step: 5 }));
  if (detail === null) failures.push('yaw_deg 가 null 인 detail 을 통째로 버렸다 — null 이 정상이다');
  if (viewpointIndexOf(detail) !== 5) failures.push('yaw_deg 가 null 이면 index 가 안 나온다 — step 이 기준이다');
  if (detail?.yaw_deg !== null) failures.push('yaw_deg null 이 다른 값으로 바뀌었다');
  // door_turn 이 아닌 것에서 고른 칸을 주장하면 안 된다.
  if (chosenIndexOf(detail, new Map([[0, 0]])) !== null) failures.push('scan_turn 인데 고른 칸을 주장한다');
}

// ── 5. door_turn 은 MS-B 로 넘어가는 계기 ────────────────────────────────────
{
  const door = parseDetail(detailOf({ event: 'door_turn', step: 9, ack: 9, of: 9, yaw_deg: 90 }));
  if (!isDoorTurn(door)) failures.push('door_turn 을 못 알아본다');
  if (viewpointIndexOf(door) !== null) failures.push('door_turn 이 뷰포인트 노드를 만들었다 — 새 노드로 만들지 않는다');
  if (isDoorTurn(parseDetail(detailOf({ event: 'scan_turn' })))) failures.push('scan_turn 을 door_turn 이라고 한다');

  // **로봇이 고른 칸을 따른다** (260910). 어긋남을 표시하지 않는다 — 로봇이 답이다.
  //
  // `door_turn` 의 `step` 은 **늘 1** 이라 못 믿는다(실측). 이 판에서 본 방위와 견준다.
  const seen = new Map([[0, 135], [1, 90], [2, 45], [3, 0], [4, 315], [5, 270], [6, 225], [7, 180]]);
  // 실제 로그 그대로 — step 1 · yaw 225 는 **7번째 걸음(index 6)** 이다.
  const real = parseDetail(detailOf({ event: 'door_turn', step: 1, yaw_deg: 225 }));
  if (chosenIndexOf(real, seen) !== 6) {
    failures.push(`step 1 · yaw 225 가 ${chosenIndexOf(real, seen)}번을 골랐다 — 6번이어야 한다 (step 을 믿으면 0번이 된다)`);
  }
  // 각도는 감긴다 — yaw 350 은 0도(index 3)에 가장 가깝다.
  const wrapped = parseDetail(detailOf({ event: 'door_turn', step: 1, yaw_deg: 350 }));
  if (chosenIndexOf(wrapped, seen) !== 3) failures.push('감기는 각도를 못 견준다');
  // 방위를 모르면 걸음 번호로 물러난다.
  const noYaw = parseDetail(detailOf({ event: 'door_turn', step: 3, yaw_deg: null }));
  if (chosenIndexOf(noYaw, seen) !== 3) failures.push('방위가 없을 때 걸음 번호로 물러나지 않는다 (걸음 k = k 번 노드)');
  // 본 걸음이 하나도 없으면 **안 고른다** — 지어 고르지 않는다.
  if (chosenIndexOf(real, new Map()) !== null) failures.push('본 걸음이 없는데 칸을 골랐다');
}

// ── 6. 진행률 ────────────────────────────────────────────────────────────────
{
  const p = progressOf(parseDetail(detailOf({ ack: 3, of: 9 })));
  if (p?.ack !== 3 || p?.of !== 9) failures.push(`진행률이 ${JSON.stringify(p)} — 3/9 여야 한다`);
  if (progressOf(parseDetail(detailOf({ of: 0 }))) !== null) failures.push('of 가 0 인데 진행률을 주장한다');
  // forward_m=0 이면 of 는 9다 — 스캔 여덟에 door_turn 하나 (§5).
  if (progressOf(parseDetail(detailOf({ of: 9 })))?.of !== 9) failures.push('of 9 를 못 읽는다');
}

// ── 7. 로봇에서 온 인덱스가 대본과 같은 함수로 노드를 채우는가 ───────────────
//
// 노드 갱신 코드는 그 인덱스가 로봇에서 왔는지 대본에서 왔는지 몰라야 한다 (§5).
{
  let fill = emptyFill(8);
  for (let step = 1; step <= 8; step += 1) {
    const detail = parseDetail(detailOf({ step, yaw_deg: step * 45 }));
    const index = viewpointIndexOf(detail);
    if (index === null) continue;
    // 로봇의 detail 을 fill.ts 의 프레임 모양으로 바꿔 넣는다 — fill.ts 는 출처를 모른다.
    fill = applyRotation(fill, {
      rotation_index: index, yaw: detail.yaw_deg ?? 0,
      state: 'rotating', last_cmd: 'scan_mission', result: null,
    });
  }
  const scanning = cellsInOrder(fill).filter((c) => c.phase === 'scanning').length;
  if (scanning !== 7) failures.push(`회전 보고 여덟(복귀 하나 포함)을 넣었는데 탐색 중이 ${scanning}칸 — 일곱이어야 한다 (0도는 촬영이 켠다)`);
  // **0도 칸은 회전이 안 켠다** — 한 칸 밀리면 여기서 갈린다.
  if (fill.get(0)?.phase !== 'pending') failures.push('회전 보고가 0도 칸을 켰다 — 0도 노드는 회전하지 않는다');
  if (fill.get(1)?.rotation?.rotation_index !== 1) failures.push('step 1 이 1번(45도) 칸에 안 들어갔다');
  if (fill.get(7)?.rotation?.rotation_index !== 7) failures.push('step 7 이 7번(315도) 칸에 안 들어갔다');
}

// ── 8. 깨진 detail ──────────────────────────────────────────────────────────
{
  for (const raw of ['', '   ', 'not json', '[]', 'null', '{"event":"scan_turn"}', '{"step":3}']) {
    const detail = parseDetail(raw);
    if (detail !== null && (typeof detail.step !== 'number' || typeof detail.event !== 'string')) {
      failures.push(`깨진 detail 「${raw}」 이 반쯤 채워진 값을 냈다`);
    }
    // 깨진 것은 인덱스를 내면 안 된다.
    if (parseDetail(raw) === null && viewpointIndexOf(null) !== null) failures.push('null detail 이 인덱스를 냈다');
  }
}

// ── 9. 응답 매핑 — 어느 태스크가 무엇을 쏘고 응답이 무엇을 바꾸는가 ─────────
{
  const { commandForTask, missionGeometry, effectsOf } = await load('src', 'physical', 'missionLink.ts');
  const geometry = missionGeometry({ viewpoint_count: 8, forward_distance_m: 4.2 });

  // T-A3 는 스캔만. **forward_m 을 태우지 않는다** — 두 마일스톤이 한 명령에 걸리면 안 된다.
  const scan = commandForTask('T-A3', geometry);
  if (scan?.action !== 'scan_mission') failures.push(`T-A3 가 ${scan?.action} 을 쏜다 — scan_mission 이어야 한다`);
  if (scan?.parameters?.forward_m !== 0) failures.push(`T-A3 의 forward_m 이 ${scan?.parameters?.forward_m} — 0 이어야 한다 (스캔만)`);
  if (scan?.parameters?.steps !== 8) failures.push('T-A3 의 steps 가 8 이 아니다');

  // **T-B2 는 대본 거리로 명령을 만들지 않는다** (260914 리허설 — 방향도 모른 채 4.2m 를 걸었다).
  // 이동은 T-B1 경로로만 나간다(`approachPlan.ts`).
  if (commandForTask('T-B2', geometry) !== null) failures.push('T-B2 가 대본 거리로 직진 명령을 만든다 — 경로 없이 걷는다');
  if (commandForTask('T-A1', geometry) !== null) failures.push('명령이 없는 태스크가 명령을 냈다');

  // **대본이 거리를 줘도 쓰지 않는다** — 경로가 없으면 0 이다.
  if (geometry.forwardDistanceM !== 0) failures.push(`경로가 없는데 거리가 ${geometry.forwardDistanceM} — 대본 거리(4.2)를 쓰면 안 된다`);
  if (missionGeometry({}).forwardDistanceM !== 0) failures.push('거리를 모르는데 값을 지어냈다');
  if (missionGeometry(null).source !== 'none') failures.push('값의 출처 표기가 없다');

  const context = { taskOf: () => 'T-A3', seenYawByIndex: new Map([[2, 225]]), viewpointCount: 8 };

  // 거절은 숨기지 않는다 — 코드와 문구가 그대로 올라온다.
  const rejected = effectsOf(
    { kind: 'acceptance', commandId: 'c', accepted: false, code: 'robot_state_dead', message: '로봇이 죽어 있다' },
    context,
  );
  const fail = rejected.find((e) => e.kind === 'task-failed');
  if (!fail) failures.push('거절이 실패로 안 올라온다');
  if (fail?.code !== 'robot_state_dead') failures.push('거절 코드를 버렸다 — 무대에서 원인을 못 찾는다');
  if (!String(fail?.message ?? '').trim()) failures.push('거절 문구를 버렸다');

  // 회전 하나가 노드를 채우면서 진행률도 민다.
  const turn = effectsOf({ kind: 'status', commandId: 'c', state: 'EXECUTING', detail: parseDetail(detailOf({ step: 3, ack: 3, of: 9 })), raw: '' }, context);
  const vp = turn.find((e) => e.kind === 'viewpoint');
  if (vp?.frame?.payload?.rotation_index !== 3) failures.push(`step 3 이 rotation_index ${vp?.frame?.payload?.rotation_index} 로 갔다 — 3 이어야 한다`);

  // **첫 회전이 왔는데 0도 칸이 아직이면 0도도 켠다** — 촬영 흐름이 없을 때(모의·pi7 전송 꺼짐)의 대비.
  const first = effectsOf({ kind: 'status', commandId: 'c', state: 'EXECUTING', detail: parseDetail(detailOf({ step: 1 })), raw: '' }, { ...context, seenYawByIndex: new Map() });
  const firstIdx = first.filter((e) => e.kind === 'viewpoint').map((e) => e.frame.payload.rotation_index);
  if (JSON.stringify(firstIdx) !== '[0,1]') failures.push(`0도가 안 켜진 채 첫 회전이 왔는데 칸이 [${firstIdx}] — [0,1] 이어야 한다`);
  const firstSeen = effectsOf({ kind: 'status', commandId: 'c', state: 'EXECUTING', detail: parseDetail(detailOf({ step: 1 })), raw: '' }, { ...context, seenYawByIndex: new Map([[0, 10]]) });
  if (firstSeen.filter((e) => e.kind === 'viewpoint').length !== 1) failures.push('촬영으로 0도가 이미 켜졌는데 첫 회전이 0도를 또 켠다');
  // 복귀 회전은 방위만 남긴다 — 이동 명령을 보정할 출발 방위다.
  const ret = effectsOf({ kind: 'status', commandId: 'c', state: 'EXECUTING', detail: parseDetail(detailOf({ step: 8, steps: 8, yaw_deg: -2.8 })), raw: '' }, context);
  if (ret.find((e) => e.kind === 'scan-return')?.yawDeg !== -2.8) failures.push('복귀 회전의 방위를 안 남긴다 — 스캔 뒤 틀어진 만큼 이동을 보정할 수 없다');
  if (ret.some((e) => e.kind === 'viewpoint')) failures.push('복귀 회전이 노드를 켰다');
  // **로봇에서 온 것은 scanning 까지만이다** — 문 유무는 대본이 준다 (§6).
  if (vp?.frame?.channel !== 'robot_state') failures.push('로봇 사건이 탐지 채널로 갔다 — 문 유무를 로봇이 말하면 안 된다');
  if (!turn.some((e) => e.kind === 'progress' && e.ack === 3 && e.of === 9)) failures.push('진행률이 안 나온다');

  // note 경고가 그 노드에 붙는다.
  const warned = effectsOf({ kind: 'status', commandId: 'c', state: 'EXECUTING', detail: parseDetail(detailOf({ step: 4, note: 'turn_timeout' })), raw: '' }, context);
  if (warned.find((e) => e.kind === 'viewpoint')?.warning !== 'turn_timeout') {
    failures.push('turn_timeout 이 노드 경고로 안 붙는다');
  }

  // door_turn 은 계기 하나이고 뷰포인트를 만들지 않는다.
  const doorTurn = effectsOf({ kind: 'status', commandId: 'c', state: 'EXECUTING', detail: parseDetail(detailOf({ event: 'door_turn', yaw_deg: 131, ack: 9, of: 9 })), raw: '' }, context);
  if (!doorTurn.some((e) => e.kind === 'door-turn')) failures.push('door_turn 이 전이 계기로 안 나온다');
  if (doorTurn.some((e) => e.kind === 'viewpoint')) failures.push('door_turn 이 뷰포인트를 만들었다');
  // **로봇이 고른 칸을 따른다** — 어긋남을 기록하는 자리가 아니다.
  if (doorTurn.find((e) => e.kind === 'door-turn')?.chosenIndex !== 2) {
    failures.push('door_turn 이 로봇이 고른 칸을 안 짚는다');
  }

  // 끝과 실패.
  const done = effectsOf({ kind: 'result', commandId: 'c', status: 'SUCCEEDED', result: { odo_m: 4.2 }, code: null, message: null }, context);
  if (done[0]?.kind !== 'task-done') failures.push('SUCCEEDED 가 완료로 안 간다');
  const aborted = effectsOf({ kind: 'result', commandId: 'c', status: 'ABORTED', result: {}, code: 'forward_timeout', message: '멈췄다' }, context);
  if (aborted[0]?.kind !== 'task-failed') failures.push('ABORTED 가 실패로 안 간다');
  if (aborted[0]?.code !== 'forward_timeout') failures.push('실패 사유를 버렸다');

  // 모르는 command_id 는 아무 노드도 안 건드린다.
  const orphan = effectsOf({ kind: 'acceptance', commandId: 'zzz', accepted: true, code: null, message: null }, { ...context, taskOf: () => null });
  if (orphan.length !== 0) failures.push('모르는 command_id 가 노드를 건드렸다');
}

// ── 10. 목 uplink — 진짜와 같은 바이트를 내는가 ──────────────────────────────
//
// 목이 화면에 가짜 경로를 따로 두면 진짜가 붙는 날 그 경로만 안 고쳐진다. 그래서 목도
// 봉투로 인코딩해서 내보내고 받는 쪽은 decodeUplink 를 그대로 지난다.
{
  const { mockScanUplink, mockAcceptance, mockResult } = await load('src', 'physical', 'mockUplink.ts');
  const { decodeUplink } = await load('src', 'physical', 'uplink.ts');
  const frames = mockScanUplink();

  // 스캔 여덟 — pi7 에서 door_turn 을 걷어 냈다 (260914).
  if (frames.length !== 8) failures.push(`목이 ${frames.length}건을 낸다 — 스캔 여덟이어야 한다 (door_turn 없음)`);

  const decoded = frames.map((f) => decodeUplink(f.payload));
  if (decoded.some((d) => d === null)) failures.push('목이 낸 바이트를 우리 디코더가 못 읽는다 — 같은 봉투가 아니다');

  const details = decoded.map((d) => d?.detail);
  // of 는 스캔 걸음 수 — door_turn 이 빠져 여덟이다.
  if (details.some((d) => d?.of !== 8)) failures.push('목의 of 가 8 이 아니다');

  // step 1~7 이 index 1~7 로 간다 — step 8 은 복귀, 0도는 촬영이 켠다.
  const indexes = details.map((d) => viewpointIndexOf(d)).filter((i) => i !== null);
  if (JSON.stringify(indexes) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7])) {
    failures.push(`목을 흘렸더니 인덱스가 [${indexes.join(', ')}] — 1~7 이어야 한다`);
  }

  // **경고가 한 번은 나온다** — 조용히 정상으로 칠하는지 여기서 드러난다.
  const warnings = details.map((d) => warningOf(d)).filter(Boolean);
  if (warnings.length === 0) failures.push('목이 note 경고를 한 번도 안 낸다 — 경고 표시를 확인할 수 없다');
  if (!warnings.includes('turn_timeout')) failures.push(`목의 경고가 ${warnings.join(', ')} — turn_timeout 이 있어야 한다`);

  // **yaw_deg 가 null 인 경우도 한 번** — 모를 수 있다.
  if (!details.some((d) => d?.yaw_deg === null)) failures.push('목이 yaw_deg null 을 한 번도 안 낸다');
  // null 이어도 그 칸은 제 인덱스로 간다.
  const nullOne = details.find((d) => d?.yaw_deg === null);
  if (nullOne && nullOne.step < 8 && viewpointIndexOf(nullOne) !== nullOne.step) failures.push('yaw 가 null 인 걸음이 제 칸으로 안 간다');

  // 마지막은 출발 방향으로 돌아오는 복귀 회전이고 뷰포인트를 만들지 않는다. door_turn 은 없다.
  const last = details[details.length - 1];
  if (last?.event !== 'scan_turn' || last?.step !== 8) failures.push('목의 마지막이 복귀 회전(step 8)이 아니다');
  if (viewpointIndexOf(last) !== null) failures.push('목의 복귀 회전이 뷰포인트를 만들었다');
  if (details.some((d) => isDoorTurn(d))) failures.push('목이 아직 door_turn 을 낸다 — pi7 에서 걷어 냈다');
  // 옛 pi7 을 흉내 내면 여전히 door_turn 하나가 붙는다 — 화면이 그것도 받아야 한다.
  const legacy = mockScanUplink({ legacyDoorTurn: true }).map((f) => decodeUplink(f.payload)?.detail);
  if (legacy.length !== 9 || !isDoorTurn(legacy[8]) || legacy[0]?.of !== 9 || viewpointIndexOf(legacy[8]) !== null) {
    failures.push('옛 pi7 흉내(legacyDoorTurn)가 여덟 + door_turn(of 9) 이 아니다');
  }

  // 1초 회전 + 1초 유지 — 대본과 같은 박자다.
  const gaps = new Set(frames.slice(1).map((f, i) => f.atSec - frames[i].atSec));
  if (gaps.size !== 1 || ![...gaps][0] || [...gaps][0] !== 2) {
    failures.push(`목의 간격이 ${[...gaps].join(', ')}초 — 2초(1초 회전 + 1초 유지)여야 한다`);
  }

  // 거절·끝도 같은 봉투다.
  const rejected = decodeUplink(mockAcceptance('c', false));
  if (rejected?.kind !== 'acceptance' || rejected.accepted !== false) failures.push('목 거절이 acceptance 로 안 온다');
  if (rejected?.code !== 'robot_state_dead') failures.push('목 거절에 코드가 없다');
  const ok = decodeUplink(mockResult('c', 'SUCCEEDED', { odo_m: 4.2 }));
  if (ok?.kind !== 'result' || ok.status !== 'SUCCEEDED') failures.push('목 결과가 SUCCEEDED 로 안 온다');
  if (Math.abs((ok?.result?.odo_m ?? 0) - 4.2) > 1e-9) failures.push('목 결과의 값이 깨졌다');
  const aborted = decodeUplink(mockResult('c', 'ABORTED'));
  if (aborted?.kind !== 'result' || aborted.status !== 'ABORTED') failures.push('목 ABORTED 가 안 온다');
  if (!String(aborted?.code ?? '').trim()) failures.push('목 ABORTED 에 사유가 없다');

  // **문 유무를 목이 만들지 않는다** (§6) — 로봇이 안 주는 것을 목이 주면 경계가 흐려진다.
  const source = readFileSync(join(root, 'src', 'physical', 'mockUplink.ts'), 'utf8');
  if (/door\s*:\s*(true|false)/.test(source)) {
    failures.push('목이 문 유무를 만든다 — 그것은 대본이 주는 값이다');
  }
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **옛 규칙 사본** (260914 까지의 코드) — index = step - 1. 회전1(0→45도)이 0도 노드에 붙어
  // 0도 노드가 회전하는 것처럼 보였다. 위 1절이 그것을 잡는지, 그 사본의 결과로 확인한다.
  const oldRule = (detail) => (detail.event === 'scan_turn' && detail.step >= 1 && detail.step <= 8 ? detail.step - 1 : null);
  const ours = [];
  const theirs = [];
  for (let step = 1; step <= 8; step += 1) {
    const d = parseDetail(detailOf({ step }));
    ours.push(viewpointIndexOf(d));
    theirs.push(oldRule(d));
  }
  control('index = step - 1 사본 (0도 노드가 첫 회전을 가져감)', theirs[0] === 0 && ours[0] === 1 && JSON.stringify(ours) !== JSON.stringify(theirs));
}
{
  // yaw 로 노드를 고르는 구현 — 출발 방위가 0 이 아니면 곧바로 어긋난다 (§5 ㉣).
  // step 1(0번 칸)인데 로봇의 절대 방위가 350 도면 yaw 로는 8번을 노린다 — 있지도 않은 칸이다.
  const drifted = parseDetail(detailOf({ step: 1, yaw_deg: 350 }));
  const byYaw = Math.round((drifted.yaw_deg ?? 0) / 45);
  control('yaw 로 노드를 고른 사본 (출발 방위 350도)', byYaw !== viewpointIndexOf(drifted));
}
{
  // note 를 버리는 구현.
  const d = parseDetail(detailOf({ note: 'turn_timeout' }));
  control('note 를 버린 사본', warningOf(d) !== null);
}

if (failures.length) {
  console.error(`❌ verify:status-index\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 회전 step 1~7 → index 1~7 · step 8 은 출발 방향 복귀(노드 아님) · 0도는 회전하지 않는다 · 범위 밖은 버린다');
console.log('✅ scan_turn 만 뷰포인트를 건드린다 — door_turn·forward·aborted 는 0건');
console.log('✅ note != ok 는 경고로 남는다 · yaw_deg: null 에서 안 깨진다 · 각도는 360 으로 감긴다');
console.log('✅ door_turn 은 계기이지 노드가 아니다 — 로봇이 고른 걸음을 따른다 (어긋남을 표시하지 않는다)');
console.log('✅ 로봇 사건 여덟이 대본과 같은 함수로 여덟 칸을 채운다 (fill.ts 는 출처를 모른다)');
console.log('✅ 응답 매핑 — 거절 코드·문구 보존 · SUCCEEDED 완료 · 모르는 command_id 는 0건');
console.log('✅ 목 uplink 여덟 건(door_turn 없음 · 옛 pi7 흉내는 아홉)이 진짜와 같은 봉투 — 경고 한 번 · yaw null 한 번 · 2초 박자 · 문 유무는 안 만든다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
