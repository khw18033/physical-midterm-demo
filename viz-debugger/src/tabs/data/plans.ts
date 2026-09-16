// 이식: web-dashboard/src/data/plans.ts @ 700ed91 — 무수정 (transport 경로만 조정)
/**
 * src/data/plans.ts
 *
 * 계획 승인 (VZ-U-07) · 서브태스크 진행 (VZ-U-05).
 *
 * 화면은 `plan`과 `plan_progress` 두 채널을 받는다.
 *  - `plan`          : 계획 본문 + 근거 + 승인 상태. 승인/거부 시점에만 바뀐다.
 *  - `plan_progress` : 구간 상태. 하달·시작·완료·실패 **네 시점에만** 온다.
 *
 * **주기 폴링이 없다.** 구간 상태는 그 네 시점에만 바뀌므로 폴링은 전부 낭비이고,
 * 수행 결과가 로봇 상태 데이터에 실려 오므로 별도 조회 경로도 필요 없다.
 */

import { getTransport } from '../../transport/index.ts';

export type SegmentStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export const SEGMENT_STATUS_LABEL: Record<SegmentStatus, string> = {
  pending: '대기',
  running: '진행중',
  done: '완료',
  failed: '실패',
  // 앞 구간이 실패해 **하달 자체가 되지 않은** 구간. '대기'와 구분해야
  // "왜 5구간이 안 돌았나"가 화면에서 설명된다.
  skipped: '건너뜀',
};

export type PlanSegment = {
  index: number;
  total: number;
  title: string;
  zone: string;
  status: SegmentStatus;
  elapsed_s: number | null;
  failure: {
    failed_stage: string;
    reason: string;
    dispatched_at: string;
    acked_at: string | null;
    failed_at: string;
    judged_by: string;
  } | null;
};

/**
 * 근거 한 조각이 **누구의 산출물인가** (BE-X-04).
 *
 * AI는 계획 생성(AI-D-01)과 검증(AI-D-02)까지고, 가시화 전달·승인 수신·엣지 발행은
 * 백엔드 중계 구간이다. 근거를 한 덩어리로 보여주면 나중에 승인이 안 먹었을 때
 * "AI가 계획을 못 만든 것"과 "백엔드 중계가 끊긴 것"을 화면에서 가를 수 없다.
 */
export type ProducedBy = 'ai' | 'backend' | 'human';

export const PRODUCED_BY_LABEL: Record<ProducedBy, string> = {
  ai: 'AI 산출',
  backend: '백엔드 중계',
  human: '사람 판단',
};

export type ProvenanceStep = {
  stage: string;
  produced_by: ProducedBy;
  /** 어느 요구사항이 이 구간의 담당을 정하는가. */
  ref: string;
  at: string | null;
  detail: string;
};

export type PlanEvidence = {
  mission: { id: string; title: string; requested_by: string; created_at: string };
  zones: Array<{ zone: string; order: number; segment_count: number }>;
  /** AI 산출물(AI-D-02). */
  validations: Array<{ rule: string; result: 'pass' | 'warn'; detail: string }>;
  /** AI 산출물의 출처 표시. */
  generator: { name: string; version: string; context_version: string };
  /** 어디까지가 AI 산출이고 어디부터가 백엔드 중계인가. */
  provenance: ProvenanceStep[];
};

export type Plan = {
  plan_id: string;
  entity: string;
  decision: 'pending' | 'approved' | 'rejected';
  decided_at: string | null;
  reject_reason: string | null;
  evidence: PlanEvidence;
  segments: PlanSegment[];
  /** BE-X-01 — **백엔드가 발급한** 상관 키. plan_id와의 매핑도 백엔드가 보유한다. */
  command_id: string | null;
  /** BE-X-04 — 계획이 온 경로와 승인이 돌아가는 곳. */
  route: {
    generated_by: string;
    delivered_by: string;
    decision_returns_to: string;
    dispatches_to: string;
  };
  /** 승인 수신 → 엣지·로봇 발행 사이의 중계 상태. */
  relay_stage: 'awaiting_decision' | 'decision_received' | 'dispatched' | 'halted';
  /**
   * 대본 조회에서 나온 계획인가 (260831). 있으면 생성 주체가 LLM/AI가 아니라
   * **키워드 대조**다 — 화면이 그 사실을 감추면 안 된다 (REQ-1207).
   */
  script?: {
    mission_id: string;
    title: string;
    matched_keywords: string[];
    world: 'registry' | 'legacy';
  };
};

export const RELAY_STAGE_LABEL: Record<Plan['relay_stage'], string> = {
  awaiting_decision: '승인 대기 — 백엔드가 전달만 한 상태',
  decision_received: '백엔드가 승인을 받았다 — 아직 발행 전',
  dispatched: '백엔드가 엣지·로봇으로 발행했다',
  halted: '거부 수신 — 발행되지 않았다',
};

/**
 * 승인/거부 발행.
 *
 * **중계자는 백엔드다**(BE-X-04). 가시화는 AI와 직접 주고받지 않는다 —
 * 승인도 거부도 백엔드 채널로 나가고, 승인된 계획만 백엔드가 엣지·로봇으로 발행한다.
 * 승인 전에는 서버가 진행 이벤트를 내보내지 않는다.
 */
export function decidePlan(planId: string, decision: 'approve' | 'reject', reason?: string): void {
  getTransport().decidePlan(planId, decision, reason);
}

/** 근거를 산출 주체별로 가른다. 화면이 두 구간을 나눠 그릴 수 있게. */
export function splitProvenance(steps: ProvenanceStep[]): { ai: ProvenanceStep[]; backend: ProvenanceStep[] } {
  return {
    ai: steps.filter((s) => s.produced_by === 'ai'),
    backend: steps.filter((s) => s.produced_by !== 'ai'),
  };
}

/**
 * 진행률 요약 — 완료 구간 수 / 전체.
 *
 * **2026-09-01 이후 이 값을 그리는 화면이 없다.** 계획 구간은 마일스톤과 같은 값이라
 * 탭①의 승인 패널에서 구간 진행 화면을 지웠다(요구사항정의서 §3.1 의 `VZ-U-05` 판단).
 * 그래도 `plan_progress` 수신·저장과 이 요약은 **남긴다** — 백엔드와의 수신 계약을
 * 화면 사정으로 죽이지 않는다. 다시 그릴 자리가 생기면 여기서 꺼내 쓴다.
 */
export function planProgressSummary(segments: PlanSegment[]): { done: number; total: number; failedAt: number | null } {
  const done = segments.filter((s) => s.status === 'done').length;
  const failed = segments.find((s) => s.status === 'failed');
  return { done, total: segments.length, failedAt: failed?.index ?? null };
}
