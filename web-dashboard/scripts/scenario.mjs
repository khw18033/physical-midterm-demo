/**
 * scripts/scenario.mjs
 *
 * 시나리오 재생 CLI.  사용법:
 *   npm run scenario              → 목록 출력
 *   npm run scenario -- sensor-surge
 */

const base = process.env.MOCK_HTTP ?? 'http://127.0.0.1:8787';
const name = process.argv[2];

if (!name) {
  const res = await fetch(base + '/scenarios');
  const list = await res.json();
  for (const s of list) {
    console.log('\n' + s.name + '  —  ' + s.title);
    console.log('  기대: ' + s.expect);
  }
  console.log('\n사용법: npm run scenario -- <name>');
  process.exit(0);
}

const res = await fetch(base + '/scenario/' + encodeURIComponent(name), { method: 'POST' });
const body = await res.json();
console.log((body.ok ? '재생' : '실패') + ': ' + body.message);
process.exit(body.ok ? 0 : 1);
