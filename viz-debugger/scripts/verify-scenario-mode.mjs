// scenario 렌더 모드 (260831) — 대본 재생이 자리표시 기본값을 깨뜨리지 않는지 검사한다.
//
// 이 검사가 막으려는 실패는 둘이다.
//  1. **대본이 자리표시를 우회하는 것** — scenario 모드가 승인 없이 켜지거나, cast 밖
//     장비까지 그리거나, 배지 없이 그리면 「목입니다」 문제로 되돌아간다.
//  2. **승인 전 실행** — 매칭 결과는 제안이고, 승인 전에는 trace_event 도 세계 채널도
//     하나도 나가면 안 된다 (plans.ts 머리말 · REQ-1506).
//
//  3. **시나리오 연계가 일반 모드를 갉아먹는 것** (260901) — 패널 접힘·탭 흐림은 시나리오
//     모드에서만이다. 일반 모드에서 접히면 「남이 줄 데이터가 어디에 얼마나 있는지」를
//     보여 주는 화면이 사라진다.
//
// 네 층을 본다: ① renderMode 모듈의 실동작 ② 화면 소스의 배지·분기 ③ 시나리오 연계
// (접힘 판정 재료 · 안내줄이 재생 머리를 따라가는가) ④ 게이트웨이 실동작 (직접 띄워
// 발화→매칭→승인→재생→감사→닫기→미리보기 왕복). 음성 대조군 포함.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.VERIFY_SCENARIO_PORT ?? 8797);
const URL = `ws://127.0.0.1:${PORT}`;
const HTTP = `http://127.0.0.1:${PORT}`;

const failures = [];
const controls = [];

// ── ① renderMode 모듈 — 기본값·진입·우선순위·복귀 ────────────────────────────
const modePath = join(root, 'src', 'shared', 'renderMode.ts');
{
  const m = await import(pathToFileURL(modePath).href);
  if (m.getRenderMode() !== 'placeholder') failures.push(`기본 렌더 모드가 '${m.getRenderMode()}' — 앱을 그냥 띄우면 자리표시여야 한다`);
  // 진입 경로 둘 (260831 요구 4) — 정지 미리보기(playing: false)와 승인 재생(playing: true).
  m.enterScenarioRender({ missionId: 'MSN-X', title: 't', cast: ['sensor-01'], axes: new Set(['water']), playing: false });
  if (m.getRenderMode() !== 'scenario') failures.push('미리보기 진입 후 모드가 scenario 가 아니다');
  if (m.getScenarioRender()?.playing !== false) failures.push('정지 미리보기가 playing: false 로 적히지 않는다 — 정지 화면을 재생 중이라고 말하면 안 된다');
  m.enterScenarioRender({ missionId: 'MSN-X', title: 't', cast: ['sensor-01'], axes: new Set(['water']), playing: true });
  if (m.getScenarioRender()?.playing !== true) failures.push('승인 재생이 playing: true 로 적히지 않는다');
  if (!m.getScenarioRender()?.castSet.has('sensor-01') || m.getScenarioRender()?.castSet.has('robot-02')) {
    failures.push('cast 집합이 대본 등장 장비만 담지 않는다 — cast 밖 장비는 자리표시여야 한다');
  }
  // 접힘 판정의 재료 (260901 층 2) — scenario 모드일 때만 축 집합이 나온다.
  if (m.getScenarioAxes() === null) failures.push('시나리오 모드인데 접힘 판정 재료(getScenarioAxes)가 null 이다 — 아무 패널도 접히지 않는다');
  m.setRenderMode('mock');
  if (m.getRenderMode() !== 'mock') failures.push('목 렌더 토글이 scenario 를 이기지 않는다 — 토글이 켜져 있으면 mock 이 이겨야 한다');
  if (m.getScenarioAxes() !== null) failures.push('목·개발 모드에서 접힘 판정 재료가 나온다 — 목이 이기므로 전부 그려야 한다');
  m.setRenderMode('placeholder');
  m.exitScenarioRender();
  if (m.getRenderMode() !== 'placeholder') failures.push('대본 닫기 후 placeholder 로 복귀하지 않는다');
  // **일반 모드에서는 아무것도 접히지 않는다.** 이 한 줄이 이번 작업의 안전선이다.
  if (m.getScenarioAxes() !== null) failures.push('일반 모드에서 접힘 판정 재료가 나온다 — 일반 모드는 모든 탭·패널이 그대로 떠야 한다');
}

// 대조군 — exitScenarioRender 를 무력화한 사본이 잡히는가.
{
  const scratch = mkdtempSync(join(root, '.verify-scenario-'));
  try {
    const mutantPath = join(scratch, 'renderMode.ts');
    writeFileSync(mutantPath, readFileSync(modePath, 'utf8').replace('scenarioRender = null;', ';'), 'utf8');
    const mutant = await import(pathToFileURL(mutantPath).href);
    mutant.enterScenarioRender({ missionId: 'MSN-X', title: 't', cast: [], axes: new Set(), playing: false });
    mutant.exitScenarioRender();
    if (mutant.getRenderMode() === 'placeholder') failures.push('대조군 실패: 닫기를 무력화한 사본이 placeholder 로 복귀했다 — 검사가 무의미하다');
    else controls.push('닫기 무력화 사본 검출');
  } finally {
    // 일부 개발 환경은 파일 삭제가 막혀 EPERM 이 난다 — 검사는 이미 끝났으므로
    // 정리 실패로 죽지 않는다. 남은 .verify-* 디렉터리는 사람이 지운다.
    try { rmSync(scratch, { recursive: true, force: true }); } catch { console.warn('임시 디렉터리 정리 실패(삭제 금지 환경?) — ' + scratch); }
  }
}

// ── ② 화면 소스 — 배지·끄는 경로·카드 단위 분기 ──────────────────────────────
function checkSources(shellSource, pendingSource, gridSource) {
  const f = [];
  if (!shellSource.includes('scenario-banner')) f.push('셸에 대본 띠(scenario-banner)가 없다 — 지워지지 않는 배지가 요구사항이다');
  if (!shellSource.includes('대본 닫기')) f.push('셸에 「대본 닫기」 버튼이 없다 — placeholder 복귀 경로가 없다');
  if (!pendingSource.includes('scenarioCast.has(entity)')) f.push('PendingSource 가 장비 ID 로 cast 를 대조하지 않는다 — cast 밖 장비가 그려질 길이 열린다');
  if (!gridSource.includes('scenarioCast.has(r.id)')) f.push('장치 그리드가 카드 단위로 갈리지 않는다 — 자리 하나가 여러 장비를 담으면 카드 단위여야 한다');
  return f;
}
const shellSource = readFileSync(join(root, 'src', 'shell', 'AppShell.tsx'), 'utf8');
const pendingSourceText = readFileSync(join(root, 'src', 'shared', 'PendingSource.tsx'), 'utf8');
const gridSource = readFileSync(join(root, 'src', 'tabs', 'views', 'DeviceGrid.tsx'), 'utf8');
failures.push(...checkSources(shellSource, pendingSourceText, gridSource));
// 대조군 — 배지를 지운 사본이 잡히는가.
if (checkSources(shellSource.replaceAll('scenario-banner', 'x'), pendingSourceText, gridSource).length === 0) {
  failures.push('대조군 실패: 배지를 지운 사본이 잡히지 않았다');
} else {
  controls.push('배지 삭제 사본 검출');
}
// 끄는 경로는 **셸에만** — 띠의 「대본 닫기」와 모드 스위치의 「일반」(둘은 같은 길이다,
// renderMode.ts 머리 주석). 탭 화면이 exitScenarioRender 를 부르면 배지가 조용히 꺼질 수 있다.
{
  const allowed = new Set(['src/shared/renderMode.ts', 'src/shell/AppShell.tsx', 'src/shell/ModeSwitch.tsx']);
  const { readdirSync, statSync } = await import('node:fs');
  const offenders = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const rel = path.slice(root.length + 1).replaceAll('\\', '/');
        if (!allowed.has(rel) && readFileSync(path, 'utf8').includes('exitScenarioRender')) offenders.push(rel);
      }
    }
  })(join(root, 'src'));
  if (offenders.length > 0) failures.push(`닫기(셸) 밖에서 exitScenarioRender 를 부른다: ${offenders.join(', ')} — 끄는 경로는 하나여야 한다`);
}

// ── ③ 시나리오 연계 — 접힘과 안내줄 (260901 · 260903 3단계에 노드 어휘로) ──────
// 표와 규칙은 verify:node-scope 가 통째로 본다. 여기서는 **재생 축과 얽힌 두 가지**만 —
// 1편에서 제어 노드가 접히는가, 안내줄이 재생 머리를 따라가는가.
{
  const axesMod = await import(pathToFileURL(join(root, 'src', 'scenarios', 'axes.ts')).href);
  const { nowPlaying } = await import(pathToFileURL(join(root, 'src', 'scenarios', 'nowPlaying.ts')).href);
  const readScript = (id) => JSON.parse(readFileSync(join(root, 'scenarios', id + '.json'), 'utf8'));
  const s1 = readScript('MSN-260831-01');
  const s3 = readScript('MSN-260831-03');

  // 1편(로봇 이동)에 액추에이터 명령이 없으므로 제어 노드는 통째로 접혀야 한다.
  const axes1 = axesMod.axesOfScript(s1);
  if (axesMod.nodeKindsOfScript(s1).has('control')) failures.push('1편이 제어 노드를 쓴다고 나온다 — 로봇 이동에는 액추에이터 명령이 없다');
  if (axesMod.panelsOfNode('control').some((panel) => axesMod.panelAlive(panel, axes1))) {
    failures.push('1편에서 제어 노드의 패널이 살아 있다 — 제목·버튼 줄까지 접혀야 한다(칩만 붙이면 뼈대가 남는다)');
  }

  // 대본 → 화면 형태. src/data/scenario.ts 의 scriptToView 와 같은 필드만 쓴다(그 파일은
  // 옛 편 JSON 을 import 하고 있어 Node 에서 열리지 않는다 — 여기서는 규칙이 아니라 자료다).
  const view3 = {
    missionId: s3.missionId, label: s3.title, world: 'registry', utteranceText: s3.utterance.text,
    durationSec: s3.durationSec, milestones: s3.milestones, tasks: s3.tasks, events: s3.events,
    cast: s3.cast, hardware: null, params: s3.params ?? {}, map: s3.map ?? null, refEdges: s3.refEdges ?? [],
  };

  // 260904 — 안내줄도 **기록 열**을 접는다. 흘러온 것이 없으면 빈 열이다(정지 미리보기).
  const preview = nowPlaying(view3, s3, 0, false, []);
  if (!preview?.text.includes('T+0 · 시작 상태')) failures.push(`정지 미리보기의 안내줄이 「T+0 · 시작 상태」가 아니다 — ${preview?.text}`);
  if (!preview?.text.includes(s3.milestones[0].id)) failures.push('정지 미리보기의 안내줄에 첫 마일스톤이 없다');

  // **재생 머리를 따라가는가** — 같은 대본인데 시각이 다르면 안내와 갈 노드가 달라져야 한다.
  const early = nowPlaying(view3, s3, 40, true, s3.events);
  const atGate = nowPlaying(view3, s3, 162, true, s3.events);
  if (early === null || atGate === null) failures.push('재생 중 안내줄이 나오지 않는다');
  else {
    if (early.text === atGate.text) failures.push(`안내줄이 재생 머리를 따라가지 않는다 — T+40 과 T+162 가 같은 문구다(${early.text})`);
    if (!atGate.text.includes('MS-C')) failures.push(`T+162 의 안내줄이 MS-C 가 아니다 — ${atGate.text}`);
    if (!atGate.nodeKinds.includes('control')) failures.push(`T+162(close_gate 발행)의 갈 노드에 제어가 없다 — [${atGate.nodeKinds.join(', ')}]`);
    if (early.nodeKinds.includes('control')) failures.push(`T+40(수위 감시)의 갈 노드에 제어가 있다 — 그 시각에는 명령이 없다`);
    // 3단계 — 만들어 줄 노드를 **어느 태스크에 붙일지**가 함께 와야 한다(없으면 전역이 된다).
    if (atGate.taskId === null) failures.push('재생 중인데 안내줄이 진행 중인 태스크를 말하지 않는다 — 「○○ 노드로」가 붙일 곳을 잃는다');
  }
  const ended = nowPlaying(view3, s3, s3.durationSec, false, s3.events);
  if (!ended?.text.includes('재생 끝')) failures.push(`재생이 끝난 뒤 안내줄이 「재생 끝」이 아니다 — ${ended?.text}`);
  // 옛 편(구판 세계)은 판정 대상이 아니다 — 대본이 없으므로 안내줄도 없다.
  if (nowPlaying(view3, null, 100, true, s3.events) !== null) failures.push('대본이 없는 임무에 안내줄이 나온다 — 구판 세계는 판정 대상이 아니다');

  // 대조군 — 명령을 지운 사본에서 T+162 의 갈 탭이 그대로면 이 검사는 무의미하다.
  const noCommands = nowPlaying(view3, { ...s3, commands: [] }, 162, true, s3.events);
  if (noCommands?.nodeKinds.includes('control')) failures.push('대조군 실패: 명령을 지운 사본인데 갈 노드가 여전히 제어다');
  else controls.push('대본 명령 삭제 사본(갈 노드에서 제어가 빠짐)');
}

// ── ④ 게이트웨이 실동작 — 발화 → 제안 → 승인 전 0건 → 재생 → 감사 → 닫기 ───────
const server = spawn(process.execPath, ['gateway/server.ts'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...process.env, MOCK_PORT: String(PORT), VIZ_SCENARIO_SPEED: '20' },
});
const stop = () => { if (!server.killed) server.kill(); };
process.on('exit', stop);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(URL);
    const timer = setTimeout(() => reject(new Error('연결 시간 초과')), 8000);
    socket.on('open', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

try {
  let socket = null;
  for (let attempt = 0; attempt < 20 && socket === null; attempt += 1) {
    try { socket = await open(); } catch { await wait(400); }
  }
  if (socket === null) throw new Error(`게이트웨이(${URL})가 뜨지 않았다`);

  const envelopes = [];
  let planSeen = null;
  let ackWaiters = [];
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === 'command_ack') {
      const waiter = ackWaiters.find((w) => w.id === msg.client_request_id);
      if (waiter) { ackWaiters = ackWaiters.filter((w) => w !== waiter); waiter.resolve(msg); }
    }
    if (msg.type === 'data' && msg.envelope) {
      envelopes.push(msg.envelope);
      if (msg.envelope.channel === 'plan' && msg.envelope.payload?.script) planSeen = msg.envelope.payload;
    }
  });
  const sendCommand = (action, params, entity = 'MSN-260826-01') => new Promise((resolve) => {
    const id = 'req-' + Math.random().toString(36).slice(2, 8);
    ackWaiters.push({ id, resolve });
    socket.send(JSON.stringify({ type: 'command', command: { client_request_id: id, entity, action, params, expires_at: new Date(Date.now() + 30000).toISOString(), audit: { input_mode: 'click', decision_source: 'human' } } }));
  });
  socket.send(JSON.stringify({ type: 'subscribe', id: 'all', selector: { entity: '*', node: '*', channel: '*' }, scope: 'all' }));
  await wait(1200);

  // 맞는 대본이 없으면 없다고 한다.
  const noMatch = await sendCommand('mission_from_utterance', { text: '안녕하세요' });
  if (noMatch.accepted !== false || noMatch.reason_code !== 'no_script_match') {
    failures.push(`「안녕하세요」가 no_script_match 로 거부되지 않았다 — ${noMatch.reason_code}`);
  }

  // 3편 문장 → 제안 (pending).
  const matched = await sendCommand('mission_from_utterance', { text: '월류방어벽 자동 개폐 시스템을 가동해.' });
  if (matched.accepted !== true || !matched.message.includes('MSN-260831-03')) failures.push(`3편 매칭 실패 — ${matched.message}`);
  await wait(600);
  if (planSeen?.script?.mission_id !== 'MSN-260831-03' || planSeen?.decision !== 'pending') {
    failures.push('대본 계획이 제안(pending) 상태로 오지 않았다');
  }

  // **승인 전 실행 없음** — 기록 열도, 대본 명령도 0건.
  envelopes.length = 0;
  await wait(2500);
  if (envelopes.some((e) => e.entity === 'MSN-260831-03' && e.channel === 'trace_event')) {
    failures.push('승인 전에 trace_event 가 나갔다 — 매칭 결과는 제안일 뿐이다');
  }
  if (envelopes.some((e) => e.channel === 'command_result' && e.entity === 'actuator-01')) {
    failures.push('승인 전에 수문 명령이 나갔다');
  }

  // 승인 → 재생. close_gate 가 실시간 개폐(6초)를 마치고 감사에 적힐 때까지 본다.
  socket.send(JSON.stringify({ type: 'plan_decision', plan_id: planSeen?.plan_id, decision: 'approve' }));
  await wait(16000);

  const trace = envelopes.filter((e) => e.entity === 'MSN-260831-03' && e.channel === 'trace_event');
  if (trace.length === 0) failures.push('승인 후 trace_event 가 오지 않는다 — 재생기가 죽어 있다');
  const levels = envelopes.filter((e) => e.entity === 'sensor-01' && e.channel === 'telemetry').map((e) => e.payload?.water_level?.value);
  if (!levels.includes(1.9)) failures.push('sensor-01 수위가 대본 값(120초의 1.90 m)을 지나지 않았다 — 세계 채널이 대본을 따르지 않는다');
  const modes = envelopes.filter((e) => e.entity === 'sensor-01' && e.channel === 'telemetry').map((e) => e.payload?.report_mode);
  if (!modes.includes('event')) failures.push('상승 급변에서 report_mode 가 event 로 바뀌지 않았다');
  const gate = envelopes.filter((e) => e.channel === 'command_result' && e.entity === 'actuator-01' && e.payload?.action === 'close_gate');
  for (const stage of ['ack', 'executing', 'settled']) {
    if (!gate.some((e) => e.payload?.stage === stage)) failures.push(`close_gate 의 '${stage}' 단계가 없다 — 대본 명령이 엔진 4단계를 지나지 않는다`);
  }
  const audit = await (await fetch(HTTP + '/audit?entity=actuator-01&limit=10')).json();
  const closeAudit = audit.records.find((r) => r.action === 'close_gate');
  if (!closeAudit) failures.push('close_gate 가 감사에 없다');
  else {
    if (closeAudit.actor_display_name !== '임무 MSN-260831-03') failures.push(`감사 actor 가 임무가 아니다 — ${closeAudit.actor_display_name}`);
    if (closeAudit.input_mode === 'click' || closeAudit.input_mode === 'voice') failures.push(`대본 명령의 input_mode 가 사람 어휘(${closeAudit.input_mode})다`);
  }

  // 닫기 — 게이트웨이가 재생을 멈추고 장치를 평시로 되돌린다.
  const closed = await sendCommand('script_close', {});
  if (closed.accepted !== true) failures.push(`대본 닫기가 거부됐다 — ${closed.message}`);

  // 정지 미리보기 (260831 요구 4) — 초기 조건 + t=0 프레임이 반영되고, 기록 열은 0건이어야 한다.
  // 미리보기는 「그린다」까지다 — 승인 선(VZ-U-07)을 우회하면 안 된다.
  //
  // 개도율은 **재생이 close_gate 로 0%(닫힘)까지 몰아 둔 상태**에서 잰다. 3편은 「열려 있던
  // 수문을 닫는」 이야기라 대본의 initial 이 100%(열림)이고, 미리보기가 그것을 반영해야
  // 출발 상태가 이야기와 맞는다 — 8/31까지는 initial 을 건너뛰어 정반대였다 (260901 요구 0-2).
  const beforePreview = envelopes
    .filter((e) => e.entity === 'actuator-01' && e.channel === 'actuator_state')
    .map((e) => e.payload?.position_pct)
    .at(-1);
  // 닫는 동작은 실시간 6초라 재생이 끝난 시점의 값이 정확히 0 이 아닐 수 있다(엔진 타이밍은
  // 배속을 따르지 않는다 — script-engine.ts 머리 주석). 「열림이 아니다」까지만 전제로 둔다.
  if (!(typeof beforePreview === 'number' && beforePreview < 50)) {
    failures.push(`미리보기 직전 개도율이 닫힘 쪽이 아니다 — ${beforePreview}. 이 검사의 전제가 깨졌다`);
  }
  envelopes.length = 0;
  const preview = await sendCommand('script_preview', { mission_id: 'MSN-260831-03' }, 'MSN-260831-03');
  if (preview.accepted !== true) failures.push(`미리보기가 거부됐다 — ${preview.message}`);
  await wait(1500);
  if (envelopes.some((e) => e.channel === 'trace_event' && e.entity === 'MSN-260831-03')) {
    failures.push('미리보기가 trace_event 를 냈다 — 미리보기는 「그린다」까지다');
  }
  const previewLevels = envelopes.filter((e) => e.entity === 'sensor-01' && e.channel === 'telemetry').map((e) => e.payload?.water_level?.value);
  if (!previewLevels.includes(1.42)) failures.push('미리보기의 t=0 프레임(수위 1.42)이 장치 경로로 반영되지 않았다');
  const previewGate = envelopes
    .filter((e) => e.entity === 'actuator-01' && e.channel === 'actuator_state')
    .map((e) => e.payload?.position_pct);
  if (!previewGate.includes(100)) {
    failures.push(`3편 미리보기 뒤 개도율이 100%(열림)가 아니다 — [${previewGate.join(', ')}]. 대본의 initial(열림)과 반대다`);
  }
  await sendCommand('script_close', {}, 'MSN-260831-03');

  socket.close();
} catch (error) {
  failures.push(String(error?.message ?? error));
} finally {
  stop();
}

if (failures.length) {
  console.error(`❌ verify:scenario-mode\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
controls.push('무매칭 문장 거부(no_script_match)');
console.log('✅ 기본 placeholder · 진입 둘(미리보기 정지 / 승인 재생 — playing 구분) · cast 집합 대조 · 목 렌더 우선 · 닫으면 복귀');
console.log('✅ 배지(scenario-banner) 존재 · 끄는 경로는 셸(대본 닫기·모드 스위치)뿐 · 장치 그리드는 카드 단위 분기');
console.log('✅ 시나리오 연계 — 1편에서 제어 노드가 패널째 접힘 · 안내줄이 재생 머리를 따라감(T+40 수위 → T+162 close_gate·제어 노드) · 미리보기는 T+0 시작 상태 · 끝나면 「재생 끝」');
console.log('✅ 게이트웨이 왕복 — 거부 · 제안 · 승인 전 발행 0건 · 재생(기록·세계 채널·event 모드·명령 4단계) · 감사 actor=임무 · 닫기 · 미리보기(초기 조건 100% + t=0 프레임 · 기록 0건)');
console.log(`✅ 음성 대조군 ${controls.length}건 — ${controls.join(' · ')}`);
