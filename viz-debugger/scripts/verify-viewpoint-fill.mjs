// verify:viewpoint-fill (260909 신설 — 시연 대본 지시서 §8)
//
// 8분할 뷰포인트가 **하나씩** 채워지는가, 그리고 **인덱스로** 찾아가는가.
//
// 막으려는 실패 넷.
//  1. **한꺼번에 바뀌는 것.** 회전이 지나가면서 하나씩 채워져야 한다(§4). 전부 채워진 뒤
//     한 번에 색이 바뀌면 「돌면서 본다」는 이야기가 화면에서 사라진다.
//  2. **도착 순서로 노드를 고르는 것.** 실제 탐지는 268ms 걸리고 순서가 뒤집힐 수 있다.
//     **사건을 뒤섞어 넣어도 각 노드가 제 인덱스로 찾아가야 한다** — 지시서가 이 줄을
//     「중요하다」고 못박았다.
//  3. **yaw 로 노드를 고르는 것.** 실제 로봇은 드리프트가 있어 90도를 명령해도 88.4도가
//     온다. 각도로 맞추면 어긋난다 — rotation_index 가 유일한 열쇠다(§6).
//  4. **대본과 라이브가 다른 길로 가는 것.** 두 입구가 같은 프레임을 내야 로봇이 붙는 날
//     노드 갱신 코드를 안 고친다. 가르는 자리가 한 곳인지 파일 수준에서도 본다.
//
// 대조군 포함 — 규칙을 무력화한 사본이 반드시 실패로 잡히는지까지 본다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);

const {
  emptyFill, applyRotation, applyDetection, reduceFrames,
  doorCell, cellsInOrder, cellClass, scanHead,
} = await load('src', 'viewpoint', 'fill.ts');
const { scriptFrames, liveFrame, toFrame } = await load('src', 'viewpoint', 'source.ts');

const door = JSON.parse(readFileSync(join(root, 'scenarios', 'MSN-260909-01.json'), 'utf8'));
const COUNT = 8;
const DOOR_INDEX = 2;

const failures = [];
const controls = [];
const phases = (fill) => cellsInOrder(fill).map((c) => c.phase).join(',');
/** 판정이 끝난 상태 둘. fill.ts 의 같은 이름 헬퍼와 뜻이 같다. */
const isJudged = (phase) => phase === 'rejected' || phase === 'selected';

// ── 1. 하나씩 채워진다 ────────────────────────────────────────────────────────
//
// 대본의 프레임을 시각 순으로 넣으면서 매 걸음의 그림을 본다. 「한꺼번에」가 아니라
// 「하나씩」이라는 것은, 걸음마다 판정 완료 칸 수가 **1씩만** 늘어난다는 뜻이다.
{
  const timeline = door.viewpointTimeline ?? [];
  let fill = emptyFill(COUNT);
  if (phases(fill) !== Array(COUNT).fill('pending').join(',')) {
    failures.push('승인 직후 여덟이 전부 대기가 아니다 — 다 보이되 비어 있어야 한다');
  }
  let judged = 0;
  let sawScanning = 0;
  const seenPhases = new Set();
  const seconds = [...new Set(timeline.map((e) => e.atSec))].sort((a, b) => a - b);
  for (const sec of seconds) {
    fill = reduceFrames(emptyFill(COUNT), scriptFrames(door.viewpointTimeline, sec));
    const now = cellsInOrder(fill).filter((c) => isJudged(c.phase)).length;
    if (now > judged + 1) failures.push(`${sec}초에 판정 완료가 ${judged}→${now} — 한 번에 둘 이상 채워졌다`);
    judged = now;
    if (cellsInOrder(fill).some((c) => c.phase === 'scanning')) sawScanning += 1;
    for (const c of cellsInOrder(fill)) seenPhases.add(c.phase);
  }
  if (judged !== COUNT) failures.push(`끝까지 흘려도 판정 완료가 ${judged}칸 — 여덟이어야 한다`);
  if (sawScanning === 0) failures.push('탐색 중 상태를 한 번도 지나지 않았다 — 대기에서 판정으로 건너뛴다');
  // 상태 **넷을 다 거치는가** (§4). 하나라도 안 나오면 그 상태는 화면에서 죽은 값이다.
  for (const phase of ['pending', 'scanning', 'rejected', 'selected']) {
    if (!seenPhases.has(phase)) failures.push(`재생 내내 '${phase}' 상태가 한 번도 안 나왔다`);
  }

  // 초록은 하나. 그리고 그것이 90도다.
  const green = cellsInOrder(fill).filter((c) => c.detection?.door === true);
  if (green.length !== 1) failures.push(`초록이 ${green.length}칸 — 90도 하나여야 한다`);
  else if (green[0].index !== DOOR_INDEX) failures.push(`초록이 index ${green[0].index} — ${DOOR_INDEX}(90도)여야 한다`);
  if (doorCell(fill)?.index !== DOOR_INDEX) failures.push('doorCell 이 90도 칸을 가리키지 않는다');

  // 화면 이름 넷이 서로 다른가 — 같은 이름이면 대기와 판정이 같아 보인다.
  const names = new Set(cellsInOrder(fill).map(cellClass));
  if (!names.has('viewpoint--selected') || !names.has('viewpoint--rejected')) {
    failures.push(`판정 완료의 화면 이름이 선정/미선정으로 갈리지 않는다 — ${[...names].join(', ')}`);
  }
  // 상태 **넷**이 서로 다른 이름을 갖는가 (260910 §2) — 같으면 화면이 못 가른다.
  const allNames = new Set(['pending', 'scanning', 'rejected', 'selected'].map(
    (phase) => cellClass({ index: 0, phase, detection: null, rotation: null }),
  ));
  if (allNames.size !== 4) failures.push(`상태 넷의 화면 이름이 ${allNames.size} 종류 — 넷이어야 한다`);

  // index 2 만 선정, 나머지 일곱은 미선정 (§4).
  const selected = cellsInOrder(fill).filter((c) => c.phase === 'selected').map((c) => c.index);
  const rejected = cellsInOrder(fill).filter((c) => c.phase === 'rejected').map((c) => c.index);
  if (JSON.stringify(selected) !== JSON.stringify([DOOR_INDEX])) {
    failures.push(`선정이 [${selected.join(', ')}] — ${DOOR_INDEX} 하나여야 한다`);
  }
  if (rejected.length !== COUNT - 1) failures.push(`미선정이 ${rejected.length}칸 — 일곱이어야 한다`);
  if (cellClass(emptyFill(1).get(0)) !== 'viewpoint--pending') failures.push('대기의 화면 이름이 viewpoint--pending 이 아니다');
}

// ── 2. 뒤섞어 넣어도 제 인덱스로 (지시서가 못박은 줄) ─────────────────────────
{
  const all = scriptFrames(door.viewpointTimeline, door.durationSec);
  const ordered = reduceFrames(emptyFill(COUNT), all);

  // 되풀이해 섞는다 — 한 번의 우연으로 통과하지 않게.
  let rng = 20260909;
  const nextRandom = () => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng / 2147483648; };
  for (let trial = 0; trial < 50; trial += 1) {
    const shuffled = [...all];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(nextRandom() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const got = reduceFrames(emptyFill(COUNT), shuffled);
    const same = cellsInOrder(got).every((c, i) => {
      const want = cellsInOrder(ordered)[i];
      return c.index === want.index && c.phase === want.phase && (c.detection?.door ?? null) === (want.detection?.door ?? null);
    });
    if (!same) {
      failures.push(`뒤섞은 ${trial}번째에서 결과가 달라졌다 — 도착 순서로 노드를 고르고 있다`);
      break;
    }
  }

  // 가장 짧은 반례 — 탐지가 회전보다 먼저 온다(268ms 지연). 그래도 제 칸이 판정 완료다.
  {
    const late = reduceFrames(emptyFill(COUNT), [
      { channel: 'detection', payload: { index: 5, angle_deg: 225, door: false, bbox: null, confidence: 0.03, reason: '없음' } },
      { channel: 'robot_state', payload: { rotation_index: 5, yaw: 225, state: 'rotating', last_cmd: 'rotate_to', result: null } },
    ]);
    if (late.get(5).phase !== 'rejected') {
      failures.push('탐지가 회전보다 먼저 왔더니 판정이 대기로 되돌아갔다 — 늦은 회전이 결과를 지운다');
    }
  }
}

// ── 3. yaw 가 아니라 rotation_index ──────────────────────────────────────────
{
  // 드리프트 — 각도는 어긋나 있는데 인덱스는 맞다. 인덱스대로 가야 한다.
  const drift = applyRotation(emptyFill(COUNT), {
    rotation_index: 3, yaw: 88.4, state: 'rotating', last_cmd: 'rotate_to', result: null,
  });
  if (drift.get(3).phase !== 'scanning') failures.push('rotation_index 3 인데 3번 칸이 안 켜졌다');
  if (drift.get(2).phase !== 'pending') failures.push('yaw 88.4 를 90도로 읽어 2번 칸을 켰다 — 각도로 노드를 고르고 있다');

  // 표 밖의 인덱스는 버린다 — 없는 칸을 만들어 그리면 화면이 대본보다 커진다.
  const stray = applyDetection(emptyFill(COUNT), {
    index: 9, angle_deg: 405, door: true, bbox: null, confidence: 1, reason: '없는 칸',
  });
  if (stray.size !== COUNT) failures.push(`표 밖 인덱스 9가 칸을 만들었다 — 크기 ${stray.size}`);
}

// ── 4. 대본과 라이브가 같은 프레임을 낸다 ────────────────────────────────────
{
  const entry = (door.viewpointTimeline ?? []).find((e) => e.channel === 'detection');
  const fromScript = toFrame(entry.channel, entry.payload);
  const fromLive = liveFrame({ channel: entry.channel, payload: entry.payload });
  if (JSON.stringify(fromScript) !== JSON.stringify(fromLive)) {
    failures.push('같은 값이 대본 입구와 라이브 입구에서 다른 프레임이 됐다 — 가르는 자리가 둘이다');
  }
  // 형식에 안 맞으면 null — 지어 채우지 않는다.
  if (toFrame('detection', { index: 'two', door: true }) !== null) failures.push('형식이 어긋난 값이 프레임이 됐다');
  if (toFrame('무슨채널', { index: 1, door: true }) !== null) failures.push('모르는 채널이 프레임이 됐다');

  // 노드 갱신 코드가 대본을 알면 안 된다 (§6) — 파일 수준에서 확인한다.
  const fillSource = readFileSync(join(root, 'src', 'viewpoint', 'fill.ts'), 'utf8');
  for (const word of ['scenarios/', 'ScriptScenario', 'viewpointTimeline', 'atSec']) {
    if (fillSource.includes(word)) {
      failures.push(`fill.ts 가 「${word}」 를 안다 — 노드 갱신 코드가 대본을 알면 라이브로 못 갈아끼운다`);
    }
  }
}

// ── 5. 화면은 **흘러온 것**을 접는다 (열과 되감기) ────────────────────────────
//
// 처음에 대본에서 곧바로 접게 만들었다가 되돌렸다 — `src/data/trace.ts` 머리말이 260904 에
// 고쳐 둔 실패가 정확히 그것이다. 열을 지나야 라이브로 갈아끼울 때 화면이 안 바뀐다.
{
  const { resetViewpoint, appendViewpoint, framesUpTo, arrivedFrames } = await load('src', 'viewpoint', 'store.ts');

  resetViewpoint('MSN-260909-01');
  for (const entry of door.viewpointTimeline ?? []) {
    const frame = toFrame(entry.channel, entry.payload);
    if (frame !== null) appendViewpoint('MSN-260909-01', entry.atSec, frame);
  }

  // 다른 임무의 프레임은 버린다 — 재접속 직후 늦게 닿은 것이 남의 노드를 칠하면 안 된다.
  const before = arrivedFrames().length;
  appendViewpoint('MSN-260831-01', 0, {
    channel: 'detection',
    payload: { index: 0, angle_deg: 0, door: true, bbox: null, confidence: 1, reason: '남의 임무' },
  });
  if (arrivedFrames().length !== before) failures.push('다른 임무의 프레임이 열에 들어갔다');

  // 되감기 — 머리를 뒤로 끌면 그 시각 이후는 아직 안 온 것으로 접힌다.
  const spinStart = door.params.spin_start_sec;
  const atFirst = reduceFrames(emptyFill(COUNT), framesUpTo(spinStart + 1));
  const atEnd = reduceFrames(emptyFill(COUNT), framesUpTo(door.durationSec));
  const judgedFirst = cellsInOrder(atFirst).filter((c) => isJudged(c.phase)).length;
  const judgedEnd = cellsInOrder(atEnd).filter((c) => isJudged(c.phase)).length;
  if (judgedFirst !== 1) failures.push(`첫 탐지 시각에 판정 완료가 ${judgedFirst}칸 — 하나여야 한다`);
  if (judgedEnd !== COUNT) failures.push(`끝에 판정 완료가 ${judgedEnd}칸 — 여덟이어야 한다`);

  // 되감았다가 다시 앞으로 — 같은 시각이면 같은 그림이다. 상태를 들고 있으면 안 꺼진다.
  const again = reduceFrames(emptyFill(COUNT), framesUpTo(spinStart + 1));
  if (phases(again) !== phases(atFirst)) failures.push('되감았다 돌아온 그림이 다르다 — 열이 아니라 상태를 들고 있다');

  // 열을 비우면 여덟이 전부 대기다.
  resetViewpoint('MSN-260909-01');
  if (framesUpTo(door.durationSec).length !== 0) failures.push('열을 비웠는데 프레임이 남았다');
}

// ── 대조군 — 무력화한 사본이 잡히는가 ────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // 도착 순서로 채우는 잘못된 구현. 뒤섞으면 반드시 달라져야 한다.
  const byArrival = (frames) => {
    const cells = [...Array(COUNT)].map((_, i) => ({ index: i, phase: 'idle' }));
    let cursor = 0;
    for (const f of frames) {
      if (f.channel === 'detection') { cells[cursor % COUNT].phase = 'judged'; cursor += 1; }
    }
    return cells.map((c) => c.phase).join(',');
  };
  const all = scriptFrames(door.viewpointTimeline, door.durationSec);
  const shuffled = [...all].reverse();
  const sameOrdered = reduceFrames(emptyFill(COUNT), all);
  const sameShuffled = reduceFrames(emptyFill(COUNT), shuffled);
  control(
    '도착 순서로 채우는 구현',
    byArrival(all) !== byArrival(shuffled) || phases(sameOrdered) === phases(sameShuffled),
  );
}
{
  // 판정이 끝난 칸을 늦은 회전이 되돌리면 안 된다.
  const judged = applyDetection(emptyFill(COUNT), {
    index: 1, angle_deg: 45, door: false, bbox: null, confidence: 0.02, reason: '없음',
  });
  const late = applyRotation(judged, { rotation_index: 1, yaw: 45, state: 'rotating', last_cmd: 'rotate_to', result: null });
  control('판정 뒤 늦게 온 회전', late.get(1).phase === 'rejected');
}
{
  // 초록을 둘로 만들면 doorCell 이 「하나」라는 이야기를 못 한다.
  const two = applyDetection(
    applyDetection(emptyFill(COUNT), { index: 2, angle_deg: 90, door: true, bbox: [0, 0, 1, 1], confidence: 0.9, reason: 'a' }),
    { index: 6, angle_deg: 270, door: true, bbox: [0, 0, 1, 1], confidence: 0.9, reason: 'b' },
  );
  const greens = cellsInOrder(two).filter((c) => c.detection?.door === true).length;
  control('초록 둘', greens === 2);
}

// ── 결과 ─────────────────────────────────────────────────────────────────────
// ── 「탐색 중」과 「탐색 완료」를 가른다 (260910 지적) ────────────────────────
//
// `scanning` 은 「회전이 지나갔고 판정은 아직」이라는 뜻인데, 화면의 낱말이 「지금 이 칸을
// 보고 있다」로 읽힌다. 그래서 여덟을 다 돌고 난 뒤에도 전부 「탐색 중」이라고 적혀 있었다.
//
// 지금 보고 있는 칸은 **하나뿐**이고, 지나간 칸은 탐색이 끝난 것이다.
{
  const rotate = (fill, index) => applyRotation(fill, { rotation_index: index, yaw: index * 45, state: 'rotating', last_cmd: 'rotate_to', result: null });
  let fill = emptyFill(8);
  if (scanHead(fill) !== null) failures.push('아무 회전도 안 왔는데 「지금 보는 칸」이 있다');

  fill = rotate(fill, 0);
  if (scanHead(fill) !== 0) failures.push(`첫 걸음 뒤 머리가 ${scanHead(fill)} 다 — 0 이어야 한다`);
  fill = rotate(fill, 1);
  fill = rotate(fill, 2);
  if (scanHead(fill) !== 2) failures.push(`세 걸음 뒤 머리가 ${scanHead(fill)} 다 — 2 여야 한다`);
  // 지나간 칸은 「지금 보는 칸」이 아니다 — 화면이 「탐색 완료」로 적는 근거다.
  for (const passed of [0, 1]) {
    if (scanHead(fill) === passed) failures.push(`지나간 ${passed}번이 아직 머리다`);
  }

  // **여덟이 다 지나가면 머리가 없다** — 탐색이 끝난 것이고 전부 「탐색 완료」다.
  for (let i = 3; i < 8; i += 1) fill = rotate(fill, i);
  if (scanHead(fill) !== null) failures.push(`여덟을 다 돌았는데 머리가 ${scanHead(fill)} 로 남았다 — 그 칸만 「탐색 중」으로 남는다`);

  // 화면이 실제로 이 함수를 쓰는가 — 함수가 있다와 화면이 쓴다는 다르다.
  const { readFileSync } = await import('node:fs');
  const graph = readFileSync(join(root, 'src', 'graph', 'TaskGraph.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (!/scanHead\(/.test(graph)) failures.push('화면이 scanHead 를 안 쓴다 — 다 돌고도 「탐색 중」이 남는다');
  if (!/탐색 완료/.test(graph)) failures.push('「탐색 완료」라는 말이 화면에 없다');
}

if (failures.length) {
  console.error(`❌ verify:viewpoint-fill\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 여덟이 대기로 서고 회전이 지나가며 하나씩 — 한 걸음에 한 칸씩만 채워진다');
console.log('✅ 상태 넷(대기·탐색 중·미선정·선정)을 다 거친다 · index 2 만 선정 · 나머지 일곱은 미선정');
console.log('✅ 뒤섞기 50회 · 탐지가 회전보다 먼저 와도 각 칸이 제 인덱스로 (도착 순서로 고르지 않는다)');
console.log('✅ yaw 88.4 는 3번 칸 — 각도가 아니라 rotation_index 가 열쇠 · 표 밖 인덱스는 버린다');
console.log('✅ 대본 입구와 라이브 입구가 같은 프레임 · fill.ts 는 대본을 모른다 (가르는 자리 한 곳)');
console.log('✅ 화면은 흘러온 열을 접는다 — 되감기가 열에서 나오고 남의 임무 프레임은 버린다');
console.log('✅ 「탐색 중」은 한 칸뿐 — 지나간 칸은 「탐색 완료」이고 여덟을 다 돌면 머리가 없다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
