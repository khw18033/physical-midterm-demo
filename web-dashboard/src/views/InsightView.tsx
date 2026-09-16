/** Phase 2 — 위험도·AI 실패·추상화 계층을 같은 데이터에서 보여 주는 화면. */

import { useMemo, useState } from 'react';
import { GATEWAY, type AiFailure, type RiskState } from '../transport/index.ts';
import { deriveDisplayStatus, DISPLAY_STATUS_LABEL, store } from '../data/index.ts';
import { useEntities } from '../data/hooks.ts';

type Level = 'decision' | 'operation' | 'development';
const LEVELS: Array<{ id: Level; label: string; note: string }> = [
  { id: 'decision', label: '결심자', note: '판단과 권고만' },
  { id: 'operation', label: '운영자', note: '대상과 원인' },
  { id: 'development', label: '개발자', note: '원본 봉투·계약' },
];
const RISK_LABEL: Record<RiskState['level'], string> = { normal: '평시', watch: '관찰', alert: '경보', recovery: '복구' };

export function InsightView() {
  const entities = useEntities();
  const [level, setLevel] = useState<Level>('decision');
  const riskSlot = [...entities.values()].map((r) => r.riskState).find(Boolean) ?? null;
  const failures = [...entities.values()].flatMap((r) => r.aiFailure ? [{ entity: r.id, slot: r.aiFailure }] : []);
  const risk = riskSlot?.payload as RiskState | undefined;
  const records = useMemo(() => [...entities.values()].filter((r) => r.registry?.zone === 'zone-503'), [entities]);

  const trigger = (name: string) => void fetch(GATEWAY.http + '/insight/' + name, { method: 'POST' });

  return (
    <main className="board insight">
      <header className="board__head">
        <div><h1 className="board__title">상황 판단 · 설명가능성</h1><p className="board__sub">같은 구독을 유지한 채 역할에 맞춰 표시 깊이만 바꾼다</p></div>
        <div className="levelbar">{LEVELS.map((v) => <button key={v.id} type="button" className={'btn' + (level === v.id ? ' btn--on' : '')} onClick={() => setLevel(v.id)}>{v.label}<em>{v.note}</em></button>)}</div>
      </header>

      {risk ? <section className={'riskcard riskcard--' + risk.level}>
        <div><span className="riskcard__label">{RISK_LABEL[risk.level]}</span><strong>{risk.score}</strong><small>/ 100</small></div>
        <p>{risk.recommendation}</p>
        {level !== 'decision' && <ul>{risk.reasons.map((r) => <li key={r.label}><b>{r.label}</b> {r.value} <span>기여도 {Math.round(r.contribution * 100)}%</span></li>)}</ul>}
        {level === 'development' && <pre>{JSON.stringify(riskSlot, null, 2)}</pre>}
      </section> : <p className="notice">위험도 판정 수신 대기</p>}

      {level !== 'decision' && <section className="layergrid">
        {records.map((r) => {
          const status = deriveDisplayStatus(r.state?.payload ?? null);
          return <article className="layercard" key={r.id}><b>{r.registry?.display_name ?? r.id}</b><span className={'badge badge--' + status}>{DISPLAY_STATUS_LABEL[status]}</span>{level === 'development' && <pre>{JSON.stringify({ state: r.state, telemetry: r.telemetry }, null, 2)}</pre>}</article>;
        })}
      </section>}

      <section className="failurebox">
        <h2>AI 실패 이벤트 <small>지표 폴링이 아니라 도착 즉시 표시</small></h2>
        {failures.length === 0 ? <p className="notice">수신된 실패 없음</p> : failures.map(({ entity, slot }) => {
          const f = slot.payload as AiFailure;
          return <article className="failure" key={f.event_id}><b>{f.error_code}</b><span>{f.component} · {f.model_version}</span><p>{f.detail}</p><small>{entity} · 입력 {f.input_ref} · {new Date(f.occurred_at).toLocaleString()}</small>{level === 'development' && <pre>{JSON.stringify(slot, null, 2)}</pre>}</article>;
        })}
      </section>

      <section className="devpanel"><h2 className="devpanel__title">전이 재생</h2><div className="devpanel__row">
        {(['normal', 'watch', 'alert', 'recovery'] as const).map((v) => <button className="btn" type="button" key={v} onClick={() => trigger('risk-' + v)}>위험도 {RISK_LABEL[v]}</button>)}
        <button className="btn" type="button" onClick={() => trigger('ai-failure')}>AI 실패 1건</button>
      </div><p className="note note--dim">현재 구독 대상 {store.getSnapshot().size}개. 계층을 바꿔도 재구독하지 않고 같은 원본의 표시 깊이만 바꾼다(VZ-U-03).</p></section>
    </main>
  );
}
