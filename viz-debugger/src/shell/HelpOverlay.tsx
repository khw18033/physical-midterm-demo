/**
 * src/shell/HelpOverlay.tsx (260831 신설 — 사이트 개선 요구 1)
 *
 * 우상단 `?` — **지금 보고 있는 것의 설명서만** 팝업으로 보인다 (사용자 결정 4).
 *
 * 260903(3단계 — 탭 제거)에 「현재 켜진 탭」이 **「캔버스, 또는 확대가 열려 있으면 그 노드」**
 * 가 됐다. 지시서 §3이 지목한 셸 5개소 중 넷째다. 판정 재료는 캔버스의 확대 상태 하나
 * (`canvas/zoomState.ts`)이고 셸은 읽기만 한다 — 셸이 캔버스 안을 알면 탭을 걷어낸 뜻이 없다.
 *
 * 내용은 각 화면의 `<Explain>` 이 자기 자리에서 등록한 문단들이다 — 글의 원본은
 * 여전히 그 컴포넌트 안에 있고, 여기는 모아 보여줄 뿐이다(요구 1 「자리만 옮긴다」).
 */

import { Fragment, useState } from 'react';
import { manualEntries, useManualVersion, type ManualScopeId } from '../shared/Explain.tsx';
import { setDevToolsVisible, useDevTools } from '../shared/renderMode.ts';

const SCOPE_TITLE: Record<ManualScopeId, string> = {
  canvas: '노드 캔버스 — 임무 설계 및 디버깅',
  'device-risk': '확대 · 장치 · 위험',
  control: '확대 · 제어',
  metrics: '확대 · 지표',
  video: '확대 · 영상',
  shell: '상단 공통 바',
};

/** 구역별 한 줄 요약 — 손으로 쓴다 (지시서 §우상단 ? 오버레이). */
const SCOPE_SUMMARY: Record<ManualScopeId, string> = {
  canvas: '발화로 임무를 만들고, 마일스톤 → 태스크 그래프 → 뷰 노드로 실행을 되짚는 화면. 팔레트에서 꺼낸 뷰 노드를 태스크에 연결하면 그 태스크의 대상·구간이 그 노드의 조회 범위가 된다.',
  'device-risk': '구역 장치의 상태 3층(자기보고·가용성·배포)과 위험도, 구역 맵 미니뷰. 요약 카드는 얕은 깊이이고 여기가 깊은 깊이다 (VZ-U-03).',
  control: '수동 제어 발행과 명령 4단계(발행→ACK→진행→완료) 추적, 감사 이력 조회.',
  metrics: '요약·원본 두 경로의 지표 질의 — 지금 보는 값이 요약인지 원본인지가 항상 표기된다.',
  video: '영상 위 탐지 박스·궤적 정합 — 프레임 참조가 없으면 박스가 어긋난다는 것을 실측한다. 접힌 카드는 정지 프레임이고 재생은 여기서만 돈다.',
  shell: '임무 이름·임무 제어·알림. 공통 명령은 단일 출구로 나가고 게이트웨이도 하나다.',
};

export function HelpOverlay({ scope }: { scope: ManualScopeId }) {
  const [open, setOpen] = useState(false);
  const devTools = useDevTools();
  useManualVersion(); // 확대 열고 닫기·마운트로 목록이 바뀌면 다시 그린다.

  return (
    <>
      <button type="button" className="help-btn" title="지금 보고 있는 화면의 설명서" onClick={() => setOpen(true)}>?</button>
      {open && (
        <div className="help-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="help-modal" role="dialog" aria-label="화면 설명서">
            <header>
              <div>
                <h2>{SCOPE_TITLE[scope]}</h2>
                <p>{SCOPE_SUMMARY[scope]}</p>
              </div>
              <button type="button" onClick={() => setOpen(false)}>닫기</button>
            </header>

            <div className="help-body">
              {manualEntries(scope).map((entry) => (
                <Fragment key={entry.id}>
                  <div className="help-entry">{entry.read()}</div>
                </Fragment>
              ))}
              {manualEntries(scope).length === 0 && <p className="help-empty">이 화면에 등록된 설명이 없습니다.</p>}

              <h3>모드 — 우상단 스위치</h3>
              <ul className="help-modes">
                <li><b>일반</b> — 기본값. 남이 줄 데이터 자리는 「연결 예정(무엇을·누구에게서)」 카드로 뜬다. 무엇이 아직 안 왔는지가 화면에 드러난다.</li>
                <li><b>시나리오</b> — 대본을 골라 <b>정지 미리보기</b>(t=0 화면)로 들어간다. <b>재생은 여전히 승인(VZ-U-07) 뒤다.</b> 발화 → 매칭 → 승인으로 들어오면 「재생 중」이 된다. 대본 등장 장비만 그려지고, 대본에 없는 축은 「이 대본에는 해당 없음」으로 갈린다.</li>
                <li><b>목·개발</b> — 남이 줄 데이터 자리에 그럴듯한 목을 그린다. 붉은 배지가 유지되며 <b>시연 중에는 켜지 말 것.</b> 개발 도구(시나리오 재생 버튼·계약 확인)도 이 모드에서 보인다.</li>
              </ul>

              {scope === 'canvas' && (
                <>
                  <h3>계획 승인 — 어디서 와서 어디로 돌아가는가 <small>(BE-X-04)</small></h3>
                  <p className="help-note">
                    계획을 만드는 것은 AI지만 <b>가시화에 가져다주고 승인 결과를 받아 가는 것은 백엔드</b>입니다.
                    경로는 <b>생성(AI) → 백엔드 중계 → 가시화(이 화면) → 백엔드 중계 → 엣지·로봇</b> 순이고,
                    <b>승인된 계획만</b> 엣지로 나갑니다. 거부도 <b>같은 백엔드 채널로</b> 돌아갑니다 —
                    승인만 백엔드를 거치면 「왜 실행이 안 됐나」의 절반이 어디에도 남지 않기 때문입니다.
                  </p>
                  <p className="help-note">
                    AI는 계획 <b>생성</b>과 <b>검증</b>까지입니다. 가시화 전달·승인 수신·엣지 발행은 백엔드
                    중계 구간이고, 화면은 그 둘을 색과 라벨로 갈라 둡니다 — 나중에 승인이 안 먹었을 때
                    「AI가 계획을 못 만든 것」과 「중계가 끊긴 것」을 구분해야 하기 때문입니다.
                    이 계획의 <b>실제 단계와 시각</b>은 결정 뒤 영수증 줄의 <b>「근거 ▾」</b>에서 봅니다.
                    중계 단계(<code>relay_stage</code>)는 백엔드 내부 상태라 <b>목·개발 모드</b>에서만 뜹니다.
                  </p>
                  <p className="help-note">
                    <b>승인 전에는 아무것도 재생되지 않습니다.</b> 그래서 계획 근거 4층(전역 임무 → 구역 분할 →
                    구간별 계획 → 검증 결과)은 결정 전에 <b>펼친 채로</b> 보입니다 — 승인은 되돌리기 어려운
                    조작이라 「펼쳐 봐야 보이는 근거」는 안 보는 근거가 되기 때문입니다. 결정이 끝나면 카드는
                    <b>한 줄 영수증</b>(승인됨/거부됨 · 시각 · 계획 id)으로 접히고 마일스톤 목록이 올라옵니다 —
                    그 시점에는 이 화면에서 결정할 것이 없고, 마일스톤 화면의 주인은 마일스톤이기 때문입니다.
                  </p>
                  <p className="help-note">
                    「구간별 계획」이 <b>「N구간 — 아래 마일스톤과 같음」</b> 한 줄인 이유: 계획 구간은 대본의
                    마일스톤과 <b>같은 값</b>이라(재생기가 태스크 상태를 접어 구간에 되돌려 줍니다) 펼쳐 두면
                    한 화면에서 같은 것을 두 번 읽게 됩니다.
                  </p>
                </>
              )}

              <h3>시나리오 모드 — 무엇이 접히고 무엇이 남는가 <small>(2026-09-01)</small></h3>
              <p className="help-note">
                대본이 그 패널의 축(위치·수위·영상·명령…)을 몰지 않으면 <b>패널을 통째로 접습니다</b> —
                제목·버튼 줄·표까지 없앱니다. 로봇 이동 대본을 보는데 수문 제어 제목이 남아 있으면
                「지금 무엇을 보고 있나」가 흐려지기 때문입니다. <b>팔레트에서도 안 쓰는 노드는 흐리게</b>
                표시되지만 <b>막지는 않습니다</b> — 눌러서 확인할 수 있습니다. 접힌 자리에는 그 자리가
                <b>어느 편에서 살아나는지</b>와 그 대본으로 바꾸는 버튼이 있습니다.
              </p>
              <p className="help-note">
                <b>일반 모드에서는 아무것도 접히지 않습니다.</b> 모든 노드와 패널이 그대로 뜨는 것이
                「남이 줄 데이터가 어디에 얼마나 있는지」를 보여 주는 화면이기 때문입니다. 목·개발 모드도
                전부 그립니다.
              </p>
              <h3>시나리오 중에도 자리표시로 남기는 셋 — 왜</h3>
              <ul className="help-modes">
                <li><b>배정 풀의 상태 3행</b>(배터리·통신 세기·온도) — 대본 등장 장비라도 <b>실측값은 남이 줄 데이터</b>라 지어내지 않습니다 (<code>VZ-D-07</code> · 2026-08-31 결정). 대본은 장비 <b>id</b>까지만 말합니다.</li>
                <li><b>임무 이력</b> — 지난 임무 목록과 결과는 백엔드가 보관하고 우리는 조회해 보여줍니다 (<code>BE-S-01</code>·<code>BE-Q-01</code>). 현재 임무의 실행 기록 열(되감기 원자료)은 우리 것이라 여기 해당하지 않습니다.</li>
                <li><b>레지스트리</b> — 대상 목록·소속 구역·노드 매핑은 백엔드가 주는 목록입니다 (<code>BE-Q-03</code>). 대본이 이 목록을 만들어 내면 「어느 장비가 실재하는가」가 화면마다 달라집니다.</li>
              </ul>

              <label className="help-devtoggle">
                <input type="checkbox" checked={devTools} onChange={(event) => setDevToolsVisible(event.target.checked ? true : null)} />
                개발 도구 표시 (시나리오 재생 버튼 · 계약 확인 · 리렌더 카운터) — 기본은 목·개발 모드에서만
              </label>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
