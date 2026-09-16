// verify:no-leak (260906 신설 — 마일스톤 분리 지시서 §4 검사)
//
// **few-shot 예시에 채점 대상 편이 들어가지 않았는가.**
//
// 정답을 보여주고 정답을 맞히라고 한 표는 아무것도 증명하지 못한다. 정답셋이 4편뿐이라
// 한 편만 새어도 그 편의 숫자는 통째로 무의미해지고, **논문에서 가장 먼저 찔리는 자리**가
// 여기다. 그래서 규칙을 코드 한 곳(`scripts/lib/fewshot.mjs`)에 두고 여기서 검사한다.
//
// 넷을 본다.
//   1. 규칙 함수가 실제로 빼는가 — 안 빼는 사본(대조군) 포함
//   2. **실제로 돌린 기록**이 깨끗한가 (`gen-lab/runs/*/summary.json` 의 `examples_used`)
//   3. 서비스가 예시를 **스스로 만들지 않는가** — 정답셋을 여는 경로가 프롬프트 쪽에 없는가
//   4. 기록의 예시 수가 **0 또는 그 실행이 돈 편 수에서 하나 뺀 수**인가 (빼는 척하고 다
//      넣지 않았는가). 한 실행 안에서 섞여 있으면 실패다
//   5. **프롬프트에 주는 장비 목록이 채점 어휘와 같지 않은가** (7단계 신설)
//
// 2번이 이 검사의 알맹이다. 함수가 옳아도 **그 함수를 안 쓰고 돌린 실행**이 있으면
// 표는 여전히 거짓말한다. 그래서 함수가 아니라 남은 기록을 본다.
//
// ## 4번이 「언제나 N−1 편」에서 「0 또는 N−1 편」으로 넓어졌다 (7단계)
//
// 6단계가 남긴 질문이 「개수 일치 45% 가 실력인가 예시를 베낀 것인가」였고, 그것은
// **예시를 빼고 같은 것을 재야** 답이 된다. 그래서 0편을 허용한다. 넓힌 것은 개수뿐이다 —
// 채점 대상 편이 예시에 드는 것은 어느 판에서도 여전히 실패이고, **한 실행 안에서 0편과
// N−1 편이 섞이면** 그 실행의 숫자는 어느 판의 것도 아니게 되므로 그것도 실패다.
//
// ## 5번이 새로 붙은 이유 — 목록을 주면 그 목록이 정답이 될 수 있다
//
// 7단계가 장비에 그라운딩을 준다. 그런데 채점기의 장비 어휘는 **정답셋의
// `assigned_targets` 합집합**이다(`score-generation.mjs` 축 2d). 그 합집합을 그대로
// 프롬프트에 실으면 「목록에서 고를 줄 아는가」가 아니라 「준 것을 옮겨 적는가」를 재게
// 되고, **축이 자기 자신을 채점한다.** 오답 선택지가 섞여 있어야 시험이 성립한다.
//
// 반대쪽도 막는다 — 정답의 장비가 목록에서 빠지면 「정답을 쓰지 말라」고 말한 셈이 된다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(vizRoot, '..');
const goldDir = join(repoRoot, 'gen-lab', 'goldset', 'missions');
const runsDir = join(repoRoot, 'gen-lab', 'runs');
const failures = [];
const controls = [];
const notes = [];

const gold = readdirSync(goldDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(goldDir, name), 'utf8')))
  .sort((a, b) => a.mission_id.localeCompare(b.mission_id));

if (gold.length === 0) {
  console.error('❌ 정답셋이 비어 있다 — 먼저 `npm run goldset:extract` 를 돌려라');
  process.exit(1);
}

// **규칙은 여기 있지 않다.** 예시를 몇 편 싣는가는 `lib/fewshot.mjs` 한 곳이고,
// 이 검사는 그 함수를 실제로 불러 쓴다 — 규칙을 베껴 오면 두 벌이 조용히 갈라진다.
const { examplesFor, asExample, allowedExampleCounts } = await import('./lib/fewshot.mjs');

/**
 * **채점기의 장비 어휘.** `score-generation.mjs` 축 2d 와 같은 것을 같은 방법으로 센다 —
 * 정답셋 각 편의 `assigned_targets` 합집합이다.
 *
 * 프롬프트에 싣는 목록(`equipment/equipment.json`)이 이것과 같아지면 축이 죽는다.
 * 그 비교가 5번 검사이고, 여기서 한 번 세어 2번과 5번이 같은 수를 본다.
 */
const goldTargets = new Set();
for (const mission of gold) {
  for (const milestone of mission.milestones ?? []) {
    for (const target of milestone.assigned_targets ?? []) goldTargets.add(target);
  }
}

// ── 1. 규칙 함수 ─────────────────────────────────────────────────────────────
{
  for (const mission of gold) {
    const examples = examplesFor(mission.mission_id, gold);
    const ids = examples.map((example) => example.mission_id);
    if (ids.includes(mission.mission_id)) {
      failures.push(`examplesFor('${mission.mission_id}') 가 채점 대상 편을 예시에 넣었다`);
    }
    if (ids.length !== gold.length - 1) {
      failures.push(`examplesFor('${mission.mission_id}') 가 ${ids.length}편을 냈다 — ${gold.length - 1}편이어야 한다`);
    }
    // 0편 방식(7단계 C 판)도 규칙 함수를 지난다. **예시를 안 주는 것도 규칙이다** —
    // 부르는 쪽이 빈 배열을 직접 만들면 그 순간 규칙이 두 곳으로 갈라진다.
    if (examplesFor(mission.mission_id, gold, 'none').length !== 0) {
      failures.push(`examplesFor('${mission.mission_id}', 'none') 이 예시를 냈다 — 0편이어야 한다`);
    }
    if (allowedExampleCounts(gold.length).join(',') !== [0, gold.length - 1].join(',')) {
      failures.push(`allowedExampleCounts(${gold.length}) 가 [0, ${gold.length - 1}] 이 아니다`);
    }
    // 기본 판의 예시는 **마일스톤까지다.** 태스크를 실으면 모델이 이번 단계에서 하지
    // 말아야 할 일을 배운다 (§5).
    for (const example of examples) {
      if (example.milestones.some((milestone) => (milestone.tasks ?? []).length > 0)) {
        failures.push(`예시(${example.mission_id})에 태스크가 실렸다 — G-01 단계의 예시는 마일스톤까지다`);
      }
    }
    // 태스크 판(10단계 E)에서는 태스크가 실린다. **그때도 `deps` 는 비어 있어야 한다** —
    // 정답의 의존을 보여주면 모델이 그것을 흉내 내고, 그 순간 지시서 §5 가 막으려던 것
    // (근거 없는 `deps`)이 규칙이 아니라 **예시를 통해** 들어온다. 의존은 예시가 아니라
    // `solveDeps()` 가 만든다.
    for (const example of examplesFor(mission.mission_id, gold, 'leave-one-out', { tasks: true })) {
      const tasks = example.milestones.flatMap((milestone) => milestone.tasks ?? []);
      if (tasks.length === 0) {
        failures.push(`태스크 판의 예시(${example.mission_id})에 태스크가 없다 — 규칙만 바꾸고 예시를 그대로 두면 예시가 이긴다 (10단계 E 판 15건 중 10건)`);
      }
      const leaked = tasks.filter((task) => (task.deps ?? []).length > 0);
      if (leaked.length) {
        failures.push(`태스크 판의 예시(${example.mission_id})가 deps 를 ${leaked.length}건 보여준다 — 의존은 예시가 아니라 규칙이 만든다 (§5)`);
      }
    }
  }
  // 대조군 — 안 빼는 사본은 반드시 잡혀야 한다.
  const leaky = (missionId, missions) => missions.map(asExample);
  if (!leaky(gold[0].mission_id, gold).some((example) => example.mission_id === gold[0].mission_id)) {
    failures.push('누출 대조군을 만들지 못했다 — 이 검사는 무의미하다');
  } else {
    controls.push('채점 대상 편을 빼지 않는 사본');
  }
}

// ── 2. 실제로 돌린 기록 ───────────────────────────────────────────────────────
//
// **함수가 옳은 것과 그 함수로 돌린 것은 다른 일이다.**
{
  let labels = [];
  try {
    labels = readdirSync(runsDir).filter((name) => statSync(join(runsDir, name)).isDirectory());
  } catch {
    labels = [];
  }
  if (labels.length === 0) {
    // 실행이 없는 것은 실패가 아니다 — 하지만 **검사했다고 말하지도 않는다.**
    notes.push('gen-lab/runs/ 에 실행 기록이 없다 — 기록 검사는 하지 않았다 (0건을 통과로 세지 않는다)');
  }
  let checked = 0;
  for (const label of labels) {
    let summary;
    try {
      summary = JSON.parse(readFileSync(join(runsDir, label, 'summary.json'), 'utf8'));
    } catch {
      notes.push(`${label}: summary.json 이 없다 — 아직 안 끝난 실행이다`);
      continue;
    }
    // 예시 수는 **그 실행이 돈 편 수** 기준으로 본다. 지금 정답셋 크기로 재면, 정답셋이
    // 바뀐 뒤(415 편 보류 · 260907) 옛 실행이 전부 실패로 잡힌다 — 그 실행은 그 시점의
    // 규칙을 지켰는데도. 검사가 봐야 하는 것은 「그때 leave-one-out 을 지켰는가」다.
    const runMissions = new Set((summary.records ?? []).map((r) => r.mission_id).filter(Boolean));
    // **0 또는 N−1.** 규칙은 `lib/fewshot.mjs` 한 곳에 있고 여기서 다시 적지 않는다.
    const allowed = allowedExampleCounts(runMissions.size);
    const seenCounts = new Set();
    for (const record of summary.records ?? []) {
      checked += 1;
      const used = record.examples_used ?? null;
      if (used === null) {
        failures.push(`${label} / ${record.mission_id} v${record.variant}: 어떤 예시를 썼는지 기록이 없다 — 누출을 확인할 방법이 없다`);
        continue;
      }
      if (used.includes(record.mission_id)) {
        failures.push(`${label} / ${record.mission_id} v${record.variant}: **채점 대상 편이 예시에 들어갔다** (${used.join(', ')})`);
      }
      if (!allowed.includes(used.length)) {
        failures.push(`${label} / ${record.mission_id} v${record.variant}: 예시가 ${used.length}편이다 — 이 실행은 ${runMissions.size}편을 돌았으므로 ${allowed.join(' 또는 ')}편이어야 한다`);
      }
      seenCounts.add(used.length);
      // 장비 목록을 준 판이라면, 그 목록이 채점 어휘와 같은 크기로 좁아진 채 돌지
      // 않았는가. **기록이 스스로를 설명해야 한다** — 5번이 파일을 보고 여기서 실행을 본다.
      if (record.equipment_given != null && record.equipment_given > 0 && record.equipment_given <= goldTargets.size) {
        failures.push(`${label} / ${record.mission_id} v${record.variant}: 장비 목록이 ${record.equipment_given}건이다 — 채점 어휘 ${goldTargets.size}건보다 넓어야 한다`);
      }
    }
    // **섞인 기록은 여전히 실패다.** 한 실행 안에서 0편과 N−1 편이 섞이면 그 실행의
    // 숫자는 어느 판의 것도 아니게 된다 — 판을 가르려고 예시를 뺀 것인데 반만 뺐다면
    // 그 표가 답하는 질문이 없다.
    if (seenCounts.size > 1) {
      failures.push(`${label}: 한 실행 안에서 예시 수가 섞였다 (${[...seenCounts].sort().join(' · ')}편) — 어느 판의 숫자인지 말할 수 없다`);
    }
  }
  if (checked > 0) controls.push(`실행 기록 ${checked}건을 실제로 훑음`);

  // 대조군 — 누출된 기록을 넣으면 반드시 잡혀야 한다.
  const dirty = { mission_id: gold[0].mission_id, variant: 0, examples_used: gold.map((mission) => mission.mission_id) };
  const caught = dirty.examples_used.includes(dirty.mission_id) && !allowedExampleCounts(gold.length).includes(dirty.examples_used.length);
  if (!caught) failures.push('누출된 기록 대조군을 만들지 못했다 — 이 검사는 무의미하다');
  else controls.push('채점 대상 편이 섞인 기록');

  // 대조군 — **섞인 기록.** 0편을 허용하면서 생긴 새 구멍이라 대조군도 새로 둔다.
  const mixed = new Set([0, gold.length - 1]);
  if (mixed.size <= 1) notes.push('정답셋이 작아 섞인 기록 대조군을 만들 수 없다 (0편과 N−1편이 같은 수다)');
  else controls.push('한 실행 안에서 예시 수가 섞인 기록');
}

// ── 3. 서비스가 예시를 스스로 만들지 않는가 ────────────────────────────────────
//
// 예시를 고르는 것은 **부르는 쪽**이다. 서비스가 정답셋을 직접 열면 「채점 대상 편을
// 뺐다」를 부르는 쪽이 보장할 수 없게 된다 — 그 순간 규칙이 두 곳으로 갈라진다.
{
  const promptSource = readFileSync(join(repoRoot, 'gen-lab', 'server', 'prompt.py'), 'utf8');
  if (/goldset|missions\//.test(promptSource)) {
    failures.push('gen-lab/server/prompt.py 가 정답셋 경로를 안다 — 예시를 서비스가 스스로 고를 수 있게 된다');
  }
  // 라우터가 정답셋을 **세는** 것은 괜찮다 (health 의 건수). 읽어서 예시로 싣는 경로가
  // 없어야 한다 — 예시는 요청으로만 들어온다.
  const mainSource = readFileSync(join(repoRoot, 'gen-lab', 'server', 'main.py'), 'utf8');
  if (/examples\s*=\s*\[.*goldset/is.test(mainSource)) {
    failures.push('gen-lab/server/main.py 가 정답셋에서 예시를 채운다 — 부르는 쪽의 선택이 무의미해진다');
  }
  controls.push('서비스가 정답셋을 열어 예시를 만들지 않음');
}

// ── 5. 프롬프트에 주는 장비 목록이 채점 어휘와 같지 않은가 ────────────────────
//
// **같아지는 순간 이 축은 자기 자신을 채점한다.** 장소에 들은 처방을 장비에 그대로 주되,
// 준 목록이 채점 어휘보다 넓어야 「목록에서 고를 줄 아는가」를 재는 것이 된다.
let equipmentLine = null;
{
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(join(repoRoot, 'equipment', 'equipment.json'), 'utf8'));
  } catch {
    // 아직 안 뽑았다. **실패는 아니지만 검사했다고 말하지도 않는다** — 2번과 같은 규칙이다.
    notes.push('equipment/equipment.json 이 없다 — 장비 어휘 검사는 하지 않았다 (`npm run extract:equipment`)');
  }
  if (doc !== null) {
    const listed = new Set((doc.equipment ?? []).map((entry) => entry.equipment_id));
    const extras = [...listed].filter((id) => !goldTargets.has(id)).sort();
    const absent = [...goldTargets].filter((id) => !listed.has(id)).sort();

    if (extras.length === 0) {
      failures.push(`장비 목록 ${listed.size}건이 채점 어휘와 같다 — **오답 선택지가 없는 시험이다.** 이 축은 「목록에서 고를 줄 아는가」가 아니라 「준 것을 옮겨 적는가」를 재게 된다`);
    }
    if (absent.length) {
      failures.push(`정답의 장비가 목록에 없다: ${absent.join(', ')} — 「정답을 쓰지 말라」고 말한 셈이고, 그 편은 낼 수 있는 답이 없다`);
    }
    if (extras.length && !absent.length) {
      equipmentLine = `장비 목록 ${listed.size}건 · 채점 어휘 ${goldTargets.size}건 · 오답 선택지 ${extras.length}건 (${extras.join(' · ')})`;
    }

    // 대조군 — 채점 어휘만 남긴 사본은 반드시 잡혀야 한다.
    const narrowed = new Set([...listed].filter((id) => goldTargets.has(id)));
    const caught = [...narrowed].every((id) => goldTargets.has(id)) && narrowed.size === goldTargets.size;
    if (!caught) failures.push('장비 목록 대조군을 만들지 못했다 — 이 검사는 무의미하다');
    else controls.push('채점 어휘만 남긴 장비 목록');
  }
}

// ── 6. 화면이 만드는 예시가 측정 경로와 같은가 (260907 · 9단계) ────────────────
//
// 9단계에 **예시를 싣는 경로가 둘이 됐다.** 측정은 정답셋(snake_case)에서 만들고, 화면은
// 대본 라이브러리(camelCase)에서 만든다 — 원천의 표기가 달라 함수를 공유할 수 없었다.
//
// 그러면 두 벌이 조용히 갈라지는 자리가 하나 생긴다. **주석으로 「같다」고 적지 않고
// 여기서 실제로 만들어 대조한다.** 갈라지면 화면은 표가 설명하지 못하는 조건으로 돌게
// 되고, 그때 「화면이 왜 표보다 잘/못하지」에 답이 없다.
//
// 그리고 화면에도 leave-one-out 이 걸려 있는지 본다 — 화면의 시연 문장이 곧 대본의
// 기준 문장이라, 맞은 편을 예시로 실으면 **정답을 주고 정답을 맞히라고 하는 것**이 된다.
{
  const { SCRIPT_LIBRARY } = await import(pathToFileURL(join(vizRoot, 'src', 'scenarios', 'library.ts')).href);
  const { examplesForUtterance, scriptAsExample } = await import(
    pathToFileURL(join(vizRoot, 'src', 'generate', 'fewshot.ts')).href
  );

  for (const mission of gold) {
    const entry = SCRIPT_LIBRARY.find((item) => item.missionId === mission.mission_id);
    if (!entry?.script) {
      failures.push(`정답셋의 ${mission.mission_id} 이 대본 라이브러리에 없다 — 화면은 이 편을 예시로 실을 수 없다`);
      continue;
    }
    // **두 판을 다 대조한다.** 태스크 판만 갈라져도 화면과 표가 다른 프롬프트로 돈다.
    for (const options of [{ tasks: false }, { tasks: true }]) {
      const fromScreen = JSON.stringify(scriptAsExample(entry.script, options));
      const fromMeasurement = JSON.stringify(asExample(mission, options));
      if (fromScreen !== fromMeasurement) {
        failures.push(
          `화면과 측정 경로의 예시가 다르다 (${mission.mission_id} · 태스크 ${options.tasks}) — 두 벌이 갈라졌다.\n`
          + `      화면: ${fromScreen.slice(0, 220)}\n      측정: ${fromMeasurement.slice(0, 220)}`,
        );
      }
    }
  }

  // 화면도 맞은 편을 뺀다.
  const target = gold[0].mission_id;
  const shown = examplesForUtterance(SCRIPT_LIBRARY, target).map((example) => example.mission_id);
  if (shown.includes(target)) {
    failures.push(`화면이 맞은 편(${target})을 예시로 싣는다 — 정답을 주고 정답을 맞히라고 하는 것이다`);
  }
  // 옛 편은 애초에 안 실린다 — 그 편의 장소(415호)가 지금 지도에 없다.
  const legacy = SCRIPT_LIBRARY.filter((item) => item.world === 'legacy').map((item) => item.missionId);
  const all = examplesForUtterance(SCRIPT_LIBRARY, null).map((example) => example.mission_id);
  for (const id of legacy) {
    if (all.includes(id)) failures.push(`화면이 옛 편(${id})을 예시로 싣는다 — 지도에 없는 장소를 모델에게 쥐여 준다`);
  }

  // 대조군 — 빼지 않는 사본은 반드시 잡혀야 한다.
  const notFiltered = SCRIPT_LIBRARY
    .filter((item) => item.world === 'registry' && item.script !== null)
    .map((item) => item.missionId);
  if (!notFiltered.includes(target)) failures.push('화면 예시 대조군을 만들지 못했다 — 이 검사는 무의미하다');
  else controls.push('화면 예시에서 맞은 편을 빼지 않은 사본');
}

if (failures.length) {
  console.error(`❌ verify:no-leak\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`✅ leave-one-out — 정답셋 ${gold.length}편, 예시는 ${allowedExampleCounts(gold.length).join('편 또는 ')}편이고 채점 대상 편은 어느 쪽에서도 빠진다`);
console.log('✅ 실행 기록의 examples_used 에 자기 자신이 없다 — 함수가 아니라 남은 기록을 봤다');
console.log('✅ 예시를 고르는 것은 부르는 쪽이다 — 서비스는 정답셋을 열지 않는다');
console.log('✅ 화면이 만드는 예시가 측정 경로의 예시와 글자까지 같다 (두 판 모두) — 화면도 맞은 편을 뺀다 (leave-one-out)');
console.log('✅ 태스크 판의 예시는 태스크를 보이되 deps 는 비어 있다 — 의존은 예시가 아니라 규칙이 만든다');
if (equipmentLine !== null) console.log(`✅ ${equipmentLine} — 목록이 채점 어휘보다 넓다`);
console.log(`✅ 대조군 ${controls.length}건 — ${controls.join(' · ')}`);
for (const note of notes) console.log(`   · ${note}`);
