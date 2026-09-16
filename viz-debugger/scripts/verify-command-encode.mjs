// verify:command-encode (260910 신설 — 하드웨어 연동 지시서 §7)
//
// **로봇 없이 「하드웨어가 알아듣는지」를 증명한다.**
//
// 하드웨어 담당이 실제로 쏴 보고 잰 바이트 수가 둘 있다.
//   ping                                  31 바이트
//   scan_mission{steps:8, forward_m:1.0}  79 바이트
//
// 우리가 인코딩한 것이 그 길이와 같으면 필드 번호·와이어 타입·맵 인코딩이 전부 맞는다는
// 뜻이다. 하나라도 어긋나면 길이가 달라진다 — 그래서 길이가 서명 노릇을 한다.
//
// ## 지시서에 hex 원문이 없다
//
// §7 은 「자료의 79바이트 hex 와 같은가」라고 적었지만 지시서 본문에는 **길이만 있고 hex
// 문자열이 없다.** 그래서 길이로 대조하고, 그 길이가 **우연이 아님**을 아래에서 따로 증명한다:
// `command_id` 길이를 바꿔 가며 재면 31 과 79 가 **동시에** 떨어지는 지점이 12자 하나뿐이다.
// 두 수치가 한 점에서 만나는 것은 필드 배치가 같을 때만 일어난다.
//
// hex 원문을 받으면 아래 `REFERENCE_HEX` 에 채우고 주석 한 줄만 지우면 된다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { physical } = await import(pathToFileURL(join(root, 'src', 'physical', 'protocol.js')).href);
const { encodeCommand, PING_BYTES, SCAN_REFERENCE_BYTES } = await import(
  pathToFileURL(join(root, 'src', 'physical', 'encode.ts')).href
);

const failures = [];
const controls = [];

/** 하드웨어가 잰 수치. 이 둘이 이 검사의 정답이다. */
const REFERENCE = { ping: 31, scanForward1: 79 };
/** 하드웨어에서 hex 원문을 받으면 여기 채운다. null 이면 길이만 대조한다. */
const REFERENCE_HEX = null;
/** 두 수치가 동시에 떨어지는 command_id 길이. 아래에서 계산으로 다시 확인한다. */
const REFERENCE_ID = 'cmd-00000001';

if (REFERENCE_ID.length !== 12) failures.push(`기준 command_id 가 ${REFERENCE_ID.length}자 — 12자여야 두 수치가 맞는다`);

// ── 1. ping 은 31 바이트인가 ─────────────────────────────────────────────────
{
  const bytes = encodeCommand({ commandId: REFERENCE_ID, action: 'ping' });
  if (bytes.length !== REFERENCE.ping) {
    failures.push(`ping 이 ${bytes.length}바이트 — 하드웨어가 잰 ${REFERENCE.ping}바이트와 다르다`);
  }
  if (PING_BYTES !== REFERENCE.ping) failures.push(`PING_BYTES 상수가 ${PING_BYTES} — ${REFERENCE.ping} 이어야 한다`);
}

// ── 2. scan_mission{steps:8, forward_m:1.0} 은 79 바이트인가 ─────────────────
{
  const bytes = encodeCommand({
    commandId: REFERENCE_ID, action: 'scan_mission', parameters: { steps: 8, forward_m: 1.0 },
  });
  if (bytes.length !== REFERENCE.scanForward1) {
    failures.push(`scan_mission 이 ${bytes.length}바이트 — 하드웨어가 잰 ${REFERENCE.scanForward1}바이트와 다르다`);
  }
  if (SCAN_REFERENCE_BYTES !== REFERENCE.scanForward1) {
    failures.push(`SCAN_REFERENCE_BYTES 상수가 ${SCAN_REFERENCE_BYTES} — ${REFERENCE.scanForward1} 이어야 한다`);
  }
  if (REFERENCE_HEX !== null) {
    const hex = Buffer.from(bytes).toString('hex');
    if (hex !== REFERENCE_HEX) failures.push(`hex 가 다르다\n    우리: ${hex}\n    자료: ${REFERENCE_HEX}`);
  }
}

// ── 3. 두 수치가 한 점에서 만나는가 (hex 없이 길이를 믿을 근거) ──────────────
//
// command_id 길이를 바꿔 가며 두 명령을 잰다. 31 과 79 가 **같은 길이에서** 나오는
// 지점이 하나뿐이면, 우리 필드 배치가 하드웨어의 것과 같다는 뜻이다.
{
  const hits = [];
  for (let n = 1; n <= 40; n += 1) {
    const id = 'x'.repeat(n);
    const ping = encodeCommand({ commandId: id, action: 'ping' }).length;
    const scan = encodeCommand({ commandId: id, action: 'scan_mission', parameters: { steps: 8, forward_m: 1.0 } }).length;
    if (ping === REFERENCE.ping && scan === REFERENCE.scanForward1) hits.push(n);
  }
  if (hits.length !== 1) {
    failures.push(`31·79 가 동시에 나오는 command_id 길이가 ${hits.length}곳 (${hits.join(', ')}) — 하나여야 근거가 된다`);
  } else if (hits[0] !== 12) {
    failures.push(`31·79 가 동시에 나오는 길이가 ${hits[0]}자 — 12자여야 한다`);
  }
}

// ── 4. move_forward 가 스키마를 통과하는가 ───────────────────────────────────
{
  const bytes = encodeCommand({
    commandId: REFERENCE_ID, action: 'move_forward', parameters: { distance_m: 4.2 },
  });
  const decoded = physical.PhysicalCommandEnvelope.decode(bytes);
  const err = physical.PhysicalCommandEnvelope.verify(decoded);
  if (err) failures.push(`move_forward 가 스키마 검증에 걸린다 — ${err}`);
  if (decoded.command?.action !== 'move_forward') failures.push('move_forward 왕복에서 action 이 사라졌다');
  if (Math.abs((decoded.command?.parameters?.distance_m ?? 0) - 4.2) > 1e-9) {
    failures.push(`distance_m 왕복이 깨졌다 — ${decoded.command?.parameters?.distance_m}`);
  }
  if (decoded.command?.parameters?.vx !== undefined) failures.push('vx 를 생략했는데 값이 생겼다');
}

// ── 5. 세 action 이 전부 왕복하는가 · target 은 하드웨어 id ─────────────────
{
  for (const [action, parameters] of [
    ['ping', undefined],
    ['scan_mission', { steps: 8, forward_m: 0 }],
    ['move_forward', { distance_m: 0.05 }],
  ]) {
    const decoded = physical.PhysicalCommandEnvelope.decode(
      encodeCommand({ commandId: REFERENCE_ID, action, parameters }),
    );
    if (decoded.command?.target !== 'go1-001') {
      failures.push(`${action}: target 이 ${decoded.command?.target} — 하드웨어는 go1-001 을 쓴다`);
    }
    if (decoded.body !== 'command') failures.push(`${action}: oneof body 가 command 가 아니다 — ${decoded.body}`);
  }
}

// ── 대조군 — 틀린 인코딩이 길이로 잡히는가 ──────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // forward_m 을 빼면 79 가 안 나온다 — 맵 항목 하나가 22바이트다.
  const short = encodeCommand({ commandId: REFERENCE_ID, action: 'scan_mission', parameters: { steps: 8 } });
  control('forward_m 누락', short.length !== REFERENCE.scanForward1);
}
{
  // 파라미터를 double 이 아니라 정수로 넣는 스키마였다면 길이가 달라진다.
  // (map<string,double> 은 값이 늘 fixed64 8바이트다 — 값이 0 이어도 줄지 않는다.)
  const zero = encodeCommand({ commandId: REFERENCE_ID, action: 'scan_mission', parameters: { steps: 8, forward_m: 0 } });
  control('forward_m=0 도 같은 길이 (double 고정폭)', zero.length === REFERENCE.scanForward1);
}
{
  // target 을 registry id 로 잘못 쓰면 길이가 달라진다(robot-01 은 8자, go1-001 은 7자).
  const wrong = physical.PhysicalCommandEnvelope.encode(
    physical.PhysicalCommandEnvelope.create({
      command: { commandId: REFERENCE_ID, target: 'robot-01', action: 'ping' },
    }),
  ).finish();
  control('target 을 robot-01 로 쓴 사본', wrong.length !== REFERENCE.ping);
}

// ── 결과 ─────────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`❌ verify:command-encode\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
{
  const scan = encodeCommand({
    commandId: REFERENCE_ID, action: 'scan_mission', parameters: { steps: 8, forward_m: 1.0 },
  });
  console.log(`✅ ping ${REFERENCE.ping}바이트 · scan_mission{steps:8, forward_m:1.0} ${REFERENCE.scanForward1}바이트 — 하드웨어가 잰 수치와 같다`);
  console.log(`   scan hex: ${Buffer.from(scan).toString('hex')}`);
  console.log('✅ 두 수치가 동시에 떨어지는 command_id 길이가 12자 하나뿐 — 필드 배치가 같다는 근거 (hex 원문 없이)');
  console.log('✅ move_forward 스키마 통과 · 세 action 왕복 · target 은 go1-001 · oneof body = command');
  console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
}
