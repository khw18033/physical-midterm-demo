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
 * 진행 노드는 목업(VZ-U-05_서브태스크_진행노드) 그대로다.
 */

import { useState } from 'react';
import {
  PRODUCED_BY_LABEL,
  RELAY_STAGE_LABEL,
  SEGMENT_STATUS_LABEL,
  decidePlan,
  planProgressSummary,
  playScenario,
  splitProvenance,
  type Plan,
  type PlanSegment,
  type ProvenanceStep,
} from '../data/index.ts';
import { useEntities } from '../data/hooks.ts';
import type { EntityRecord } from '../data/store.ts';

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

export function MissionView() {
  const entities = useEntities();
  const targets = planTargets(entities);
  const [picked, setPicked] = useState<string | null>(null);
  const target = picked !== null && targets.includes(picked) ? picked : (targets[0] ?? null);
  const record = target === null ? null : (entities.get(target) ?? null);

  const plan = (record?.plan?.payload as Plan | undefined) ?? null;
  // 진행은 별도 채널로 온다. 계획 본문과 갱신 시점이 다르기 때문이다.
  const progress = record?.planProgress?.payload ?? null;
  const segments: PlanSegment[] =
    progress?.plan_id === plan?.plan_id && progress !== null ? progress.segments : (plan?.segments ?? []);

  return (
    <main className="board">
      <header className="board__head">
        <div>
          <h1 className="board__title">임무 승인 · 서브태스크 진행</h1>
          <p className="board__sub">
            검증을 통과해도 <strong>사람이 승인해야 실행된다</strong>. 승인 전에는 구간이 하나도 진행되지 않는다
          </p>
        </div>
        <div className="board__meta">
          {targets.length > 1 && (
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
          )}
          <span>VZ-U-07 · VZ-U-05</span>
        </div>
      </header>

      {plan === null ? (
        <p className="notice">
          승인 대기 중인 계획이 없다. 아래에서 계획을 하나 내려받아 보라.
        </p>
      ) : (
        <>
          <ApprovalPanel plan={plan} />
          <SegmentTrack plan={plan} segments={segments} />
        </>
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
    </main>
  );
}

/** VZ-U-07 — 근거를 펼쳐 보이고 승인/거부를 받는다. */
function ApprovalPanel({ plan }: { plan: Plan }) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');

  const pending = plan.decision === 'pending';
  const ev = plan.evidence;

  return (
    <section className="panel panel--wide">
      <header className="panel__head">
        <h2 className="panel__title">
          계획 승인 <code className="cmdhead__id">{plan.plan_id}</code>
        </h2>
        <span className={'badge badge--plan-' + plan.decision}>
          {plan.decision === 'pending' ? '승인 대기' : plan.decision === 'approved' ? '승인됨' : '거부됨'}
        </span>
      </header>

      <RouteStrip plan={plan} />

      {pending && (
        <p className="notice notice--warn">
          <strong>아직 실행되지 않았다.</strong> 승인해야 구간이 하달된다. 승인 없이 자동 실행하면 사고가 났을 때
          책임소재가 성립하지 않는다.
        </p>
      )}

      {plan.decision === 'rejected' && (
        <p className="notice notice--warn">
          거부됨 — {plan.reject_reason} <span className="muted">({timeOf(plan.decided_at)})</span>
        </p>
      )}

      {/* 근거 네 층. 요구사항이 말한 순서 그대로 쌓는다. */}
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
            <h3 className="evidence__title">구간별 계획 — {plan.segments.length}구간</h3>
            <ol className="seglist">
              {plan.segments.map((s) => (
                <li key={s.index}>
                  <code>{s.index}/{s.total}</code> {s.title} <span className="muted">· {s.zone}</span>
                </li>
              ))}
            </ol>
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

      <ProvenanceTrack steps={ev.provenance} />

      <p className="note note--dim">
        생성기 {ev.generator.name} {ev.generator.version} · 입력 맥락 {ev.generator.context_version}
        <span className="chip chip--ai">AI 산출</span>
        {plan.command_id !== null && (
          <>
            <br />
            상관키 <code>{plan.command_id}</code> <span className="chip chip--backend">백엔드 발급 (BE-X-01)</span>
          </>
        )}
      </p>

      {pending && (
        <div className="approvebar">
          <button type="button" className="btn btn--action btn--approve" onClick={() => decidePlan(plan.plan_id, 'approve')}>
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
      )}
    </section>
  );
}

/**
 * BE-X-04 — 이 계획이 온 경로와 승인이 돌아가는 곳.
 *
 * 예전 화면은 승인을 AI 쪽과 직접 주고받는 모양이었다. 확정된 계약에서는 백엔드가 중계하고
 * **승인된 계획만** 엣지·로봇으로 발행하므로, 그 경로가 화면 위쪽에 한 줄로 보여야
 * "내 승인이 어디로 가는가"를 사용자가 안다.
 */
function RouteStrip({ plan }: { plan: Plan }) {
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
      <span className={'route__stage route__stage--' + plan.relay_stage}>{RELAY_STAGE_LABEL[plan.relay_stage]}</span>
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
      <p className="note note--dim">
        AI는 계획 <strong>생성</strong>과 <strong>검증</strong>까지다. 가시화 전달·승인 수신·엣지 발행은 백엔드
        중계 구간이며, 승인·거부 모두 이 경로로 돌아간다.
      </p>
    </section>
  );
}

/** VZ-U-05 — 구간 노드. 목업 그대로. */
function SegmentTrack({ plan, segments }: { plan: Plan; segments: PlanSegment[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const summary = planProgressSummary(segments);
  const started = plan.decision === 'approved';

  return (
    <section className="panel panel--wide">
      <header className="panel__head">
        <h2 className="panel__title">
          {plan.entity} · {plan.plan_id}{' '}
          {plan.command_id !== null && <code className="cmdhead__id">command_id {plan.command_id}</code>}
        </h2>
        <span className="panel__tag">
          {started ? summary.done + '/' + summary.total + ' 완료' : '미시작'} · VZ-U-05
        </span>
      </header>

      {!started && (
        <p className="muted">
          승인 전이라 진행 이벤트가 하나도 오지 않았다. 구간은 전부 대기 상태다.
        </p>
      )}

      <div className="track">
        {segments.map((s, i) => (
          <div key={s.index} className="track__cell">
            <button
              type="button"
              className={'segnode segnode--' + s.status + (s.failure !== null ? ' segnode--clickable' : '')}
              onClick={() => s.failure !== null && setOpenIndex(openIndex === s.index ? null : s.index)}
            >
              <span className="segnode__mark">
                {s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : s.status === 'running' ? '…' : '·'}
              </span>
              <strong className="segnode__title">
                구간 {s.index}/{s.total}
                {s.status === 'failed' && ' 실패'}
              </strong>
              <span className="segnode__sub">{s.title}</span>
              <span className="segnode__meta">
                {s.status === 'done' && s.elapsed_s !== null
                  ? s.elapsed_s + ' s'
                  : s.status === 'failed'
                    ? 'rejected · ' + timeOf(s.failure?.failed_at ?? null)
                    : SEGMENT_STATUS_LABEL[s.status]}
              </span>
              <span className="segnode__zone">{s.zone}</span>
            </button>
            {i < segments.length - 1 && <span className="track__arrow">→</span>}
          </div>
        ))}
      </div>

      {segments.map(
        (s) =>
          s.failure !== null &&
          openIndex === s.index && (
            <div key={'d' + s.index} className="faildetail">
              <h3 className="faildetail__title">
                구간 {s.index}/{s.total} 상세 — 실패 지점
              </h3>
              <p className="faildetail__line">
                하달 {timeOf(s.failure.dispatched_at)} → ACK {timeOf(s.failure.acked_at)} →{' '}
                <strong>실패 {timeOf(s.failure.failed_at)}</strong>
              </p>
              <p className="faildetail__line">
                멈춘 단계 — <strong>{s.failure.failed_stage}</strong>
              </p>
              <p className="faildetail__line">사유 — {s.failure.reason}</p>
              <p className="faildetail__line muted">{s.failure.judged_by}</p>
            </div>
          ),
      )}

      {segments.some((s) => s.status === 'failed') && (
        <p className="note">
          실패 뒤 구간은 <strong>하달 자체가 되지 않아</strong> '건너뜀'으로 표시된다. '대기'와 구분해야
          "왜 뒤 구간이 안 돌았나"가 화면에서 설명된다.
        </p>
      )}

      {segments.some((s) => s.failure !== null) && openIndex === null && (
        <p className="muted">실패 노드를 누르면 어느 단계에서 왜인지 펼쳐진다.</p>
      )}
    </section>
  );
}
