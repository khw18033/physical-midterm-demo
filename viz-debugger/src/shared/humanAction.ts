/**
 * src/shared/humanAction.ts (260910 신설)
 *
 * **사람이 이번 세션에서 무언가를 했는가.** 빗장 하나짜리 모듈이다.
 *
 * 계획 채널은 **캐시되는 채널**이다 — 구독하는 순간 게이트웨이가 들고 있던 계획을 그대로
 * 다시 밀어 준다(`VZ-I-02` 「복원 즉시 서버가 현재값을 1회 푸시한다」). 그래서 앱을 열자마자
 * 지난 세션의 제안과 승인이 다시 들어오고, 그걸 새 것으로 받으면 **아무도 아무것도 안
 * 눌렀는데 화면이 임무로 찬다.**
 *
 * 260910 에 빈 화면을 기본으로 만들고 나서도 부팅 화면이 안 비었던 이유가 이것이다 —
 * 지난 판의 승인된 계획이 임무를 열고, 지난 판의 제안이 패널을 채웠다.
 *
 * 로봇 관문에는 이미 같은 빗장이 걸려 있다(`robotSession.approvedByHuman` — 캐시된 승인으로
 * 로봇이 움직이던 것을 막은 자리다). 임무에도 같은 것을 건다.
 *
 * ## 왜 `shell/` 이 아니라 여기인가
 *
 * 이 빗장을 여는 쪽은 발화 패널(`views/UtterancePanel`)과 승인 패널(`tabs/views/PlanApproval`)
 * 이고, 발화 패널은 **단독 빌드에도 들어간다.** 거기서 `shell/` 을 가져오면 셸과 탭 데이터
 * 계층이 통째로 단독 번들에 딸려 들어와 논문 측정축 D가 오염된다 — `verify:standalone` 이
 * 실제로 그 자리에서 잡았다. 그래서 공용 층에 둔다.
 *
 * 모듈 변수다. 새로고침하면 비고, **그것이 이 값의 요점이다.**
 */

let acted = false;

/** 사람이 발화를 냈다 · 승인을 눌렀다. 그 순간에만 부른다. */
export function noteHumanAction(): void {
  acted = true;
}

/** 이번 세션에서 사람이 무언가를 했는가. */
export function humanActed(): boolean {
  return acted;
}

/** 검사용. 화면에서는 부르지 않는다. */
export function resetHumanAction(): void {
  acted = false;
}
