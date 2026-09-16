/**
 * src/canvas/persist.ts (260903 — 1단계)
 *
 * **캔버스 구성 보존 3층** (`VZ-N-04`).
 *
 * | 층 | 어디에 | 언제 이기나 |
 * |---|---|---|
 * | ① 기본 구성 | 대본 사이드카 (읽기 전용 · `defaults.ts`) | 사용자 구성이 **없을 때만** |
 * | ② 사용자 구성 | `localStorage` · 키 `(missionId, milestoneId ∣ __mission__)` | **있으면 항상** |
 * | ③ 되돌리기 | 캔버스 머리줄 버튼 | 누를 때 ②를 지우고 ①로 |
 *
 * 읽는 순서 `② → ① → 빈 캔버스`. **쓰는 것은 ②뿐이다.**
 *
 * 새로고침·재접속에 살아남아야 한다 — `VZ-I-02`(재접속 시 현재값 복원)와 같은 원칙이고,
 * 좌표를 대본 JSON 이 아니라 사이드카/브라우저에 두는 것은 F10 `REQ-1002` 와 같은 원칙이다.
 *
 * ## 반드시 처리하는 실패 셋 (지시서 §4)
 *
 * 1. **저장소가 막혀 있다** — 사파리 비공개 창·정책 차단. `try/catch` 로 감싸고
 *    **기본 구성으로 조용히 진행**한다. 화면은 「이 브라우저에서는 저장되지 않습니다」
 *    한 줄만 적고 캔버스는 정상 동작한다.
 * 2. **연결했던 태스크가 대본 개정으로 사라졌다** — 제일 자주 난다(대본을 계속 고치고 있다).
 *    **지우지 않고 전역 노드로 강등**하고 사유 한 줄. 지우면 "내가 만든 게 사라졌다"가 된다.
 * 3. **스키마가 바뀌었다** — `version` 이 안 맞으면 버리고 기본 구성 + 한 줄 안내.
 *
 * React 도 DOM 도 모르는 순수 함수 + 주입 가능한 저장소로 짠다 — `verify:canvas-persist`
 * 가 Node 에서 세 실패를 그대로 재현한다.
 */

import type { ViewNodeInstance } from './types.ts';

/** 스키마 판. **키가 아니라 값 안에 둔다** — 키에 두면 옛 구성이 조용히 미아가 된다. */
export const CANVAS_SCHEMA_VERSION = 1;

/** 「임무 전체」 보기의 슬롯. 마일스톤별 저장만으로는 이 화면의 구성이 미아가 된다. */
export const MISSION_SLOT = '__mission__';

const KEY_PREFIX = 'viz-debugger.canvas';

export type CanvasConfig = { version: number; nodes: ViewNodeInstance[] };

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function emptyCanvas(): CanvasConfig {
  return { version: CANVAS_SCHEMA_VERSION, nodes: [] };
}

/** 저장 키. 마일스톤(또는 「임무 전체」)마다 다른 구성이다 — 한 키에 뭉치면 서로 덮는다. */
export function canvasKey(missionId: string, slot: string): string {
  return `${KEY_PREFIX}:${missionId}:${slot}`;
}

function isInstance(value: unknown): value is ViewNodeInstance {
  if (typeof value !== 'object' || value === null) return false;
  const node = value as Record<string, unknown>;
  return typeof node.id === 'string'
    && typeof node.kind === 'string'
    && (node.taskId === null || typeof node.taskId === 'string')
    && (node.x === null || typeof node.x === 'number')
    && (node.y === null || typeof node.y === 'number')
    // 크기는 **없어도 된다** (260911 신설). 이미 저장된 구성에는 이 칸이 없고, 그것을
    // 못 읽는 것으로 치면 사람이 짜 둔 배치가 통째로 날아간다.
    && (node.w === undefined || (typeof node.w === 'number' && node.w > 0))
    && (node.h === undefined || (typeof node.h === 'number' && node.h > 0));
}

/**
 * 저장된 문자열 → 구성. **못 읽으면 null 과 한 줄 안내**를 돌려주고 절대 던지지 않는다 —
 * 저장소 한 칸이 깨졌다고 화면이 통째로 멎으면 안 된다.
 */
export function parseCanvas(raw: string | null): { config: CanvasConfig | null; notice: string | null } {
  if (raw === null) return { config: null, notice: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: null, notice: '저장된 캔버스 구성을 읽지 못해 기본 구성으로 시작합니다.' };
  }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as CanvasConfig).nodes)) {
    return { config: null, notice: '저장된 캔버스 구성의 모양이 달라 기본 구성으로 시작합니다.' };
  }
  const version = (parsed as CanvasConfig).version;
  if (version !== CANVAS_SCHEMA_VERSION) {
    return {
      config: null,
      notice: `저장된 캔버스 구성이 옛 판(v${String(version)})이라 버리고 기본 구성으로 시작합니다.`,
    };
  }
  const nodes = (parsed as CanvasConfig).nodes.filter(isInstance);
  return { config: { version: CANVAS_SCHEMA_VERSION, nodes }, notice: null };
}

/**
 * 실패 2 — **연결했던 태스크가 사라졌다.** 지우지 않고 전역으로 강등한다.
 *
 * `taskIds` 가 비면 아무것도 하지 않는다. 적재 도중의 빈 목록에 반응해 강등하면
 * 그 강등이 그대로 저장돼 되돌릴 수 없다.
 */
export function reconcile(config: CanvasConfig, taskIds: ReadonlySet<string>): { config: CanvasConfig; notices: string[] } {
  if (taskIds.size === 0) return { config, notices: [] };
  const lost: string[] = [];
  const nodes = config.nodes.map((node) => {
    if (node.taskId === null || taskIds.has(node.taskId)) return node;
    lost.push(node.taskId);
    return { ...node, taskId: null };
  });
  if (lost.length === 0) return { config, notices: [] };
  return {
    config: { ...config, nodes },
    notices: [`연결했던 태스크 ${[...new Set(lost)].join(' · ')} 가 지금 대본에 없어 전역 노드로 두었습니다 (지우지 않았습니다).`],
  };
}

/** 브라우저 저장소. 없거나 막혀 있으면 null — 접근 자체가 던지는 환경이 있다. */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    // 읽기만 되고 쓰기가 막힌 환경이 있다. 기동 때 한 번 실제로 써 본다.
    const probe = `${KEY_PREFIX}:probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

export type CanvasLoad = {
  config: CanvasConfig;
  /** 어느 층에서 왔는가 — 되돌리기 버튼을 켤지 판정할 재료다. */
  source: 'user' | 'default' | 'empty';
  notices: string[];
  /** 저장이 되는가. false 면 실패 1(저장소 막힘)이고 화면은 한 줄만 적는다. */
  writable: boolean;
};

export type CanvasDeps = {
  storage: StorageLike | null;
  /** 층 ① — 대본 사이드카의 기본 구성. 없으면 null 이고 빈 캔버스로 간다. */
  defaults(missionId: string, slot: string): CanvasConfig | null;
};

/** 읽는 순서 ② → ① → 빈 캔버스. */
export function loadCanvas(missionId: string, slot: string, taskIds: ReadonlySet<string>, deps: CanvasDeps): CanvasLoad {
  const notices: string[] = [];
  let raw: string | null = null;
  let writable = deps.storage !== null;
  if (deps.storage !== null) {
    try {
      raw = deps.storage.getItem(canvasKey(missionId, slot));
    } catch {
      writable = false;
    }
  }
  const parsed = parseCanvas(raw);
  if (parsed.notice !== null) notices.push(parsed.notice);
  const base = parsed.config ?? deps.defaults(missionId, slot);
  const source: CanvasLoad['source'] = parsed.config !== null ? 'user' : base !== null ? 'default' : 'empty';
  const settled = reconcile(base ?? emptyCanvas(), taskIds);
  notices.push(...settled.notices);
  return { config: settled.config, source, notices, writable };
}

/** 쓰는 것은 층 ② 뿐이다. 실패해도 화면은 계속 돈다 — 돌려주는 값은 「저장됐는가」다. */
export function saveCanvas(missionId: string, slot: string, config: CanvasConfig, deps: CanvasDeps): boolean {
  if (deps.storage === null) return false;
  try {
    deps.storage.setItem(canvasKey(missionId, slot), JSON.stringify(config));
    return true;
  } catch {
    return false;
  }
}

/** 층 ③ 되돌리기 — ②를 지운다. 다음 적재가 ①(또는 빈 캔버스)로 간다. */
export function clearCanvas(missionId: string, slot: string, deps: CanvasDeps): void {
  if (deps.storage === null) return;
  try {
    deps.storage.removeItem(canvasKey(missionId, slot));
  } catch {
    // 저장소가 막힌 것과 같은 자리다 — 조용히 진행한다.
  }
}
