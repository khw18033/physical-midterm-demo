// 이식: web-dashboard/src/views/MissionView.tsx @ 700ed91 — 탭① 안의 승인 패널로 개조
//
// 구 「임무 승인·진행」 탭은 탭①에 통폐합됐다. 화면 하나를 통째로 옮긴 것이 아니라
// **승인·거부 호출부(VZ-U-07)를 탭① 안으로 들여온 것**이다. 그래서 최상위가 <main> 이
// 아니라 <section> 이고, 제목도 h1 이 아니라 h2 다 — 이 화면의 h1 은 탭①이 갖는다.
//
// 2026-09-01 — **서브태스크 진행(SegmentTrack)을 지웠다.** 근거 둘.
//  1. 계획 구간은 마일스톤과 **같은 값**이다. gateway/plans.ts 머리 주석이 그렇게 적고 있고
//     ScriptEngine 이 foldMilestones() 결과를 plans.applyScriptMilestones() 로 되돌린다 —
//     즉 이 패널의 구간 목록은 탭①의 마일스톤 목록을 한 화면에서 두 번 그리는 것이었다.
//  2. 실패 상세(faildetail)도 지웠다 — 탭①에 실패 경로 강조 화면(screen === 'failure')이
//     이미 있다. 중계 단계(relay_stage)는 백엔드 내부 상태라 목·개발 모드로 내렸다.
//
// **VZ-U-05 를 조용히 없앤 것이 아니다.** 탭①의 마일스톤 목록 · 태스크 그래프 · 되감기
// 타임라인이 그 요구를 충족한다고 보고, 그 판단을 요구사항정의서 §3.1 에 적었다.
//
// 2026-09-01 (2차) — **결정이 끝나면 한 줄 영수증으로 접는다.** 승인된 뒤에도 근거 4층과
// 산출 경로가 화면 한가운데를 차지해 마일스톤을 아래로 밀고 있었는데, 그 시점에는 결정할
// 것이 하나도 없다. 여기는 마일스톤 화면이고 마일스톤이 주인이다.
//  - 승인 전  : 근거 4층을 **펼친 채로** + 승인·거부 (판단 1 그대로 — 관문이다)
//  - 결정 후  : `✓ 승인됨 · 시각 · plan_id · [근거 ▾]` 한 줄. 펼치면 근거 4층과 산출 경로
//  - 「어떻게 동작하는가」(경로 hop 의 뜻 · AI/백엔드 중계 구분)는 우상단 `?` 설명서로 옮겼다
//
// **탭① 단독 빌드에는 들어가지 않는다.** 이 파일은 tabs/ 아래에 있고, 통합 셸이
// integrated.tsx 에서 프롭으로 주입한다. 단독 빌드는 프롭을 주지 않으므로 데이터 계층을
// 끌고 들어가지 않는다 (verify:standalone).
/**
 * src/views/MissionView.tsx
 *
 * VZ-U-07 계획 승인 · VZ-U-05 서브태스크 진행.
 *
 * **중계자는 백엔드다** (BE-X-04). 계획도 백엔드 채널로 도착하고 승인·거부도 같은 채널로
 * 돌아간다. AI는 계획의 **출처**로만 근거에 남는다 — 그래서 이 화면에는 AI와 직접
 * 주고받는 경로가 없고, 근거에는 어디까지가 AI 산출이고 어디부터가 백엔드 중계인지가
 * 구분되어 표시된다. 나중에 승인이 안 먹었을 때 어느 구간에서 끊겼는지 봐야 하기 때문이다.
 *
 * **승인 화면은 목업이 없어 직접 설계했다.** 판단한 것 셋:
 *  1. 근거를 접어 두지 않고 **처음부터 펼쳐서** 보여준다. 승인은 되돌리기 어려운 조작이라
 *     "펼쳐 봐야 보이는 근거"는 안 보는 근거가 된다.
 *  2. 근거를 요구사항이 말한 **네 층 순서 그대로**(임무 → 구역 → 구간 → 검증) 세로로 쌓았다.
 *     생성기·맥락 버전은 맨 아래 각주로 뺐다 — 판단에 쓰는 값이 아니라 되짚을 때 쓰는 값이다.
 *  3. 거부는 **사유 없이 보낼 수 없게** 했다. 사유 없는 거부는 다음 계획 생성에 반영할 수 없다.
 *
 * 판단 1은 260901 이후에도 그대로다 — 승인은 되돌리기 어려운 조작이라 **승인 전에는**
 * 근거 4층을 접지 않는다. 다만 그중 「구간별 계획」 절만 **한 줄로 줄였다**: 아래 마일스톤
 * 목록과 같은 값이라 펼쳐 두면 같은 것을 두 번 읽게 된다.
 *
 * 판단 1이 말하는 것은 **결정하기 전**이다. 결정이 끝난 뒤에도 펼쳐 두는 것은 근거를 보이는
 * 일이 아니라 자리를 차지하는 일이다 — 그래서 결정 후에는 접는다.
 */

import { armApproval } from '../../physical/robotSession.ts';
import { useState, type ReactNode } from 'react';
import {
  PRODUCED_BY_LABEL,
  RELAY_STAGE_LABEL,
  decidePlan,
  playScenario,
  splitProvenance,
  type Plan,
  type ProvenanceStep,
} from '../data/index.ts';
import { useEntities } from '../data/hooks.ts';
import type { EntityRecord } from '../data/store.ts';
import { Explain } from '../../shared/Explain.tsx';
import { useDevTools } from '../../shared/renderMode.ts';
import { humanActed, noteHumanAction } from '../../shared/humanAction.ts';

/**
 * **계획 대상을 코드에 적지 않는다.** 계획이 도착한 대상이 곧 임무 대상이고,
 * 그 목록은 스토어(=레지스트리 + 수신)에서 나온다. 대상 id를 상수로 두면
 * 장치가 늘 때 화면이 따라가지 못하고, 범용 프레임워크라는 전제가 화면에서만 깨진다.
 */
function planTargets(entities: ReadonlyMap<string, EntityRecord>): string[] {
  return [...entities.values()].filter((r) => r.plan !== null).map((r) => r.id).sort();
}

function timeOf(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(Math.floor(d.getMilliseconds() / 100))
  );
}

/**
 * 아직 결정 안 난 계획 중 **가장 나중에 만들어진** 것의 대상. 없으면 목록의 첫째다.
 * 만든 시각을 못 읽으면 순서를 안 바꾼다 — 모를 때 뒤섞으면 더 나쁘다.
 */
function freshestTarget(entities: ReturnType<typeof useEntities>, targets: readonly string[]): string | null {
  let best: string | null = null;
  let bestAt = -Infinity;
  for (const id of targets) {
    const plan = entities.get(id)?.plan?.payload as Plan | undefined;
    if (plan === undefined) continue;
    const at = Date.parse(plan.evidence?.mission?.created_at ?? '');
    if (Number.isNaN(at)) continue;
    if (at > bestAt) { bestAt = at; best = id; }
  }
  return best ?? targets[0] ?? null;
}

export function PlanApproval() {
  const entities = useEntities();
  /**
   * **사람이 먼저다** (260910). 계획 채널은 캐시되는 채널이라, 구독하는 순간 지난 세션의
   * 계획이 그대로 다시 들어온다. 그걸 그리면 **아무도 아무것도 안 눌렀는데** 앱을 열자마자
   * 지난 판의 승인 버튼이 떠 있다 — 누르면 게이트웨이가 「그런 계획이 없다」로 거절한다.
   *
   * 빈 화면을 기본으로 만들고도 이 카드만 남아 있던 자리다. 임무 다리(`missionBridge`)에
   * 건 것과 같은 빗장이고 같은 이유다.
   *
   * 훅을 부른 **뒤에** 돌아간다 — 훅의 수가 그리기마다 달라지면 안 된다.
   */
  const acted = humanActed();
  const targets = planTargets(entities);
  const [picked, setPicked] = useState<string | null>(null);
  /**
   * **새 계획이 오면 그리로 따라간다** (260910 실측으로 드러난 자리).
   *
   * 전에는 목록의 첫째(`targets[0]`)를 그렸다. 그 자리에 지난 편의 **묵은 계획**이 앉아
   * 있으면, 방금 요청해 받은 계획이 아니라 그것의 승인 버튼이 뜬다. 눌러도 게이트웨이가
   * 「그런 계획이 없다」로 거절한다 — 그쪽은 최신 한 건만 들고 있기 때문이다.
   *
   * 실제로 그랬다. 승인을 눌러도 임무가 시작되지 않았고, 화면에는 아무 말도 없었다.
   * 이제 **가장 새 계획**을 기본으로 고른다. 사람이 직접 고른 것은 그대로 존중한다.
   *
   * 처음엔 「아직 결정 안 난 것 중」으로 좁혔다가 되돌렸다. 승인하는 순간 그 계획이
   * pending 에서 빠지면서 화면이 **다른 편의 묵은 pending 계획으로 튀었다** — 방금 승인한
   * 영수증을 봐야 할 자리에 지난 판의 승인 버튼이 떴다. 승인 여부로 고르면 안 된다.
   */
  const target = picked !== null && targets.includes(picked) ? picked : freshestTarget(entities, targets);
  const record = target === null ? null : (entities.get(target) ?? null);

  const plan = (record?.plan?.payload as Plan | undefined) ?? null;
  // 진행(planProgress)은 더 이상 읽지 않는다 — 구간 = 마일스톤이고, 마일스톤은 탭①이 그린다.

  /** 결정이 끝났는가. 끝났으면 **머리글까지** 없애고 한 줄 영수증만 남긴다 (260901 2차). */
  const decided = plan !== null && plan.decision !== 'pending';

  // 계획 대상이 여럿일 때만 뜨는 고르개. 영수증 줄에서도 같은 것을 쓴다 — 두 벌로 만들지 않는다.
  if (!acted) return null;

  const targetPicker = targets.length > 1 ? (
    <label className="missionpick">
      임무 대상
      <select value={target ?? ''} onChange={(e) => setPicked(e.target.value)}>
        {targets.map((id) => (
          <option key={id} value={id}>
            {entities.get(id)?.registry?.display_name ?? id}
          </option>
        ))}
      </select>
    </label>
  ) : null;

  return (
    <section className={'board board--embedded' + (decided ? ' board--receipt' : '')}>
      {!decided && (
        <header className="board__head">
          <div>
            <h2 className="board__title">임무 승인 — 계획 근거와 승인·거부</h2>
            <Explain id="plan-1" className="board__sub">
              검증을 통과해도 <strong>사람이 승인해야 실행된다</strong>. 승인 전에는 아무것도 재생되지 않고,
              승인하면 <strong>아래 마일스톤</strong>이 순서대로 진행된다
            </Explain>
          </div>
          <div className="board__meta">
            {targetPicker}
            <span>VZ-U-07</span>
          </div>
        </header>
      )}

      {plan === null ? (
        <p className="notice">
          승인 대기 중인 계획이 없다. 아래에서 계획을 하나 내려받아 보라.
        </p>
      ) : decided ? (
        <DecidedReceipt plan={plan} picker={targetPicker} />
      ) : (
        <ApprovalPanel plan={plan} />
      )}

      <section className="devpanel">
        <h2 className="devpanel__title">시나리오 재생</h2>
        <div className="devpanel__row">
          <button type="button" className="btn" onClick={() => playScenario('plan-propose')}>
            계획 내려받기 (정상 완주)
          </button>
          <button type="button" className="btn" onClick={() => playScenario('plan-propose-failing')}>
            계획 내려받기 (구간 4/5 실패)
          </button>
        </div>
      </section>
    </section>
  );
}

/**
 * VZ-U-07 — **결정하기 전** 화면. 근거를 펼쳐 보이고 승인/거부를 받는다.
 *
 * 산출 경로(RouteStrip)와 중계 4단계(ProvenanceTrack)는 여기 없다 (260901 2차) —
 * 그건 「이 계획을 승인할 것인가」가 아니라 「이 시스템이 어떻게 동작하는가」이고,
 * 그 설명은 우상단 `?` 설명서에 있다. 실제 단계와 시각은 결정 뒤 「근거 ▾」에서 본다
 * (승인 수신·재생 시작 두 단계는 애초에 결정 뒤에야 생긴다).
 */
function ApprovalPanel({ plan }: { plan: Plan }) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <section className="panel panel--wide">
      <header className="panel__head">
        <h2 className="panel__title">
          계획 승인 <code className="cmdhead__id">{plan.plan_id}</code>
        </h2>
        <span className="badge badge--plan-pending">승인 대기</span>
      </header>

      <p className="notice notice--warn">
        <strong>아직 실행되지 않았다.</strong> 승인해야 구간이 하달된다. 승인 없이 자동 실행하면 사고가 났을 때
        책임소재가 성립하지 않는다.
      </p>

      <EvidenceList plan={plan} />

      <Explain id="plan-2" className="note note--dim">
        생성기 {plan.evidence.generator.name} {plan.evidence.generator.version} · 입력 맥락{' '}
        {plan.evidence.generator.context_version}
        {/* 대본 계획은 AI 산출이 아니다 — 키워드 대조다. 감추면 REQ-1207 위반이다 (260831). */}
        {plan.script !== undefined
          ? <span className="chip chip--backend">대본 조회 — LLM 아님 · 키워드 [{plan.script.matched_keywords.join(' · ')}]</span>
          : <span className="chip chip--ai">AI 산출</span>}
        {plan.command_id !== null && (
          <>
            <br />
            상관키 <code>{plan.command_id}</code> <span className="chip chip--backend">백엔드 발급 (BE-X-01)</span>
          </>
        )}
      </Explain>

      <div className="approvebar">
        <button type="button" className="btn btn--action btn--approve" onClick={() => { noteHumanAction(); armApproval(plan.plan_id); decidePlan(plan.plan_id, 'approve'); }}>
          승인 — 백엔드로 회신
        </button>
        <button type="button" className="btn btn--action" onClick={() => setRejectOpen((v) => !v)}>
          거부
        </button>

        {rejectOpen && (
          <div className="rejectbox">
            <input
              type="text"
              className="input"
              placeholder="거부 사유 (필수) — 다음 계획 생성에 반영된다"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className="btn"
              // 사유 없는 거부는 다음 계획 생성에 반영할 수 없으므로 막는다.
              // 거부도 **같은 백엔드 채널로** 돌아간다 — 승인만 백엔드를 거치면
              // "왜 실행이 안 됐나"의 절반이 어디에도 남지 않는다.
              disabled={reason.trim().length === 0}
              onClick={() => {
                decidePlan(plan.plan_id, 'reject', reason.trim());
                setRejectOpen(false);
                setReason('');
              }}
            >
              사유와 함께 거부
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * 결정이 끝난 계획 — **한 줄 영수증** (260901 2차 · 사용자 피드백).
 *
 * 승인/거부가 끝나면 이 화면에서 결정할 것이 없다. 여기는 마일스톤 화면이고 마일스톤이
 * 주인이므로, 무엇이 언제 어느 계획으로 결정됐는지만 한 줄로 남기고 자리를 비운다.
 * 근거와 산출 경로는 사라지지 않는다 — 「근거 ▾」로 그대로 펼친다.
 */
function DecidedReceipt({ plan, picker }: { plan: Plan; picker: ReactNode }) {
  const [open, setOpen] = useState(false);
  const approved = plan.decision === 'approved';

  return (
    <>
      <p className={'planreceipt planreceipt--' + plan.decision}>
        <span className={'badge badge--plan-' + plan.decision}>{approved ? '✓ 승인됨' : '✕ 거부됨'}</span>
        <span className="planreceipt__time">{timeOf(plan.decided_at)}</span>
        <code className="cmdhead__id">{plan.plan_id}</code>
        <span className="planreceipt__tag">VZ-U-07</span>
        {!approved && <span className="planreceipt__reason">사유 — {plan.reject_reason}</span>}
        {picker}
        <button type="button" className="btn btn--tiny planreceipt__toggle" onClick={() => setOpen((v) => !v)}>
          근거 {open ? '▴' : '▾'}
        </button>
      </p>

      {open && (
        <section className="panel panel--wide">
          <EvidenceList plan={plan} />
          {/* 실제 중계 단계와 시각 — 「어디서 끊겼나」를 되짚을 때 본다. 뜻풀이는 `?` 설명서에. */}
          <RouteStrip plan={plan} />
          <ProvenanceTrack steps={plan.evidence.provenance} />
        </section>
      )}
    </>
  );
}

/** 근거 네 층. 요구사항이 말한 순서 그대로 쌓는다. 승인 전 화면과 「근거 ▾」가 같이 쓴다. */
function EvidenceList({ plan }: { plan: Plan }) {
  const ev = plan.evidence;
  return (
      <ol className="evidence">
        <li className="evidence__step">
          <span className="evidence__no">1</span>
          <div>
            <h3 className="evidence__title">전역 임무</h3>
            <p className="evidence__body">{ev.mission.title}</p>
            <p className="evidence__meta">
              <code>{ev.mission.id}</code> · 하달 {ev.mission.requested_by} · {timeOf(ev.mission.created_at)}
            </p>
          </div>
        </li>

        <li className="evidence__step">
          <span className="evidence__no">2</span>
          <div>
            <h3 className="evidence__title">구역 분할 — 어느 구역을 어떤 순서로</h3>
            <div className="zonerow">
              {[...ev.zones]
                .sort((a, b) => a.order - b.order)
                .map((z) => (
                  <span key={z.zone} className="chip">
                    {z.order}. {z.zone} <em>구간 {z.segment_count}개</em>
                  </span>
                ))}
            </div>
          </div>
        </li>

        <li className="evidence__step">
          <span className="evidence__no">3</span>
          <div>
            {/* 한 줄로 줄였다 (260901) — 구간 목록은 아래 마일스톤 목록과 **같은 값**이라
                펼쳐 두면 한 화면에서 같은 것을 두 번 읽게 된다. */}
            <h3 className="evidence__title">구간별 계획</h3>
            <p className="evidence__body">{plan.segments.length}구간 — <strong>아래 마일스톤과 같음</strong></p>
          </div>
        </li>

        <li className="evidence__step">
          <span className="evidence__no">4</span>
          <div>
            <h3 className="evidence__title">검증 결과</h3>
            <ul className="vallist">
              {ev.validations.map((v, i) => (
                <li key={i} className={'vallist__item vallist__item--' + v.result}>
                  <span className="vallist__mark">{v.result === 'pass' ? '통과' : '주의'}</span>
                  <strong>{v.rule}</strong>
                  <span className="muted">{v.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </li>
      </ol>
  );
}

/**
 * BE-X-04 — 이 계획이 온 경로와 승인이 돌아가는 곳.
 *
 * 예전 화면은 승인을 AI 쪽과 직접 주고받는 모양이었다. 확정된 계약에서는 백엔드가 중계하고
 * **승인된 계획만** 엣지·로봇으로 발행한다.
 *
 * 260901 2차 — 이 줄은 **결정 뒤 「근거 ▾」 안에만** 있다. 「내 승인이 어디로 가는가」는
 * 이 계획의 사실이 아니라 시스템의 동작 방식이라 우상단 `?` 설명서가 맡는다.
 */
function RouteStrip({ plan }: { plan: Plan }) {
  // 중계 단계(relay_stage)는 **백엔드 내부 상태**다 (260901). 승인 화면에 늘 떠 있으면
  // 「지금 내가 무엇을 보고 있나」가 흐려진다 — 필요할 때만 목·개발 모드에서 본다.
  const devTools = useDevTools();
  return (
    <div className="route">
      <span className="route__hop route__hop--ai">{plan.route.generated_by}</span>
      <span className="route__arrow">→</span>
      <span className="route__hop route__hop--backend">{plan.route.delivered_by}</span>
      <span className="route__arrow">→</span>
      <span className="route__hop route__hop--screen">가시화 (이 화면)</span>
      <span className="route__arrow">→</span>
      <span className="route__hop route__hop--backend">{plan.route.decision_returns_to}</span>
      <span className="route__arrow">→</span>
      <span className="route__hop route__hop--device">{plan.route.dispatches_to}</span>
      {devTools && <span className={'route__stage route__stage--' + plan.relay_stage}>{RELAY_STAGE_LABEL[plan.relay_stage]}</span>}
    </div>
  );
}

/**
 * **어디까지가 AI 산출이고 어디부터가 백엔드 중계인가.**
 *
 * 근거를 한 덩어리로 보여주면, 나중에 승인이 안 먹었을 때 "AI가 계획을 못 만든 것"과
 * "백엔드 중계가 끊긴 것"을 구분할 수 없다. 두 구간을 색과 라벨로 갈라 두면
 * 어느 구간에서 끊겼는지 화면만 보고 좁힐 수 있다.
 */
function ProvenanceTrack({ steps }: { steps: ProvenanceStep[] }) {
  if (steps.length === 0) return null;
  const split = splitProvenance(steps);

  return (
    <section className="prov">
      <h3 className="prov__title">
        산출 경로 — AI 구간 {split.ai.length}단계 · 백엔드 중계 구간 {split.backend.length}단계
      </h3>
      <ol className="prov__list">
        {steps.map((s, i) => (
          <li key={i} className={'prov__row prov__row--' + s.produced_by}>
            <span className={'prov__who prov__who--' + s.produced_by}>{PRODUCED_BY_LABEL[s.produced_by]}</span>
            <div className="prov__body">
              <strong>{s.stage}</strong> <code className="prov__ref">{s.ref}</code>
              <div className="prov__detail">{s.detail}</div>
            </div>
            <time className="prov__time">{timeOf(s.at)}</time>
          </li>
        ))}
      </ol>
      {/* 뜻풀이(어디까지 AI이고 어디부터 백엔드인가·왜 갈라 두는가)는 우상단 `?` 설명서로
          옮겼다 (260901 2차). 여기 남는 것은 이 계획의 **실측 단계와 시각**이다. */}
    </section>
  );
}
