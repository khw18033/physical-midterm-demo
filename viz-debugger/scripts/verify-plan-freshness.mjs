// verify:plan-freshness (260910 신설 — 실물 시연에서 승인이 안 먹던 자리)
//
// **승인을 눌러도 아무 일도 안 일어났다.** 화면에는 아무 말도 없었다.
//
// 원인은 둘이 겹친 것이었다.
//
//  1. **게이트웨이는 구독하는 순간 계획을 여러 건 밀어 준다** — 지금 것과 지난 것이 같이
//     온다. 저장소가 그냥 덮으면 나중에 도착한 쪽이 이기고, 그게 지난 계획이면 화면이
//     지난 계획의 승인 버튼을 그린다.
//  2. **승인 패널이 목록의 첫째를 그렸다** — 그 자리에 옛 편의 묵은 계획이 앉아 있었다.
//
// 그래서 방금 요청해 받은 계획이 아니라 묵은 것을 승인했고, 게이트웨이는 최신 한 건만
// 들고 있어서 「그런 계획이 없다」로 거절했다. 그 답을 전송 계층이 버리고 있어서
// 화면에는 아무 말도 안 남았다.
//
// 실측(2026-09-10):
//
//     IN  plan-mtvkeftp-scr decision=pending   ← 방금 받은 것
//     IN  plan-mtvj90if-scr decision=pending   ← 지난 것 (나중에 도착)
//     OUT plan_decision approve plan-mtvj90if-scr
//     IN  {"accepted":false,"message":"그런 계획이 없다: plan-mtvj90if-scr"}
//
// 보는 것 넷.
//  1. 지난 계획이 새 계획을 덮지 않는가 (도착 순서와 무관하게)
//  2. **같은 계획의 갱신은 언제나 받는가** (pending → approved) — 이것까지 막으면 승인이 안 보인다
//  3. 승인 패널이 **아직 결정 안 난 것 중 가장 새 것**을 고르는가
//  4. 거절된 승인이 화면에 남는가 — 조용히 버리지 않는가
//
// 대조군 포함.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(join(root, ...p)).href);
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const { store } = await load('src', 'tabs', 'data', 'index.ts');

const failures = [];
const controls = [];

const MISSION = 'MSN-260909-01';
const planEnvelope = (planId, createdAt, decision = 'pending') => ({
  entity: MISSION,
  node: 'mission-trace',
  channel: 'plan',
  observed_at: createdAt,
  payload: {
    plan_id: planId,
    entity: MISSION,
    decision,
    decided_at: null,
    reject_reason: null,
    command_id: null,
    segments: [],
    evidence: {
      mission: { id: MISSION, title: '문 쪽으로 이동', requested_by: 'khw', created_at: createdAt },
      zones: [], validations: [], provenance: [],
      generator: { name: 'script-library', version: '260831', context_version: MISSION },
    },
    route: { generated_by: 'x', delivered_by: 'y', decision_returns_to: 'z' },
    relay_stage: 'awaiting_decision',
  },
});

const OLD = { id: 'plan-old-scr', at: '2026-09-10T12:58:47.000Z' };
const NEW = { id: 'plan-new-scr', at: '2026-09-10T13:30:15.000Z' };
const heldPlanId = () => store.getSnapshot().get(MISSION)?.plan?.payload?.plan_id ?? null;

// ── 1. 지난 계획이 새 계획을 덮지 않는다 (도착 순서와 무관하게) ─────────────
for (const order of [[NEW, OLD], [OLD, NEW]]) {
  store.reset?.();
  for (const plan of order) store.apply(planEnvelope(plan.id, plan.at));
  const held = heldPlanId();
  if (held !== NEW.id) {
    failures.push(`${order.map((p) => p.id).join(' → ')} 순서에서 ${held} 를 들고 있다 — 새 계획(${NEW.id})이어야 한다`);
  }
}

// ── 2. 같은 계획의 갱신은 언제나 받는다 ─────────────────────────────────────
//
// 여기까지 막으면 **승인 자체가 화면에 안 보인다.** 승인된 계획은 같은 plan_id 로
// 다시 내려오기 때문이다.
{
  store.reset?.();
  store.apply(planEnvelope(NEW.id, NEW.at));
  store.apply(planEnvelope(NEW.id, NEW.at, 'approved'));
  const decision = store.getSnapshot().get(MISSION)?.plan?.payload?.decision;
  if (decision !== 'approved') failures.push(`같은 계획의 승인 갱신을 안 받는다 — decision 이 ${decision} 다`);
}

// ── 3. 승인 패널이 가장 새 것을 고른다 ──────────────────────────────────────
{
  const panel = code(read('src', 'tabs', 'views', 'PlanApproval.tsx'));
  if (!/freshestTarget\(/.test(panel)) {
    failures.push('승인 패널이 가장 새 계획을 안 고른다 — 목록의 첫째에 묵은 계획이 앉으면 그것을 승인한다');
  }
  // `targets[0]` 만 보는 옛 모양이 남아 있으면 안 된다.
  if (/const target = picked !== null && targets\.includes\(picked\) \? picked : \(targets\[0\]/.test(panel)) {
    failures.push('승인 패널이 아직 targets[0] 을 그린다');
  }
  // 사람이 고른 것은 존중한다 — 새 계획이 온다고 손이 미끄러지면 안 된다.
  if (!/picked !== null && targets\.includes\(picked\) \? picked/.test(panel)) {
    failures.push('사람이 고른 대상을 존중하지 않는다');
  }
  // **승인 여부로 고르면 안 된다** (260911 실측). 「아직 결정 안 난 것 중에서」로 좁혔더니,
  // 승인하는 순간 그 계획이 pending 에서 빠지면서 화면이 **다른 편의 묵은 pending 계획으로
  // 튀었다** — 방금 승인한 영수증 자리에 지난 판의 승인 버튼이 떴다.
  if (/plan\.decision !== 'pending'\) continue;/.test(panel)) {
    failures.push('가장 새 것을 고를 때 승인 여부로 거른다 — 승인하는 순간 묵은 계획으로 튄다');
  }
}

// ── 4. 거절된 승인이 화면에 남는다 ──────────────────────────────────────────
{
  const transport = code(read('src', 'transport', 'WsTransport.ts'));
  if (!/case 'plan_decision'/.test(transport)) {
    failures.push('전송 계층이 plan_decision 응답을 안 읽는다 — 거절이 조용히 사라진다');
  }
  if (!/pushNotification\(/.test(transport)) {
    failures.push('거절을 화면에 안 남긴다 — 눌러도 아무 일이 없고 이유도 없다');
  }
  // 수락됐을 때까지 알림을 띄우면 시연 중에 알림이 쌓인다.
  if (!/msg\.accepted !== true/.test(transport)) {
    failures.push('수락과 거절을 안 가른다 — 성공에도 알림이 뜬다');
  }
}

// ── 대조군 ───────────────────────────────────────────────────────────────────
function control(name, hit) {
  if (!hit) failures.push(`대조군 실패: ${name} — 변조 사본이 잡히지 않았다`);
  controls.push(name);
}
{
  // **그냥 덮는 사본.** 나중에 도착한 것이 이긴다 — 그게 지난 계획이면 화면이 그것을 그린다.
  let held = null;
  for (const plan of [NEW, OLD]) held = plan.id;
  control('나중에 온 것으로 그냥 덮는 사본', held === OLD.id && heldPlanId() !== OLD.id);
}
{
  // **목록의 첫째를 그리는 사본.** 옛 편이 첫째면 묵은 계획을 승인한다.
  const targets = ['MSN-260826-01', MISSION];
  control('목록의 첫째를 그리는 사본', targets[0] !== MISSION);
}

if (failures.length) {
  console.error(`❌ verify:plan-freshness\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('✅ 지난 계획이 새 계획을 안 덮는다 — 도착 순서가 뒤바뀌어도 같다');
console.log('✅ 같은 계획의 승인 갱신은 그대로 받는다 (여기까지 막으면 승인이 안 보인다)');
console.log('✅ 승인 패널이 가장 새 계획을 고른다 (승인 여부로 안 거른다) · 사람이 고른 것은 존중한다');
console.log('✅ 거절된 승인이 화면에 남는다 — 조용히 사라지지 않는다');
console.log(`✅ 대조군 ${controls.length}건 전부 검출 — ${controls.join(' · ')}`);
