/**
 * src/shell/ConnectionsPanel.tsx (260904 — `VZ-C-07` 연결 대상 설정)
 *
 * **접속 주소를 화면에서 정한다.** 지금까지는 빌드 시점 환경변수라 바꾸려면 다시 빌드해야
 * 했고, 현장에서 게이트웨이·제어 노드 IP가 바뀔 때마다 빌드할 수는 없었다.
 *
 * 화면은 **대상 목록을 그린다** — 손으로 넷을 적지 않는다. 목록의 원천은
 * `shared/connections.ts` 하나이고, 대상이 늘거나 줄면 이 파일은 그대로다.
 *
 * `live: false` 인 대상(제어 노드 · 디지털 트윈)은 **주소를 넣어도 붙을 곳이 없다.**
 * 칸을 잠그고 「연결 예정」으로 둔다 — 없는 것을 있는 척하지 않는다(다른 자리표시와 같은 규칙).
 *
 * ## 설정만이 아니라 확인까지 (260910 — 연결 관리 통합)
 *
 * 260904 에는 이 판이 **설정**(어디에 붙을 것인가)만 하고 상태는 상단 배지가 말했다.
 * 그 가름이 하드웨어가 붙으면서 깨졌다 — 로봇은 「주소가 맞는가」와 「로봇이 답하는가」가
 * 따로 놀고, 둘 다 무대에 오르기 전에 확인해야 하는 것이다. 그래서 대상마다 **네 줄**을 둔다:
 * 주소 · 상태 · 확인 버튼 · 마지막 확인.
 *
 * **「붙었다」와 「답한다」는 다르다.** 브로커는 살아 있는데 로봇이 꺼져 있으면 연결은
 * 성공이고 왕복은 실패다. `physical` 이 줄을 둘 갖는 이유가 그것이다.
 *
 * 상단의 `conn` 배지는 여전히 게이트웨이 연결 하나를 말한다 — 그건 늘 붙어 있어야 하는
 * 것이라 성격이 다르다.
 */

import { useState } from 'react';
import { DETECT_PRESETS, detectPresetReady } from '../detect/presets.ts';
import { BROKER_PRESETS, presetReady } from '../physical/presets.ts';
import { checkTarget, type PhysicalProbe } from '../shared/connectionCheck.ts';
import { robotFacts } from '../physical/robotFacts.ts';
import { setTestMode, useDetect } from '../detect/store.ts';
import { useDeviceStates } from '../physical/deviceState.ts';
import { CHECKED_TARGETS, useConnectionHealth, type TargetHealth } from '../shared/connectionHealth.ts';
import type { ConnectionTargetId } from '../shared/connections.ts';
import {
  CONNECTION_TARGETS,
  connectionKey,
  connectionsWritable,
  resetConnections,
  saveConnections,
  useConnections,
} from '../shared/connections.ts';

type AddressPreset = { id: string; label: string; url: string; why: string };

/**
 * **네트워크 환경을 고르는 칸이 있는 대상** (260910 로봇 · 260914 객체 탐지).
 *
 * 둘 다 망에 따라 주소가 갈리는 상대다 — 테일넷 이름 · 같은 랜 · 직접 입력. 프리셋 목록은
 * 각자의 경계(`src/physical/` · `src/detect/`)에 두고, 이 화면은 고르는 칸만 그린다.
 * 대상이 늘면 여기 한 줄을 더한다.
 */
const ADDRESS_PRESETS: Partial<Record<ConnectionTargetId, { presets: readonly AddressPreset[]; ready(preset: AddressPreset): boolean }>> = {
  physical: { presets: BROKER_PRESETS, ready: presetReady },
  detect: { presets: DETECT_PRESETS, ready: detectPresetReady },
};

export function ConnectionsPanel({ onClose, physical }: { onClose(): void; physical?: PhysicalProbe | null }) {
  const current = useConnections();
  /** 편집 중인 값. 저장을 눌러야 적용된다 — 한 글자 칠 때마다 끊고 다시 붙으면 못 쓴다. */
  const [draft, setDraft] = useState<Record<string, string>>({ ...current });
  const [note, setNote] = useState<string | null>(null);
  const writable = connectionsWritable();
  const dirty = CONNECTION_TARGETS.some((target) => target.fields.some((field) => {
    const key = connectionKey(target.id, field.key);
    return (draft[key] ?? '') !== (current[key] ?? '');
  }));

  const apply = () => {
    const saved = saveConnections(draft);
    setNote(saved
      ? '적용했습니다 — 게이트웨이 주소가 바뀌었으면 끊고 새 주소로 다시 붙습니다.'
      : '이번 세션에만 적용했습니다 — 저장소가 막혀 있어 새로고침하면 기본값으로 돌아갑니다.');
  };
  const restore = () => {
    resetConnections();
    setDraft({});
    setNote('기본값으로 되돌렸습니다.');
  };

  return <aside className="global-panel global-panel--connections">
    <header><b>⇄ 연결 관리</b><button onClick={onClose}>닫기</button></header>
    {/* **최상단 안내를 뺐다** (260913 지시). 여기 있던 세 줄은 이 판을 처음 여는 사람에게
        필요한 말이고, 시연 직전에 여는 사람에게는 매번 같은 자리를 차지할 뿐이었다.
        규칙 자체는 그대로다 — 환경변수가 기본값이고 여기서 넣은 값이 이긴다. */}
    {!writable && <p className="connections__warn">
      저장소가 막혀 있습니다 — 바꿔도 이번 세션에만 적용되고 새로고침하면 기본값으로 돌아갑니다.
    </p>}
    {/* 목록을 그린다. 대상이 늘면 이 파일이 아니라 shared/connections.ts 가 바뀐다. */}
    {CONNECTION_TARGETS.map((target) => <section key={target.id} className={`conn-target${target.live ? '' : ' conn-target--pending'}`}>
      <h3>{target.label}{target.live ? null : <em>연결 예정</em>}</h3>
      {/* 설명이 없는 대상도 있다 (260913 지시 — 로봇·객체 탐지). 늘 쓰는 둘이라
          매번 읽을 문장이 아니다. 자리도 그만큼 줄어든다. */}
      {target.what !== undefined && <p>{target.what}</p>}
      {target.pending !== undefined && <p className="conn-target__pending">{target.pending}</p>}
      {target.fields.map((field) => {
        const key = connectionKey(target.id, field.key);
        const choice = ADDRESS_PRESETS[target.id];
        return <label key={key}>
          <span>{field.label}</span>
          {/* 프리셋이 있는 대상은 네트워크 환경을 고르는 자리도 준다 (§2) — 로봇과 객체 탐지.
              이름이 안 풀릴 때 손으로 IP 를 치는 것보다 고르는 편이 빠르다. */}
          {choice !== undefined && <select
            className="conn-preset"
            value={choice.presets.find((preset) => preset.url === (draft[key] ?? ''))?.id ?? 'manual'}
            onChange={(event) => {
              const preset = choice.presets.find((p) => p.id === event.target.value);
              if (preset && preset.url) setDraft((prev) => ({ ...prev, [key]: preset.url }));
            }}
          >
            {choice.presets.map((preset) => <option
              key={preset.id}
              value={preset.id}
              title={preset.why}
              // 값이 빈 프리셋은 **아직 없는 것**이다 — 고를 수 없게 막는다.
              disabled={!choice.ready(preset)}
            >{preset.label}{choice.ready(preset) || preset.id === 'manual' ? '' : ' (미정)'}</option>)}
          </select>}
          <input
            value={draft[key] ?? ''}
            disabled={!target.live}
            placeholder={target.live ? field.fallback : '상대가 정해지면 열립니다'}
            onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))} />
        </label>;
      })}
      {/* 상태 · 확인 · 마지막 확인 — 나머지 세 줄 (§2). 확인 방법이 있는 대상만. */}
      {CHECKED_TARGETS.includes(target.id) && <HealthRow
        target={target.id}
        physical={target.id === 'physical' ? (physical ?? null) : null}
      />}
    </section>)}
    <footer className="connections__actions">
      {note && <span className="connections__note">{note}</span>}
      {/* 되돌아올 길. 틀린 주소를 넣으면 아무 데도 못 붙으므로 이 길이 없으면 갇힌다. */}
      <button onClick={restore}>기본값 복원</button>
      <button className="connections__apply" onClick={apply} disabled={!dirty}>적용</button>
    </footer>
  </aside>;
}

/**
 * 대상 하나의 **상태 · 확인 · 마지막 확인** 세 줄.
 *
 * 줄이 여럿일 수 있다 — `physical` 이 브로커와 로봇 둘이다. 한 줄로 뭉치면 발표 직전에
 * 주소를 봐야 하는지 로봇 전원을 봐야 하는지 못 가른다 (§3).
 */
function HealthRow({ target, physical }: { target: ConnectionTargetId; physical: PhysicalProbe | null }) {
  const health = useConnectionHealth();
  // 장비 상태를 구독한다 — 로봇 줄이 그 값으로 채워진다.
  useDeviceStates();
  const state: TargetHealth = health[target] ?? { checking: false, lines: [] };
  // 탐지 줄만 「테스트」를 쓴다. 훅은 조건 없이 부른다 — 그리기마다 수가 달라지면 안 된다.
  const detect = useDetect();
  return <div className="conn-health">
    <div className="conn-health__lines">
      {state.lines.length === 0
        ? <span className="conn-dot conn-dot--unknown">아직 확인하지 않았습니다</span>
        : state.lines.map((row) => <span key={row.id} className={`conn-dot conn-dot--${row.ok === true ? 'ok' : row.ok === false ? 'bad' : 'unknown'}`}>
          {row.label} {row.ok === true ? '✓' : row.ok === false ? '✕' : '?'}
          {row.roundTripMs !== null && ` ${row.roundTripMs}ms`}
          {row.reason !== null && ` — ${row.reason}`}
        </span>)}
    </div>
    {/*
      **탐지만의 「테스트」** (260912 지시). 확인 버튼 왼쪽이다.

      켜면 탐지 담당이 준 **실제 산출물**(`door_example/`)을 진짜 결과처럼 읽는다. 목을
      지어내는 것이 아니라 받은 값 그대로다 — 그래서 화면이 「테스트 자료」라고 적되 값은
      손대지 않는다. 탐지 서비스가 붙기 전에 화면 쪽을 다 맞춰 둘 수 있다.

      **끄면 읽어 둔 것도 같이 버린다.** 시료가 실제 결과로 남아 있으면 안 된다.
    */}
    {target === 'detect' && <label className="conn-test" title="탐지 담당이 준 실제 산출물을 진짜 결과처럼 읽습니다">
      <input type="checkbox" checked={detect.testMode} onChange={(event) => setTestMode(event.target.checked)} />
      테스트
    </label>}
    <button
      type="button"
      className="conn-check"
      disabled={state.checking}
      onClick={() => void checkTarget(target, physical, robotFacts)}
    >{state.checking ? '확인 중…' : '확인'}</button>
    {state.lines.length > 0 && <small className="conn-health__at">
      {new Date(state.lines[0].checkedAtIso).toLocaleTimeString()}
    </small>}
  </div>;
}
