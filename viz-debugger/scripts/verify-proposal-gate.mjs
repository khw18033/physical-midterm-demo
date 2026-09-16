// verify:proposal-gate (260907 신설 — 마일스톤 분리 지시서 §6)
//
// **승인 없이 제안이 캔버스에 올라가지 않는가** (`VZ-U-07` · `REQ-1506`).
//
// 9단계에 제안이 두 종류가 됐다 — 대본이 골라진 것과 **모델이 방금 만든 것.** 승인 선이
// 걸린 자리가 하나 늘었고, 늘어난 쪽이 하필 사람이 한 번도 안 본 계획이다. 그래서
// 이 검사가 생겼다.
//
// ## 화면을 눌러 보는 검사가 아니다
//
// 상태 기계를 **Node 에서 그대로 돌린다.** `src/data/scenario.ts` 가 승인의 유일한 문
// (`acceptProposal`)을 들고 있고, 여기서는 그 문 앞뒤의 상태를 직접 본다 —
// 「제안했는데 current 가 안 바뀌었나 · 기록 열이 비어 있나 · 승인하니 바뀌었나 ·
// 근거가 기록에 남았나」.
//
// (이 파일이 가능해진 것은 9단계에 `scenario.ts` 의 JSON import 에 `with { type: 'json' }`
// 를 붙였기 때문이다. 그전에는 Node 가 이 모듈을 못 열어 소스 문자열 검사로 내려앉았고,
// 문자열 검사는 「그 함수가 실제로 무엇을 하는가」를 못 본다.)
//
// ## 대조군이 없으면 이 검사는 무의미하다
//
// 승인을 건너뛴 사본을 실제로 만들어 **반드시 실패로 잡히는지**까지 본다. 잡히지 않으면
// 이 파일은 통과 도장만 찍는 종이가 된다.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(vizRoot, 'src');
const scenarioPath = join(srcDir, 'data', 'scenario.ts');
const failures = [];
const controls = [];

const store = await import(pathToFileURL(scenarioPath).href);
const { provenanceOf, tasksFromGenerated, viewFromGenerated } = await import(
  pathToFileURL(join(srcDir, 'generate', 'proposal.ts')).href
);

// ── 재료 — 서비스가 돌려주는 모양 그대로 ──────────────────────────────────────
//
// 모델을 부르지 않는다. **이 검사가 보는 것은 승인 선이지 모델의 품질이 아니다** —
// 모델을 부르면 검사가 GPU 와 가중치에 매달리고, 그러면 CI 에서 못 돈다.
function sampleResult() {
  return {
    mission: {
      mission_id: 'MSN-GEN-TEST-0001',
      utterance: { audio_ref: null, text: '503호에서 엘리베이터까지 가줘', engine: 'manual_text', confidence: 1 },
      milestones: [
        { milestone_id: 'MS-A', title: '503호에서 출발', order: 0, status: 'pending', assigned_targets: ['robot-01'], tasks: [] },
        { milestone_id: 'MS-B', title: '엘리베이터 위치에 도달', order: 1, status: 'pending', assigned_targets: ['robot-01'], tasks: [] },
      ],
    },
    engine: 'llama.cpp',
    model: 'Qwen3-8B-Q4_K_M',
    grammar: { source: 'contracts/mission.schema.json', digest: 'abc123', bytes: 2048 },
    schema_checked: true,
    schema_errors: [],
    elapsed_sec: 7.4,
    extra: {
      stub: false,
      prompt_digest: 'deadbeefdeadbeef',
      prompt_chars: 9000,
      rules_applied: ['출력은 JSON 객체 하나다.', '마일스톤은 여러 개다.'],
      overwritten: [],
      places_given: true,
      equipment_given: 10,
      examples_given: 2,
      node_kinds_given: false,
    },
  };
}

/** 그 임무의 기록 열. 다른 임무면 빈 열이다 — 그것이 「아직 아무 일도 없었다」다. */
function traceOf(module, view) {
  return module.traceFor(view);
}

/**
 * 승인 선을 한 판 돌린다. **원본과 대조군이 정확히 같은 절차를 지난다** —
 * 절차가 다르면 「대조군이 잡혔다」가 무엇을 뜻하는지 알 수 없다.
 *
 * @returns 규칙을 어긴 자리들. 원본은 비어 있어야 하고 대조군은 비어 있으면 안 된다.
 */
function runGate(module) {
  const broken = [];
  const result = sampleResult();
  const provenance = provenanceOf(result);
  const view = viewFromGenerated(result.mission, '검사용 생성 임무');
  const before = module.getMissionState().current.missionId;

  // 1. 제안은 실행이 아니다 ---------------------------------------------------
  if (!module.proposeGenerated(view, provenance)) broken.push('제안이 서지 않았다 — 마일스톤 2건짜리 임무를 거절했다');
  const proposed = module.getMissionState();
  if (proposed.current.missionId !== before) {
    broken.push(`제안만 했는데 현재 임무가 바뀌었다 (${before} → ${proposed.current.missionId}) — 승인 선을 건너뛰었다`);
  }
  if (proposed.activatedBy === 'approval') broken.push("제안만 했는데 activatedBy 가 'approval' 이다");
  if (proposed.playing) broken.push('제안만 했는데 재생이 돌고 있다');
  const shown = module.displayMission();
  if (shown.phase !== 'proposal') broken.push(`제안 중인데 화면 단계가 '${shown.phase}' 다`);
  if (shown.view.missionId !== view.missionId) broken.push('제안된 임무를 화면이 안 그린다 — 모델이 낸 본문은 라이브러리에 없다');
  if (shown.trace.length !== 0) broken.push(`승인 전인데 기록 열에 ${shown.trace.length}건이 있다 — 「진행 사건이 하나도 없다」가 깨졌다`);

  // 2. 거부하면 아무것도 안 올라간다 -------------------------------------------
  module.rejectProposal();
  if (module.getMissionState().proposal !== null) broken.push('거부했는데 제안이 남아 있다');
  if (module.getMissionState().current.missionId !== before) broken.push('거부했는데 현재 임무가 바뀌어 있다');

  // 3. 승인할 것이 없으면 승인도 없다 -------------------------------------------
  if (module.acceptProposal('local') !== false) broken.push('제안이 없는데 승인이 성공했다 — 이것이 승인 선을 우회하는 길이다');
  if (module.getMissionState().current.missionId !== before) broken.push('빈 승인이 현재 임무를 바꿨다');

  // 4. 승인하면 올라간다 + 근거가 기록에 남는다 ---------------------------------
  module.proposeGenerated(view, provenance);
  if (module.acceptProposal('local') !== true) broken.push('승인이 실패했다');
  const after = module.getMissionState();
  if (after.current.missionId !== view.missionId) broken.push('승인했는데 현재 임무가 안 바뀌었다');
  if (after.proposal !== null) broken.push('승인했는데 제안이 남아 있다');
  if (after.activatedBy !== 'approval') broken.push(`승인했는데 activatedBy 가 '${after.activatedBy}' 다`);

  const trace = traceOf(module, after.current);
  const ai = trace.filter((event) => event.producedBy === 'ai');
  const human = trace.filter((event) => event.producedBy === 'human');
  if (ai.length !== 1) broken.push(`생성 근거가 기록에 ${ai.length}건이다 — 1건이어야 한다 (VZ-G-01 역추적)`);
  if (human.length !== 1) broken.push(`승인 기록이 ${human.length}건이다 — 승인도 사람 조작이다 (VZ-D-08)`);
  if (ai.length && human.length && ai[0].seq >= human[0].seq) {
    broken.push('기록에서 승인이 생성보다 먼저다 — 순서가 뜻이다 (무엇이 만들었나 → 누가 받아들였나)');
  }
  const payload = ai[0]?.payload ?? {};
  if (payload.produced_by !== 'ai') broken.push('생성 기록에 produced_by=ai 가 없다');
  if (!payload.model) broken.push('생성 기록에 모델 이름이 없다');
  if (!payload.prompt_digest) broken.push('생성 기록에 프롬프트 지문이 없다');
  if (!Array.isArray(payload.rules_applied) || payload.rules_applied.length === 0) {
    broken.push('생성 기록에 적용된 규칙 목록이 없다 — 모델이 지킨 규칙과 사람이 본 규칙이 갈라진다');
  }
  return broken;
}

// ── 원본 ─────────────────────────────────────────────────────────────────────
failures.push(...runGate(store));

// 5. 대본 제안도 **같은 문**을 쓴다 ------------------------------------------
{
  const scriptId = 'MSN-260831-01';
  store.proposeMission({ origin: 'script', missionId: scriptId, title: '검사', keywords: ['503'], planId: null, world: 'registry' });
  if (store.displayMission().phase !== 'proposal') failures.push('대본 제안이 제안 상태로 서지 않는다');
  if (store.getMissionState().current.missionId === scriptId) failures.push('대본 제안만 했는데 현재 임무가 됐다');
  if (store.acceptProposal('local') !== true) failures.push('대본 제안의 승인이 실패했다 — 문이 하나가 아니다');
  if (store.getMissionState().current.missionId !== scriptId) failures.push('대본을 승인했는데 현재 임무가 안 바뀌었다');
  // 로컬 재생기가 세운 타이머를 내린다 — 안 내리면 이 프로세스가 안 끝난다.
  // (`previewMission` 이 `stopLocalTimer` 를 부르는 유일한 공개 경로다.)
  store.previewMission(scriptId);
}

// 6. 그릴 수 없는 제안은 서지 않는다 -----------------------------------------
{
  const empty = viewFromGenerated({ mission_id: 'MSN-GEN-EMPTY', utterance: { text: '' }, milestones: [] }, '빈 임무');
  if (store.proposeGenerated(empty, provenanceOf(sampleResult())) !== false) {
    failures.push('마일스톤 0건짜리 임무가 제안으로 섰다 — 사람이 승인을 판단할 재료가 없다');
    store.rejectProposal();
  }
}

// 7. `VZ-G-02` 는 규칙이다 — 노드가 있으면 규칙이 실제로 돈다 -------------------
{
  const withNodes = sampleResult();
  withNodes.mission.milestones[0].tasks = [
    { task_id: 'T-1', title: '위치 확인', deps: [], status: 'pending', attempt: 1, derived_from: null, action_items: [], evaluation: null, node_kind: 'sense' },
    { task_id: 'T-2', title: '이동', deps: [], status: 'pending', attempt: 1, derived_from: null, action_items: [], evaluation: null, node_kind: 'act' },
  ];
  const solved = tasksFromGenerated(withNodes.mission);
  if (solved.nodeCount !== 2) failures.push(`노드 ${solved.nodeCount}개를 읽었다 — 2개여야 한다`);
  // 모델이 낸 deps 는 빈 배열이었다. **규칙이 매단 것이어야 한다** — 그대로면 규칙이 안 돈 것이다.
  const act = solved.tasks.find((task) => task.id === 'T-2');
  if (!act || act.deps.length === 0) failures.push('solveDeps() 가 의존을 안 매달았다 — 태스크 칸이 모델의 빈 배열을 그대로 그린다');
  if (act && !act.deps.includes('T-1')) failures.push(`구동이 관측 뒤에 오지 않았다 (deps=${JSON.stringify(act.deps)})`);
  // 모델이 낸 것을 그대로 쓰지 않는다는 확인 — 빈 배열이 그대로 남으면 위에서 걸린다.
  const empty = tasksFromGenerated(sampleResult().mission);
  if (empty.nodeCount !== 0 || empty.tasks.length !== 0) failures.push('노드가 없는데 태스크를 지어냈다');
}

// ── 대조군 둘 — 승인을 건너뛴 사본 · 근거를 안 남기는 사본 ────────────────────
//
// 사본은 `src/data/` **안에** 둔다. 이 모듈은 형제 파일(`./trace.ts`)과 상위 폴더의
// 대본 JSON 을 실제로 읽으므로, 하위 폴더에 두면 상대 경로가 어긋나 「검사가 잡았다」가
// 아니라 「사본이 안 열렸다」가 된다.
{
  // **줄끝을 맞춰 둔다.** 이 저장소의 소스는 CRLF 라, `\n` 으로 적은 자리표가 그대로는
  // 안 맞는다. 그때 나오는 실패 문구는 「사본을 만들 자리가 사라졌다」인데 실제로는
  // 자리가 그대로 있다 — 검사가 자기 자신에 대해 거짓말을 하게 된다. 사본은 임시 파일이라
  // 줄끝이 무엇이든 상관없다.
  const source = readFileSync(scenarioPath, 'utf8').replaceAll('\r\n', '\n');
  const mutants = [
    {
      name: '제안이 곧바로 현재 임무가 되는 사본 (승인 건너뜀)',
      from: "  commitNow({\n    proposal: {\n      origin: 'ai',",
      to: "  commitNow({\n    current: view,\n    activatedBy: 'approval',\n    proposal: {\n      origin: 'ai',",
    },
    {
      name: '승인해도 생성 근거를 기록에 안 남기는 사본',
      from: "  appendGenerated(\n    proposal.view.missionId,",
      to: "  if (0 as number) appendGenerated(\n    proposal.view.missionId,",
    },
  ];
  for (const [index, mutant] of mutants.entries()) {
    if (!source.includes(mutant.from)) {
      failures.push(`대조군 ${index + 1}을 만들지 못했다 — 사본을 만들 자리(${mutant.name})가 원본에서 사라졌다. 이 검사는 무의미하다`);
      continue;
    }
    const path = join(srcDir, 'data', `.verify-gate-${index}.ts`);
    try {
      writeFileSync(path, source.replace(mutant.from, mutant.to), 'utf8');
      const module = await import(pathToFileURL(path).href);
      const broken = runGate(module);
      if (broken.length === 0) failures.push(`대조군을 검출하지 못했다: ${mutant.name} — 이 검사는 무의미하다`);
      else controls.push(`${mutant.name} → ${broken[0]}`);
    } finally {
      try { rmSync(path, { force: true }); } catch { console.warn('임시 파일 정리 실패 — ' + path); }
    }
  }
}

// ── 화면이 문을 우회하지 않는가 ───────────────────────────────────────────────
//
// 함수가 옳은 것과 화면이 그 함수를 쓰는 것은 다른 일이다 (`verify:no-leak` 2번과 같은 논리).
// 발화 패널은 **제안까지**만 한다 — 거기서 활성화를 부를 수 있으면 승인 선은 이미 없다.
{
  const raw = readFileSync(join(srcDir, 'views', 'UtterancePanel.tsx'), 'utf8');
  // **주석은 코드가 아니다.** 이 패널의 머리말이 「승인의 문은 `acceptProposal()` 하나」라고
  // 적고 있어서, 문자열 그대로 훑으면 그 설명이 위반으로 잡힌다. 규칙을 적어 둔 문장이
  // 규칙 위반이 되면 사람은 설명을 지우게 되고, 그것이 이 저장소가 가장 피하려는 일이다.
  const panel = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['activateMission', 'acceptProposal', 'previewMission']) {
    if (new RegExp(`\\b${forbidden}\\s*\\(`).test(panel)) {
      failures.push(`발화 패널이 ${forbidden}() 를 부른다 — 제안한 쪽이 승인까지 하면 승인 선이 없는 것이다`);
    }
  }
  if (!panel.includes('proposeGenerated')) failures.push('발화 패널이 제안을 올리지 않는다 — 생성 결과가 어디로도 가지 않는다');
  // 대조군 — 주석을 걷어낸 뒤에도 실제 호출은 반드시 잡혀야 한다.
  if (!/\bacceptProposal\s*\(/.test(`${panel}\nacceptProposal('local');`)) {
    failures.push('승인 호출을 주입한 대조군을 검출하지 못했다 — 이 검사는 무의미하다');
  } else {
    controls.push('발화 패널에 acceptProposal() 호출을 주입한 사본');
  }
}

if (failures.length) {
  console.error(`❌ verify:proposal-gate\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 제안은 실행이 아니다 — 모델이 낸 임무를 제안해도 현재 임무·재생·기록 열이 그대로다');
console.log('✅ 승인해야 올라간다 — 승인 뒤에만 current 가 바뀌고 activatedBy 가 approval 이 된다');
console.log('✅ 문은 하나다 — 대본 제안과 AI 제안이 같은 acceptProposal() 을 지난다 · 제안이 없으면 승인도 없다');
console.log('✅ 근거가 기록에 남는다 — produced_by=ai(모델·프롬프트 지문·규칙 목록) 다음에 produced_by=human 승인');
console.log('✅ 태스크 칸은 규칙이다 — solveDeps() 가 매단 의존이고, 노드가 없으면 0개라고 적는다');
console.log('✅ 발화 패널은 제안까지만 한다 — 활성화 경로를 부르지 않는다');
console.log(`✅ 대조군 ${controls.length}건 검출\n   - ${controls.join('\n   - ')}`);
