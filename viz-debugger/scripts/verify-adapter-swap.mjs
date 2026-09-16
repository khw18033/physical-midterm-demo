import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const adapterDir = join(root, 'adapters');
const profiles = (await readdir(adapterDir)).filter((name) => name.endsWith('.json'));
for (const name of profiles) JSON.parse(await readFile(join(adapterDir, name), 'utf8'));

// 판정 기준(두 번째 프로파일부터 활성화): 기준 커밋과 비교해 adapters/*.json만 추가됐을 때
// src/model/ 및 src/views/의 마일스톤·태스크 관련 변경 파일 수가 반드시 0이어야 한다.
if (profiles.length < 2) {
  console.log('✅ 스켈레톤 통과 — 프로파일 1종; 두 번째 프로파일 추가 시 상위 계층 변경 0건을 판정한다');
} else {
  console.error('❌ 두 번째 프로파일이 생겼다. 기준 커밋 기반 변경 0건 검사를 구현한 뒤 통과시켜야 한다');
  process.exit(1);
}
