import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const contracts = join(root, 'contracts');
const names = ['mission', 'milestone', 'task', 'action-item', 'evaluation', 'trace-event'];
const schemas = Object.fromEntries(await Promise.all(names.map(async (name) => [name, JSON.parse(await readFile(join(contracts, `${name}.schema.json`), 'utf8'))])));
const failures = [];
const statuses = ['pending', 'running', 'done', 'failed', 'skipped', 'awaiting_evaluation', 'not_executed', 'rerunning'];

for (const name of names) {
  const example = JSON.parse(await readFile(join(contracts, 'examples', name, 'valid-basic.json'), 'utf8'));
  if (schemas[name].type !== 'object' || example === null || Array.isArray(example)) failures.push(`${name}: object 계약/예시가 아니다`);
}
if (schemas.mission.properties.milestones.items.$ref !== 'milestone.schema.json') failures.push('mission → milestone 참조 누락');
if (schemas.milestone.properties.tasks.items.$ref !== 'task.schema.json') failures.push('milestone → task 참조 누락');
if (schemas.task.properties.action_items.items.$ref !== 'action-item.schema.json') failures.push('task → action-item 참조 누락');
if (schemas.task.properties.evaluation.anyOf[1].$ref !== 'evaluation.schema.json') failures.push('task → evaluation 참조 누락');
for (const name of ['milestone', 'task']) {
  if (schemas[name].additionalProperties !== false) failures.push(`${name}: additionalProperties가 false가 아니다`);
  const actual = schemas[name].$defs.status.enum;
  if (JSON.stringify(actual) !== JSON.stringify(statuses)) failures.push(`${name}: 8상태 열거 불일치`);
}
for (const forbidden of ['index', 'total']) if (forbidden in schemas.task.properties) failures.push(`task에 일렬 필드 ${forbidden} 존재`);

function rejectsExtra(schema, instance) {
  return schema.additionalProperties === false && Object.keys(instance).some((key) => !(key in schema.properties));
}
const milestoneProbe = { milestone_id: 'm', title: 'm', order: 0, status: 'pending', tasks: [], assigned_targets: [], motor_speed: 1 };
const taskProbe = { task_id: 't', title: 't', deps: [], status: 'pending', attempt: 1, derived_from: null, action_items: [], evaluation: null, joint_angle: 30 };
if (!rejectsExtra(schemas.milestone, milestoneProbe)) failures.push('milestone 하드웨어 어휘 주입을 거부하지 못함');
if (!rejectsExtra(schemas.task, taskProbe)) failures.push('task 하드웨어 어휘 주입을 거부하지 못함');

if (failures.length) { console.error(`❌ verify:hierarchy 실패\n- ${failures.join('\n- ')}`); process.exit(1); }
console.log('✅ 6종 계약 연결·8상태·DAG 필드 확인');
console.log('✅ 의도적 하드웨어 어휘 주입 2건을 additionalProperties:false로 거부');
