import type { MissionTaskStatus } from '../shared/statusTypes.ts';

export type TaskStatus = MissionTaskStatus;
export type Connection = 'online' | 'offline' | 'maintenance';
export type Hardware = { id: string; kind: string; connection: Connection; battery: number; rssi: number; latency: number; ip: string; firmware: string; temperature: number; heartbeat: string };
export type ActionItem = { id: string; label: string; params: Record<string, string | number>; status: TaskStatus };
/**
 * 대본 재생(260831) 확장 — 대체가 아니다.
 *  - `target`: 대상 장비가 없는 태스크(임무 종료 처리)는 null. 옛 파일은 전부 문자열이다.
 *  - `milestone`: 이 태스크가 접히는 마일스톤. 옛 파일에는 없다(전부 MS-C 암묵 —
 *    적재할 때 채운다). 마일스톤 상태는 태스크 상태를 접은 결과라서 이 연결이 필요하다.
 */
/**
 * 노드 문법 5종 (260831 — 노드 분화). 마일스톤을 임의로 쪼개지 않기 위한 규칙이다:
 * sense(관측) · decide(판정) · act(구동) · verify(검증) · report(보고).
 */
export type NodeKind = 'sense' | 'decide' | 'act' | 'verify' | 'report';
export type Task = { id: string; title: string; deps: string[]; target: string | null; actionItems: ActionItem[]; milestone?: string; nodeKind?: NodeKind; evaluation?: { criteria: string[]; judgedBy: 'ai' | 'backend' | 'human' } };
/**
 * 되돌아가는 참조 엣지 (260831 — 2편 재탐색 루프). **`deps` 가 아니다** —
 * `graph/layout.ts` 의 depths() 에 순환이 들어가면 안 되므로, 레이아웃·깊이 계산에는
 * 넣지 않고 점선으로 **그리기만** 한다. 그리지 않으면 사용자는 대본이 되돌아간다는 것을 모른다.
 */
export type RefEdge = { from: string; to: string; label: string; note?: string };
/**
 * `status` 는 옛 파일의 정적 필드다 — **무시하되 지우지 않는다.** 마일스톤 상태는
 * `statusesAt()` 이 태스크 상태를 접어 돌려준다(되감기와 어긋나지 않게).
 * 태스크가 없는 마일스톤(옛 파일의 MS-A·B·D~G)만 이 정적 값으로 그린다 — 접을 재료가 없다.
 */
export type Milestone = { id: string; title: string; status?: TaskStatus; assignedTargets: string[] };
/** `payload`(평가 근거값·파생 사유)와 `derivedFrom` 은 대본 확장 — 옛 파일에는 없다. */
export type ScenarioEvent = { seq: number; atSec: number; nodeId: string; status: TaskStatus; kind: string; producedBy: 'ai' | 'backend' | 'human'; attempt?: number; payload?: Record<string, unknown>; derivedFrom?: string };
/**
 * 번들 임무 형식. 옛 파일(MSN-260826-01)이 그대로 유효하고, 대본(MSN-260831-**)은
 * `hardware` 대신 `cast` 를 갖는다(선택 필드 — src/scenarios/types.ts 의 ScriptScenario 참조).
 */
export type Scenario = { missionId: string; utterance: { text: string; engine: string; confidence: number; audioRef: string | null }; durationSec: number; milestones: Milestone[]; hardware?: Hardware[]; tasks: Task[]; events: ScenarioEvent[] };
