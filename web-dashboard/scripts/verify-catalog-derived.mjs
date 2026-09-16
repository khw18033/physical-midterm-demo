/**
 * REQ-1003 회귀 검증 — 카탈로그가 등록된 디스크립터·렌더러·데이터소스에서 파생되는가.
 *
 * 요건이 못박은 조건은 "개발자가 편집기 코드를 고쳐 노드를 추가하는 일이 없어야 한다"다.
 * 그래서 판정 기준도 그 문장 그대로다 — **예시 파일을 하나 넣고, `.ts`는 한 줄도
 * 건드리지 않은 채 카탈로그에 노드가 하나 느는지** 본다.
 *
 * 목 게이트웨이 없이 돈다. 파생 함수를 직접 부르기 때문이다.
 *
 * 검사 네 가지.
 *   1. 코드 상수 노드 목록이 남아 있지 않다.
 *   2. 렌더러 예시를 하나 넣으면 카탈로그가 정확히 하나 는다. 빼면 되돌아온다.
 *   3. 모든 항목이 자기가 나온 등록 파일을 달고 있다.
 *   4. 포트 타입 어휘가 디스크립터 선언과 일치한다 (코드에 타입 표가 없다).
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { deriveCatalog } from '../mock-gateway/pipeline-catalog.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = join(WEB, '..', 'contracts', 'examples');
const RENDERER_DIR = join(EXAMPLES, 'renderer');
const PROBE = join(RENDERER_DIR, 'valid-verify-derived-probe.json');

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const note = (message) => process.stdout.write(message + '\n');

/**
 * 코드 상수 노드 목록의 **선언**을 찾는다. 주석에서 옛 이름을 설명하는 것은 문제가
 * 아니고, 선언이 되살아나는 것이 문제다.
 */
const CONSTANT_DECL = /(?:const|let|var)\s+NODE_CATALOG\b/;

/** `.ts`·`.tsx` 전부를 훑어 코드 상수 노드 목록이 되살아나지 않았는지 본다. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function main() {
  // ── 1. 코드 상수 노드 목록이 없다 ────────────────────────────────────────
  const offenders = sourceFiles(WEB).filter((f) => CONSTANT_DECL.test(readFileSync(f, 'utf8')));
  check(offenders.length === 0, '코드 상수 노드 목록이 남아 있다: ' + offenders.join(', '));
  note('■ 코드 상수 노드 목록(NODE_CATALOG) 0건 — 검사 파일 ' + sourceFiles(WEB).length + '개');

  const before = deriveCatalog();
  check(before.nodes.length > 0, '파생 카탈로그가 비어 있다');

  // ── 3. 모든 항목이 등록 근거를 달고 있다 ────────────────────────────────
  const rootless = before.nodes.filter((n) => !Array.isArray(n.derivedFrom) || n.derivedFrom.length === 0);
  check(rootless.length === 0, '등록 근거가 없는 카탈로그 항목: ' + rootless.map((n) => n.type).join(', '));
  const missingFile = before.nodes.flatMap((n) => n.derivedFrom).filter((f) => {
    try {
      readFileSync(join(WEB, '..', f), 'utf8');
      return false;
    } catch {
      return true;
    }
  });
  check(missingFile.length === 0, '존재하지 않는 등록 파일을 가리킨다: ' + [...new Set(missingFile)].join(', '));

  // ── 4. 포트 타입이 디스크립터 선언에서 온다 ─────────────────────────────
  const declared = new Set();
  for (const name of readdirSync(join(EXAMPLES, 'component-descriptor'))) {
    if (!name.startsWith('valid-')) continue;
    const body = JSON.parse(readFileSync(join(EXAMPLES, 'component-descriptor', name), 'utf8'));
    for (const field of body.fields ?? []) declared.add(field.type);
  }
  check(
    JSON.stringify([...declared].sort()) === JSON.stringify([...before.portTypes].sort()),
    '포트 타입 어휘가 디스크립터 선언과 다르다: 선언 ' + [...declared].sort().join(',') + ' / 파생 ' + before.portTypes.join(','),
  );
  const unknownEmit = before.nodes.filter((n) => n.emits !== null && !declared.has(n.emits));
  check(unknownEmit.length === 0, '디스크립터가 선언하지 않은 출력 타입: ' + unknownEmit.map((n) => n.type + '→' + n.emits).join(', '));
  note('■ 포트 타입 어휘 ' + before.portTypes.join(', ') + ' — 전부 디스크립터 field.type에서 왔다');

  // ── 2. 예시 파일 하나로 노드 하나 ────────────────────────────────────────
  // 스트리밍이 아닌 렌더러를 넣는다. streaming=true면 source 파생 규칙까지 흔들려서
  // "하나 늘었다"가 아니라 "여러 개가 바뀌었다"가 되어 판정이 흐려진다.
  const probe = {
    type: 'verify-derived-probe',
    version: '1.0.0',
    displayName: 'Verify Derived Probe',
    description: 'REQ-1003 회귀 검증이 잠깐 넣었다 빼는 렌더러. 검사가 끝나면 지워진다.',
    acceptsFieldTypes: ['number'],
    streaming: false,
    executionLocation: 'client',
    implementationRef: 'verify/renderers/probe',
  };

  try {
    writeFileSync(PROBE, JSON.stringify(probe, null, 2) + '\n', 'utf8');
    const after = deriveCatalog();
    check(
      after.nodes.length === before.nodes.length + 1,
      '렌더러 예시를 하나 넣었는데 카탈로그가 ' + before.nodes.length + ' → ' + after.nodes.length + '로 변했다 (하나 늘어야 한다)',
    );
    const added = after.nodes.find((n) => n.type === 'sink:verify-derived-probe');
    check(added !== undefined, '넣은 렌더러가 카탈로그에 나타나지 않았다');
    check(added?.kind === 'sink', '파생된 노드가 sink가 아니다');
    check(added?.accepts?.join(',') === 'number', '파생된 노드의 입력 타입이 선언과 다르다');
    check(added?.defaults.sink?.rendererType === 'verify-derived-probe', '파생된 노드가 렌더러 타입을 기본값으로 갖지 않는다');
    check(
      (added?.defaults.sink?.componentRef ?? '') !== '' && (added?.defaults.sink?.fieldRef ?? '') !== '',
      '파생된 sink가 계약 필수값(componentRef·fieldRef) 기본값을 갖지 않는다',
    );
    note('■ 렌더러 예시 1개 추가 → 카탈로그 ' + before.nodes.length + ' → ' + after.nodes.length + '종 · .ts 수정 0건');
  } finally {
    rmSync(PROBE, { force: true });
  }

  const restored = deriveCatalog();
  check(restored.nodes.length === before.nodes.length, '예시 파일을 빼도 카탈로그가 되돌아오지 않았다');
  note('■ 예시 파일 제거 → 카탈로그 ' + restored.nodes.length + '종으로 복귀');

  if (failures.length) {
    note('\n❌ 실패 ' + failures.length + '건');
    for (const failure of failures) note('   - ' + failure);
    process.exitCode = 1;
    return;
  }
  note('\n✅ 통과 — 카탈로그가 등록처에서 파생된다 (REQ-1003)');
}

main();
