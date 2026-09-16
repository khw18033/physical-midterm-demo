/**
 * src/transport/Transport.ts
 *
 * 상위 코드가 보는 **유일한 면**. 이 인터페이스에는 WebSocket·토픽·프레임이 없다.
 * 백엔드가 논리 구독 대신 토픽 문자열을 고르면 이 인터페이스의 구현만 바뀐다.
 */

import type {
  CommandAck,
  CommandRequest,
  ConnectionStatus,
  Envelope,
  RoleInfo,
  ScopeSpec,
  Selector,
} from './types.ts';

export type Unsubscribe = () => void;

export interface Transport {
  /** 연결 시작. 이미 열려 있으면 무시. */
  connect(): void;
  /** 연결 종료. 자동 재연결도 멈춘다. */
  close(): void;

  /**
   * 계약 축으로 구독한다. 반환된 함수를 부르면 해제된다.
   *
   * 구현체가 반드시 지켜야 하는 것 둘:
   *  - 재연결 시 **기존 구독을 자동 복원**한다. 호출자는 다시 구독하지 않는다.
   *  - 서버가 구독 즉시 보내는 현재값(VZ-I-02)을 그대로 흘려보낸다. 걸러내지 않는다.
   */
  subscribe(selector: Selector, handler: (envelope: Envelope) => void, scope?: ScopeSpec): Unsubscribe;

  /** 연결 상태 구독. 화면 상단 배너용. */
  onStatus(handler: (status: ConnectionStatus) => void): Unsubscribe;
  getStatus(): ConnectionStatus;

  /**
   * VZ-C-01 / VZ-C-04 — 현재 역할과 **그 역할이 적용되는 범위**.
   * 로그인 시 1회 + 토큰 갱신 시 재조회다. 주기 조회가 아니므로 여기에 인터벌이 없다.
   */
  fetchRole(): Promise<RoleInfo>;

  /**
   * VZ-O-01 — 추상 명령 발행.
   *
   * 이 메서드는 **논리 계약**이지 전송 방식이 아니다. 토픽 방식으로 갈아끼워도
   * 시그니처는 그대로다.
   *
   * 반환 Promise는 **ACK**다 — 접수 여부와 함께 백엔드가 발급한 `command_id`가 실려 온다.
   * 이후 진행 단계는 command_result 채널 구독으로 `command_id`만 달고 도착한다.
   * 두 경로가 다른 이유는 접수 응답은 즉답이지만 수행 결과는 물리 시간이 걸리기 때문이고,
   * **그래서 두 키의 매핑이 필요하다.** 매핑 보관은 이 계층이 아니라 데이터 레이어의 일이다
   * (src/data/correlation.ts) — 전송 방식을 갈아끼워도 매핑 규칙은 그대로여야 하기 때문이다.
   *
   * ACK 자체가 오지 않을 수 있다. 그 경우 `commandId`가 null인 결과가 돌아온다.
   */
  publishCommand(command: CommandRequest): Promise<CommandAck>;

  /**
   * VZ-U-07 — 계획 승인/거부.
   *
   * **중계자는 백엔드다**(BE-X-04). 가시화는 AI와 직접 주고받지 않는다 —
   * 승인도 거부도 백엔드 채널로 나가고, 승인된 계획만 백엔드가 엣지·로봇으로 발행한다.
   * 판정 결과는 `plan` 채널로 되돌아온다. **승인 전에는 진행 이벤트가 없다.**
   */
  decidePlan(planId: string, decision: 'approve' | 'reject', reason?: string): void;

  /**
   * VZ-I-06 — 영상 패널 열기/닫기.
   * 열린 패널만 프레임을 받는다. 전 카메라 상시 재생은 무선 대역폭과
   * 브라우저 디코딩을 동시에 낭비한다.
   */
  setVideoPanel(entity: string, open: boolean): void;

  /**
   * 시나리오 재생 트리거. **목 게이트웨이 전용 개발 기능**이며 실제 게이트웨이에는 없다.
   * 제어 명령 발행 경로가 아니다 — 명령은 목 서버 안에서만 왕복한다.
   */
  playScenario?(name: string): void;
}
