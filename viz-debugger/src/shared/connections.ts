/**
 * src/shared/connections.ts (260904 — `VZ-C-07` 연결 대상 설정 · 추가 개선 3)
 *
 * **접속 주소의 런타임 원천.** 지금까지 주소는 빌드 시점 환경변수였다.
 *
 * ```
 * transport/index.ts   VITE_GATEWAY_WS / VITE_GATEWAY_HTTP
 * stt/SttClient.ts     (STT 주소 — 그 파일 안에서만 읽는다)
 * ```
 *
 * 바꾸려면 다시 빌드해야 했다. 현장에서 게이트웨이·제어 노드 IP가 바뀔 때마다 빌드할 수는
 * 없다. 그래서 **환경변수를 기본값으로 두고 화면에서 덮어쓴다.**
 *
 * ## 지켜야 하는 것 넷 (지시서 §3)
 *
 * 1. **출입구는 여전히 하나다.** 이 모듈은 주소만 들고 있고 연결을 만들지 않는다.
 *    `getTransport()` 싱글턴은 그대로이고, 주소가 바뀌면 **끊고 다시 붙는다**(새 인스턴스를
 *    만들지 않는다 — 만들면 구독이 통째로 날아간다). 여기저기서 URL 을 읽게 하면
 *    `verify:one-gateway` 가 무너진다.
 * 2. **대상 목록이 한 곳에 있다.** 화면은 이 목록을 그린다 — 손으로 넷을 적지 않는다.
 * 3. **새로고침에 살아남는다.** `localStorage` 이고 **키는 앱 전역**이다(임무별이 아니다 —
 *    접속 주소는 임무의 성질이 아니라 이 설치본의 성질이다). 저장소가 막혔으면 `try/catch`
 *    로 기본값으로 조용히 진행한다.
 * 4. **되돌아올 길이 있다.** 틀린 주소를 넣으면 아무 데도 못 붙으므로 기본값 복원이 필요하다.
 *
 * ## 상단의 `conn` 배지와 섞지 않는다
 *
 * 배지는 **상태**(지금 붙어 있나)이고 이 모듈은 **설정**(어디에 붙을 것인가)이다.
 * 둘을 한 곳에 두면 「연결 안 됨」이 주소가 틀린 것인지 서버가 죽은 것인지 알 수 없어진다.
 *
 * ## STT·생성의 기본값은 여기서 읽지 않는다
 *
 * STT 주소를 아는 곳은 `src/stt/` 뿐이어야 하고(`verify:no-stt`), 생성 주소를 아는 곳은
 * `src/generate/` 뿐이어야 한다(`verify:gen-port`) — 면이 둘이 되면 안 된다.
 * 그래서 각자 자기 환경변수를 읽어 `registerConnectionDefault()` 로 **기본값만 심는다.**
 * 여기 적힌 값은 그 전에 화면이 그릴 대비값이다.
 */

import { useSyncExternalStore } from 'react';

export type ConnectionTargetId = 'gateway' | 'stt' | 'generate' | 'physical' | 'detect' | 'control-node' | 'digital-twin';

export type ConnectionField = {
  key: string;
  label: string;
  /** 기본값. 환경변수가 있으면 그것이 이긴다(아래 `seed`). */
  fallback: string;
};

export type ConnectionTarget = {
  id: ConnectionTargetId;
  label: string;
  /**
   * 무엇을 위해 붙는가. 화면이 그대로 적는다.
   *
   * **없어도 된다** (260913 지시). 늘 쓰는 대상(로봇·객체 탐지)은 매번 읽을 문장이 아니라
   * 빼 뒀다 — 자리가 그만큼 줄고, 주소 칸이 먼저 눈에 들어온다.
   */
  what?: string;
  fields: readonly ConnectionField[];
  /**
   * 지금 **실제로 붙는가.** false 면 주소를 넣어도 붙을 곳이 없다 — 자리만 두고
   * 「연결 예정」으로 표시한다. 없는 것을 있는 척하지 않는다(다른 자리표시와 같은 규칙).
   */
  live: boolean;
  /** `live: false` 의 사유. 있는 것만 적는다. */
  pending?: string;
};

/** **대상 목록의 유일한 원천.** 화면은 이것을 그린다. */
/**
 * **대상 목록의 유일한 원천.** 화면은 이것을 그린다.
 *
 * **순서가 화면의 순서다** (260912 지시). 지금 실제로 쓰는 둘 — 로봇과 객체 탐지 — 이
 * 맨 위다. 시연 직전에 확인해야 하는 것이 그 둘이고, 아래로 내려가면 스크롤한 만큼
 * 늦게 눈에 들어온다. 나머지는 쓰던 순서 그대로 뒤에 선다.
 */
export const CONNECTION_TARGETS: readonly ConnectionTarget[] = [
  {
    id: 'physical',
    label: '로봇 (MQTT 브로커)',
    live: true,
    // **주소를 여기 적지 않는다.** stt·generate 는 대비값을 여기 두지만, 로봇은
    // 주소·토픽·장비 id 가 한 곳에만 있어야 한다는 제약이 더 세다(`verify:physical-port`) —
    // 브로커를 옮기거나 중앙 서버 경유로 바꿀 때 한쪽만 고쳐지면 화면이 「붙었다」고
    // 말하면서 아무것도 못 받는다. 기본값은 `src/physical/PhysicalClient.ts` 가 심는다.
    fields: [{ key: 'ws', label: 'WebSocket', fallback: '' }],
  },
  {
    id: 'detect',
    label: '객체 탐지',
    live: true,
    // 설명도 자리표시 문구도 없다 (260913 지시). 주소가 비었을 때 무엇을 할 수 있는지는
    // 아래 「상태」 줄이 그때그때 말한다 — 늘 떠 있는 문장이 아니라 그 상태의 사유다.
    //
    // **주소를 여기 적지 않는다** (260914). 로봇과 같다 — 기본값(Tailscale)은
    // `src/detect/DetectClient.ts` 가 `src/detect/presets.ts` 에서 꺼내 심는다.
    fields: [{ key: 'base', label: '주소', fallback: '' }],
  },
  {
    id: 'gateway',
    label: '백엔드 WS 게이트웨이',
    what: '구독·명령·레지스트리 — 화면의 값 대부분이 이 하나를 지난다',
    live: true,
    fields: [
      { key: 'ws', label: 'WebSocket', fallback: 'ws://127.0.0.1:8790' },
      { key: 'http', label: 'HTTP', fallback: 'http://127.0.0.1:8790' },
    ],
  },
  {
    id: 'stt',
    label: 'STT 서비스',
    what: '발화 전사. 꺼져 있어도 화면은 뜨고 수동 입력이 열려 있다 (VZ-C-02)',
    live: true,
    fields: [{ key: 'base', label: '주소', fallback: 'http://127.0.0.1:8801' }],
  },
  {
    id: 'generate',
    label: '생성 서비스',
    what: '발화 → 임무 객체 (VZ-G-01·VZ-G-02). 꺼져 있으면 생성만 꺼지고 대본 재생·되감기·캔버스는 그대로 돈다',
    live: true,
    fields: [{ key: 'base', label: '주소', fallback: 'http://127.0.0.1:8802' }],
  },
  {
    id: 'control-node',
    label: '제어 노드',
    what: '엣지 제어 노드로의 직접 경로',
    live: false,
    pending: '상대 없음 — 주소를 넣어도 붙을 곳이 아직 없습니다. 자리만 잡아 둡니다',
    fields: [{ key: 'base', label: '주소', fallback: '' }],
  },
  {
    id: 'digital-twin',
    label: '디지털 트윈',
    what: '별도 네이티브 뷰어(Unity) — `VZ-U-02`',
    live: false,
    pending: '상대 없음 — 뷰어가 붙는 방식이 정해지지 않았습니다. 자리만 잡아 둡니다',
    fields: [{ key: 'base', label: '주소', fallback: '' }],
  },
];

/** `대상.칸` — 저장과 조회의 키. 화면도 이 함수로 키를 만든다. */
export function connectionKey(target: ConnectionTargetId, field: string): string {
  return `${target}.${field}`;
}

/**
 * 저장 칸. **앱 전역이다** — 임무별이 아니다. 판(v1)을 붙여 두어 모양이 바뀌면 옛 값을
 * 조용히 버릴 수 있게 한다(캔버스 구성과 같은 규칙).
 */
const STORAGE_KEY = 'viz.connections.v1';

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** 기본값 — 환경변수가 있으면 그것이 이긴다. 사용자가 덮어쓰기 전까지 이 값이 쓰인다. */
const defaults = new Map<string, string>();
for (const target of CONNECTION_TARGETS) {
  for (const field of target.fields) defaults.set(connectionKey(target.id, field.key), field.fallback);
}
defaults.set('gateway.ws', env.VITE_GATEWAY_WS ?? defaults.get('gateway.ws')!);
defaults.set('gateway.http', env.VITE_GATEWAY_HTTP ?? defaults.get('gateway.http')!);

/**
 * 자기 환경변수를 읽는 모듈이 **기본값만** 심는다. 사용자가 덮어쓴 값은 건드리지 않는다.
 * `src/stt/` 가 이것을 쓴다 — STT 주소를 아는 면은 그쪽 하나여야 하기 때문이다.
 */
export function registerConnectionDefault(target: ConnectionTargetId, field: string, value: string): void {
  const key = connectionKey(target, field);
  if (defaults.get(key) === value) return;
  defaults.set(key, value);
  notify();
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // 사파리 비공개 창처럼 **접근 자체가 던지는** 경우가 있다.
    return null;
  }
}

function readOverrides(): Record<string, string> {
  try {
    const raw = storage()?.getItem(STORAGE_KEY) ?? null;
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') result[key] = value.trim();
    }
    return result;
  } catch {
    // 판이 다르거나 깨졌으면 버린다. 기본값으로 조용히 진행한다 — 여기서 던지면 앱이 안 뜬다.
    return {};
  }
}

let overrides: Record<string, string> = readOverrides();
const listeners = new Set<() => void>();
/** `useSyncExternalStore` 는 같은 참조를 돌려받아야 다시 그리지 않는다. */
let snapshot: Readonly<Record<string, string>> = merged();

function merged(): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of defaults) result[key] = value;
  for (const [key, value] of Object.entries(overrides)) result[key] = value;
  return result;
}

function notify(): void {
  snapshot = merged();
  for (const listener of listeners) listener();
}

/** 이 설치본이 지금 쓰는 주소 전부. 기본값 위에 사용자 값이 얹힌 결과다. */
export function connectionAddresses(): Readonly<Record<string, string>> {
  return snapshot;
}

/** 한 칸. 없는 키면 빈 문자열이다 — 던지지 않는다. */
export function connectionAddress(target: ConnectionTargetId, field: string): string {
  return snapshot[connectionKey(target, field)] ?? '';
}

/** 사용자가 덮어쓴 것만. 화면이 「기본값과 다름」을 표시하는 데 쓴다. */
export function connectionOverrides(): Readonly<Record<string, string>> {
  return overrides;
}

/** 저장이 되는 창인가. 안 되면 화면이 그 사실을 숨기지 않는다. */
export function connectionsWritable(): boolean {
  return storage() !== null;
}

/**
 * 주소를 바꾼다. 기본값과 같은 칸은 저장하지 않는다 — 나중에 기본값이 바뀌면 따라가야 한다.
 * @returns 저장까지 됐는가. 저장소가 막혀 있으면 이번 세션에만 적용된다(false).
 */
export function saveConnections(next: Readonly<Record<string, string>>): boolean {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === defaults.get(key)) continue;
    cleaned[key] = trimmed;
  }
  overrides = cleaned;
  notify();
  try {
    const store = storage();
    if (store === null) return false;
    if (Object.keys(cleaned).length === 0) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    return true;
  } catch {
    return false;
  }
}

/** **되돌아올 길.** 틀린 주소를 넣으면 아무 데도 못 붙는다 — 이 길이 없으면 갇힌다. */
export function resetConnections(): void {
  saveConnections({});
}

export function subscribeConnections(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useConnections(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribeConnections, connectionAddresses, connectionAddresses);
}
