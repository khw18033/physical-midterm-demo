import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const scenario = JSON.parse(await readFile(join(root, 'scenarios', 'MSN-260826-01.json'), 'utf8'));
const expected = ['pending', 'running', 'done', 'failed', 'skipped', 'awaiting_evaluation', 'not_executed', 'rerunning']; const actual = new Set(scenario.events.map((event) => event.status)); const errors = [];
if (scenario.missionId !== 'MSN-260826-01') errors.push('임무 ID 불일치');
if (scenario.milestones.length !== 7 || scenario.tasks.length !== 7) errors.push('마일스톤/태스크 7건 불일치');
if (scenario.tasks.find((task) => task.id === 'T-31')?.actionItems.length !== 4) errors.push('T-31 액션 아이템 4건 불일치');
if (scenario.hardware.length !== 7 || scenario.hardware.find((item) => item.id === 'arm-03')?.connection !== 'offline') errors.push('하드웨어 7대 또는 arm-03 오프라인 불일치');
if (scenario.events.some((event, index) => index > 0 && event.atSec < scenario.events[index - 1].atSec)) errors.push('이벤트 시각 역전');
for (const status of expected) if (!actual.has(status)) errors.push(`상태 누락: ${status}`);
const deps = Object.fromEntries(scenario.tasks.map((task) => [task.id, task.deps])); if (JSON.stringify(deps['T-34']) !== JSON.stringify(['T-32', 'T-33'])) errors.push('T-34 합류 관계 불일치');
if (errors.length) { console.error(`❌ verify:scenario\n- ${errors.join('\n- ')}`); process.exit(1); }
console.log('✅ MSN-260826-01 · 7 마일스톤 · 7 태스크 · 7 하드웨어 · 분기/합류 확인'); console.log(`✅ 시각 순서 이벤트 ${scenario.events.length}건과 8상태 전부 확인`);
