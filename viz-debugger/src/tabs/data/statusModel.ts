// 이식: web-dashboard/src/data/statusModel.ts @ 700ed91 — 무수정 (transport 경로만 조정)
/**
 * src/data/statusModel.ts
 *
 * 상태 3층 → 화면 표시 4종 파생 (REQ-203 / REQ-205 / VZ-U-01).
 *
 * **3층 원본을 그대로 보관하고 표시값은 여기서 파생시킨다.** 단일 값으로 뭉쳐 저장하면
 * "연결은 됐는데 기기가 fault"와 "값이 오래됨"을 표현할 수 없고, 원천(기기·서버·오케스트레이터)이
 * 섞여 책임 소재가 흐려진다. 세 층은 각각 다른 주체가 채우고 화면이 조합할 뿐이다.
 *
 * **stale 판정은 여기서 하지 않는다.** 서버가 last_seen과 서버 시각으로 이미 끝냈다.
 * 클라이언트가 계산하면 사용자 PC 시계에 의존하게 된다.
 */

import type { StateLayers } from '../../transport/index.ts';

export type DisplayStatus = 'normal' | 'fault' | 'not_deployed' | 'unknown';

export const DISPLAY_STATUS_LABEL: Record<DisplayStatus, string> = {
  normal: '정상',
  fault: '장애',
  not_deployed: '의도적 미배포',
  unknown: '판단 불가',
};

/**
 * 목업 오른쪽 매핑표 그대로.
 *
 * | device_status | availability | deployment    | 화면 표시     |
 * |---------------|--------------|---------------|--------------|
 * | ok            | online       | deployed      | 정상          |
 * | fault         | online       | deployed      | 장애          |
 * | —             | offline      | deployed      | 장애          |
 * | ok            | stale        | deployed      | 판단 불가      |
 * | —             | —            | not_deployed  | 의도적 미배포   |
 *
 * 판정 순서에 의미가 있다.
 *  - deployment 가 먼저다. 안 켠 것은 고장이 아니다.
 *  - offline 이 device_status 보다 먼저다. 연락이 끊겼으면 기기 자기보고는 과거의 말이다.
 *  - stale 도 device_status 보다 먼저다. 같은 이유로 **ok + stale 은 정상이 아니라 판단 불가**다.
 *    (마지막으로 들은 "나 괜찮아"가 몇 분 전 것이라면 그건 현재값이 아니다)
 */
export function deriveDisplayStatus(layers: StateLayers | null): DisplayStatus {
  // 상태 봉투를 아직 한 번도 못 받았다면 판단할 근거가 없다.
  if (layers === null) return 'unknown';

  if (layers.deployment !== 'deployed') return 'not_deployed';
  if (layers.availability === 'offline') return 'fault';
  if (layers.availability === 'stale') return 'unknown';
  if (layers.availability !== 'online') return 'unknown';

  if (layers.device_status === 'fault') return 'fault';
  if (layers.device_status === 'ok') return 'normal';

  // 연결은 살아 있으나 기기가 자기보고를 한 적이 없는 경우(엣지노드 등).
  return layers.device_status === null ? 'normal' : 'unknown';
}

/** 3층을 사람이 읽는 한 줄로. 값이 없는 층은 목업처럼 '—'. */
export function formatLayers(layers: StateLayers | null): string {
  if (layers === null) return '— · — · —';
  const dev = layers.device_status === null ? '—' : 'device ' + layers.device_status;
  const avail = layers.availability ?? '—';
  return dev + ' · ' + avail + ' · ' + layers.deployment;
}

/**
 * "최근 수신 N초 전".
 *
 * **두 시각 모두 서버 시각이다** — 봉투의 ts(서버가 봉투를 만든 시각)에서
 * last_seen(서버가 마지막으로 받은 시각)을 뺀다. 클라이언트 시계가 개입하지 않는다.
 * 그래서 이 값은 봉투가 도착할 때만 갱신되며, 상태 채널이 5초마다 재발행되는 이유가 이것이다.
 */
export function lastSeenAgeMs(layers: StateLayers | null, envelopeTs: string | null): number | null {
  if (layers?.last_seen == null || envelopeTs === null) return null;
  const age = Date.parse(envelopeTs) - Date.parse(layers.last_seen);
  return Number.isFinite(age) ? Math.max(0, age) : null;
}

export function formatAge(ms: number | null): string {
  if (ms === null) return '수신 이력 없음';
  if (ms < 1000) return '최근 수신 ' + (ms / 1000).toFixed(2) + '초 전';
  if (ms < 60_000) return '최근 수신 ' + Math.round(ms / 1000) + '초 전';
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return '최근 수신 ' + min + '분 ' + sec + '초 전';
}
