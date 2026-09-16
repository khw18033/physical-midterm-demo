// verify:plan-shape (260908 신설 — 11단계)
//
// **발화가 요구한 모양과 계획의 모양이 어긋나면 그것이 화면과 기록에 남는가.**
//
// 10단계 §7 이 찾은 구멍이다. 「사람을 찾을 때까지 계속 이동해」에 모델은 분기를 알아봤는데
// (「탐지 시 멈춤」/「탐지 없음」) 그 둘이 **순차로 꿰였고**, 되돌아가는 길이 없었다.
// 그런데 그 계획은 스키마를 통과하고 순환도 없어서 `verify:*` 27개가 전부 초록이었다 —
// **틀렸다는 것을 기계가 아는 자리가 없었다.**
//
// 이 검사는 그 자리를 지킨다. 고치는 검사가 아니라 **말하는 검사**다.
//
// ## 무엇을 보는가
//
//  1. 못 만드는 모양을 요구한 발화에서 경고가 **난다** (루프 · 배타 분기)
//  2. 평범한 발화에서 경고가 **안 난다** — 거짓 경보가 잦으면 사람이 경고를 안 읽는다
//  3. 경고가 **근거에 실려 기록까지 간다** (`provenancePayload` → 기록 열)
//  4. 화면이 그것을 그린다 — 기록에만 있고 화면에 없으면 「기록이라고 부를 수 없다」
//     (`verify:human-trace` 4번과 같은 논리)
//
// 대조군 포함 — 판별을 무력화한 사본이 반드시 실패로 잡히는지까지 본다.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(vizRoot, 'src');
const failures = [];
const controls = [];

const { planShapeWarnings, isPureChain } = await import(pathToFileURL(join(srcDir, 'generate', 'planShape.ts')).href);
const { provenanceOf } = await import(pathToFileURL(join(srcDir, 'generate', 'proposal.ts')).href);
const { provenancePayload } = await import(pathToFileURL(join(srcDir, 'shared', 'provenance.ts')).href);

/** 10단계 §7 에서 실제로 나온 모양 — 한 줄로 꿰인 사슬. */
const CHAIN = { 'T-1': [], 'T-2': ['T-1'], 'T-3': ['T-2'], 'T-4': ['T-3'] };
/** 갈라지는 계획 — `T-1` 이 후속을 둘 갖는다. */
const FORKED = { 'T-1': [], 'T-2': ['T-1'], 'T-3': ['T-1'], 'T-4': ['T-2', 'T-3'] };

// ── 1. 못 만드는 모양은 잡힌다 ────────────────────────────────────────────────
{
  const cases = [
    ['loop', '사람을 찾을 때까지 5층 복도를 계속 이동해'],
    ['loop', '사각지대를 다 채울 때까지 반복해'],
    ['branch', '엘리베이터 앞에 상자가 있는지 확인하고, 있으면 보고하고 없으면 503호로 돌아와'],
  ];
  for (const [kind, text] of cases) {
    const got = planShapeWarnings(text, CHAIN).map((w) => w.kind);
    if (!got.includes(kind)) failures.push(`「${text}」 에서 ${kind} 경고가 안 났다 — 이 모양은 지금 생성 경로가 못 만든다`);
  }
  // 표지가 무엇이었는지 사람이 볼 수 있어야 한다. 「경고가 났다」만으로는 무시하게 된다.
  const [first] = planShapeWarnings(cases[0][1], CHAIN);
  if (!first?.markers?.length) failures.push('경고에 발화의 표지가 안 실렸다 — 무엇 때문에 경고했는지 사람이 볼 수 없다');
  if (!first?.message) failures.push('경고에 사람이 읽는 문장이 없다');
}

// ── 2. 평범한 발화에서는 안 난다 ──────────────────────────────────────────────
//
// **거짓 경보가 잦으면 사람이 경고를 안 읽는다.** 그러면 이 파일은 소음이 된다.
// 특히 「엘리베이터**까지**」가 「찾을 **때까지**」로 오인되면 정답셋 3편이 전부 경고에 걸린다.
{
  const quiet = [
    '503호에서 복도에 있는 엘리베이터 앞까지 이동해줘.',
    '503호 내에서 고정 카메라의 사각지대를 탐지해줘.',
    '월류방어벽 자동 개폐 시스템을 가동해.',
    '503호에서 제자리에서 주변에 소화기가 있는지 찾아봐',
  ];
  for (const text of quiet) {
    const got = planShapeWarnings(text, CHAIN);
    if (got.length) failures.push(`「${text}」 에서 거짓 경보가 났다 (${got.map((w) => `${w.kind}:${w.markers.join(',')}`).join(' · ')}) — 잦으면 사람이 경고를 안 읽는다`);
  }
}

// ── 3. 계획이 실제로 갈라져 있으면 분기 경고는 안 난다 ────────────────────────
//
// 경고의 뜻은 「못 만들었다」이지 「이런 발화는 위험하다」가 아니다. 만들었으면 조용해야 한다.
{
  if (!isPureChain(CHAIN)) failures.push('사슬을 사슬로 못 알아본다');
  if (isPureChain(FORKED)) failures.push('갈라진 계획을 사슬로 봤다 — 만들었는데도 경고가 난다');
  const branchText = '있는지 확인하고, 있으면 보고하고 없으면 503호로 돌아와';
  if (planShapeWarnings(branchText, FORKED).some((w) => w.kind === 'branch')) {
    failures.push('계획이 갈라져 있는데도 분기 경고가 났다 — 만들었으면 조용해야 한다');
  }
  // 루프는 되돌아가는 엣지가 생기면 조용해진다. 지금은 언제나 0건이라 늘 경고가 난다.
  if (planShapeWarnings('찾을 때까지 이동해', CHAIN, 1).some((w) => w.kind === 'loop')) {
    failures.push('되돌아가는 엣지가 있는데도 루프 경고가 났다 — 만들게 되는 날 이 함수는 저절로 조용해져야 한다');
  }
}

// ── 4. 노드가 없으면 대조할 계획이 없다 ───────────────────────────────────────
{
  if (planShapeWarnings('사람을 찾을 때까지 이동해', {}).length) {
    failures.push('노드가 하나도 없는데 모양 경고가 났다 — 「모양이 틀렸다」가 아니라 「아직 계획이 없다」다');
  }
}

// ── 5. 근거에 실리고 기록까지 간다 ────────────────────────────────────────────
//
// 함수가 옳은 것과 그 결과가 남는 것은 다른 일이다 (`verify:no-leak` 2번과 같은 논리).
{
  const result = {
    mission: {
      mission_id: 'MSN-GEN-SHAPE',
      utterance: { audio_ref: null, text: '사람을 찾을 때까지 5층 복도를 계속 이동해', engine: 'manual_text', confidence: 1 },
      milestones: [{
        milestone_id: 'MS-A', title: '이동', order: 0, status: 'pending', assigned_targets: ['robot-01'],
        tasks: [
          { task_id: 'T-1', title: '이동', deps: [], status: 'pending', attempt: 1, derived_from: null, action_items: [], evaluation: null, node_kind: 'act', target: 'robot-01' },
          { task_id: 'T-2', title: '확인', deps: [], status: 'pending', attempt: 1, derived_from: null, action_items: [], evaluation: null, node_kind: 'verify', target: 'robot-01' },
        ],
      }],
    },
    engine: 'llama.cpp', model: 'test', grammar: null, schema_checked: true, schema_errors: [], elapsed_sec: 1,
    extra: { stub: false, rules_applied: ['x'], overwritten: [], examples_given: 2, places_given: true, equipment_given: 10 },
  };
  const provenance = provenanceOf(result);
  if (!provenance.shapeWarnings.some((w) => w.kind === 'loop')) {
    failures.push('생성 근거에 모양 경고가 안 실렸다 — 화면과 기록이 볼 자리가 없다');
  }
  const payload = provenancePayload(provenance);
  if (!Array.isArray(payload.shape_warnings) || payload.shape_warnings.length === 0) {
    failures.push('기록 payload 에 shape_warnings 가 없다 — 승인된 뒤 「그때 어긋난다고 적혀 있었나」에 답할 수 없다');
  }
}

// ── 6. 화면이 그린다 ──────────────────────────────────────────────────────────
//
// 기록에만 있고 화면에 없으면 「기록이라고 부를 수 없다」 (`verify:human-trace` 4번).
{
  const raw = readFileSync(join(srcDir, 'views', 'UtterancePanel.tsx'), 'utf8');
  const panel = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  if (!/shapeWarnings/.test(panel)) {
    failures.push('발화 패널이 모양 경고를 안 그린다 — 기록에만 있고 화면에 없으면 사람이 못 본다');
  }
  if (checkPanel(panel.replaceAll('shapeWarnings', 'xxx'))) controls.push('화면에서 모양 경고를 지운 사본');
  else failures.push('화면 대조군을 검출하지 못했다 — 이 검사는 무의미하다');
}
function checkPanel(source) {
  return !/shapeWarnings/.test(source);
}

// ── 대조군 — 판별을 무력화한 사본 ─────────────────────────────────────────────
{
  const source = readFileSync(join(srcDir, 'generate', 'planShape.ts'), 'utf8').replaceAll('\r\n', '\n');
  /**
   * 사본마다 **무엇이 조용해져야 하는지**를 함께 적는다.
   *
   * 「경고가 하나라도 줄었나」로 보면 안 된다 — 표지를 절반만 지워도 다른 표지가 남아
   * 경고는 계속 나고, 그때 「대조군을 못 만들었다」와 「판별이 튼튼하다」가 구별되지 않는다.
   * 무력화한 축이 정확히 그 축에서 조용해지는지를 본다.
   */
  const mutants = [
    {
      name: '되풀이 표지 목록을 비운 사본',
      silences: 'loop',
      probe: '사람을 찾을 때까지 계속 이동해',
      from: /const LOOP_MARKERS = \[[^\]]*\];/,
      to: 'const LOOP_MARKERS: string[] = [];',
    },
    {
      name: '사슬을 늘 갈라진 것으로 보는 사본',
      silences: 'branch',
      probe: '있으면 보고하고 없으면 돌아와',
      from: 'export function isPureChain(',
      to: 'export function isPureChain(): boolean { return false; }\nfunction unusedIsPureChain(',
    },
  ];
  for (const [index, mutant] of mutants.entries()) {
    const hit = typeof mutant.from === 'string' ? source.includes(mutant.from) : mutant.from.test(source);
    if (!hit) { failures.push(`대조군을 만들지 못했다 — 자리(${mutant.name})가 원본에서 사라졌다`); continue; }
    // **사본마다 다른 파일 이름을 쓴다.** Node 는 모듈을 URL 로 캐시하므로 이름이 같으면
    // 두 번째 사본이 첫 번째의 결과를 그대로 돌려주고, 그때 검사는 자기 자신에 대해
    // 거짓말을 한다 (실제로 한 번 그렇게 됐다).
    const path = join(srcDir, 'generate', `.verify-shape-${index}.ts`);
    try {
      writeFileSync(path, source.replace(mutant.from, mutant.to), 'utf8');
      const copy = await import(pathToFileURL(path).href);
      const before = planShapeWarnings(mutant.probe, CHAIN).some((w) => w.kind === mutant.silences);
      const after = copy.planShapeWarnings(mutant.probe, CHAIN).some((w) => w.kind === mutant.silences);
      if (!before) failures.push(`대조군의 전제가 깨졌다 — 원본이 「${mutant.probe}」 에서 ${mutant.silences} 경고를 안 낸다`);
      else if (after) failures.push(`대조군을 검출하지 못했다: ${mutant.name} — 이 검사는 무의미하다`);
      else controls.push(mutant.name);
    } finally {
      try { rmSync(path, { force: true }); } catch { console.warn('임시 파일 정리 실패 — ' + path); }
    }
  }
}

if (failures.length) {
  console.error(`❌ verify:plan-shape\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 못 만드는 모양(되풀이·배타 분기)을 요구한 발화에서 경고가 난다 — 표지와 사유가 함께 실린다');
console.log('✅ 평범한 발화에서는 조용하다 — 「엘리베이터까지」를 「찾을 때까지」로 오인하지 않는다');
console.log('✅ 계획이 실제로 갈라져 있으면 조용하다 — 경고의 뜻은 「못 만들었다」이지 「위험한 발화다」가 아니다');
console.log('✅ 경고가 생성 근거에 실려 기록까지 간다 · 화면이 그것을 그린다');
console.log(`✅ 대조군 ${controls.length}건 검출 — ${controls.join(' · ')}`);
