// 이식: web-dashboard/src/views/InsightView.tsx @ 700ed91 — 해체해서 탭②로
//
// 구 「판단·알림」 탭은 화면 하나로 남기지 않고 **해체했다.**
//   위험도 판단 근거 (VZ-I-08)  → 여기. 탭② 구역 현황판 위쪽
//   표시 깊이 3단 (VZ-U-03)     → 여기. 같은 구독을 유지한 채 깊이만 바꾼다
//   AI 실패 이벤트 (VZ-I-10)    → 상단 공통 알림. tabs/aiFailureBridge.ts 가 잇는다
//   자체 관측 (VZ-O-04)         → 공유 계층. startDataLayer() 가 기동한다
//
// 탭 하나를 통째로 옮기지 않은 이유: 위험도는 "그 구역이 지금 어떤가"이고, 그 질문에
// 답하는 화면은 이미 탭②다. 같은 질문에 답하는 화면이 둘이면 사용자가 어느 쪽을 봐야
// 하는지 알 수 없게 된다 — 탭⑥에서 임무 관제 모드를 지운 것과 같은 이유다.

import { useState } from 'react';
import { GATEWAY, type RiskState } from '../../transport/index.ts';
import { deriveDisplayStatus, DISPLAY_STATUS_LABEL, store } from '../data/index.ts';
import { useEntities } from '../data/hooks.ts';
import { PendingSource } from '../../shared/PendingSource.tsx';
import { CURRENT_ZONE_ID } from '../../shared/registry.ts';
import { Explain } from '../../shared/Explain.tsx';

type Level = 'decision' | 'operation' | 'development';

const LEVELS: Array<{ id: Level; label: string; note: string }> = [
  { id: 'decision', label: '결심자', note: '판단과 권고만' },
  { id: 'operation', label: '운영자', note: '대상과 원인' },
  { id: 'development', label: '개발자', note: '원본 봉투·계약' },
];

const RISK_LABEL: Record<RiskState['level'], string> = { normal: '평시', watch: '관찰', alert: '경보', recovery: '복구' };

export function RiskPanel() {
  const entities = useEntities();
  const [level, setLevel] = useState<Level>('decision');
  const riskSlot = [...entities.values()].map((r) => r.riskState).find(Boolean) ?? null;
  const risk = riskSlot?.payload as RiskState | undefined;
  const records = [...entities.values()].filter((r) => r.registry?.zone === CURRENT_ZONE_ID);

  const trigger = (name: string) => void fetch(GATEWAY.http + '/insight/' + name, { method: 'POST' });

  return (
    <section className="board insight insight--embedded">
      <header className="board__head">
        <div>
          <h2 className="board__title">상황 판단 · 설명가능성</h2>
          <Explain id="risk-1" className="board__sub">같은 구독을 유지한 채 역할에 맞춰 <strong>표시 깊이만</strong> 바꾼다 (VZ-U-03)</Explain>
        </div>
        <div className="levelbar">
          {LEVELS.map((v) => (
            <button key={v.id} type="button" className={'btn' + (level === v.id ? ' btn--on' : '')} onClick={() => setLevel(v.id)}>
              {v.label}<em>{v.note}</em>
            </button>
          ))}
        </div>
      </header>

      {/* 위험도는 어느 대본도 몰지 않는다 — AI 파트(VZ-I-08)의 몫. 시나리오 모드에서는
          「연결 예정」이 아니라 「이 대본에는 해당 없음」으로 갈린다 (260831 요구 2). */}
      <PendingSource id="risk-state" minHeight={132} axis="risk">
        {risk ? (
          <div className={'riskcard riskcard--' + risk.level}>
            <div><span className="riskcard__label">{RISK_LABEL[risk.level]}</span><strong>{risk.score}</strong><small>/ 100</small></div>
            <p>{risk.recommendation}</p>
            {level !== 'decision' && <ul>{risk.reasons.map((r) => <li key={r.label}><b>{r.label}</b> {r.value} <span>기여도 {Math.round(r.contribution * 100)}%</span></li>)}</ul>}
            {level === 'development' && <pre>{JSON.stringify(riskSlot, null, 2)}</pre>}
          </div>
        ) : (
          <p className="notice">위험도 판정 수신 대기</p>
        )}
      </PendingSource>

      {level !== 'decision' && (
        <PendingSource id="device-cards" minHeight={96}>
        <div className="layergrid">
          {records.map((r) => {
            const status = deriveDisplayStatus(r.state?.payload ?? null);
            return (
              <article className="layercard" key={r.id}>
                <b>{r.registry?.display_name ?? r.id}</b>
                <span className={'badge badge--' + status}>{DISPLAY_STATUS_LABEL[status]}</span>
                {level === 'development' && <pre>{JSON.stringify({ state: r.state, telemetry: r.telemetry }, null, 2)}</pre>}
              </article>
            );
          })}
        </div>
        </PendingSource>
      )}

      <div className="devpanel">
        <h3 className="devpanel__title">전이 재생 <small>목 게이트웨이 — 목임을 감추지 않는다</small></h3>
        <div className="devpanel__row">
          {(['normal', 'watch', 'alert', 'recovery'] as const).map((v) => (
            <button className="btn" type="button" key={v} onClick={() => trigger('risk-' + v)}>위험도 {RISK_LABEL[v]}</button>
          ))}
          <button className="btn" type="button" onClick={() => trigger('ai-failure')}>AI 실패 1건 → 상단 알림</button>
        </div>
        <Explain id="risk-2" className="note note--dim">
          현재 구독 대상 {store.getSnapshot().size}개. 계층을 바꿔도 <strong>재구독하지 않고</strong> 같은 원본의 표시 깊이만 바꾼다 (VZ-U-03).
          AI 실패는 이 화면이 아니라 <strong>상단 공통 알림</strong>으로 올라간다 (VZ-I-10) — 탭을 보고 있지 않아도 알아야 하는 것이기 때문이다.
        </Explain>
      </div>
    </section>
  );
}
