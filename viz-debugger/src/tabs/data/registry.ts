// 이식: web-dashboard/src/data/registry.ts @ 700ed91 — 무수정 (transport 경로만 조정)
/**
 * src/data/registry.ts
 *
 * 구성(레지스트리) 조회 — VZ-I-03 / REQ-304·305.
 *
 * **화면이 "의도적 미배포"를 그릴 수 있는 유일한 근거가 이것이다.**
 * 미배포 대상은 값을 발행하지 않으므로, 상태 메시지만으로는 화면에 영원히 나타나지 않고
 * '의도적 미배포'와 '장애'를 구분할 수도 없다.
 *
 * 구성은 등록·배포·핸드오버 시점에만 바뀌므로 주기 폴링은 전부 낭비다.
 * 최초 진입 시 1회 조회하고, 변경 통지가 오면 갱신한다(통지 경로는 백엔드 확정 대기).
 */

import { GATEWAY } from '../../transport/index.ts';

export type RegistryEntity = {
  id: string;
  node: string;
  zone: string | null;
  entity_type: string;
  display_name: string;
  aliases: string[];
  channels: string[];
  /** 이 대상이 구현하는 컴포넌트 디스크립터(F1) id. 파이프라인 `componentRef`의 실물 대상. */
  component?: string;
  note?: string;
};

export type RegistryNode = {
  id: string;
  zone: string | null;
  display_name: string;
  aliases: string[];
  /** REQ-302 — Node 원점의 전역 배치. **변환은 백엔드가 하고 우리는 받아서 배치만 한다.** */
  origin: {
    position: { x: number; y: number; z: number };
    rotation: { yaw_deg: number; pitch_deg: number; roll_deg: number };
    frame?: string;
  };
};

export type RegistryZone = {
  id: string;
  display_name: string;
  aliases: string[];
  nodes: string[];
};

export type Registry = {
  registry_version: string;
  zones: RegistryZone[];
  nodes: RegistryNode[];
  entities: RegistryEntity[];
};

/**
 * REQ-204 — 레지스트리에 닿지 못해도 화면은 떠야 한다.
 * 다른 파트의 진척에 가시화가 블로킹되지 않기 위한 요건이므로, 실패 시 빈 구성을 돌려주고
 * 화면은 "구성을 못 받았다"는 사실 자체를 표시한다(값이 없는 것과 구성이 없는 것은 다르다).
 */
export const EMPTY_REGISTRY: Registry = {
  registry_version: '(미수신)',
  zones: [],
  nodes: [],
  entities: [],
};

export async function fetchRegistry(signal?: AbortSignal): Promise<{ registry: Registry; error: string | null }> {
  try {
    const res = await fetch(GATEWAY.http + '/registry', { signal });
    if (!res.ok) return { registry: EMPTY_REGISTRY, error: '레지스트리 응답 ' + res.status };
    const registry = (await res.json()) as Registry;
    return { registry, error: null };
  } catch (e) {
    return { registry: EMPTY_REGISTRY, error: '레지스트리 조회 실패 — ' + String(e) };
  }
}

export function zoneOf(registry: Registry, zoneId: string): RegistryZone | null {
  return registry.zones.find((z) => z.id === zoneId) ?? null;
}

export function entitiesOfZone(registry: Registry, zoneId: string): RegistryEntity[] {
  return registry.entities.filter((e) => e.zone === zoneId);
}
