// scripts/report-baseline.mjs (260906 신설 — 마일스톤 분리 지시서 §4)
//
// `gen-lab/runs/` 에 쌓인 실행들을 **한 표**로 놓는다. 8B 대 4B 의 낙폭은 두 표를
// 번갈아 보면 안 보인다 — 그것이 배포 크기 결정의 근거이자 논문 5장의 숫자다.
//
// **합산 점수 하나로 뭉치지 않는다.** 축마다 열이 따로 있고, 못 잰 축은 0이 아니라
// 「해당없음」이다. 실패 유형을 못 가르면 5단계의 학습 판단이 성립하지 않는다.
//
//   node scripts/report-baseline.mjs
//   node scripts/report-baseline.mjs --json
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const runsDir = join(vizRoot, '..', 'gen-lab', 'runs');
const asJson = process.argv.includes('--json');

/**
 * **지금 정답셋이 무엇인가.** 실행마다 그때의 정답셋으로 채점돼 있는데, 정답셋이 바뀌면
 * (415 편 보류 · 260907) 옛 실행의 숫자는 지금 것과 **같은 표에 놓을 수 없다.**
 *
 * 특히 장비 위반 축이 그렇다. 어휘가 정답셋의 `assigned_targets` 합집합이라 편이 빠지면
 * 어휘가 좁아지고, 옛 실행이 **예시로 받았던 장비**(go1-02 · cam-5f)가 갑자기 위반이 된다.
 * 그것은 모델이 나빠진 것이 아니라 **자로 잰 눈금이 바뀐 것**이다.
 *
 * 그래서 조용히 섞지 않고 줄에 표시한다. 유령 `llama-server` 때와 같은 규칙이다 —
 * **못 쓰는 숫자는 못 쓴다고 적는다.**
 */
let goldIds = null;
try {
  const index = JSON.parse(readFileSync(join(vizRoot, '..', 'gen-lab', 'goldset', 'index.json'), 'utf8'));
  goldIds = new Set((index.missions ?? []).map((m) => (typeof m === 'string' ? m : m.mission_id)));
} catch { goldIds = null; }

let labels;
try {
  labels = readdirSync(runsDir).filter((name) => statSync(join(runsDir, name)).isDirectory());
} catch {
  console.error('❌ gen-lab/runs/ 가 없다 — 먼저 `node scripts/run-baseline.mjs --model <이름>` 을 돌려라');
  process.exit(1);
}

const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const round = (value, digits = 2) => (value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits);

const rows = [];
for (const label of labels.sort()) {
  let summary;
  try {
    summary = JSON.parse(readFileSync(join(runsDir, label, 'summary.json'), 'utf8'));
  } catch {
    continue; // 아직 안 끝난 실행. 반쪽 숫자를 표에 올리지 않는다.
  }
  const records = summary.records;
  const runIds = new Set(records.map((r) => r.mission_id).filter(Boolean));
  const stale = goldIds !== null
    && (runIds.size !== goldIds.size || [...runIds].some((id) => !goldIds.has(id)));
  const flat = summary.scored.flatMap((entry) => entry.results.filter((result) => !result.missing));

  // **실제로 답한 가중치가 요청한 것과 같은가.** 260906 에 이 둘이 어긋난 표가 한 번
  // 나왔다(유령 llama-server). 어긋나면 그 줄의 숫자는 전부 못 쓴다.
  const served = new Set(records.map((record) => record.served_model_file).filter(Boolean));
  const requested = new Set(records.map((record) => record.model_requested));

  rows.push({
    label,
    stale,
    runMissions: [...runIds].sort(),
    model: summary.model,
    grammar: summary.grammar_enforced,
    // **판을 표가 말한다.** 이름에만 적으면 이름을 바꾼 순간 열이 거짓말한다 —
    // 옛 실행에는 이 두 칸이 없고, 그때는 장비 목록도 예시 0편도 없었다(6단계).
    equipmentGiven: Math.max(0, ...records.map((r) => r.equipment_given ?? 0)),
    shots: summary.shots ?? 'leave-one-out',
    // **스위치를 켠 것이 아니라 규칙이 붙은 것을 읽는다** — 기록에 서비스가 적은 값이 있고,
    // 없으면(8단계 전 실행) summary 의 스위치로 물러선다.
    nodeKinds: records.some((record) => record.node_kinds_given === true) || (summary.node_kinds ?? false),
    withTasks: records.some((record) => record.tasks_given === true) || (summary.tasks ?? false),
    // 축 6·7 — 태스크 판에서만 잰다. **안 낸 판은 0이 아니라 「해당없음」이다.**
    nodes: records.reduce((sum, record) => sum + (record.nodes ?? 0), 0),
    // 모델이 규칙 14 를 어기고 적은 의존. **0이 정상이다** — 의존은 규칙이 만든다.
    model_deps: records.reduce((sum, record) => sum + (record.model_deps ?? 0), 0),
    node_grammar: flat.some((result) => result.node_grammar?.accuracy == null)
      ? null : round(mean(flat.map((result) => result.node_grammar.accuracy))),
    graph_f1: flat.some((result) => result.graph?.f1 == null)
      ? null : round(mean(flat.map((result) => result.graph.f1))),
    cycles: flat.filter((result) => result.graph?.has_cycle).length,
    // **출력이 잘린 건.** 모델이 못 한 것과 자리가 없던 것은 다른 실패다 (10단계 E2).
    truncated: records.filter((record) => record.extra?.stop_reason === 'limit').length,
    ctx_size: Math.max(0, ...records.map((record) => record.extra?.applied_options?.ctx_size ?? 0)) || null,
    calls: records.length,
    served: [...served],
    weights_ok: served.size <= 1 && [...served].every((file) => file.startsWith([...requested][0] ?? '')),
    // 축 1 — 스키마 통과율. 강제 디코딩이 실제로 듣는가.
    schema_pass: round(records.filter((record) => record.schema_pass === true).length / Math.max(1, records.length)),
    // 서비스에 닿지도 못한 건. 모델의 실패와 섞지 않는다.
    call_failed: records.filter((record) => !record.ok).length,
    // 축 2 — 마일스톤 개수 일치 / 순서 재현율 / 제목 유사도.
    count_match: round(flat.filter((result) => result.milestone.count.match).length / Math.max(1, flat.length)),
    count_delta: round(mean(flat.map((result) => result.milestone.count.got - result.milestone.count.gold))),
    order_recall: round(mean(flat.map((result) => result.milestone.order_recall ?? 0))),
    title_similarity: round(mean(flat.map((result) => result.milestone.title_similarity ?? 0))),
    // 축 3 — 장소 어휘 위반 (건수 합).
    place_violations: flat.some((result) => result.place_violation.count === null)
      ? null : flat.reduce((sum, result) => sum + result.place_violation.count, 0),
    // 축 3b — 장비 어휘 위반. **장소 축의 대조군이다** — 장소는 목록을 주고 장비는 안 준다.
    target_violations: flat.reduce((sum, result) => sum + result.target_violation.count, 0),
    target_total: flat.reduce((sum, result) => sum + result.target_violation.total, 0),
    // **지어냄과 오선택을 가른다.** 뭉치면 그라운딩이 들었는지를 못 읽는다 — 260907 에
    // 목록을 주자 지어냄이 20건에서 0건이 됐는데 총합은 거의 그대로였다(오선택으로 옮겼다).
    target_invented: flat.some((result) => result.target_violation.invented == null)
      ? null : flat.reduce((sum, result) => sum + result.target_violation.invented, 0),
    target_mischosen: flat.some((result) => result.target_violation.mischosen == null)
      ? null : flat.reduce((sum, result) => sum + result.target_violation.mischosen, 0),
    // 축 4 — 추상 위반 (건수 합).
    abstraction_violations: flat.reduce((sum, result) => sum + result.abstraction.count, 0),
    // 축 5 — 응답 시간. **적재 시간은 뺀다** — 합치면 첫 요청만 크게 나와 비교가 안 된다.
    sec_median: round(median(records.map((record) => record.elapsed_sec).filter((value) => typeof value === 'number'))),
    sec_max: round(Math.max(...records.map((record) => record.elapsed_sec ?? 0))),
    load_sec: round(Math.max(...records.map((record) => record.extra?.load_sec ?? 0))),
    vram_model_mib: Math.max(...records.map((record) => record.extra?.vram_model_mib ?? 0)) || null,
    prompt_tokens: round(mean(records.map((record) => record.extra?.prompt_tokens ?? 0)), 0),
    // 부산물이지만 남긴다 — 「식별자를 옮겨 적으라」는 지시를 지켰는가.
    id_obeyed: round(records.filter((record) => record.id_obeyed === true).length / Math.max(1, records.length)),
    json_recovered: records.filter((record) => record.extra?.json_recovered === true).length,
  });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const pad = (text, width) => String(text).padStart(width);
  /**
   * 못 잰 축은 **0이 아니라 「해당없음」이다.**
   *
   * 10단계 E2 가 이 자리를 찾았다 — 15건이 전부 잘려 채점할 것이 하나도 남지 않자
   * 축의 평균이 전부 `null` 이 됐고, 표가 그 줄에서 죽었다. 실행이 통째로 실패하는 것은
   * 정상적인 결과 중 하나이므로(그것도 재야 하는 숫자다) 표가 그것을 그릴 수 있어야 한다.
   */
  const cell = (value, width, digits = null) => pad(
    value === null || value === undefined ? '해당없음' : (digits === null ? value : value.toFixed(digits)),
    width,
  );
  console.log('');
  console.log('모델별 네 축 — 합산하지 않는다.');
  console.log('');
  console.log('  ' + '실행'.padEnd(34) + pad('문법', 6) + pad('장비', 8) + pad('예시', 6) + pad('종류', 6) + pad('태스크', 8) + pad('스키마', 8) + pad('개수일치', 9) + pad('개수차', 8) + pad('순서', 7) + pad('제목', 7) + pad('장소위반', 9) + pad('장비지어냄', 11) + pad('장비오선택', 12) + pad('추상위반', 9) + pad('중앙초', 8) + pad('최대초', 8));
  for (const row of rows) {
    console.log('  ' + row.label.padEnd(34) +
      pad(row.grammar ? '강제' : '없음', 6) +
      pad(row.equipmentGiven ? `${row.equipmentGiven}건` : '없음', 8) +
      pad(row.shots === 'none' ? '0편' : `${row.runMissions.length - 1}편`, 6) +
      pad(row.nodeKinds ? '5종' : '없음', 6) +
      pad(row.withTasks ? `${row.nodes}개` : '안냄', 8) +
      pad(`${(row.schema_pass * 100).toFixed(0)}%`, 8) +
      cell(row.count_match === null ? null : `${(row.count_match * 100).toFixed(0)}%`, 9) +
      cell(row.count_delta === null ? null : (row.count_delta > 0 ? `+${row.count_delta}` : row.count_delta), 8) +
      cell(row.order_recall, 7, 2) +
      cell(row.title_similarity, 7, 2) +
      pad(row.place_violations === null ? '해당없음' : row.place_violations, 9) +
      pad(row.target_invented === null ? '해당없음' : row.target_invented, 11) +
      pad(row.target_mischosen === null ? '해당없음' : `${row.target_mischosen}/${row.target_total}`, 12) +
      cell(row.abstraction_violations, 9) +
      cell(row.sec_median, 8) +
      cell(row.sec_max, 8));
  }
  console.log('');
  for (const row of rows) {
    const flags = [];
    if (!row.weights_ok) flags.push('⚠ 요청한 가중치와 실제로 답한 파일이 다르다 — 이 줄의 숫자는 못 쓴다');
    if (row.call_failed) flags.push(`호출 실패 ${row.call_failed}건 (모델의 실패가 아니다)`);
    if (row.json_recovered) flags.push(`JSON 을 잘라 낸 건 ${row.json_recovered}건 (문법 없는 대조군의 관대함)`);
    // **잘린 것과 모델이 못 한 것은 다른 실패다.** 안 적으면 둘 다 스키마 실패로만 보인다.
    if (row.truncated) flags.push(`⚠ 출력이 잘린 건 ${row.truncated}건 (ctx ${row.ctx_size}) — 모델이 못 한 것이 아니라 자리가 없었다`);
    console.log(`  ${row.label}`);
    console.log(`    가중치=${row.served.join(', ') || '?'} · 적재 ${row.load_sec}초 · VRAM ${row.vram_model_mib ?? '해당없음'} MiB · 프롬프트 ${row.prompt_tokens} 토큰 · 식별자 준수 ${(row.id_obeyed * 100).toFixed(0)}%`);
    for (const flag of flags) console.log(`    ${flag}`);
  }
  console.log('');
  const staleRows = rows.filter((r) => r.stale);
  if (staleRows.length) {
    console.log('');
    console.log('  ⚠ 지금 정답셋과 다른 편으로 돌린 실행 — **같은 표에서 비교하지 마라.**');
    for (const r of staleRows) {
      console.log(`     ${r.label}: ${r.runMissions.length}편 (${r.runMissions.join(' · ')})`);
    }
    console.log(`     지금 정답셋: ${[...(goldIds ?? [])].sort().join(' · ')}`);
    console.log('     장비 위반 축이 특히 흔들린다 — 어휘가 정답셋에서 오므로 편이 빠지면 눈금이 바뀐다.');
    console.log('     비교하려면 지금 정답셋으로 **다시 돌려라.** 다시 채점하는 것으로는 안 된다.');
  }
  console.log('  개수차 = (낸 마일스톤 수 − 정답 수)의 평균. 음수면 덜 나눈 것이다.');
  console.log('  장비/예시 = 프롬프트에 실제로 실린 것. 「없음」과 「0편」이 대조판이다 — 한 번에 하나만 끈다.');
  console.log('  종류 = 단계 종류 5종(감지·판단·실행·검증·보고) 규칙이 붙었는가 (8단계 D 판). **개수가 아니라 종류다.**');
  console.log('    이 열이 갈리는 두 줄은 개수만 보면 안 된다 — 개수가 오르고 제목이 내려가면 빈 단계를 채운 것이다.');
  console.log('  장비지어냄 = 저장소가 아는 장비 어디에도 없는 id. **그라운딩이 막아야 하는 것이 이것이다.**');
  console.log('  장비오선택 = 실재하는 장비인데 정답이 고른 것이 아니다 / 낸 assigned_targets 총수. 어휘 문제가 아니라 배정 문제다.');
  console.log('  장소위반 대 장비위반 = **같은 조건에서 목록을 준 축과 안 준 축.** 그 차이가 그라운딩의 효과다.');
  console.log('    7단계부터는 장비 열이 「없음」인 줄과 아닌 줄의 차이가 그 처방의 효과다.');
  console.log('  태스크 = 모델이 낸 노드 총수 (10단계 E 판). 「안냄」은 마일스톤까지만 낸 판이다.');
  console.log('  중앙초/최대초 = 서비스가 잰 추론 시간. **모델 적재 시간은 빼고** 따로 적는다.');
  console.log('');
  console.log('  태스크 판의 축 둘 — `VZ-G-02`. 안 낸 판은 0이 아니라 해당없음이다.');
  for (const row of rows.filter((r) => r.withTasks)) {
    console.log(`    ${row.label}`);
    console.log(`      노드 문법 ${row.node_grammar ?? '해당없음'} · 그래프 f1 ${row.graph_f1 ?? '해당없음'} · 순환 ${row.cycles}건`
      + ` · 모델이 낸 deps ${row.model_deps}건(0이 정상) · ctx ${row.ctx_size}`
      + (row.truncated ? ` · ⚠ 출력이 잘린 건 ${row.truncated}` : ''));
  }
}
