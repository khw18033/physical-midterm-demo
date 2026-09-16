/**
 * src/data/audit.ts
 *
 * 감사 이력 조회 (VZ-I-05).
 *
 * **조회 키는 상관 키(`command_id`)다.** `BE-X-01`이 "가시화 요청부터 디바이스 실행·결과·
 * 감사까지 이 키로 사슬을 잇는다"고 정의하므로, 화면도 그 키로 되짚어야 사슬이 검증된다.
 * 대상(entity) 조회는 "이 대상을 마지막으로 조작한 사람"을 묻는 보조 경로로 남긴다.
 *
 * **컴포넌트가 상관 키를 다루지 않는다.** 요청 하나를 넘기면 이 파일이 추적기에서
 * 조회 키를 꺼내 쓴다 — 키가 몇 개인지는 데이터 레이어 안에서 끝난다.
 *
 * **패널을 열 때만 조회한다. 주기 폴링을 만들지 않는다.**
 * 감사는 확정된 과거 기록이라 폴링해도 새 값이 나오지 않고, 진행 중인 명령의 상태 변화는
 * command_result 푸시로 이미 도달하므로 주기 조회는 그냥 중복이다.
 *
 * 이 파일에는 감사 **필드 이름이 없다.** 이름 해석은 auditFieldMap 한 곳에서만 한다.
 */

import { GATEWAY } from '../transport/index.ts';
import { toAuditEntry, type AuditEntry } from './auditFieldMap.ts';
import { commandTracker, type TrackedCommand } from './commands.ts';

export type AuditQueryResult = {
  entries: AuditEntry[];
  error: string | null;
  /** 서버가 무엇으로 조회했는지 되돌려 준 값. 화면이 "상관 키로 조회했다"를 보이는 근거. */
  queriedBy: 'command_id' | 'entity' | 'all' | null;
  queriedKey: string | null;
  /** 서버가 센 누적 조회 횟수. 주기 폴링이 없다는 것을 숫자로 확인하는 계측값. */
  serverQueryCount: number | null;
};

const EMPTY: AuditQueryResult = {
  entries: [],
  error: null,
  queriedBy: null,
  queriedKey: null,
  serverQueryCount: null,
};

/**
 * 감사 조회.
 *
 * `command`를 주면 **그 요청의 상관 키로** 조회한다(1차 경로). 아직 ACK가 오지 않아
 * 상관 키가 없으면 조회할 사슬 자체가 없으므로, `entity`로 물러나 "이 대상의 최근 조작"을
 * 보여준다.
 */
export async function fetchAuditTrail(
  target: { command?: TrackedCommand | null; entity?: string | null },
  limit = 10,
): Promise<AuditQueryResult> {
  const commandId = target.command ? commandTracker.auditKeyFor(target.command.requestId) : null;

  const params = new URLSearchParams();
  if (commandId !== null) params.set('command_id', commandId);
  else if (target.entity) params.set('entity', target.entity);
  else return EMPTY;
  params.set('limit', String(limit));

  try {
    const res = await fetch(GATEWAY.http + '/audit?' + params.toString());
    if (!res.ok) {
      return { ...EMPTY, error: '감사 조회 응답 ' + res.status };
    }
    const body = (await res.json()) as {
      records?: unknown[];
      queried_by?: AuditQueryResult['queriedBy'];
      queried_key?: string | null;
      _query_count?: number;
    };
    return {
      entries: (body.records ?? []).map(toAuditEntry),
      error: null,
      queriedBy: body.queried_by ?? null,
      queriedKey: body.queried_key ?? null,
      serverQueryCount: body._query_count ?? null,
    };
  } catch (e) {
    // 감사 저장소에 닿지 못해도 제어 화면 자체는 살아 있어야 한다 (VZ-C-02).
    return { ...EMPTY, error: '감사 조회 실패 — ' + String(e) };
  }
}
