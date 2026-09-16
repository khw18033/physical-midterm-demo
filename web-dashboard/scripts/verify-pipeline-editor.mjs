/**
 * VZ-U-04 회귀 검증. 목 게이트웨이가 떠 있는 상태에서 실행한다.
 * 화면 클릭만 확인하면 서버 검증·시험 토큰·되돌리기 경계가 빠지므로 API 실물로 검사한다.
 *
 * 오가는 그래프는 **F4 계약형**이다 (REQ-1002). 좌표는 계약 본문이 아니라 `layout`으로
 * 따로 실어 보내고, 이 스크립트가 계약 본문에 좌표가 없다는 것도 함께 확인한다.
 *
 * 노드 종류를 여기에 적지 않는다 — **카탈로그에서 골라 쓴다** (REQ-1003).
 * 스크립트가 노드 타입을 알고 있으면 카탈로그가 파생인지 상수인지 구분되지 않는다.
 */

const HTTP = process.env.MOCK_HTTP ?? 'http://127.0.0.1:8787';

async function request(path, body) {
  const response = await fetch(HTTP + path, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const note = (message) => process.stdout.write(message + '\n');

/** 카탈로그 항목 → 계약 노드. 편집기가 하는 것과 같은 일이다. */
function nodeOf(entry, id) {
  const node = { id, kind: entry.kind, executionLocation: entry.executionLocation };
  if (entry.defaults.source) node.source = entry.defaults.source;
  if (entry.defaults.transform) node.transform = entry.defaults.transform;
  if (entry.defaults.sink) node.sink = entry.defaults.sink;
  return node;
}

async function main() {
  const catalog = await request('/pipelines/catalog');
  check(catalog.status === 200, '카탈로그 조회 실패');
  const entries = catalog.body.nodes ?? [];
  // 파생 결과라 개수는 등록 파일이 늘면 함께 는다. 지금 등록처
  // (contracts/examples/ 아래 valid-*.json)에서 나오는 값이 14종이다.
  check(entries.length === 14, '카탈로그가 14종이 아니다 (' + entries.length + '종)');
  check(entries.every((n) => n.derivedFrom?.length > 0), '등록 근거(derivedFrom)가 없는 카탈로그 항목이 있다');
  check((catalog.body.port_types ?? []).length > 0, '포트 타입 어휘가 응답에 없다');
  note('■ 카탈로그 ' + entries.length + '종 · 등록처 ' + (catalog.body.registration_sources ?? []).length + '개 파일에서 파생');

  const src = entries.find((n) => n.kind === 'source' && n.emits === 'number');
  const step = entries.find((n) => n.kind === 'transform' && n.accepts?.includes('number'));
  const out = entries.find((n) => n.kind === 'sink' && n.accepts?.includes('number'));
  const mismatched = entries.find((n) => n.kind === 'sink' && !n.accepts?.includes('number'));
  if (!src || !step || !out || !mismatched) {
    note('❌ 실패 — 검증에 필요한 카탈로그 항목을 찾지 못했다');
    process.exitCode = 1;
    return;
  }

  function graph(version) {
    return {
      id: 'verify-pipeline', version, serializationFormat: 'json',
      nodes: [nodeOf(src, 'src'), nodeOf(step, 'step'), nodeOf(out, 'out')],
      edges: [{ from: 'src', to: 'step' }, { from: 'step', to: 'out' }],
    };
  }
  // 좌표는 계약 밖으로만 간다 (REQ-1002).
  const layout = { src: { x: 10, y: 10 }, step: { x: 200, y: 10 }, out: { x: 400, y: 10 } };

  const invalid = graph('0.0.1');
  invalid.edges = [{ from: 'src', to: 'out' }, { from: 'out', to: 'src' }];
  const invalidResult = await request('/pipelines/test', { graph: invalid });
  const invalidCodes = new Set(invalidResult.body.issues?.map((v) => v.code));
  for (const code of ['type_mismatch', 'direction', 'cycle']) check(invalidCodes.has(code), `무효 그래프에서 ${code}를 잡지 못했다`);
  note('■ 타입 불일치·역방향·순환 거부: ' + [...invalidCodes].join(', '));

  const orphan = graph('0.0.2'); orphan.edges = [];
  const orphanResult = await request('/pipelines/test', { graph: orphan });
  const orphanCodes = new Set(orphanResult.body.issues?.map((v) => v.code));
  check(orphanCodes.has('input_required') && orphanCodes.has('output_required'), '고립 노드 입력/출력을 모두 잡지 못했다');
  note('■ 고립 노드 거부: ' + [...orphanCodes].join(', '));

  // REQ-1004 — 포트 타입이 맞지 않는 sink로 보내는 연결은 사유와 함께 거부돼야 한다.
  const typed = graph('0.0.3');
  typed.nodes[2] = nodeOf(mismatched, 'out');
  const typedResult = await request('/pipelines/test', { graph: typed });
  check(typedResult.body.issues?.some((v) => v.code === 'type_mismatch'), '포트 타입이 다른 sink 연결을 잡지 못했다');
  note('■ 카탈로그 포트 타입 불일치 거부: ' + (typedResult.body.issues?.find((v) => v.code === 'type_mismatch')?.message ?? ''));

  // 계약 밖 키(좌표 등)가 섞인 그래프는 서버가 걸러 내야 한다.
  const polluted = graph('0.0.4');
  polluted.nodes[0].x = 10;
  polluted.nodes[0].y = 10;
  const pollutedTest = await request('/pipelines/test', { graph: polluted });
  check(pollutedTest.body.ok === true, '좌표가 섞인 그래프를 서버가 정규화하지 못했다');

  const first = graph('1.0.0');
  const firstTest = await request('/pipelines/test', { graph: first });
  check(firstTest.body.ok && firstTest.body.outputs?.length === 3, '정상 그래프 시험 실행 실패');
  const wrongToken = await request('/pipelines/commit', { graph: first, token: 'wrong', layout });
  check(wrongToken.status === 409, '잘못된 시험 토큰이 409로 거부되지 않았다');
  const firstCommit = await request('/pipelines/commit', { graph: first, token: firstTest.body.token, layout });
  check(firstCommit.body.state?.active?.version === '1.0.0', 'v1.0.0 반영 실패');
  const activeNodes = firstCommit.body.state?.active?.nodes ?? [];
  check(activeNodes.every((n) => !('x' in n) && !('y' in n)), '운영 계약 본문에 좌표가 섞여 있다');
  check(Object.keys(firstCommit.body.state?.activeLayout ?? {}).length === 3, '좌표가 계약 바깥에 보존되지 않았다');
  note('■ 계약 본문 좌표 0건 · 레이아웃은 계약 바깥에 보존');

  const second = graph('1.0.1');
  const secondTest = await request('/pipelines/test', { graph: second });
  // 시험 뒤 초안을 바꾸면 같은 토큰을 쓸 수 없어야 한다.
  const changed = structuredClone(second); changed.version = '1.0.2';
  const changedCommit = await request('/pipelines/commit', { graph: changed, token: secondTest.body.token, layout });
  check(changedCommit.status === 409, '시험 뒤 변경한 초안이 거부되지 않았다');
  const secondCommit = await request('/pipelines/commit', { graph: second, token: secondTest.body.token, layout });
  check(secondCommit.body.state?.active?.version === '1.0.1', 'v1.0.1 반영 실패');
  check(secondCommit.body.state?.previous?.version === '1.0.0', '직전 버전 보존 실패');

  // REQ-1007 — 반영된 그래프의 역방향 관측. 시험 결과와 다른 응답으로 온다.
  const observation = await request('/pipelines/observation');
  check(observation.status === 200, '관측 조회 실패');
  check(observation.body.graph_id === 'verify-pipeline', '관측이 반영된 그래프를 가리키지 않는다');
  check(observation.body.nodes?.length === 3, '관측에 노드 3개가 없다');
  check(typeof observation.body.executor === 'string' && observation.body.executor.includes('목'), '관측 응답이 목 실행기임을 밝히지 않는다');
  const observedKeys = Object.keys(observation.body.nodes?.[0] ?? {});
  for (const key of ['received', 'last_at', 'last_value', 'origin', 'bound_to']) {
    check(observedKeys.includes(key), '관측에 ' + key + '가 없다');
  }
  const testKeys = Object.keys(firstTest.body.outputs?.[0] ?? {});
  check(!testKeys.includes('received') && !observedKeys.includes('rows'), '시험 결과와 관측이 같은 모양이라 구분되지 않는다');
  const bound = observation.body.nodes?.find((n) => n.bound_to !== null) ?? null;
  note('■ 역방향 관측 · 노드 ' + (observation.body.nodes?.length ?? 0) + '개 · 실물 대상에 붙은 노드 ' + (bound ? bound.node_id + '→' + bound.bound_to : '없음'));

  const rollback = await request('/pipelines/rollback', {});
  check(rollback.body.state?.active?.version === '1.0.0', '되돌리기 후 active가 v1.0.0이 아니다');
  check(rollback.body.state?.audit?.slice(-3).map((v) => v.action).join(',') === 'commit,commit,rollback', '감사 순서가 commit,commit,rollback이 아니다');
  note('■ 시험 토큰·변경 후 토큰 무효화·2회 반영·되돌리기·감사 확인');

  if (failures.length) {
    note(`\n❌ 실패 ${failures.length}건`);
    for (const failure of failures) note('   - ' + failure);
    process.exitCode = 1;
    return;
  }
  note('\n✅ 통과 — 그래프 검증, 시험 증명, 반영, 직전 버전 복구, 감사, 역방향 관측 확인');
}

main().catch((error) => {
  process.stderr.write('실행 실패 — ' + (error?.message ?? String(error)) + '\n');
  process.stderr.write('목 게이트웨이가 떠 있는지 확인할 것: npm run dev:mock\n');
  process.exitCode = 1;
});
