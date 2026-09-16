/**
 * src/shared/renderMode.ts
 *
 * 남이 줄 데이터를 **그릴지 말지**를 정하는 한 곳.
 *
 * 목 게이트웨이는 끄지 않는다 — 개발과 검증에 필요하고, `verify:one-gateway` 가
 * "데이터가 실제로 온다"를 검사한다. 게이트웨이는 여전히 발행하고 데이터 계층도 여전히 받는다.
 * **바뀌는 것은 그리는 층뿐이다.**
 *
 * ## 기본값은 자리표시다
 *
 * 앱을 그냥 띄우면 남의 데이터가 있어야 할 자리에 **무엇을 · 누구에게서 기다리는지**가 뜬다.
 * 진짜처럼 보이는 목이 시연에서 거짓말이 되는 것을 막고, 무엇이 아직 안 왔는지가
 * 화면에 드러나야 다음 회의에서 "이건 누가 언제 주느냐"를 물을 수 있기 때문이다.
 *
 * `verify:placeholder-default` 가 이 기본값을 검사한다. **여기를 `'mock'` 으로 바꾸면
 * 그 검사가 실패한다** — 바꾸려면 그 검사부터 봐야 한다.
 */

import { useSyncExternalStore } from 'react';
import type { ScenarioAxis } from '../scenarios/axes.ts';

/**
 * 셋째 모드 `scenario` (260831 — 대본 재생).
 *
 * **기본값은 여전히 `placeholder` 다.** 목 렌더 토글이 켜져 있으면 `mock` 이 이긴다
 * (전부 그린다 — 붉은 띠가 대본 띠 위에 겹친다).
 *
 * 들어가는 길이 둘이다 (260831 사이트 개선 요구 4 — 우상단 모드 스위치):
 *  - **승인 자동**  : 발화 → 매칭 → VZ-U-07 승인 → 재생과 함께 (`playing: true`)
 *  - **수동 미리보기**: 우상단 모드 스위치에서 대본을 고름 (`playing: false`)
 *
 * 수동 진입은 **「그린다」까지**다. 재생은 여전히 승인 뒤다 — 스위치가 승인 선을 우회하지 않는다.
 * 나오는 길은 스위치의 「일반」 또는 띠의 「대본 닫기」 하나로 같다.
 */
export type RenderMode = 'placeholder' | 'mock' | 'scenario';

/** **기본값.** 이 한 줄이 "앱을 그냥 띄우면 자리표시"를 정한다. */
const DEFAULT_MODE: RenderMode = 'placeholder';

let mode: RenderMode = DEFAULT_MODE;
const listeners = new Set<() => void>();

/** 재생 중(또는 미리보기·재생 끝·닫기 전)인 대본. cast 밖 장비는 이 모드에서도 자리표시다. */
export type ScenarioRender = {
  missionId: string;
  title: string;
  cast: readonly string[];
  castSet: ReadonlySet<string>;
  /**
   * 재생 중인가(승인됨), 아니면 정지한 미리보기인가(모드 스위치).
   * 화면은 이 둘을 **다르게 적어야 한다** — 정지 화면을 재생 중이라고 말하면 안 된다.
   */
  playing: boolean;
  /**
   * 이 대본이 실제로 몰아 주는 축 (scenarios/axes.ts — 대본에서 유도).
   * 여기 없는 축의 자리는 「연결 예정」이 아니라 **「이 대본에는 해당 없음」**이다.
   */
  axes: ReadonlySet<ScenarioAxis>;
};

let scenarioRender: ScenarioRender | null = null;

export function getRenderMode(): RenderMode {
  if (mode === 'mock') return 'mock'; // 목 렌더 토글이 이긴다 — 전부 그린다.
  if (scenarioRender !== null) return 'scenario';
  return mode;
}

export function setRenderMode(next: RenderMode): void {
  if (mode === next) return;
  mode = next;
  for (const listener of listeners) listener();
}

export function toggleRenderMode(): void {
  setRenderMode(mode === 'mock' ? 'placeholder' : 'mock');
}

/**
 * scenario 모드 진입. 통합 셸만 부른다 — 승인 자동(임무 브리지 · `playing: true`)과
 * 모드 스위치의 정지 미리보기(`playing: false`). 구판 세계(legacy) 대본은 들어오지
 * 않는다 — 탭②~⑤에 따라 움직일 것이 없다.
 */
export function enterScenarioRender(info: {
  missionId: string;
  title: string;
  cast: readonly string[];
  axes: ReadonlySet<ScenarioAxis>;
  playing: boolean;
}): void {
  scenarioRender = {
    missionId: info.missionId,
    title: info.title,
    cast: [...info.cast],
    castSet: new Set(info.cast),
    axes: info.axes,
    playing: info.playing,
  };
  for (const listener of listeners) listener();
}

/** 「대본 닫기」 · 모드 스위치의 「일반」 — placeholder 복귀. 끄는 경로는 셸의 이 둘뿐이다. */
export function exitScenarioRender(): void {
  if (scenarioRender === null) return;
  scenarioRender = null;
  for (const listener of listeners) listener();
}

export function getScenarioRender(): ScenarioRender | null {
  return scenarioRender;
}

/** 대본 띠(셸)와 자리표시 분기(PendingSource)가 읽는 훅. */
export function useScenarioRender(): ScenarioRender | null {
  return useSyncExternalStore(subscribe, getScenarioRender, () => null);
}

/**
 * 「이 장비를 지금 그려도 되는가」의 판단 훅 (지시서 §탭②~⑤ — 자리 ID뿐 아니라 장비 ID).
 * scenario 모드에서만 cast 집합을 돌려준다. 목 렌더가 켜져 있으면 null — 목이 이긴다
 * (그때는 PendingSource 가 전부 그린다). 대본에 안 나오는 장비는 대본 중에도 자리표시다.
 */
export function useScenarioCast(): ReadonlySet<string> | null {
  const scenario = useScenarioRender();
  const effective = useRenderMode();
  return effective === 'scenario' && scenario !== null ? scenario.castSet : null;
}

/**
 * **패널 접힘 판정의 재료** (260901 — 층 2). 시나리오 모드일 때만 대본의 축 집합을 준다.
 *
 * `null` 이면 **아무것도 접지 않는다.** 일반 모드는 모든 탭·패널이 그대로 떠야 하고
 * (그게 「남이 줄 데이터가 어디에 얼마나 있는지」를 보여 주는 화면이다), 목 렌더가 켜져
 * 있으면 목이 이긴다(전부 그린다). `verify:scenario-mode` 가 이 셋을 그대로 검사한다.
 */
export function getScenarioAxes(): ReadonlySet<ScenarioAxis> | null {
  if (getRenderMode() !== 'scenario' || scenarioRender === null) return null;
  return scenarioRender.axes;
}

export function useScenarioAxes(): ReadonlySet<ScenarioAxis> | null {
  const scenario = useScenarioRender();
  const effective = useRenderMode();
  return effective === 'scenario' && scenario !== null ? scenario.axes : null;
}

/**
 * 「이 축을 지금 대본이 몰아 주는가」 (260831 — 요구 2의 넷째 상태).
 *  - null       : 시나리오 모드가 아니다 (평소의 자리표시 판단으로 간다)
 *  - true/false : 시나리오 모드다. false 면 「이 대본에는 해당 없음」
 */
export function useScenarioAxis(axis: ScenarioAxis | undefined): boolean | null {
  const scenario = useScenarioRender();
  const effective = useRenderMode();
  if (effective !== 'scenario' || scenario === null || axis === undefined) return null;
  return scenario.axes.has(axis);
}

/**
 * 개발 도구(시나리오 재생 버튼·계약 확인·리렌더 카운터)를 그릴 것인가 (260831 — 요구 1).
 * 기본은 **목·개발 모드에서만**이고, `?` 오버레이의 토글로 명시적으로 켜고 끌 수 있다.
 * 시연 화면(일반·시나리오)에서 개발 버튼 무더기가 메인 기능을 가리는 것을 막는다.
 */
let devToolsOverride: boolean | null = null;

export function setDevToolsVisible(next: boolean | null): void {
  devToolsOverride = next;
  for (const listener of listeners) listener();
}

export function getDevToolsVisible(): boolean {
  return devToolsOverride ?? mode === 'mock';
}

export function useDevTools(): boolean {
  return useSyncExternalStore(subscribe, getDevToolsVisible, () => false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRenderMode(): RenderMode {
  return useSyncExternalStore(subscribe, getRenderMode, () => DEFAULT_MODE);
}

/**
 * 목 렌더 중인가.
 *
 * 참이면 화면 어딘가에 **지워지지 않는 목 배지**가 떠 있어야 한다. 토글을 켠 것을 잊고
 * 시연하면 원래 문제로 되돌아간다 — 배지를 끄는 경로는 만들지 않는다.
 */
export function useMockRender(): boolean {
  return useRenderMode() === 'mock';
}
