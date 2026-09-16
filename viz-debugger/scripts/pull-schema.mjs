// npm run schema:pull — HW 브랜치의 .proto 를 다시 가져와 정적 모듈을 다시 뽑는다.
//
// **원본은 HW 브랜치 하나다.** 우리 쪽 복사본은 낡을 수 있고, 낡은 채로 두면 바이트가
// 어긋나는 순간 로봇이 우리 명령을 못 알아듣는다. 그래서 가져오는 방법을 스크립트로
// 남긴다 — 손으로 복사하면 다음 사람이 어디서 가져왔는지 모른다.
//
// 스키마를 우리가 고치지 않는다. 고쳐야 하면 HW 브랜치에 요청한다.
//
//   원본: https://github.com/khw18033/Physical-Project-mk2/blob/HW/schema/physical_command.proto
//
// 가져온 뒤 `verify:command-encode` 를 반드시 다시 돌려라 — 스키마가 바뀌면 79·31 바이트가
// 달라질 수 있고, 그때는 하드웨어와 다시 맞춰야 한다.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const repoRoot = join(root, '..');
const SOURCE = 'origin/HW:schema/physical_command.proto';
const DEST = join(root, 'schema', 'physical_command.proto');

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

console.log('· origin/HW 를 가져온다');
git('fetch', 'origin', 'HW');
const commit = git('rev-parse', '--short', 'origin/HW').trim();
const body = git('show', SOURCE);

const today = new Date().toISOString().slice(0, 10);
const header = `// 이 파일은 **복사본이다. 우리가 고치지 않는다.**
//
// 원본: https://github.com/khw18033/Physical-Project-mk2/blob/HW/schema/physical_command.proto
// 가져온 날: ${today} · 원본 커밋: ${commit}
// 다시 가져오기: npm run schema:pull
//
// 스키마를 고쳐야 할 일이 생기면 HW 브랜치에 요청한다 — 여기서 고치면 두 벌이 되고,
// 바이트가 어긋나는 순간 로봇이 우리 명령을 못 알아듣는다(verify:command-encode).

`;

const before = (() => {
  try { return readFileSync(DEST, 'utf8'); } catch { return null; }
})();
writeFileSync(DEST, header + body, 'utf8');
console.log(`· schema/physical_command.proto ← ${commit}`);

// 머리말을 뺀 본문이 달라졌는지만 본다 — 날짜만 바뀐 것은 변경이 아니다.
const strip = (text) => (text ?? '').split('\n').filter((line) => !line.startsWith('// 가져온 날:')).join('\n');
if (before !== null && strip(before) === strip(header + body)) {
  console.log('· 본문 변화 없음');
} else {
  console.log('· **본문이 바뀌었다** — verify:command-encode 를 돌려 79·31 바이트를 다시 확인해라');
}

console.log('· 정적 모듈을 다시 뽑는다 (pbjs)');
execFileSync(
  join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'pbjs.cmd' : 'pbjs'),
  ['-t', 'static-module', '-w', 'es6', '--es6', '-o', join(root, 'src', 'physical', 'protocol.js'), DEST],
  { cwd: root, stdio: 'inherit' },
);
console.log('· 타입 선언도 다시 뽑는다 (pbts)');
execFileSync(
  join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'pbts.cmd' : 'pbts'),
  ['-o', join(root, 'src', 'physical', 'protocol.d.ts'), join(root, 'src', 'physical', 'protocol.js')],
  { cwd: root, stdio: 'inherit' },
);
console.log('✅ 끝 — 이제 `npm run verify:command-encode` 를 돌려라');
