// scripts/run-baseline.mjs (260906 신설 — 마일스톤 분리 지시서 §4)
//
// `VZ-G-01` 베이스라인을 **CLI 로** 돌린다. 화면에 붙이기 전에 숫자가 나와야 한다 —
// 붙인 뒤에 실패하면 모델 탓인지 붙이는 코드 탓인지 가를 수 없다.
//
// ## 무엇을 도는가
//
//   모델 × 임무 4편 × 발화 5개(원본 1 + 변형 4) = 모델당 20건
//
// 발화 변형이 축의 하나다. **마일스톤 정답은 원본과 같으므로**(goldset/utterances.json)
// 같은 임무를 다른 말로 했을 때 같은 마일스톤이 나오는지가 표현 강건성이다.
//
// ## few-shot 은 leave-one-out 이다 — 여기가 누출이 나는 자리
//
// 채점 대상인 편을 예시에 넣으면 정답을 보여주고 정답을 맞히라고 하는 것이 된다.
// **논문에서 가장 먼저 찔리는 자리**이므로 규칙을 코드 한 곳(`examplesFor`)에 두고
// `verify:no-leak` 이 그 함수를 실제로 불러 검사한다.
//
// ## 부르는 길은 LlmClient 하나다
//
// 이 스크립트도 `src/generate/LlmClient.ts` 를 통해 부른다. 여기서 주소를 직접 알면
// 생성 주소를 아는 면이 둘이 되고, 그것이 `verify:gen-port` 가 막는 것이다.
//
// ## 실행
//
//   node scripts/run-baseline.mjs --model Qwen3-8B-Q4_K_M
//   node scripts/run-baseline.mjs --model X --no-grammar      문법 없는 대조군
//   node scripts/run-baseline.mjs --model X --no-equipment    장비 목록 없는 대조판 (7단계 A)
//   node scripts/run-baseline.mjs --model X --no-examples     예시 0편 (7단계 C)
//   node scripts/run-baseline.mjs --model X --node-kinds      노드 문법 5종 규칙 (8단계 D)
//   node scripts/run-baseline.mjs --model X --tasks           태스크까지 낸다 (10단계 E)
//   node scripts/run-baseline.mjs --model X --tasks --branch  분기·되풀이까지 (분기와루프 3단계 G)
//   node scripts/run-baseline.mjs --model X --limit 2         빠른 확인용
//   node scripts/run-baseline.mjs --rescore                   이미 낸 결과를 다시 채점만
//
// ## 스위치가 넷인 이유 — 하나씩만 움직여야 원인이 갈린다
//
// `--no-grammar` 는 「강제 디코딩이 실제로 듣는가」를, `--no-equipment` 는 「장비 목록이
// 위반을 줄이는가」를, `--no-examples` 는 「개수 일치가 실력인가 예시를 베낀 것인가」를,
// `--node-kinds` 는 「단계의 *종류*를 알려주면 빠뜨린 단계가 돌아오는가」를,
// `--tasks` 는 「모델이 노드 목록을 낼 줄 아는가」를 답한다.
// **한 번에 하나만 움직인다.** 둘을 같이 움직이면 그 판의 숫자는 두 원인 중 어느 쪽에도
// 돌릴 수 없고, 돌릴 수 없는 숫자는 표에 올릴 수 없다.
//
// 앞 셋은 기본이 켜짐이라 **끄는** 스위치이고 `--node-kinds`·`--tasks` 는 **켜는** 스위치다.
// 그 차이가 이름에 그대로 있다 — 이름이 기본값을 말하지 않으면 「끈 판」과 「안 켠 판」이
// 표에서 같은 얼굴을 하게 된다.
//
// `--rescore` 가 있는 이유: 채점기에 축이 붙으면 옛 실행의 숫자에 그 축이 없다. 그때
// **모델을 다시 돌리면 안 된다** — 같은 출력을 다시 뽑는 데 시간을 쓰는 것도 문제지만,
// 재생성하면 「이 표의 출력이 그때 그 출력인가」가 흐려진다. 출력은 그대로 두고 채점만
// 다시 한다.
//
// ## `deps` 는 채점 전에 **규칙이** 매단다 (10단계)
//
// `--tasks` 판에서 모델은 노드만 내고 `deps` 는 빈 배열로 낸다(규칙 14). 채점되는 것은
// 그 상태가 아니라 **`solveDeps()` 를 지난 것**이다 — 지시서 §5 가 정한 파이프라인이
// 「모델 노드 + 규칙 의존」이므로, 재는 대상도 그 파이프라인의 출력이어야 한다.
//
// 그 함수는 화면과 **같은 것**이다 (`src/generate/proposal.ts`). 두 벌이면 표의 그래프
// 숫자와 화면에 그려지는 그래프가 조용히 갈라진다. 모델의 원본은 `raw/` 가 그대로 들고
// 있고, 모델이 규칙을 어기고 적은 의존이 몇 건인지는 기록의 `model_deps` 가 센다.
//
// 결과는 `gen-lab/runs/<이름>/` 에 쌓이고 채점은 `score-generation.mjs` 가 한다 —
// **축의 정의를 두 벌로 두지 않는다.**
import { execFileSync } from 'node:child_process';
// **누출을 막는 규칙은 여기 있지 않다** — scripts/lib/fewshot.mjs 한 곳이고,
// `verify:no-leak` 이 그 파일을 직접 불러 검사한다.
import { examplesFor } from './lib/fewshot.mjs';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(vizRoot, '..');
const goldDir = join(repoRoot, 'gen-lab', 'goldset', 'missions');
const runsDir = join(repoRoot, 'gen-lab', 'runs');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const model = flag('--model');
const enforceGrammar = !args.includes('--no-grammar');
// 7단계의 두 축. **한 번에 하나만 끈다** — 둘을 같이 끄면 어느 쪽 덕인지 못 가른다.
const giveEquipment = !args.includes('--no-equipment');
const shots = args.includes('--no-examples') ? 'none' : 'leave-one-out';
// 8단계의 축. **켜는 스위치**라 기본이 꺼짐이고, 그래서 7단계까지의 판은 이름이 그대로다.
const nodeKinds = args.includes('--node-kinds');
// 10단계의 축. **켜는 스위치**라 기본이 꺼짐이고, 9단계까지의 판은 이름이 그대로다.
const withTasks = args.includes('--tasks');
// 분기와루프 3단계의 축. **켜는 스위치**이고, 예시도 함께 켠다 — 규칙만 바꾸면 예시가
// 이긴다(10단계 E 판 15건 중 10건).
const withBranch = args.includes('--branch');
const limit = Number(flag('--limit', '0')) || 0;
const rescoreOnly = args.includes('--rescore');
// 이름이 **설정을 말한다.** 6단계에 유령 llama-server 로 표가 한 번 무효가 됐고, 그때
// 배운 것이 「기록이 스스로를 설명해야 한다」였다. 끈 것이 있으면 이름에 남는다.
const suffix = `${enforceGrammar ? '' : '__nogrammar'}${giveEquipment ? '' : '__noequip'}${shots === 'none' ? '__noshot' : ''}${nodeKinds ? '__kinds' : ''}${withTasks ? '__tasks' : ''}${withBranch ? '__branch' : ''}`;
const label = flag('--label', model ? `${model}${suffix}` : null);

if (model === null && !rescoreOnly) {
  console.error('❌ --model 이 필요하다. 무엇을 쟀는지 모르는 숫자는 쓸 수 없다.');
  console.error('   쓸 수 있는 이름은 http://127.0.0.1:8802/generate/health 의 models 에 있다.');
  process.exit(1);
}

// ── 재료 ─────────────────────────────────────────────────────────────────────

const gold = readdirSync(goldDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(goldDir, name), 'utf8')))
  .sort((a, b) => a.mission_id.localeCompare(b.mission_id));

const variants = JSON.parse(readFileSync(join(repoRoot, 'gen-lab', 'goldset', 'utterances.json'), 'utf8'));

/**
 * 장소 위상. **기하 파일을 읽지 않는다** — 좌표를 보면 모델이 503호 전용이 된다
 * (지시서 §1 · `verify:places` 4번 검사가 이 경로를 훑는다).
 */
const places = JSON.parse(readFileSync(join(repoRoot, 'places', 'places.json'), 'utf8'));

/**
 * 장비 어휘. **장소와 같은 자리의 재료**다 — 260906 에 목록을 준 축은 위반 0건이고
 * 안 준 축은 22~48% 였다(6단계 §4 축 3).
 *
 * `--no-equipment` 로 끄면 프롬프트에 규칙도 목록도 안 붙어 6단계와 같은 프롬프트가 된다.
 * 그 판이 있어야 차이를 장비 목록에 돌릴 수 있다.
 */
const equipment = giveEquipment
  ? JSON.parse(readFileSync(join(repoRoot, 'equipment', 'equipment.json'), 'utf8'))
  : null;

/** 원본 발화 + 손으로 적은 변형. 마일스톤 정답은 전부 원본과 같다. */
function utterancesFor(missionId, mission) {
  const entry = (variants.missions ?? []).find((item) => item.mission_id === missionId);
  return [mission.utterance.text, ...(entry?.variants ?? [])];
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

/**
 * 채점 — **축의 정의는 `score-generation.mjs` 하나다.** 여기서 다시 계산하지 않는다.
 * 축을 두 곳에 적으면 표와 채점기가 조용히 갈라진다.
 */
function writeSummary(root, { model: modelName, label: runLabel, grammar_enforced, equipment_given, shots: runShots, node_kinds, tasks, branch, records: rows }) {
  const scored = [];
  for (const dir of readdirSync(root).filter((name) => /^v\d+$/.test(name)).sort()) {
    const out = execFileSync(process.execPath, [join(vizRoot, 'scripts', 'score-generation.mjs'), '--candidate', join(root, dir), '--json'], {
      encoding: 'utf8', cwd: vizRoot, maxBuffer: 64 * 1024 * 1024,
    });
    scored.push({ variant: dir, results: JSON.parse(out).results });
  }
  const previous = (() => {
    try { return JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8')); } catch { return null; }
  })();
  writeFileSync(join(root, 'summary.json'), JSON.stringify({
    model: modelName,
    label: runLabel,
    grammar_enforced,
    // **판을 파일이 스스로 말한다.** 이름만으로 설명하면 이름을 바꾼 순간 설명이 사라진다.
    equipment_given,
    shots: runShots,
    node_kinds,
    tasks,
    branch,
    // **생성한 시각은 그대로 두고 채점한 시각만 갱신한다** — 다시 채점했다고 해서
    // 출력이 새로 난 것이 아니다. 그 둘을 한 칸에 적으면 기록이 거짓말한다.
    ran_at: previous?.ran_at ?? new Date().toISOString(),
    scored_at: new Date().toISOString(),
    calls: rows.length,
    records: rows,
    scored,
  }, null, 2), 'utf8');
}

if (rescoreOnly) {
  // 출력은 손대지 않는다. 채점만 다시 한다.
  //
  // **정답셋이 바뀐 실행은 건너뛴다.** 다시 채점하면 그 실행이 그때 예시로 받았던 장비가
  // 갑자기 위반이 되고(어휘가 정답셋에서 온다), 모델이 나빠진 것처럼 보이는 표가 나온다.
  // 눈금이 바뀐 자로 옛 길이를 다시 재는 것이다 — **다시 채점이 아니라 다시 돌려야 한다.**
  const goldIds = new Set(gold.map((m) => m.mission_id));
  let skipped = 0;
  for (const name of readdirSync(runsDir)) {
    const root = join(runsDir, name);
    let previous;
    try { previous = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8')); } catch { continue; }
    const runIds = new Set((previous.records ?? []).map((r) => r.mission_id).filter(Boolean));
    const same = runIds.size === goldIds.size && [...runIds].every((id) => goldIds.has(id));
    if (!same) {
      console.log(`  건너뜀 — ${name}: ${runIds.size}편으로 돌았는데 지금 정답셋은 ${goldIds.size}편이다. 다시 채점하지 않는다 (다시 돌려라)`);
      skipped += 1;
      continue;
    }
    writeSummary(root, {
      model: previous.model, label: previous.label,
      grammar_enforced: previous.grammar_enforced,
      // 다시 채점하는 것이지 다시 도는 것이 아니다 — 그때의 판을 그대로 옮긴다.
      equipment_given: previous.equipment_given ?? false,
      shots: previous.shots ?? 'leave-one-out',
      // 옛 실행에는 이 칸들이 없다 — 8·10단계 전에는 그 규칙 자체가 없었다.
      node_kinds: previous.node_kinds ?? false,
      tasks: previous.tasks ?? false,
      branch: previous.branch ?? false,
      records: previous.records,
    });
    console.log(`  다시 채점 — ${name} (${previous.records.length}건, 출력은 그대로)`);
  }
  if (skipped > 0) console.log(`  ${skipped}개 실행을 건너뛰었다 — 정답셋이 그때와 다르다.`);
  process.exit(0);
}

const { generateMission } = await import('../src/generate/LlmClient.ts');
// **`deps` 를 매다는 규칙은 화면과 같은 파일이다.** 여기서 다시 쓰면 두 벌이 갈라진다.
const { withSolvedDeps } = await import('../src/generate/proposal.ts');

const outRoot = join(runsDir, label);

/**
 * **설정이 다른 실행을 조용히 덮어쓰지 않는다.**
 *
 * 이 자리는 `rmSync` 다 — 같은 이름이면 지우고 다시 쓴다. 그래서 `--label` 을 빼먹은
 * 한 줄이 6단계의 8B 기록을 통째로 지울 수 있고, 지워진 뒤에는 표가 무엇과 무엇을
 * 비교했는지 아무도 모른다. 유령 `llama-server` 가 표를 한 번 무효로 만든 것과 같은
 * 종류의 사고이고, 그때 배운 것은 「기록을 못 믿게 되면 그 뒤가 전부 무의미하다」였다.
 *
 * 그래서 **덮어쓰기 자체를 막지는 않되**(같은 설정을 다시 돌리는 것은 정상이다)
 * 설정이 다르면 멈춘다. 다시 돌릴 사람은 이름을 주면 된다.
 */
const config = { model, grammar_enforced: enforceGrammar, equipment_given: giveEquipment, shots, node_kinds: nodeKinds, tasks: withTasks, branch: withBranch };
try {
  const previous = JSON.parse(readFileSync(join(outRoot, 'summary.json'), 'utf8'));
  const before = {
    model: previous.model,
    grammar_enforced: previous.grammar_enforced,
    // 옛 실행에는 이 칸들이 없다 — 그때는 장비 목록도 예시 0편도(6단계),
    // 노드 문법 규칙도(7단계까지) 없었다.
    equipment_given: previous.equipment_given ?? false,
    shots: previous.shots ?? 'leave-one-out',
    node_kinds: previous.node_kinds ?? false,
    tasks: previous.tasks ?? false,
    branch: previous.branch ?? false,
  };
  const differs = Object.keys(config).filter((key) => config[key] !== before[key]);
  if (differs.length) {
    console.error(`❌ ${label} 에 설정이 다른 실행이 이미 있다 — 지우고 덮어쓰지 않는다.`);
    for (const key of differs) console.error(`   ${key}: 기존 ${JSON.stringify(before[key])} → 지금 ${JSON.stringify(config[key])}`);
    console.error('   --label 로 다른 이름을 주거나, 그 기록이 정말 필요 없으면 폴더를 손으로 지워라.');
    process.exit(1);
  }
} catch { /* 없으면 새 실행이다 */ }

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(join(outRoot, 'raw'), { recursive: true });

const records = [];
const targets = limit > 0 ? gold.slice(0, limit) : gold;

console.log(`베이스라인 — model=${model} · 문법=${enforceGrammar ? '강제' : '없음(대조군)'} · 임무 ${targets.length}편`);
console.log(`             장비 목록=${equipment ? `${equipment.equipment.length}건` : '없음'} · 예시=${shots === 'none' ? '0편' : `${targets.length - 1}편(leave-one-out)`} · 노드 문법 규칙=${nodeKinds ? '붙임' : '없음'} · 태스크=${withTasks ? '낸다(deps 는 규칙)' : '안 낸다'} · 분기·되풀이=${withBranch ? '적게 한다' : '안 적는다'} · 이름=${label}`);
console.log('');

for (const mission of targets) {
  // **규칙과 예시를 함께 켠다.** 규칙만 바꾸고 예시를 그대로 두면 프롬프트가 서로
  // 반대되는 지시 둘을 들고, 실측에서 예시가 이겼다 (10단계 E 판 15건 중 10건).
  const examples = examplesFor(mission.mission_id, gold, shots, { tasks: withTasks, branch: withBranch });
  const texts = utterancesFor(mission.mission_id, mission);
  for (const [index, text] of texts.entries()) {
    const started = Date.now();
    let result = null;
    let failure = null;
    try {
      result = await generateMission(text, {
        places,
        equipment,
        examples,
        nodeKinds,
        tasks: withTasks,
        branch: withBranch,
        model,
        missionId: mission.mission_id,
        // 대본 유래라 인식 수치가 없다 — `confidence_signals` 없이 간다 (§7.8 규칙 2).
        utteranceMeta: mission.utterance,
        enforceGrammar,
        maxTokens: 2048,
        temperature: 0,
        seed: 0,
      });
    } catch (error) {
      // **삼키지 않는다.** 서비스가 죽은 것과 모델이 못 낸 것은 다른 일이고,
      // 둘을 같은 빈칸으로 적으면 표가 거짓말을 한다.
      failure = String(error?.message ?? error);
    }
    const wall = (Date.now() - started) / 1000;
    const variantDir = join(outRoot, `v${index}`);
    mkdirSync(variantDir, { recursive: true });

    const record = {
      mission_id: mission.mission_id,
      variant: index,
      utterance: text,
      ok: failure === null,
      failure,
      wall_sec: Number(wall.toFixed(3)),
      // **서비스가 말한 모델과 실제로 답한 파일을 둘 다 적는다.** 260906 에 이 둘이
      // 어긋난 채로 표가 나온 적이 있다 (유령 llama-server). 기록이 거짓말하면
      // 그 뒤의 모든 판단이 무의미하다.
      model_requested: model,
      model_reported: result?.model ?? null,
      served_model_file: result?.extra?.served_model_file ?? null,
      elapsed_sec: result?.elapsed_sec ?? null,
      schema_errors: result?.schema_errors ?? null,
      schema_pass: result === null ? null : (result.schema_errors ?? []).length === 0,
      grammar: result?.grammar ?? null,
      grammar_enforced: result?.extra?.grammar_enforced ?? null,
      examples_used: examples.map((example) => example.mission_id),
      // 프롬프트에 실제로 실린 장비가 몇 건인가 (서비스가 센 값). **「줬다」만 남기면
      // 목록이 채점 어휘 크기로 좁아진 채 돈 실행을 나중에 못 가려낸다** — 그 순간
      // 이 축은 자기 자신을 채점하게 되고, `verify:no-leak` 5번이 이 숫자를 본다.
      equipment_given: result?.extra?.equipment_given ?? (giveEquipment ? null : 0),
      // 규칙이 실제로 붙었는지도 **서비스가 말한 값**을 적는다. 스위치를 켰다는 것과
      // 프롬프트에 붙었다는 것은 다른 일이고, 표는 뒤엣것을 읽어야 한다.
      node_kinds_given: result?.extra?.node_kinds_given ?? null,
      tasks_given: result?.extra?.tasks_given ?? null,
      branch_given: result?.extra?.branch_given ?? null,
      extra: result?.extra ?? null,
    };
    records.push(record);
    writeFileSync(join(outRoot, 'raw', `${mission.mission_id}__v${index}.json`), JSON.stringify({ record, mission: result?.mission ?? null }, null, 2), 'utf8');

    if (result?.mission != null) {
      // 채점기는 mission_id 로 짝을 찾는다. **식별자는 애초에 부르는 쪽이 준 값이므로**
      // 9단계부터는 서비스가 응답을 조립할 때 이미 덮어쓴다 (`_apply_caller_values`) —
      // 여기서 다시 맞출 것이 없다. 지켰는지 여부는 서비스가 남긴 `overwritten` 이
      // 답한다: 고쳐 놓고 안 고친 척하지 않는다.
      //
      // 8단계까지의 실행에는 그 자리가 없다. 그때는 화면 쪽 비교가 유일한 근거였으므로
      // 없으면 그 비교로 물러선다 — 옛 기록의 숫자가 지금 규칙 때문에 바뀌면 안 된다.
      const overwritten = result.extra?.overwritten;
      record.id_obeyed = Array.isArray(overwritten)
        ? !overwritten.some((entry) => entry.field === 'mission_id')
        : result.mission.mission_id === mission.mission_id;
      // **채점되는 것은 `deps` 를 규칙이 매단 뒤의 임무다** (위 머리말). 노드가 0개면
      // 아무것도 안 바뀐다 — 9단계까지의 판에서 이 줄은 항등이다.
      const { mission: scored, solved } = withSolvedDeps(result.mission);
      record.nodes = solved.nodeCount;
      record.edges_by_rule = solved.edgeCount;
      // 규칙 14(「deps 는 빈 배열로 둔다」)를 지켰는가. **0이 정상이다.**
      record.model_deps = solved.modelDeps;
      // 분기·되풀이 주석을 **몇 개나 적었는가.** 정답셋 발화 15개에는 표지가 하나도
      // 없으므로(3단계에서 확인) 여기서 0이 아닌 것은 전부 **지어낸 것**이다.
      record.branches = (result.mission.milestones ?? []).filter((m) => m.branch !== undefined).length;
      record.repeats = (result.mission.milestones ?? []).filter((m) => m.repeat_of !== undefined).length;
      record.ignored_plan = solved.ignoredPlan;
      writeFileSync(
        join(variantDir, `${mission.mission_id}.json`),
        JSON.stringify({ ...scored, mission_id: mission.mission_id }, null, 2),
        'utf8',
      );
    }
    const status = failure !== null ? `실패 — ${failure.slice(0, 60)}`
      : `${record.schema_pass ? '스키마통과' : `스키마실패 ${record.schema_errors.length}`} · ${wall.toFixed(1)}초 · 마일스톤 ${result.mission?.milestones?.length ?? '?'}`
        + (withTasks ? ` · 노드 ${record.nodes ?? 0} · 의존 ${record.edges_by_rule ?? 0}(규칙)` : '')
        + (withBranch ? ` · 분기 ${record.branches ?? 0} · 되풀이 ${record.repeats ?? 0}` : '')
        // **잘린 것과 모델이 못 한 것은 다른 실패다.** 안 적으면 둘 다 「스키마 실패」로만
        // 보이고, 진단이 매번 처음부터 시작된다 (10단계 E2 가 15건 전부 그것이었다).
        + (record.extra?.stop_reason === 'limit'
          ? ` ⚠ 출력이 잘렸다 (프롬프트 ${record.extra?.prompt_tokens} + 출력 ${record.extra?.completion_tokens} = ctx ${record.extra?.applied_options?.ctx_size})`
          : '');
    console.log(`  ${mission.mission_id} v${index}  ${status}`);
  }
}

writeSummary(outRoot, { model, label, grammar_enforced: enforceGrammar, equipment_given: giveEquipment, shots, node_kinds: nodeKinds, tasks: withTasks, branch: withBranch, records });
console.log('');
console.log(`기록 ${records.length}건 → ${join(outRoot, 'summary.json')}`);
console.log('표는 `node scripts/report-baseline.mjs` 가 만든다 — 여러 모델을 한 표에 놓아야 낙폭이 보인다.');
