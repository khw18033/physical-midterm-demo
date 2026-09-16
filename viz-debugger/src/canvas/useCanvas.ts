/**
 * src/canvas/useCanvas.ts (260903 — 1단계)
 *
 * 캔버스 구성 한 슬롯의 상태 보관. **슬롯은 `(missionId, 마일스톤 ∣ __mission__)`** 이고
 * 슬롯이 바뀌면 그 슬롯의 구성을 새로 읽는다 — 마일스톤을 옮겼다 돌아오면 놓아 둔 뷰
 * 노드가 그대로 있어야 한다 (`VZ-N-04` · `verify:canvas-persist`).
 *
 * 규칙은 전부 `persist.ts` 의 순수 함수에 있다. 여기 있는 것은 React 배선뿐이다 —
 * 검사가 Node 에서 3층과 실패 셋을 그대로 재현할 수 있어야 하기 때문이다.
 *
 * **태스크의 `movedPositions` 와 저장소가 다르다.** 그쪽은 DAG↔트리 전환에서 버려진다
 * (자동 배치가 다시 계산되니 맞다). 뷰 노드는 사용자가 놓은 것이라 같이 버리면
 * "내가 만든 게 사라졌다"가 된다 — 그래서 배치 모드와 무관한 이 저장소에 있다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '../model/types.ts';
import { defaultCanvasConfig } from './defaults.ts';
import {
  browserStorage,
  clearCanvas,
  loadCanvas,
  saveCanvas,
  type CanvasConfig,
  type CanvasDeps,
  type CanvasLoad,
} from './persist.ts';
import type { ViewNodeInstance, ViewNodeKind } from './types.ts';

export type CanvasApi = {
  nodes: readonly ViewNodeInstance[];
  /** 실패 셋에서 나온 한 줄들 — 화면 머리줄에 그대로 적는다. */
  notices: readonly string[];
  /** 저장이 되는가. false 면 저장소가 막힌 것이고 캔버스는 그대로 동작한다. */
  writable: boolean;
  /** 되돌릴 사용자 구성이 있는가 (층 ③ 버튼을 켤지). */
  restorable: boolean;
  /** 만든 노드의 id 를 돌려준다 — 대본 띠가 「없으면 만들고 하이라이트」에 쓴다 (260903). */
  add(kind: ViewNodeKind, taskId: string | null): string;
  remove(id: string): void;
  bind(id: string, taskId: string | null): void;
  move(id: string, position: { x: number; y: number }): void;
  /** 사람이 테두리를 끌어 크기를 바꿨다 (260911). 좌표와 같은 자리에 저장된다. */
  resize(id: string, size: { w: number; h: number }): void;
  reset(): void;
};

/** 새 뷰 노드의 id. 새로고침 뒤에도 겹치지 않게 시각 + 난수 다섯 자다. */
function newId(kind: ViewNodeKind): string {
  return `vn-${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function useCanvas(missionId: string, slot: string, tasks: readonly Task[]): CanvasApi {
  // 저장소 접근은 기동 때 한 번만 확인한다 — 막힌 환경에서 매번 던지게 두지 않는다.
  const deps = useMemo<CanvasDeps>(() => ({ storage: browserStorage(), defaults: defaultCanvasConfig }), []);
  const taskIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  // 태스크 **집합**이 바뀔 때만 다시 읽는다. 배열 신원이 바뀔 때마다 읽으면 되감기 한 칸에도
  // 저장소를 두드리게 된다.
  const taskKey = useMemo(() => [...taskIds].sort().join(','), [taskIds]);
  const [state, setState] = useState<CanvasLoad>(() => loadCanvas(missionId, slot, taskIds, deps));
  // 이벤트 처리에서 최신 구성을 읽는 자리. setState 안에서 저장하면 StrictMode 가 갱신
  // 함수를 두 번 부르며 저장도 두 번 일어난다 — 부수효과는 이벤트 쪽에 둔다.
  const configRef = useRef<CanvasConfig>(state.config);
  configRef.current = state.config;

  useEffect(() => {
    setState(loadCanvas(missionId, slot, taskIds, deps));
    // taskIds 는 taskKey 가 대표한다.
  }, [missionId, slot, taskKey, deps]);

  const commit = useCallback((next: CanvasConfig) => {
    const saved = saveCanvas(missionId, slot, next, deps);
    configRef.current = next;
    setState((current) => ({
      config: next,
      source: 'user',
      // 저장이 실패했으면 그 사실을 한 줄로 남긴다 — 조용히 잃는 것이 제일 나쁘다.
      notices: saved ? current.notices : [...new Set([...current.notices, '이 브라우저에서는 캔버스 구성이 저장되지 않습니다 — 새로고침하면 기본 구성으로 돌아갑니다.'])],
      writable: saved,
    }));
  }, [deps, missionId, slot]);

  const add = useCallback((kind: ViewNodeKind, taskId: string | null) => {
    const node: ViewNodeInstance = { id: newId(kind), kind, taskId, x: null, y: null };
    commit({ ...configRef.current, nodes: [...configRef.current.nodes, node] });
    return node.id;
  }, [commit]);

  const remove = useCallback((id: string) => {
    commit({ ...configRef.current, nodes: configRef.current.nodes.filter((node) => node.id !== id) });
  }, [commit]);

  /**
   * 연결·연결 해제. **좌표를 함께 비운다** — 연결이 바뀌면 기준 자리도 바뀌어야 하는데
   * 옛 좌표가 남아 있으면 노드가 엉뚱한 태스크 아래에 붙어 있는 것처럼 보인다.
   */
  const bind = useCallback((id: string, taskId: string | null) => {
    commit({
      ...configRef.current,
      nodes: configRef.current.nodes.map((node) => (node.id === id ? { ...node, taskId, x: null, y: null } : node)),
    });
  }, [commit]);

  const move = useCallback((id: string, position: { x: number; y: number }) => {
    commit({
      ...configRef.current,
      nodes: configRef.current.nodes.map((node) => (node.id === id ? { ...node, x: position.x, y: position.y } : node)),
    });
  }, [commit]);

  const resize = useCallback((id: string, size: { w: number; h: number }) => {
    commit({
      ...configRef.current,
      nodes: configRef.current.nodes.map((node) => (node.id === id ? { ...node, w: size.w, h: size.h } : node)),
    });
  }, [commit]);

  const reset = useCallback(() => {
    clearCanvas(missionId, slot, deps);
    setState(loadCanvas(missionId, slot, taskIds, deps));
  }, [deps, missionId, slot, taskIds]);

  return {
    nodes: state.config.nodes,
    notices: state.notices,
    writable: state.writable,
    restorable: state.source === 'user' || state.config.nodes.length > 0,
    add, remove, bind, move, resize, reset,
  };
}
