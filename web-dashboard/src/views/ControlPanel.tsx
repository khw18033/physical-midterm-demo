/**
 * src/views/ControlPanel.tsx
 *
 * VZ-O-01 · VZ-O-02 · VZ-O-05 · VZ-C-04 · VZ-I-05 — 제어 패널.
 *
 * 목업의 세 칸을 그대로 옮긴다 — 제어 / 명령 진행 / 마지막 조작자.
 *
 * 화면이 하지 않는 것.
 *  - 만료 판정 — 서버가 서버 시각으로 한다. 화면은 만료 시각을 붙여 보내기만 한다.
 *  - 확정 판정 — 백엔드가 승격한 `completed`를 따른다. 액션별 규칙을 프런트가 떠안지 않는다.
 *  - 잠금 강제 — 화면 차단은 사용자 편의이고 실제 차단은 서버가 한다. 둘 다 있어야 한다.
 *  - **키 관리** — 요청 식별자와 상관 키를 화면이 다루지 않는다. 데이터 레이어가 주는
 *    "이 요청의 현재 상태" 하나만 그린다. 아래 코드에 상관 키 **값**을 읽거나 조립하는
 *    곳이 없는 것이 그 증거다 — 표시할 키는 `tracking.value`로 이미 만들어져 오고,
 *    감사 조회 키도 데이터 레이어가 꺼낸다.
 *    (`'command_id'` 문자열이 아래에 두 번 나오지만 그건 키 값이 아니라 **서버가 무엇으로
 *    조회했는지 알려 주는 종류 태그**다. 키를 다루는 것과는 다른 일이다.)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  COMMAND_DISPLAY_LABEL,
  COMMAND_TTL_MS,
  commandTracker,
  describeScope,
  fetchActions,
  fetchAuditTrail,
  playScenario,
  store,
  type AuditQueryResult,
  type ControlGate,
  type TrackedCommand,
} from '../data/index.ts';
import { useCommands, useControlGate, useEntities, useRole, useRoleRefresh } from '../data/hooks.ts';
import type { ActionSpec } from '../transport/index.ts';

/** 제어 대상 후보. 둘째는 **다른 구역**에 있어 권한 범위 검증에 쓰인다(VZ-C-04). */
const TARGETS = ['actuator-01', 'actuator-02'] as const;

/** ACK 없이 만료되는 것을 보려면 30초를 기다릴 수 없으므로 짧은 TTL을 쓴다. */
const SHORT_TTL_MS = 6_000;

const STAGE_LABEL: Record<string, string> = {
  issued: '발행 — 요청 식별자로 화면 상태를 걸었다',
  linked: '수신 확인 — 상관 키 매핑',
  ack: '수신 확인 — 디바이스 ACK',
  executing: '수행 중',
  physical_state_changed: '물리 상태 변화',
  settled: '완료 / 실패 확정',
  expired: '만료 — 상관 키 미도착',
};

function timeOf(iso: string): string {
  // 서버가 보낸 시각을 표시만 한다. 이 값으로 판정하지 않는다.
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(Math.floor(d.getMilliseconds() / 100))
  );
}

export function ControlPanel() {
  const entities = useEntities();
  const commands = useCommands();
  const role = useRole();
  const refreshRole = useRoleRefresh();

  const [target, setTarget] = useState<string>(TARGETS[0]);
  const [actions, setActions] = useState<ActionSpec[]>([]);
  /** 만료 검증용 — 이미 만료된 명령을 일부러 보내 본다. */
  const [forceExpired, setForceExpired] = useState(false);
  /** ACK 미도착 검증용 — 목 서버가 ACK를 보내지 않게 하고 짧은 TTL로 발행한다. */
  const [dropAck, setDropAck] = useState(false);

  const record = entities.get(target) ?? null;
  const gate = useControlGate(target);
  const latest = commands.find((c) => c.entity === target) ?? null;

  useEffect(() => {
    void fetchActions(target).then(setActions);
  }, [target]);

  /**
   * 발행 직후 버튼을 잠그는 근거는 **추적기의 상태**다.
   * `await`가 끝나기를 기다리는 로컬 플래그로 잠그면 ACK가 늦을 때 버튼이 먼저 풀린다 —
   * 이번 계약에서는 ACK가 늦게 올 수 있으므로 그 방식이 실제로 깨진다.
   */
  const inFlight = latest !== null && latest.display === 'in_progress' && !latest.settled;

  const issue = useCallback(
    async (spec: ActionSpec, options: { bypassUiLock?: boolean } = {}) => {
      if (dropAck) {
        // 목 서버가 다음 1건의 ACK를 보내지 않게 한다. 실제 게이트웨이에는 없는 경로다.
        playScenario('ack-drop');
      }
      await commandTracker.issue(target, spec, {
        // 만료 검증 모드에서는 **이미 지난** 만료 시각을 붙여 보낸다.
        // 서버가 실제로 거부하는지 확인하기 위한 것으로, 판정은 여전히 서버가 한다.
        ttlMs: forceExpired ? -5_000 : dropAck ? SHORT_TTL_MS : COMMAND_TTL_MS,
        inputMode: options.bypassUiLock === true ? 'api' : 'click',
      });
    },
    [target, forceExpired, dropAck],
  );

  return (
    <main className="board">
      <header className="board__head">
        <div>
          <h1 className="board__title">제어 패널 — 두 키의 수명 구간과 책임소재</h1>
          <p className="board__sub">
            가시화는 <strong>요청 식별자</strong>만 붙여 보내고, 상관 키는 백엔드가 발급해 ACK로 내려준다.
            화면은 ACK 전후 두 구간으로 나뉘어 동작한다
          </p>
        </div>
        <div className="board__meta">
          <span>VZ-O-01 · VZ-O-02 · VZ-O-05 · VZ-C-04 · VZ-I-05</span>
        </div>
      </header>

      <section className="targetbar">
        <span className="targetbar__label">제어 대상</span>
        {TARGETS.map((id) => (
          <button
            key={id}
            type="button"
            className={'btn btn--small' + (target === id ? ' btn--on' : '')}
            onClick={() => setTarget(id)}
          >
            {store.getRegistry()?.entities.find((e) => e.id === id)?.display_name ?? id}
          </button>
        ))}
        <span className="targetbar__role">
          역할 <strong>{role?.display_name ?? '조회 중'}</strong> · {describeScope(role)}
          <button type="button" className="btn btn--tiny" onClick={refreshRole}>
            역할 다시 조회 <em>(토큰 갱신 상황)</em>
          </button>
        </span>
      </section>

      <div className="cols cols--3">
        {/* ── 1. 제어 (VZ-O-01 / VZ-O-05 / VZ-C-04) ─────────────────────── */}
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">{record?.registry?.display_name ?? target} · 수문 제어</h2>
            <span className="panel__tag">VZ-O-01</span>
          </header>

          <ControlGateBar gate={gate} />

          <div className="btnrow">
            {actions.map((spec) => (
              <button
                key={spec.action}
                type="button"
                className={'btn btn--action' + (spec.action.startsWith('open') ? ' btn--danger' : '')}
                // 잠금 사유가 하나라도 있으면 잠근다. 진행 중에도 잠근다 —
                // **ACK를 기다리지 않고** 발행 직후부터 잠기는 것이 요구사항이다.
                disabled={gate.locked || inFlight}
                onClick={() => void issue(spec)}
              >
                {spec.label}
              </button>
            ))}
            {actions.length === 0 && <p className="muted">액션 카탈로그를 받지 못했다.</p>}
          </div>

          {inFlight && (
            <p className="notice notice--busy">
              <span className="spinner" aria-hidden="true" />
              발행됨 — {latest?.tracking.linked === true ? '상관 키로 결과를 잇는 중' : '수신 확인(ACK) 대기 중'}
            </p>
          )}

          <dl className="kv">
            <dt>현재 상태</dt>
            <dd>
              <strong>{describePosition(record?.actuator?.payload?.position_pct ?? null)}</strong>
            </dd>
            <dt>발행 형태</dt>
            <dd>
              <code>action={actions[0]?.action ?? '—'}</code>
            </dd>
            <dt>동봉 필드</dt>
            <dd className="muted">
              <code>client_request_id</code> / <code>expires_at</code> / 감사 필드
              <br />
              <em>상관 키는 동봉하지 않는다 — 백엔드가 발급한다 (BE-X-01)</em>
            </dd>
          </dl>

          <p className="note">
            가시화는 <strong>추상 action까지만</strong> 발행한다. 디바이스 명령(<code>levee:open</code>)으로의 번역은
            백엔드가 어휘집으로 수행한다.
            {actions.some((a) => a.irreversible) && (
              <>
                {' '}
                이 액션들은 <strong>되돌리기 어려움</strong>으로 선언되어 ACK가 아니라 수행 결과로 확정한다.
              </>
            )}
          </p>

          <div className="devpanel devpanel--inline">
            <h3 className="devpanel__title">계약 검증</h3>

            <label className="check">
              <input type="checkbox" checked={forceExpired} onChange={(e) => setForceExpired(e.target.checked)} />
              만료된 명령 보내보기 <em>(expires_at을 과거로 — 서버가 거부하는지 확인)</em>
            </label>

            <label className="check">
              <input type="checkbox" checked={dropAck} onChange={(e) => setDropAck(e.target.checked)} />
              ACK 없이 만료시키기 <em>(목 서버가 ACK 미발신 · TTL {SHORT_TTL_MS / 1000}초)</em>
            </label>

            <div className="devpanel__row">
              <button type="button" className="btn btn--small" onClick={() => playScenario('ack-late')}>
                ACK를 진행 이벤트보다 늦게
              </button>
              <button type="button" className="btn btn--small" onClick={() => playScenario('command-fail')}>
                다음 명령 실패시키기
              </button>
              <button type="button" className="btn btn--small" onClick={() => playScenario('control-lock')}>
                통신 두절 → 잠금
              </button>
              <button type="button" className="btn btn--small" onClick={() => playScenario('control-unlock')}>
                복구 → 재확인 후 해제
              </button>
            </div>

            {/*
              전송 아키텍처 문서 대조 결과 — Kafka 지연 10~50ms에 브릿지 전환이 한 겹 더 붙고
              왕복이니 두 번 겪는다. 즉시 ACK를 전제로 정한 expires_at 기본값과 만료 임계가
              실제 경로에서 견디는지, 실물 백엔드에 붙기 전에 여기서 확인한다.
            */}
            <div className="devpanel__row">
              <button
                type="button"
                className="btn btn--small btn--probe"
                onClick={() => playScenario('command-roundtrip-slow')}
              >
                왕복 지연 주입 (한 방향 60ms)
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => playScenario('command-roundtrip-zero')}
              >
                왕복 지연 해제
              </button>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => playScenario('cache-policy-audit')}
              >
                캐시 정책 대조 (BE-T-06)
              </button>
            </div>

            <div className="devpanel__row">
              <button type="button" className="btn btn--small" onClick={() => { playScenario('role-narrow'); }}>
                역할을 503 담당으로 좁히기
              </button>
              <button type="button" className="btn btn--small" onClick={() => { playScenario('role-full'); }}>
                역할을 전 범위로
              </button>
              <button
                type="button"
                className="btn btn--small btn--probe"
                // **화면 잠금을 우회한다.** 화면 차단이 방어선이 아니라는 것을 보이기 위한 경로로,
                // 서버가 out_of_scope로 거부해야 정상이다.
                disabled={actions.length === 0}
                onClick={() => actions[0] && void issue(actions[0], { bypassUiLock: true })}
              >
                화면 잠금 우회해 발행 <em>(서버가 거부하는지 확인)</em>
              </button>
            </div>
            <p className="note note--dim">
              역할은 로그인·토큰 갱신 시점에만 조회된다. 범위를 바꾼 뒤에는 위의 <strong>역할 다시 조회</strong>를
              눌러야 화면에 반영된다 — 주기 조회가 없는 것이 요구사항이기 때문이다.
            </p>
          </div>
        </section>

        {/* ── 2. 명령 진행 (VZ-O-02) ────────────────────────────────────── */}
        <section className="panel">
          <header className="panel__head">
            <h2 className="panel__title">명령 진행 — 발행에서 확정까지</h2>
            <span className="panel__tag">VZ-O-02</span>
          </header>

          {latest === null ? (
            <p className="muted">아직 발행한 명령이 없다. 왼쪽에서 명령을 눌러 보라.</p>
          ) : (
            <CommandTimeline command={latest} />
          )}

          <p className="note">
            프론트는 <strong>진행중 · 확정 · 실패</strong> 3상태만 그린다. ACK를 확정으로 취급하면 화면과 현실이
            어긋난다.
          </p>
        </section>

        {/* ── 3. 마지막 조작자 (VZ-I-05) ───────────────────────────────── */}
        <LastOperatorPanel entity={target} command={latest} refreshKey={latest?.stages.length ?? 0} />
      </div>

      <p className="footnote">
        감사 조회는 <strong>패널 열람 시점에만</strong> 질의하고, 조회 키는 <strong>상관 키</strong>다 —
        요청부터 감사까지 사슬을 잇는 것이 그 키이기 때문이다(BE-X-01). 진행 중 명령의 상태 변화는 결과 푸시로
        이미 도달하므로 주기 폴링은 중복이다.
      </p>
    </main>
  );
}

function describePosition(pct: number | null): string {
  if (pct === null) return '—';
  if (pct === 100) return 'open';
  if (pct === 0) return 'closed';
  return '개도 ' + pct + '%';
}

/**
 * VZ-O-05 + VZ-C-04 — 잠금 사유들.
 * **사유가 둘 이상일 수 있다** — 통신 두절과 권한 범위 밖은 동시에 성립한다.
 * 판정은 데이터 레이어가 끝냈고 여기서는 늘어놓기만 한다.
 */
function ControlGateBar({ gate }: { gate: ControlGate }) {
  if (!gate.locked) return null;
  return (
    <div className="lockbar">
      <strong>제어 잠금</strong>
      {gate.reasons.map((r) => (
        <span key={r.kind} className={'lockbar__reason lockbar__reason--' + r.kind}>
          <span className="lockbar__badge">{r.label}</span>
          {r.text}
          {r.meta !== null && <span className="lockbar__meta">{r.meta}</span>}
        </span>
      ))}
    </div>
  );
}

/**
 * 네 단계 이력. store는 마지막 값만 갖지만 추적기가 단계를 모두 들고 있다.
 *
 * 화면은 추적 키를 **한 개**만 본다 — 지금 무엇으로 추적 중인지는 데이터 레이어가
 * 라벨과 값으로 만들어 넘겨 준다.
 */
function CommandTimeline({ command }: { command: TrackedCommand }) {
  return (
    <>
      <div className="cmdhead">
        <span className={'badge badge--cmd-' + command.display}>{COMMAND_DISPLAY_LABEL[command.display]}</span>
        <span className={'trackkey' + (command.tracking.linked ? ' trackkey--linked' : '')}>
          <em>{command.tracking.label}</em>
          <code className="cmdhead__id">{command.tracking.value}</code>
        </span>
        {command.progressPct !== null && command.display === 'in_progress' && (
          <span className="progress">
            <span className="progress__bar" style={{ width: command.progressPct + '%' }} />
            <span className="progress__pct">{command.progressPct}%</span>
          </span>
        )}
      </div>

      {command.absorbedCount > 0 && (
        <p className="notice notice--absorbed">
          매핑보다 먼저 도착한 이벤트 <strong>{command.absorbedCount}건</strong>을 보류했다가 흡수했다.
          순서를 신뢰했다면 이 이벤트들은 사라졌을 것이다.
        </p>
      )}

      <ol className="timeline">
        {command.stages.map((s, i) => (
          <li
            key={i}
            className={
              'timeline__row timeline__row--' + s.status +
              (s.absorbed === true ? ' timeline__row--absorbed' : '')
            }
          >
            <span className="timeline__dot" />
            <div>
              <strong>{STAGE_LABEL[s.stage] ?? s.stage}</strong>
              {s.absorbed === true && <span className="chip chip--absorbed">보류 후 흡수</span>}
              <div className="timeline__sub">
                {s.detail}
                {s.progressPct !== null && ' · ' + s.progressPct + '%'}
                {s.reasonCode !== null && ' · 사유코드 ' + s.reasonCode}
              </div>
            </div>
            <time className="timeline__time">{timeOf(s.ts)}</time>
          </li>
        ))}
      </ol>

      <p className="note note--dim">
        만료 <code>{timeOf(command.expiresAt)}</code> · 만료 검사는 서버가 서버 시각으로 한다
      </p>

      {command.display === 'failed' && (
        <div className="failbox">
          <strong>실패</strong> — {command.lastDetail}
          {command.restored && <div className="failbox__sub">이전 상태로 복원됨. 화면과 현실이 어긋나지 않는다.</div>}
        </div>
      )}
    </>
  );
}

/**
 * VZ-I-05 — 마지막 조작자.
 *
 * **열 때만 조회한다.** 아래 useEffect에 인터벌이 없는 것이 요구사항 그 자체다.
 * 조회 키는 **상관 키**이며, 그 키를 꺼내는 일은 데이터 레이어가 한다 —
 * 이 컴포넌트는 "이 요청"을 넘길 뿐 키를 만지지 않는다.
 * 감사 필드 이름도 여기 없다 — auditFieldMap이 만든 표시행만 늘어놓는다.
 */
function LastOperatorPanel({
  entity,
  command,
  refreshKey,
}: {
  entity: string;
  command: TrackedCommand | null;
  refreshKey: number;
}) {
  const [result, setResult] = useState<AuditQueryResult | null>(null);
  const [open, setOpen] = useState(true);

  // 요청 객체 자체가 아니라 식별자에만 반응해야 매 단계마다 조회가 나가지 않는다.
  const requestId = command?.requestId ?? null;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetchAuditTrail({ command, entity }, 5).then((r) => {
      if (alive) setResult(r);
    });
    return () => {
      alive = false;
    };
    // refreshKey — 명령 단계가 늘면 한 번 더 읽는다. 주기가 아니라 **이벤트**다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, requestId, open, refreshKey]);

  const entries = result?.entries ?? [];
  const last = entries[0] ?? null;
  const error = result?.error ?? null;

  const queryLabel = useMemo(() => {
    if (result === null) return null;
    if (result.queriedBy === 'command_id') return '상관 키로 조회 — ' + result.queriedKey;
    if (result.queriedBy === 'entity') return '대상으로 조회 (상관 키 없음) — ' + result.queriedKey;
    return null;
  }, [result]);

  return (
    <section className="panel">
      <header className="panel__head">
        <h2 className="panel__title">마지막 조작자</h2>
        <span className="panel__tag">VZ-I-05</span>
      </header>

      <button type="button" className="btn btn--small" onClick={() => setOpen((v) => !v)}>
        {open ? '패널 닫기' : '패널 열기 (열 때 1회 조회)'}
      </button>

      {!open && <p className="muted">닫힌 동안에는 조회하지 않는다.</p>}

      {open && queryLabel !== null && (
        <p className={'querykey' + (result?.queriedBy === 'command_id' ? ' querykey--chain' : '')}>{queryLabel}</p>
      )}

      {open && error !== null && <p className="notice notice--warn">{error}</p>}

      {open && last === null && error === null && (
        <p className="muted">조작 이력이 없다. 명령을 한 번 발행하면 기록이 생긴다.</p>
      )}

      {open && last !== null && (
        <>
          <div className="actor">
            <strong className="actor__name">{last.actorName ?? '미기록'}</strong>
            {last.actorRole !== null && <span className="chip">{last.actorRole}</span>}
          </div>

          <dl className="kv">
            <dt>시각</dt>
            <dd>
              <strong>{last.occurredAt === null ? '—' : timeOf(last.occurredAt)}</strong>
            </dd>
            {last.rows.map((row, i) => (
              <FragmentRow key={i} label={row.label} value={row.value} muted={row.muted} />
            ))}
          </dl>

          <p className="note note--dim">
            상관 키 · {last.commandId ?? '—'}
            <br />
            기록 작성 — {last.writtenBy ?? '—'}
            <br />
            조작자·시각은 토큰·서버 시각에서 주입
          </p>

          {result?.serverQueryCount != null && (
            <p className="note note--dim">
              서버 누적 감사 조회 {result.serverQueryCount}회 (주기 폴링이 없으면 늘지 않는다)
            </p>
          )}
        </>
      )}
    </section>
  );
}

function FragmentRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={muted === true ? 'muted' : undefined}>{value}</dd>
    </>
  );
}
