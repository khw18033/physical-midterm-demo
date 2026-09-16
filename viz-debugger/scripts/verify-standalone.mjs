// 탭① 단독 빌드가 셸·다른 탭과 얽히지 않았는지 검사한다.
// 논문 측정축 D는 이 빌드로 재는 것이므로, 관제·영상 탭 코드가 섞이면 측정이 오염된다.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = normalize(fileURLToPath(new URL('../src/', import.meta.url)));
const entry = join(sourceRoot, 'standalone.tsx');

/** @param inject 진입점에 덧붙일 가짜 import. 음성 대조군 확인용. */
function scan(inject = '') {
  const visited = new Set();
  const forbidden = [];
  function visit(path) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, 'utf8') + (path === entry ? inject : '');
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const next = normalize(join(dirname(path), match[1]));
      if (!/\.(ts|tsx)$/.test(next)) continue;
      const rel = relative(sourceRoot, next).replaceAll('\\', '/');
      if (rel.startsWith('shell/') || rel.startsWith('tabs/')) forbidden.push(rel);
      if (existsSync(next)) visit(next);
    }
  }
  visit(entry);
  return { visited, forbidden };
}

const actual = scan();
if (actual.forbidden.length) {
  console.error(`❌ 탭① 단독 진입점이 셸/다른 탭을 import함: ${actual.forbidden.join(', ')}`);
  process.exit(1);
}

// 음성 대조군 — 일부러 셸을 끌어오면 반드시 잡혀야 한다.
if (scan("\nimport { AppShell } from './shell/AppShell.tsx';").forbidden.length === 0) {
  console.error('❌ 셸 import를 주입한 음성 대조군을 검출하지 못했다 — 이 검사는 무의미하다');
  process.exit(1);
}

if (!existsSync(new URL('../dist-standalone/standalone.html', import.meta.url))) {
  console.error('❌ dist-standalone이 없다. 먼저 npm run build:standalone을 실행해야 한다');
  process.exit(1);
}
console.log(`✅ 통과 — 단독 빌드 존재, 의존 그래프 ${actual.visited.size}개 파일에 셸/다른 탭 import 0건, 주입 시 실패 검출`);
