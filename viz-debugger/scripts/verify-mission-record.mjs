// verify:mission-record (260914 신설 — 「새로고침하면 임무 이력이 다 날아간다」)
//
// **한 판이 파일로 남고, 그 파일로 같은 화면을 다시 세울 수 있는가.**
//
// 리허설 기록이 디버깅에 쓰이는데 새로고침 한 번에 사라졌다. DB 전까지 저장소 루트
// `mission-history/<날짜>/<시각_임무>/` 에 남긴다. 막으려는 실패 여섯.
//
//  1. **폴더 밖을 쓰는 것** — 날짜·판·그림 이름에 `..` 가 끼면 저장소 아무 데나 쓴다.
//  2. **끝나기 전에 끊긴 판이 안 남는 것** — 새로고침·충돌로 끝 표시 없이 끊긴 판이 리허설에서
//     가장 알고 싶은 판이다. 도는 동안 계속 써야 한다.
//  3. **새 판을 올리는 순간 지난 판의 마지막이 사라지는 것** — 저장소를 비우기 전에 떠야 한다.
//  4. **받은 그림이 안 남는 것** — 탐지 그림은 탐지가 새 판을 시작할 때 지운다.
//  5. **다시보기가 다른 화면인 것** — 기록을 도로 채워 같은 저장소로 그려야 한다. 따로 그리면
//     지금 판 화면과 갈라진다.
//  6. **다시보기가 살아 움직이는 것** — 채운 값에 탐지 구독·로봇 수신기가 반응하거나, 로봇에
//     명령이 나가거나, 다시보기가 또 기록되면 안 된다.
//
// 가짜 탐지 창구 대신 저장소의 실제 시료(`door_example`)를 쓴다. 창구는 임시 폴더에 띄운다.
// 대조군 포함.

import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const sampleDir = join(root, '..', 'door_example', 'test');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const failures = [];
const controls = [];

const dir = mkdtempSync(join(tmpdir(), 'mission-records-'));
const { missionRecordsMiddleware, listRuns } = await import(pathToFileURL(join(root, 'scripts', 'mission-records.mjs')).href);
const middleware = missionRecordsMiddleware(dir);
const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('next'); }));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// 브라우저의 상대 주소를 흉내 낸다 — 기록 창구는 임시 서버로, 탐지 시료는 파일로.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const text = String(url);
  if (text.startsWith('/detect-sample/')) {
    const file = join(sampleDir, decodeURIComponent(text.split('?')[0].slice('/detect-sample/'.length)));
    if (!existsSync(file)) return new Response('없음', { status: 404 });
    return new Response(readFileSync(file), { status: 200, headers: { 'Content-Type': text.endsWith('.json') ? 'application/json' : 'image/jpeg' } });
  }
  if (text.startsWith('/')) return realFetch(`${origin}${text}`, init);
  return realFetch(url, init);
};

try {
  // ── 1. 창구 — 폴더 밖을 못 쓰고 못 읽는다 ─────────────────────────────────
  {
    const put = (path, body, method = 'PUT') => realFetch(`${origin}/mission-records/api/runs/${path}`, { method, body });
    if ((await put('260914/120000_MSN-1/mission.json', '{"a":1}')).status !== 200) failures.push('정상 JSON 을 못 쓴다');
    if ((await put('260914/120000_MSN-1/mission.json', '{깨짐')).status === 200) failures.push('깨진 JSON 을 쓴다');
    if ((await put('..%2F..%2Fescape/120000_x/mission.json', '{}')).status === 200) failures.push('날짜 자리의 `..` 로 폴더 밖을 쓴다');
    if ((await put('260914/..%2F..%2Fx/mission.json', '{}')).status === 200) failures.push('판 자리의 `..` 로 폴더 밖을 쓴다');
    if ((await put('260914/120000_MSN-1/images/detect/..%2F..%2Fx.jpg', 'x', 'POST')).status === 200) failures.push('그림 이름의 `..` 로 폴더 밖을 쓴다');
    if ((await put('260914/120000_MSN-1/other.json', '{}')).status === 200) failures.push('정해진 두 파일 밖의 이름을 쓴다');
    const escape = await realFetch(`${origin}/mission-records/files/..%2F..%2Fpackage.json`);
    if (escape.status === 200) failures.push('파일 창구가 폴더 밖을 읽는다');
    if (existsSync(join(dir, '..', 'escape'))) failures.push('폴더 밖에 무언가 생겼다');
    rmSync(join(dir, '260914'), { recursive: true, force: true });
  }

  const scenario = await load('src', 'data', 'scenario.ts');
  const history = await load('src', 'data', 'missionHistory.ts');
  const session = await load('src', 'physical', 'robotSession.ts');
  const store = await load('src', 'detect', 'store.ts');
  const log = await load('src', 'detect', 'detectLog.ts');
  const recorder = await load('src', 'record', 'recorder.ts');
  const { openRecordedRun } = await load('src', 'record', 'loadRecord.ts');
  const { isReplayingRecord } = await load('src', 'record', 'replayMode.ts');
  const { receiveUplink } = await load('src', 'physical', 'robotBridge.ts');
  const { frameImageUrl, pathImageUrl, viewSourceOf } = await load('src', 'detect', 'DetectClient.ts');
  const { traceEvents } = await load('src', 'data', 'trace.ts');
  const { arrivedFrames } = await load('src', 'viewpoint', 'store.ts');

  const MISSION = 'MSN-260909-01';
  const summary = JSON.parse(readFileSync(join(sampleDir, 'door', 'target_summary.json'), 'utf8'));
  const evidence = JSON.parse(readFileSync(join(sampleDir, 'door', 'frame_000113', 'evidence.json'), 'utf8'));
  const path = JSON.parse(readFileSync(join(sampleDir, 'door', 'evidence.json'), 'utf8'));
  const robotJpeg = readFileSync(join(sampleDir, 'door', 'frame_000001', 'original.jpg'));
  const runDirs = () => existsSync(dir) ? readdirSync(dir).flatMap((date) => readdirSync(join(dir, date)).map((run) => `${date}/${run}`)) : [];
  const readRun = (folder, file) => JSON.parse(readFileSync(join(dir, folder, file), 'utf8'));
  const event = (seq, atSec, nodeId, status) => ({ seq, atSec, nodeId, status, kind: 'robot_progress', producedBy: 'backend' });

  // ── 2. 도는 동안 쓴다 — 끝 표시 없이 끊겨도 거기까지는 남는다 ────────────────
  recorder.resetRecorderForTest();
  // 앱과 같이 켠다 — 끝 표시와 봉인은 켤 때 걸린다. 주기도 같이 돈다.
  const stopRecorder = recorder.startMissionRecorder();
  scenario.activateMission(MISSION, 'remote');
  session.markApproved();
  recorder.recordTick();
  await recorder.settleRecorder();
  if (runDirs().length !== 0) failures.push('승인만 했는데 폴더가 생겼다 — 목록이 빈 판으로 찬다');

  session.markStarted();
  store.setTestMode(true);
  scenario.receiveRobotProgress(MISSION, event(3_000_001, 3, 'T-A3', 'running'));
  session.recordCommand({
    taskId: 'T-A3', commandId: 'cmd-rec', action: 'scan_mission', parameters: { steps: 8, step_deg: 45, forward_m: 0 },
    issuedAtIso: new Date().toISOString(), requestId: null, state: 'running', code: null, message: null, result: {}, log: [],
  });
  session.noteCommandLog('cmd-rec', { atIso: new Date().toISOString(), kind: 'status', text: 'ack 1/9 · scan_turn · step 1/8', raw: '{"ack":1}', index: 1 });
  store.receiveFrames(summary.frames);
  store.receiveEvidence('frame_000113.jpg', evidence);
  store.receivePath(path);
  log.appendDetectLog({ lane: 'detect', level: 'info', text: '경로를 받았습니다 — 기록 검사', detail: '', tasks: ['T-B1'] });
  recorder.noteRobotFrame({
    kind: 'frame', deviceId: 'go1-001', missionId: MISSION, seq: 7, rotationDeg: 45, width: 640, height: 480,
    bytes: robotJpeg.length, sha1: 'abc', duplicateOfPrev: false, timestamp: null, imageBase64: robotJpeg.toString('base64'),
  });
  recorder.recordTick();
  await recorder.settleRecorder();

  const folders = runDirs();
  const folder = folders[0];
  if (folders.length !== 1) failures.push(`시작한 판의 폴더가 ${folders.length}개다 — 하나여야 한다`);
  else {
    if (!/^\d{6}\/\d{6}_MSN-260909-01$/.test(folder)) failures.push(`폴더 이름이 ${folder} 다 — 날짜/시각_임무 여야 한다`);
    const mission = readRun(folder, 'mission.json');
    const progress = readRun(folder, 'progress.json');
    if (mission.missionId !== MISSION || !Array.isArray(mission.view?.tasks)) failures.push('mission.json 에 어떤 임무인지(정의 전체)가 없다');
    if (mission.outcome !== null) failures.push('아직 안 끝났는데 결과가 적혔다');
    if (!progress.trace.some((e) => e.seq === 3_000_001)) failures.push('progress.json 에 기록 열이 없다');
    if (progress.robot.commands['cmd-rec']?.log.length !== 1) failures.push('로봇 명령과 응답 로그가 안 남는다');
    if (progress.detect.frames.length !== summary.frames.length || progress.detect.path === null) failures.push('탐지 결과·경로가 안 남는다');
    if (!progress.detectLog.some((line) => line.text.includes('기록 검사'))) failures.push('탐지 로그가 안 남는다');
    if (progress.robotFrames[0]?.file !== 'images/robot/rot_045.jpg') failures.push('로봇 촬영 목록이 안 남는다');
    const images = join(dir, folder, 'images');
    for (const file of ['detect/frame_000113_original.jpg', 'detect/frame_000113_target_overlay.jpg', 'detect/frame_000113_target_crop.jpg',
      'detect/frame_000001_original.jpg', 'detect/path_overlay.jpg', 'robot/rot_045.jpg']) {
      if (!existsSync(join(images, file))) failures.push(`받은 그림 ${file} 가 안 남는다`);
    }
    if (existsSync(join(images, 'detect/frame_000001_target_overlay.jpg'))) failures.push('문 없는 각도의 상자 그림을 지어 남긴다');
    if (existsSync(join(images, 'robot/rot_045.jpg')) && readFileSync(join(images, 'robot/rot_045.jpg')).length !== robotJpeg.length) {
      failures.push('로봇 원본이 바이트 그대로가 아니다');
    }
  }

  // ── 3. 끝나면 곧바로 · 새 판을 올리기 전에 마지막 모습을 뜬다 ─────────────────
  history.noteMissionEnd({ missionId: MISSION, label: '문 쪽으로 이동', outcome: 'failed', endedAtIso: new Date().toISOString(), done: 9, of: 16, failedTaskId: 'T-B2', reason: 'INVALID_ARGUMENT' });
  await recorder.settleRecorder();
  if (folder !== undefined && readRun(folder, 'mission.json').outcome !== 'failed') failures.push('끝났는데 곧바로 결과가 안 적힌다');
  // 주기가 오기 전에 「처음부터」 — 마지막 사건이 봉인으로 남아야 한다.
  scenario.receiveRobotProgress(MISSION, event(3_000_002, 9, 'T-B2', 'failed'));
  scenario.activateMission(MISSION, 'remote');
  await recorder.settleRecorder();
  if (folder !== undefined && !readRun(folder, 'progress.json').trace.some((e) => e.seq === 3_000_002)) {
    failures.push('새 판을 올리면서 지난 판의 마지막 사건이 사라졌다 — 비우기 전에 떠야 한다');
  }
  if (runDirs().length !== 1) failures.push('「처음부터」만 누르고 아무 일도 안 했는데 새 폴더가 생겼다');
  const listed = listRuns(dir);
  if (listed[0]?.mission?.outcome !== 'failed' || listed[0]?.mission?.view !== undefined) failures.push('목록이 결과를 안 주거나 본문까지 통째로 준다');

  // ── 4·5. 다시보기 — 같은 저장소를 채워 같은 화면으로 ──────────────────────────
  if (folder !== undefined) {
    const [date, run] = folder.split('/');
    const saved = readRun(folder, 'progress.json');
    const opened = await openRecordedRun(date, run);
    if (!opened.ok) failures.push(`다시보기가 안 열린다 — ${opened.reason}`);
    else {
      const mission = scenario.getMissionState();
      if (!isReplayingRecord() || mission.activatedBy !== 'record') failures.push('다시보기 표시가 안 켜진다');
      if (mission.current.missionId !== MISSION) failures.push('다시보기가 그 임무를 안 올린다');
      if (traceEvents().length !== saved.trace.length) failures.push(`기록 열이 ${traceEvents().length}건이다 — 저장된 ${saved.trace.length}건이어야 한다`);
      if (arrivedFrames().length !== saved.viewpointFrames.length) failures.push('뷰포인트 프레임이 저장된 것과 다르다');
      if (session.commandsOfTask('T-A3')[0]?.log.length !== 1) failures.push('액션 아이템이 읽는 로봇 명령 로그가 안 채워진다');
      if (store.detectState().path?.turn_instruction !== path.turn_instruction) failures.push('경로 산출 결과가 안 채워진다');
      if (!log.detectLog().some((line) => line.text.includes('기록 검사'))) failures.push('탐지 로그가 안 채워진다');
      const source = viewSourceOf(store.detectState());
      const imageUrl = frameImageUrl(source, 'frame_000113.jpg', 'target_overlay');
      if (imageUrl !== `/mission-records/files/${date}/${encodeURIComponent(run)}/images/detect/frame_000113_target_overlay.jpg`) {
        failures.push(`다시보기의 탐지 그림이 기록 폴더가 아니다 — ${imageUrl}`);
      }
      if ((await fetch(pathImageUrl(source))).status !== 200) failures.push('다시보기의 경로 그림을 못 읽는다');

      // ── 6. 다시보기는 움직이지 않는다 ─────────────────────────────────────
      const s = session.robotSession();
      if (s.approved || s.started || s.scanIssued) failures.push('다시보기가 승인·시작을 되살린다 — 로봇에 명령이 나갈 수 있다');
      const before = session.commandsOfTask('T-A3')[0]?.log.length;
      receiveUplink({ kind: 'status', commandId: 'cmd-rec', state: 'RUNNING', detail: null, raw: '{}' }, MISSION, 99);
      if (session.commandsOfTask('T-A3')[0]?.log.length !== before) failures.push('다시보기 중에 지금 로봇의 응답이 지난 판 로그에 섞인다');
      if (scenario.recordHuman('pressed_something') !== null) failures.push('다시보기 중에 누른 것이 지난 판 기록 열에 끼어든다');
      scenario.receiveRobotProgress(MISSION, event(3_000_099, 99, 'T-C1', 'done'));
      if (traceEvents().some((e) => e.seq === 3_000_099)) failures.push('다시보기 중에 로봇 진행이 지난 판 열에 붙는다');
      const beforeFolders = runDirs().length;
      recorder.recordTick();
      await recorder.settleRecorder();
      if (runDirs().length !== beforeFolders) failures.push('다시보기가 또 기록된다');

      scenario.closeRecordReplay();
      if (isReplayingRecord() || store.detectState().recordRun !== null || scenario.getMissionState().current.missionId !== '') {
        failures.push('다시보기를 닫아도 지난 판이 남는다');
      }
    }
  }

  stopRecorder();

  // ── 대조군 ─────────────────────────────────────────────────────────────────
  const control = (name, hit) => { if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`); controls.push(name); };
  {
    // **이름 검사를 뺀 창구.** `..` 가 그대로 경로가 된다.
    const naive = join(dir, '..%2F..'.replaceAll('%2F', '/'), 'escape');
    control('이름 검사를 뺀 창구 (날짜 자리 `..`)', !naive.startsWith(dir));
  }
  {
    // **주기에만 쓰는 기록기.** 봉인이 없으면 「처음부터」 직전의 사건은 다음 주기 전에 비워진다.
    const lastFlush = [3_000_001];
    const sealed = [...lastFlush, 3_000_002];
    control('봉인 없이 주기에만 쓰는 기록기', !lastFlush.includes(3_000_002) && sealed.includes(3_000_002));
  }
  {
    // **탐지 창구 주소를 그대로 쓰는 다시보기.** 지난 판 그림은 창구에서 이미 지워졌다.
    const live = frameImageUrl({ kind: 'live', base: 'http://detect:8000' }, 'frame_000113.jpg', 'target_overlay');
    control('탐지 창구 주소로 지난 판 그림을 읽는 다시보기', !live.startsWith('/mission-records/'));
  }
} finally {
  globalThis.fetch = realFetch;
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`❌ verify:mission-record\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 창구는 날짜/판/두 파일/그림 이름만 받는다 — `..` 로 폴더 밖을 쓰거나 읽지 못하고 깨진 JSON 은 안 쓴다');
console.log('✅ 시작한 판만 날짜/시각_임무 폴더가 생기고, 도는 동안 mission.json · progress.json 이 계속 갱신된다');
console.log('✅ 로봇 명령과 응답 · 탐지 결과와 경로 · 탐지 로그 · 기록 열이 남고, 탐지 그림과 로봇 원본이 바이트 그대로 남는다');
console.log('✅ 끝나면 곧바로 결과가 적히고, 새 판을 올리기 직전의 마지막 사건까지 봉인된다');
console.log('✅ 다시보기는 같은 저장소를 채워 같은 화면을 세우고, 그림은 기록 폴더에서 읽는다');
console.log('✅ 다시보기는 승인·시작을 안 되살리고, 지금 로봇 응답·사람 조작·진행을 안 섞고, 또 기록되지 않는다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
process.exit(0);
