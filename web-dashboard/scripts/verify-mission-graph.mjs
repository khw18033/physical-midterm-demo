/** 임무 그래프가 실제 plan/plan_progress 이벤트를 따라가는지 검증한다. */
import { WebSocket } from 'ws';

const WS = process.env.MOCK_WS ?? 'ws://127.0.0.1:8787';
const timeoutMs = 20_000;

async function main() {
  const ws = new WebSocket(WS);
  const plans = [];
  const progress = [];
  let targetPlan = null;

  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type !== 'data') return;
    const env = msg.envelope;
    if (env.channel === 'plan') { plans.push(env.payload); if (env.payload.decision === 'pending') targetPlan = env.payload; }
    if (env.channel === 'plan_progress') progress.push(env.payload);
  });
  ws.send(JSON.stringify({ type: 'subscribe', id: 'mission-verify', selector: { entity: 'robot-01', node: '*', channel: '*' }, scope: 'all' }));
  ws.send(JSON.stringify({ type: 'scenario', name: 'plan-propose-failing' }));

  const waitFor = async (test, label) => {
    const started = Date.now();
    while (!test()) {
      if (Date.now() - started > timeoutMs) throw new Error(label + ' 대기 시간 초과');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await waitFor(() => targetPlan !== null, '승인 대기 계획');
  if (progress.length !== 0) throw new Error('승인 전 plan_progress가 발행됐다');
  process.stdout.write(`■ 임무 ${targetPlan.plan_id} · Sub task ${targetPlan.segments.length}개 · 승인 전 진행 0건\n`);

  ws.send(JSON.stringify({ type: 'plan_decision', plan_id: targetPlan.plan_id, decision: 'approve' }));
  await waitFor(() => progress.some((p) => p.segments.some((s) => s.status === 'failed')), '실패 전이');
  const final = progress.at(-1).segments.map((s) => s.status);
  const expected = ['done', 'done', 'done', 'failed', 'skipped'];
  if (JSON.stringify(final) !== JSON.stringify(expected)) throw new Error(`최종 상태 불일치: ${final.join(',')}`);
  if (!progress.some((p) => p.segments.some((s) => s.status === 'running'))) throw new Error('진행중 전이가 없다');
  const approved = plans.some((p) => p.plan_id === targetPlan.plan_id && p.decision === 'approved');
  if (!approved) throw new Error('승인된 plan 이벤트가 없다');

  process.stdout.write(`■ 진행 이벤트 ${progress.length}건 · 최종 ${final.join(' → ')}\n`);
  process.stdout.write('✅ 통과 — 승인 전 실행 금지, Sub task 실시간 전이, 실패 뒤 건너뜀 확인\n');
  ws.close();
}

main().catch((error) => {
  process.stderr.write('❌ 실패 — ' + (error?.message ?? String(error)) + '\n');
  process.stderr.write('목 게이트웨이가 떠 있는지 확인할 것: npm run dev:mock\n');
  process.exitCode = 1;
});
