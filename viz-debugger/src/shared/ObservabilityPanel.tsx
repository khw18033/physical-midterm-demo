/**
 * src/shared/ObservabilityPanel.tsx (260904 신설 — `VZ-O-04` 2단계)
 *
 * 자체 관측의 **화면**. 재고 있는 값과 못 재는 값을 한 자리에서 가른다.
 *
 * ## 왜 `shared/` 이고 왜 `main.tsx` 가 그리나
 *
 * 논문 측정축 D는 **단독 빌드**에서 잰다. 셸(`AppShell`)이 그리면 단독 빌드에는 이 화면이
 * 없어서, 정작 재야 하는 빌드에서 「지금 뭘 재고 있는지」를 사람이 볼 수 없다.
 * 그래서 부품은 `shared/` 에 두고 `main.tsx`(두 빌드가 공유하는 임무 화면)가 그린다.
 *
 * ## 언제 보이나
 *
 * `devpanel` 이다 — 통합 셸에서는 기존 규칙대로 **목·개발 모드(또는 `?` 오버레이 토글)**
 * 에서만 뜬다(`.app-shell:not(.app-shell--dev) .devpanel{display:none}`). 단독 빌드에는
 * 셸이 없으므로 늘 보인다. **그 편이 맞다** — 단독 빌드가 곧 측정 장비다.
 *
 * 접혀 있는 것이 기본이고, 펼치면 1초마다 다시 그린다. **재는 동안에는 접어 두는 것이
 * 맞다** — 패널을 열어 두면 그 리렌더가 측정 대상에 섞인다. 그 사실도 화면에 적는다.
 */

import { useEffect, useState } from 'react';
import { PendingSource } from './PendingSource.tsx';
import {
  closeWindow,
  closedWindows,
  currentWindow,
  FOLD_BUDGET_MS,
  observabilityReport,
  PERIOD_MS,
  unmeasured,
  type ObservabilityWindow,
} from './observability.ts';

/** 못 잰 값은 「해당 없음」이다. **0을 넣지 않는다** — 0은 「쟀는데 0」으로 읽힌다. */
function Value({ value, unit, digits = 0 }: { value: number | null; unit: string; digits?: number }) {
  if (value === null) return <b className="obs__na">해당 없음</b>;
  return <b>{value.toFixed(digits)}<small> {unit}</small></b>;
}

function Row({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return <div className="obs__row"><span>{label}</span>{children}{note !== undefined && <small className="obs__note">{note}</small>}</div>;
}

function kb(bytes: number): number {
  return Math.round((bytes / 1024) * 10) / 10;
}

function download(report: unknown): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `viz-observability-${new Date().toISOString().replaceAll(':', '').slice(0, 15)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function ObservabilityPanel() {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [open]);

  const now: ObservabilityWindow = currentWindow();
  const closed = closedWindows();
  const gaps = unmeasured();
  const overBudget = now.foldP95Ms !== null && now.foldP95Ms > FOLD_BUDGET_MS;

  if (!open) {
    return <section className="devpanel obs obs--closed">
      <button className="obs__toggle" onClick={() => setOpen(true)}>
        ▸ 자체 관측 (VZ-O-04) — 열 {now.traceLength}건 · 접기 p95 {now.foldP95Ms === null ? '표본 없음' : `${now.foldP95Ms.toFixed(2)} ms`} · 창 {closed.length}개
      </button>
    </section>;
  }

  return <section className="devpanel obs">
    <header className="obs__head">
      <button className="obs__toggle" onClick={() => setOpen(false)}>▾ 자체 관측 (VZ-O-04)</button>
      <small>{PERIOD_MS / 1000}초 1회 집계 · 닫힌 창 {closed.length}개 · 이 패널은 <b>열려 있는 동안 1초마다 다시 그립니다</b> — 재는 동안에는 접어 두세요</small>
    </header>

    <div className="obs__grid">
      <div className="obs__group">
        <h4>기록 열 <small>축 D 본문</small></h4>
        <Row label="발생률"><Value value={now.traceRatePerSec} unit="건/초" digits={2} /></Row>
        <Row label="열 길이"><Value value={now.traceLength} unit="건" /></Row>
        <Row label="추정 용량" note="표본 직렬화 × 건수"><Value value={kb(now.traceBytesEstimate)} unit="KB" digits={1} /></Row>
        <Row label="중복 무시" note="재접속 흔적"><Value value={now.traceDuplicates} unit="건" /></Row>
        <Row label="순서 뒤바뀜"><Value value={now.traceOutOfOrder} unit="건" /></Row>
      </div>

      <div className="obs__group">
        <h4>접기 <small>축 D 「임의 시점 복원」 · 목표 {FOLD_BUDGET_MS} ms</small></h4>
        <Row label="횟수"><Value value={now.foldCount} unit="회" /></Row>
        <Row label="평균"><Value value={now.foldAvgMs} unit="ms" digits={3} /></Row>
        <Row label={`p95 ${overBudget ? '⚠' : ''}`}><Value value={now.foldP95Ms} unit="ms" digits={3} /></Row>
        <Row label="최대"><Value value={now.foldMaxMs} unit="ms" digits={3} /></Row>
        {now.foldDropped > 0 && <Row label="표본 초과" note="위 통계는 앞쪽 표본만의 값"><Value value={now.foldDropped} unit="회" /></Row>}
      </div>

      <div className="obs__group">
        <h4>전송 <small>추가 지연 · 안정성</small></h4>
        <Row label="받은 봉투"><Value value={now.envelopeCount} unit="건" /></Row>
        <Row label="수신 지연 평균"><Value value={now.receiveDelayAvgMs} unit="ms" /></Row>
        <Row label="수신 지연 최대"><Value value={now.receiveDelayMaxMs} unit="ms" /></Row>
        <Row label="재연결"><Value value={now.reconnects} unit="회" /></Row>
      </div>

      <div className="obs__group">
        <h4>화면 <small>병합 창 100 ms (VZ-I-01)</small></h4>
        <Row label="브라우저 메모리"><Value value={now.jsHeapUsedMb} unit="MB" digits={1} /></Row>
        <Row label="알림 표시"><Value value={now.notifyMarked} unit="회" /></Row>
        <Row label="실제 그림"><Value value={now.notifyFlushed} unit="회" /></Row>
      </div>
    </div>

    {/* 못 재는 것 — 「아직 안 왔다」·「이 환경에서는 못 잰다」·「상대가 없다」는 서로 다른 말이다. */}
    <div className="obs__gaps">
      <h4>못 재는 것 {gaps.length}건 — 빈칸에 0을 넣지 않습니다</h4>
      <ul>{gaps.map((gap) => <li key={gap.key}><b>{gap.label}</b> — {gap.why}</li>)}</ul>
    </div>

    {/* 발행 상대는 아직 없다. 「무엇을 · 누구에게서」가 아니라 「무엇을 · 누구에게」이지만
        기다리는 자리라는 점은 같아서 같은 부품을 쓴다. */}
    <PendingSource id="client-metrics-sink" minHeight={92} />

    <div className="obs__actions">
      <button onClick={() => download(observabilityReport())}>JSON 내려받기</button>
      <button onClick={() => closeWindow()}>지금 창 닫기 <small>({PERIOD_MS / 1000}초를 안 기다리고)</small></button>
      <small>콘솔에서도 꺼냅니다 — <code>__vizObservability()</code></small>
    </div>
  </section>;
}
