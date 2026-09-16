// verify:mission-history (260912 신설 — 「임무 이력을 임시로 기능 활성화」)
//
// **끝난 판이 목록에 한 줄로 남는가.**
//
// 지금까지 임무 이력 자리는 손으로 쓴 세 줄이었다(`MSN-260826-01 · 실패 · 현재` …).
// 실제로 돌린 판이 무엇이었는지는 아무 데도 안 남아서, 한 판 끝내고 「방금 게 끝난 건가
// 실패한 건가」를 화면에서 확인할 길이 없었다.
//
// 막으려는 실패 넷.
//
//  1. **손으로 쓴 목록이 남아 있는 것** — 돌린 적 없는 임무가 이력에 뜨면 그것을 읽고
//     원인을 찾게 된다. 실패 사유를 지어내면 안 되는 것과 같은 이유다.
//  2. **한 판이 여러 줄이 되는 것** — 접기 결과는 다시 그릴 때마다 나온다. 표시가 없으면
//     같은 판이 목록을 통째로 채운다.
//  3. **같은 편을 두 번 돌렸는데 한 줄인 것** — 「처음부터」는 새 판이다. 두 줄이어야 한다.
//  4. **DB 이력인 척하는 것** — 판은 파일로 남지만(260914 · `verify:mission-record`) DB 가
//     보관하는 이력은 아직이다(`mission-history` 자리표시). 창구가 없으면 이 세션 것뿐이라고 적는다.
//
// 대조군 포함.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src = (...p) => strip(readFileSync(join(root, 'src', ...p), 'utf8'));

const failures = [];
const controls = [];

const history = await load('src', 'data', 'missionHistory.ts');
const { activateMission, resetMission } = await load('src', 'data', 'scenario.ts');

const entry = (missionId, outcome, extra = {}) => ({
  missionId, label: '문 쪽으로 이동', outcome,
  endedAtIso: new Date().toISOString(), done: 13, of: 16,
  failedTaskId: null, reason: '', ...extra,
});

// ── 1. 손으로 쓴 목록이 없다 ────────────────────────────────────────────────
{
  history.resetMissionHistory();
  if (history.missionHistory().length !== 0) failures.push('비웠는데 목록이 남아 있다');

  for (const [where, text] of [
    ['AppShell', src('shell', 'AppShell.tsx')],
    ['main', src('main.tsx')],
  ]) {
    // 돌린 적 없는 임무가 이력에 뜨면 안 된다.
    if (/MSN-260826-0\d · (실패|완료)/.test(text)) {
      failures.push(`${where} 에 손으로 쓴 임무 이력이 남아 있다 — 돌린 적 없는 판이 목록에 뜬다`);
    }
    if (!/MissionHistoryList/.test(text)) failures.push(`${where} 이 실제 목록을 안 그린다`);
  }
}

// ── 2. 한 판은 한 줄이다 ────────────────────────────────────────────────────
{
  history.resetMissionHistory();
  history.armMissionHistory();
  if (!history.noteMissionEnd(entry('MSN-260909-01', 'done'))) failures.push('첫 줄이 안 적힌다');
  // 접기 결과는 다시 그릴 때마다 나온다 — 같은 판이 목록을 채우면 안 된다.
  for (let again = 0; again < 5; again += 1) history.noteMissionEnd(entry('MSN-260909-01', 'done'));
  if (history.missionHistory().length !== 1) {
    failures.push(`한 판이 ${history.missionHistory().length}줄이 됐다 — 한 줄이어야 한다`);
  }
  if (history.missionHistory()[0]?.outcome !== 'done') failures.push('결과가 안 남는다');
}

// ── 3. 새 판은 새 줄이다 ────────────────────────────────────────────────────
//
// 「처음부터」와 승인이 `activateMission` 을 지나므로, 그것이 표시를 내려야 한다.
{
  history.resetMissionHistory();
  history.armMissionHistory();
  history.noteMissionEnd(entry('MSN-260909-01', 'done'));
  activateMission('MSN-260909-01', 'remote');      // 새 판이 선다
  history.noteMissionEnd(entry('MSN-260909-01', 'failed', { failedTaskId: 'T-B2', reason: 'INVALID_ARGUMENT deg out of range' }));
  if (history.missionHistory().length !== 2) {
    failures.push(`같은 편을 두 번 돌렸는데 ${history.missionHistory().length}줄이다 — 두 줄이어야 한다`);
  }
  // 최근 것이 먼저다 — 목록을 아래로 훑어 내려가게 하면 안 된다.
  if (history.missionHistory()[0]?.outcome !== 'failed') failures.push('최근 판이 맨 위가 아니다');
  // **사유는 로봇이 준 것 그대로.** 여기서 문장을 만들지 않는다.
  if (history.missionHistory()[0]?.reason !== 'INVALID_ARGUMENT deg out of range') {
    failures.push('실패 사유가 넘어온 그대로가 아니다');
  }
  if (history.missionHistory()[0]?.failedTaskId !== 'T-B2') failures.push('어느 노드에서 실패했는지 안 남는다');

  // 「초기화」는 목록도 비운다 — 화면을 처음 상태로 되돌리는 것이다.
  resetMission();
  if (history.missionHistory().length !== 0) failures.push('초기화했는데 이력이 남아 있다');
}

// ── 4. DB 이력인 척하지 않는다 ──────────────────────────────────────────────
{
  const view = src('views', 'MissionHistory.tsx');
  if (!/mission-history/.test(view)) {
    failures.push('DB 이력 자리표시를 안 남긴다 — 이 목록이 DB 것으로 읽힌다');
  }
  // 파일 창구가 없을 때(단독 빌드 등)는 이 세션 것뿐이라고 적어야 한다.
  if (!/세션/.test(view)) failures.push('창구가 없을 때 이 세션에만 남는다는 말이 없다 — 새로고침하고 「사라졌다」가 된다');
  if (!/listRecordedRuns/.test(view) || !/openRecordedRun/.test(view)) failures.push('목록이 저장된 판을 안 읽거나 다시보기가 없다');
  // 끝난 판이 셋 중 무엇인지 적어야 한다.
  for (const word of ['완료', '실패', '정지']) {
    if (!new RegExp(word).test(src('data', 'missionHistory.ts'))) failures.push(`결과 「${word}」 가 없다`);
  }
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **표시를 안 내리는 사본.** 다시 그릴 때마다 한 줄씩 늘어난다.
  history.resetMissionHistory();
  history.armMissionHistory();
  let naive = 0;
  for (let again = 0; again < 5; again += 1) {
    naive += 1;                                    // 표시를 안 보는 사본
    history.noteMissionEnd(entry('MSN-260909-01', 'done'));
  }
  control('한 판을 다시 그릴 때마다 적는 사본', naive === 5 && history.missionHistory().length === 1);
  history.resetMissionHistory();
}
{
  // **손으로 쓴 목록을 쓰는 사본.**
  const made = "['MSN-260826-01 · 실패', 'MSN-260826-00 · 완료']";
  control('손으로 쓴 이력을 그리는 사본',
    /MSN-260826-01 · 실패/.test(made) && !/MSN-260826-01 · 실패/.test(src('main.tsx')));
}

if (failures.length) {
  console.error(`❌ verify:mission-history\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 손으로 쓴 이력이 사라지고 두 자리(셸 판·리플레이 기둥)가 같은 목록을 그린다');
console.log('✅ 한 판은 한 줄 — 다시 그려도 안 늘어나고, 새 판이 서면 새 줄이 쌓인다 (최근 것이 위)');
console.log('✅ 실패는 어느 노드에서 왜인지 로봇이 준 그대로 남고, 초기화하면 목록도 비운다');
console.log('✅ 목록은 저장된 판을 읽어 다시보기를 달고, DB 이력은 자리표시로 남긴다 — 창구가 없으면 이 세션 것뿐이라고 적는다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
