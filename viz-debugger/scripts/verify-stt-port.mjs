// 이식본 engines/*.py 가 stt-lab 원본과 바이트 동일한지 검사한다.
//
// 복사의 유일한 위험은 두 벌이 조용히 갈라지는 것이다. 누가 복사본을 고치면 여기서
// 실패하고, 그때 "원본도 같이 고칠 것인가, 갈라놓을 것인가"를 의식적으로 정하게 된다.
// 갈라지는 것 자체를 막는 검사가 아니라 **조용히 갈라지는 것**을 막는 검사다.
//
// 출처 주석(파일 맨 위의 연속된 `#` 줄)만 예외로 둔다. 그 아래로는 한 글자도 다르면 안 된다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const originDir = join(root, 'stt-lab', 'server', 'engines');
const portDir = join(root, 'viz-debugger', 'stt', 'engines');

/** 파일 맨 위의 연속된 `#` 주석 줄만 떼어 낸다. 본문 안의 `#` 주석은 건드리지 않는다. */
function stripProvenance(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].startsWith('#')) index += 1;
  return { header: lines.slice(0, index), body: lines.slice(index).join('\n') };
}

const files = readdirSync(originDir).filter((name) => name.endsWith('.py'));
if (files.length === 0) {
  console.error(`❌ 원본 엔진 파일을 찾지 못했다: ${originDir}`);
  process.exit(1);
}

/** @param mutate 이식본 본문에 주입할 변형. 음성 대조군 확인용. */
function compare(mutate = (body) => body) {
  const problems = [];
  for (const name of files) {
    let portRaw;
    try {
      portRaw = readFileSync(join(portDir, name));
    } catch {
      problems.push(`${name}: 이식본이 없다`);
      continue;
    }
    const origin = stripProvenance(readFileSync(join(originDir, name)));
    const port = stripProvenance(portRaw);
    if (port.header.length === 0) problems.push(`${name}: 출처 주석이 없다`);
    else if (!port.header.some((line) => line.includes('이식:'))) problems.push(`${name}: 출처 주석에 원본 경로가 없다`);
    if (mutate(port.body, name) !== origin.body) problems.push(`${name}: 원본과 다르다`);
  }
  return problems;
}

const actual = compare();
if (actual.length) {
  console.error(`❌ 이식본이 stt-lab 원본과 어긋났다:\n  - ${actual.join('\n  - ')}`);
  console.error('  원본을 고쳤다면 이식본도 다시 복사하고, 갈라놓기로 정했다면 그 결정을 보고서에 남길 것.');
  process.exit(1);
}

// 음성 대조군 — 한 글자만 바꿔도 반드시 잡혀야 한다.
// (verify:standalone 이 경로 구분자 때문에 아무것도 못 잡은 채 통과하던 일이 실제로 있었다.
//  reports/2026-08-28_1036_통합구현_검토.md B항)
const oneChar = compare((body, name) => (name === files[0] ? body.replace('=', '≠') : body));
if (oneChar.length === 0) {
  console.error('❌ 한 글자를 바꾼 음성 대조군을 검출하지 못했다 — 이 검사는 무의미하다');
  process.exit(1);
}

console.log(`✅ 통과 — 이식본 ${files.length}개가 stt-lab 원본과 바이트 동일(출처 주석 제외), 한 글자 변형 시 실패 검출`);
