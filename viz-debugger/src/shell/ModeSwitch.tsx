/**
 * src/shell/ModeSwitch.tsx (260831 신설 — 사이트 개선 요구 4)
 *
 * 우상단 **모드 표시·전환** — `모드 [일반] [시나리오 ▾] [목·개발]`.
 *
 * 지금까지 모드가 세 군데에 흩어져 있었다(목 토글 · 승인 자동 진입 · 배너 안의 닫기).
 * 이 스위치가 그 셋을 한 자리에 모은다 — 지금 무엇을 보고 있는지가 세그먼트로 보이므로
 * 화면의 설명 문단이 줄어든다(요구 1).
 *
 * **승인 선을 우회하지 않는다** — 시나리오를 고르면 「그린다」까지다(정지 미리보기 ·
 * t=0 프레임). 재생은 여전히 VZ-U-07 승인 뒤이고, 그 사실이 상태 문구(`정지`/`재생 중`)로
 * 구분되어 보인다. 셸에만 있다 — 탭① 단독 빌드는 게이트웨이가 없으므로 이 스위치도 없다.
 */

import { useEffect, useRef, useState } from 'react';
import { enterScriptPreview } from '../scenarios/enterPreview.ts';
import { SCRIPT_LIBRARY } from '../scenarios/library.ts';
import { issueCommand } from '../shared/commandEgress.ts';
import {
  exitScenarioRender,
  setRenderMode,
  useRenderMode,
  useScenarioRender,
} from '../shared/renderMode.ts';

export function ModeSwitch() {
  const mode = useRenderMode();
  const scenario = useScenarioRender();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 드롭다운 밖을 누르면 닫는다 — 메뉴가 열린 채로 남으면 스위치가 상태 표시 구실을 못 한다.
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  const toNormal = () => {
    setMenuOpen(false);
    setRenderMode('placeholder');
    if (scenario !== null) {
      // 게이트웨이가 재생·미리보기를 멈추고 장치를 평시로 되돌린다. 실패해도 화면은 복귀한다.
      void issueCommand({ action: 'script_close', entity: scenario.missionId }).catch(() => undefined);
      exitScenarioRender();
    }
  };

  // 진입 네 단계는 scenarios/enterPreview.ts 하나에 있다 — 접힘 카드의 「그 대본으로
  // 바꾸기」가 같은 경로를 부른다(두 벌로 만들지 않는다, 260901).
  const toPreview = (missionId: string) => {
    setMenuOpen(false);
    enterScriptPreview(missionId);
  };

  const toMock = () => {
    setMenuOpen(false);
    setRenderMode('mock');
  };

  const scenarioLabel =
    scenario === null
      ? '시나리오 ▾'
      : `시나리오 · ${scenario.missionId.replace('MSN-', '')} ${scenario.playing ? '재생 중' : '정지'} ▾`;

  return (
    <div className="modeswitch" role="group" aria-label="렌더 모드" ref={rootRef}>
      <span className="modeswitch__label">모드</span>
      <button
        type="button"
        className={'modeswitch__seg' + (mode === 'placeholder' ? ' modeswitch__seg--on' : '')}
        onClick={toNormal}
      >
        일반
      </button>
      <div className="modeswitch__drop">
        <button
          type="button"
          className={'modeswitch__seg' + (mode === 'scenario' ? ' modeswitch__seg--on modeswitch__seg--scenario' : '')}
          onClick={() => setMenuOpen((open) => !open)}
          title="대본을 고르면 정지 미리보기로 들어갑니다. 재생은 여전히 승인(VZ-U-07) 뒤입니다"
        >
          {scenarioLabel}
        </button>
        {menuOpen && (
          <ul className="modeswitch__menu">
            {SCRIPT_LIBRARY.filter((entry) => entry.script !== null).map((entry) => (
              <li key={entry.missionId}>
                <button type="button" onClick={() => toPreview(entry.missionId)}>
                  <b>{entry.missionId}</b> {entry.script?.title}
                </button>
              </li>
            ))}
            <li className="modeswitch__menunote">정지 미리보기 — 재생은 승인 뒤 (VZ-U-07)</li>
          </ul>
        )}
      </div>
      <button
        type="button"
        className={'modeswitch__seg' + (mode === 'mock' ? ' modeswitch__seg--on modeswitch__seg--mock' : '')}
        onClick={toMock}
        title="남이 줄 데이터 자리에 목을 그립니다. 켜져 있는 동안 붉은 배지가 유지됩니다"
      >
        목·개발
      </button>
    </div>
  );
}
