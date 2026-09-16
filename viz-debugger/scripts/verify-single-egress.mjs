import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
const files = [];
function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name)) files.push(path);
  }
}
walk(root);

// 출구 본체는 shared/commandCenter.ts 다. 통합 전에는 commandEgress.ts 였지만, 탭②~⑥이
// 들어오면서 4단계 추적·상관 키 매핑·만료 처리를 가진 CommandTracker 가 본체가 됐고
// commandEgress.ts 는 그 위의 얇은 껍데기로 접혔다. **세는 규칙은 그대로다 — 한 곳이어야 한다.**
const EXIT = 'shared/commandCenter.ts';

function exits(extra = '') {
  return files.flatMap((path) => {
    if (path.endsWith(join('transport', 'WsTransport.ts'))) return [];
    const source = readFileSync(path, 'utf8') + (path.endsWith('commandCenter.ts') ? extra : '');
    return [...source.matchAll(/\.publishCommand\s*\(/g)].map(() => relative(root, path));
  });
}

const actual = exits();
if (actual.length !== 1 || !actual[0].replaceAll('\\', '/').endsWith(EXIT)) {
  console.error(`❌ 명령 출구 ${actual.length}개: ${actual.join(', ')} (있어야 할 곳: ${EXIT})`);
  process.exit(1);
}

// 껍데기가 본체를 실제로 부르는가. 부르지 않으면 탭①과 셸의 명령이 4단계 추적 밖으로 샌다.
const egress = readFileSync(join(root, 'shared', 'commandEgress.ts'), 'utf8');
if (!/commandTracker\.issue\s*\(/.test(egress)) {
  console.error('❌ shared/commandEgress.ts 가 commandTracker.issue() 를 부르지 않는다 — 출구가 갈라졌다');
  process.exit(1);
}

// 음성 대조군 — 두 번째 출구를 주입하면 반드시 잡혀야 한다.
if (exits('\ngetTransport().publishCommand({});').length !== 2) {
  console.error('❌ 두 번째 출구를 주입한 음성 대조군을 검출하지 못했다');
  process.exit(1);
}
console.log(`✅ 통과 — 앱 명령 출구 1개(${EXIT}), 껍데기가 본체를 호출, 두 번째 출구 주입 시 실패 검출`);
