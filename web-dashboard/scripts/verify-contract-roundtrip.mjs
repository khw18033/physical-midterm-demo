/**
 * REQ-1002 회귀 검증 — 편집기 초안과 F4 계약 사이의 무손실 왕복.
 *
 * 목 게이트웨이가 없어도 돈다. 검사하는 것은 HTTP 왕복이 아니라 **직렬화 계층**이다.
 *
 * 네 가지를 본다.
 *   1. 초안 → 계약 JSON → 초안이 같은 그래프를 낸다 (좌표까지).
 *   2. 중간 계약 JSON이 `contracts/pipeline.schema.json`을 통과한다.
 *      검증기는 `contracts/validate_examples.py`와 같은 것을 쓴다.
 *   3. **좌표가 계약 JSON에 섞이면 실패로 잡는다.** 오염된 본문을 일부러 만들어
 *      스키마가 거부하는지 확인하고, 직렬화가 그 오염을 실제로 끊는지 확인한다.
 *   4. 등록된 파이프라인 예시가 전부 무손실로 왕복한다. 실물 계약이 왔을 때
 *      "읽을 수는 있는데 되돌리면 달라진다"를 미리 잡는 자리다.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { deriveCatalog } from '../mock-gateway/pipeline-catalog.ts';
import {
  draftFingerprint,
  fromContract,
  nodeFromCatalog,
  toContract,
  validateContract,
} from '../shared/pipeline-contract.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIPELINE_EXAMPLES = join(ROOT, 'contracts', 'examples', 'pipeline');

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const note = (message) => process.stdout.write(message + '\n');

/** 계약 스키마가 아는 키. 이 밖의 키가 본문에 있으면 그 자체가 오염이다. */
const ALLOWED = {
  root: new Set(['id', 'version', 'displayName', 'description', 'serializationFormat', 'extensionPoint', 'nodes', 'edges']),
  node: new Set(['id', 'kind', 'executionLocation', 'source', 'transform', 'sink']),
  edge: new Set(['from', 'to']),
};

function strayKeys(contract) {
  const stray = [];
  for (const key of Object.keys(contract)) if (!ALLOWED.root.has(key)) stray.push('<root>.' + key);
  for (const node of contract.nodes ?? []) {
    for (const key of Object.keys(node)) if (!ALLOWED.node.has(key)) stray.push(node.id + '.' + key);
  }
  for (const [i, edge] of (contract.edges ?? []).entries()) {
    for (const key of Object.keys(edge)) if (!ALLOWED.edge.has(key)) stray.push('edges[' + i + '].' + key);
  }
  return stray;
}

/** `contracts/validate_instance.py`로 스키마 검증. 돌려주는 값은 통과 여부다. */
function schemaAccepts(instance, label) {
  const dir = mkdtempSync(join(tmpdir(), 'roundtrip-'));
  const file = join(dir, 'instance.json');
  writeFileSync(file, JSON.stringify(instance, null, 2), 'utf8');
  try {
    for (const python of ['python', 'python3']) {
      const run = spawnSync(python, [join(ROOT, 'contracts', 'validate_instance.py'), 'pipeline', file], { encoding: 'utf8' });
      if (run.error) continue;
      if (run.status === 0) return { ok: true, detail: '' };
      if (run.status === 1) return { ok: false, detail: (run.stdout ?? '').trim() };
      failures.push(label + ': 검증기 사용법 오류 — ' + (run.stdout ?? '') + (run.stderr ?? ''));
      return { ok: false, detail: 'usage' };
    }
    failures.push(label + ': python을 찾지 못해 스키마 검증을 실행할 수 없다');
    return { ok: false, detail: 'no-python' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const catalog = deriveCatalog().nodes;
  const source = catalog.find((n) => n.kind === 'source' && n.emits === 'number');
  const transform = catalog.find((n) => n.kind === 'transform' && n.accepts?.includes('number') && n.emits === 'number');
  const sink = catalog.find((n) => n.kind === 'sink' && n.accepts?.includes('number'));
  if (!source || !transform || !sink) {
    note('❌ 실패 — 파생 카탈로그에 number 경로(source·transform·sink)가 없다');
    process.exitCode = 1;
    return;
  }

  // ── 1. 초안 → 계약 → 초안 ────────────────────────────────────────────────
  const draft = {
    pipeline: {
      id: 'roundtrip-check',
      version: '1.0.0',
      displayName: '왕복 검사용 초안',
      serializationFormat: 'json',
      nodes: [nodeFromCatalog(source, 'source_1'), nodeFromCatalog(transform, 'transform_1'), nodeFromCatalog(sink, 'sink_1')],
      edges: [{ from: 'source_1', to: 'transform_1' }, { from: 'transform_1', to: 'sink_1' }],
    },
    layout: { source_1: { x: 37, y: 214 }, transform_1: { x: 401, y: 88 }, sink_1: { x: 733, y: 305 } },
  };

  const issues = validateContract(draft.pipeline, catalog);
  check(issues.length === 0, '왕복 검사용 초안이 편집기 검증을 통과하지 못한다: ' + issues.map((i) => i.code).join(','));

  const contract = toContract(draft);
  const back = fromContract(contract, draft.layout);
  check(draftFingerprint(back) === draftFingerprint(draft), '초안 → 계약 → 초안이 같은 그래프를 내지 않는다');
  check(JSON.stringify(back.layout) === JSON.stringify(draft.layout), '좌표가 왕복에서 보존되지 않는다');
  note('■ 초안 → 계약 → 초안 동일 · 노드 ' + contract.nodes.length + '개 · 좌표 ' + Object.keys(back.layout).length + '개 보존');

  // 좌표를 잃고도 계약만으로 복원되는가 — 그때는 자동 배치가 대신 들어온다.
  const withoutLayout = fromContract(contract);
  check(
    JSON.stringify(toContract(withoutLayout)) === JSON.stringify(contract),
    '레이아웃 없이 복원한 초안의 계약 본문이 달라진다',
  );
  check(Object.keys(withoutLayout.layout).length === contract.nodes.length, '레이아웃 없이 복원했을 때 좌표가 채워지지 않는다');

  // ── 2. 중간 계약 JSON이 스키마를 통과하는가 ──────────────────────────────
  const stray = strayKeys(contract);
  check(stray.length === 0, '계약 본문에 계약 밖 키가 있다: ' + stray.join(', '));
  const accepted = schemaAccepts(contract, '왕복 산출물');
  check(accepted.ok, '왕복 산출 계약 JSON이 pipeline.schema.json을 통과하지 못한다\n' + accepted.detail);
  note('■ 왕복 산출 계약 JSON이 pipeline.schema.json 통과 · 계약 밖 키 0건');

  // ── 3. 좌표 오염을 실패로 잡는가 ─────────────────────────────────────────
  const polluted = JSON.parse(JSON.stringify(contract));
  polluted.nodes[0].x = 37;
  polluted.nodes[0].y = 214;
  const rejected = schemaAccepts(polluted, '오염 본문');
  check(!rejected.ok, '좌표가 섞인 계약 JSON을 스키마가 통과시켰다 — 오염을 잡지 못한다');
  check(strayKeys(polluted).length === 2, '좌표 오염을 계약 밖 키 검사가 잡지 못한다');

  // 직렬화가 실제로 그 오염을 끊는가. 초안 쪽 노드에 좌표를 붙여도 계약에는 없어야 한다.
  const pollutedDraft = { pipeline: JSON.parse(JSON.stringify(polluted)), layout: draft.layout };
  const cleaned = toContract(pollutedDraft);
  check(strayKeys(cleaned).length === 0, 'toContract가 노드에 붙은 좌표를 걸러내지 못한다');
  check(JSON.stringify(cleaned) === JSON.stringify(contract), '오염을 걷어낸 계약이 원본 계약과 다르다');
  note('■ 좌표 오염 검출 · 스키마 거부 확인 · 직렬화가 오염을 끊는 것 확인');

  // ── 4. 등록된 파이프라인 예시 전부 왕복 ──────────────────────────────────
  const examples = readdirSync(PIPELINE_EXAMPLES).filter((n) => n.startsWith('valid-') && n.endsWith('.json')).sort();
  check(examples.length > 0, '왕복을 확인할 파이프라인 예시가 없다');
  for (const name of examples) {
    const original = JSON.parse(readFileSync(join(PIPELINE_EXAMPLES, name), 'utf8'));
    const restored = toContract(fromContract(original));
    check(
      JSON.stringify(restored) === JSON.stringify(original),
      name + ': 계약 → 초안 → 계약이 원본과 다르다\n    원본  ' + JSON.stringify(original) + '\n    복원  ' + JSON.stringify(restored),
    );
  }
  note('■ 등록된 파이프라인 예시 ' + examples.length + '건 전부 계약 → 초안 → 계약 동일');

  if (failures.length) {
    note('\n❌ 실패 ' + failures.length + '건');
    for (const failure of failures) note('   - ' + failure);
    process.exitCode = 1;
    return;
  }
  note('\n✅ 통과 — 무손실 왕복, 좌표 격리, 스키마 검증 확인 (REQ-1002)');
}

main();
