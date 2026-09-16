/**
 * gateway/mission-trace.ts
 *
 * 탭①의 임무 실행 기록 재생 (`trace_event`).
 *
 * 통합 전 `gateway/server.mjs` 10줄이 하던 일이 여기로 접혔다. **반대 방향으로 합치면**
 * — 즉 10줄짜리를 본체로 두고 대시보드 게이트웨이를 그 안에 넣으면 — 4,757줄을 다시 짜게 된다.
 *
 * 접으면서 달라진 것 둘.
 *
 * 1. **엔벨로프를 직접 만들지 않고 `hub.publish()`를 거친다.** seq·ts·quality·scope·
 *    coordinate_frame 을 붙이는 규칙이 허브 안에 하나 있고, 여기서 또 만들면 두 벌이 된다.
 *    캐시 정책도 허브가 본다 — `trace_event` 는 캐시하지 않는다(config.ts 의 사유 참조).
 * 2. **`node` 축이 태스크 id 가 아니라 `mission-trace` 고정이다.** 옛 구현은 봉투의 `node` 에
 *    태스크 id 를 넣었는데, 허브의 node 축은 **레지스트리의 노드**를 가리키는 자리라
 *    거기에 태스크 id 를 넣으면 zone 매칭이 엉킨다. 태스크 id 는 payload 의 `node_id` 에
 *    그대로 있고, 그것이 `contracts/trace-event.schema.json` 의 필드 이름이기도 하다.
 *
 * 임무 대상은 `hub.runtime` 에만 등록하고 **`/registry` 응답에는 넣지 않는다.** 넣으면
 * 탭②의 구역 현황판에 임무가 장비처럼 한 칸 뜬다. 임무는 장비가 아니다.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Hub } from './hub.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 시나리오 원본. 브라우저 번들에도 같은 파일이 들어간다(게이트웨이 없이도 화면이 차게). */
const SCENARIO_PATH = join(HERE, '..', 'scenarios', 'MSN-260826-01.json');

/** 임무 기록의 node 축. 레지스트리 노드와 겹치지 않는 이름이어야 한다. */
export const MISSION_TRACE_NODE = 'mission-trace';

/** 재생 배속. 95초짜리 시나리오를 시연 중에 다 보려면 실시간은 너무 길다. */
const SPEED = Number(process.env.VIZ_SCENARIO_SPEED ?? 20);

type ScenarioEvent = {
  seq: number;
  atSec: number;
  nodeId: string;
  status: string;
  kind: string;
  producedBy: string;
  attempt?: number;
};

type Scenario = { missionId: string; durationSec: number; events: ScenarioEvent[] };

export function loadMissionScenario(): Scenario {
  return JSON.parse(readFileSync(SCENARIO_PATH, 'utf-8')) as Scenario;
}

/**
 * 임무를 허브의 런타임 대상으로 등록한다. `publish()` 가 레지스트리에 없는 대상을 거부하므로
 * 이 등록이 없으면 기록을 내보낼 수 없다.
 */
export function registerMission(hub: Hub, missionId: string): void {
  hub.runtime.set(missionId, {
    id: missionId,
    node: MISSION_TRACE_NODE,
    // zone 을 주지 않는다 — 구역 구독(`{node: 'zone-503'}`)에 임무가 딸려 오면 안 된다.
    zone: null,
    entityType: 'mission',
    deployment: 'deployed',
    deviceStatus: null,
    lastSeenMs: null,
    forcedOffline: false,
    note: '목 임무 시나리오 재생 (탭①)',
    lastAvailability: null,
    everPublished: false,
  });
}

/**
 * 시나리오를 배속으로 재생한다. 돌려주는 함수를 부르면 남은 타이머가 정리된다.
 *
 * 장치 채널과 달리 **주기 발행이 아니라 한 번의 타임라인**이다. 서버가 뜨는 순간 시작하고,
 * 끝나면 다시 돌지 않는다 — 되감기의 기준축은 재생 반복이 아니라 기록 열이기 때문이다.
 */
export function startMissionTrace(hub: Hub, log: (message: string) => void): () => void {
  const scenario = loadMissionScenario();
  registerMission(hub, scenario.missionId);

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  for (const event of scenario.events) {
    timers.push(
      setTimeout(() => {
        hub.publish(
          scenario.missionId,
          'trace_event',
          {
            // contracts/trace-event.schema.json 의 필드 이름을 그대로 쓴다.
            layer: 'task',
            node_id: event.nodeId,
            kind: event.kind,
            produced_by: event.producedBy,
            status: event.status,
            attempt: event.attempt ?? 1,
            seq: event.seq,
            at_sec: event.atSec,
            // 목임을 감추지 않는다.
            mock: true,
          },
          // 임무 기록은 장치가 보낸 것이 아니다. last_seen 을 건드리면 임무가 장비처럼
          // availability 판정을 받게 된다.
          { fromDevice: false },
        );
        log(
          '[trace ' + String(event.atSec).padStart(2, '0') + 's] ' +
            event.nodeId + ' → ' + event.status + ' (' + event.producedBy + ')',
        );
      }, (event.atSec * 1000) / SPEED),
    );
  }

  log(
    '임무 기록 재생 — ' + scenario.missionId + ' · 사건 ' + scenario.events.length +
      '건 · ' + SPEED + '배속 · 채널 trace_event',
  );

  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
  };
}
