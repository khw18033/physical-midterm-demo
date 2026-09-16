/**
 * src/generate/availability.ts (260904 신설 — 마일스톤 분리 지시서 §3)
 *
 * **생성 서비스가 없어도 화면이 뜬다** 는 제약을 코드로 붙잡아 두는 곳 (`VZ-G-01`·`VZ-G-02`).
 *
 * `stt/availability.ts` 와 **같은 모양이다.** 이 판단을 화면 컴포넌트 안에 조건문으로
 * 흩어 놓으면, 나중에 누가 조건 하나를 넓히면서 대본 재생이나 되감기까지 같이 잠가도
 * 아무도 모른다. 그래서 **"무엇이 켜지고 무엇이 꺼지는가"를 의존 없는 순수 함수 하나**로
 * 뽑아 두고, `verify:no-llm` 이 이 함수를 실제로 불러 검사한다.
 *
 * ## 꺼지는 것은 생성 하나뿐이다
 *
 * 배치 ①(생성 꺼짐)이 **기본형**이다 — 심사·평가 배포에는 `dist/` 만 뿌리고 생성 서비스를
 * 두지 않는다. 그 상태에서 대본 재생 · 되감기 · 캔버스 · 명령 출구가 전부 돌아야 한다.
 * 그래서 아래 넷은 **타입이 `true` 로 고정되어 있다** — 상태에 따라 잠글 수 있게 만들면
 * 언젠가 잠긴다(`manualInput` 과 같은 규칙).
 */

export type GenerateStatus = 'probing' | 'ready' | 'unavailable';

export type GenerateCapabilities = {
  /** 발화·문장에서 임무를 만드는 길 (`VZ-G-01`·`VZ-G-02`). 서비스가 있어야 한다. */
  canGenerate: boolean;
  /**
   * 대본 재생. **생성과 무관하다** — 키워드 대조이지 모델이 아니다.
   * 타입이 `true` 로 고정되어 있다.
   */
  scriptPlayback: true;
  /** 되감기. 기록 열을 접는 것이라 서비스와 무관하다. 타입 고정. */
  replay: true;
  /** 노드 캔버스. 타입 고정. */
  canvas: true;
  /** 명령 출구. 게이트웨이의 일이고 생성 서비스와 무관하다. 타입 고정. */
  commands: true;
  /** 무엇이 왜 꺼졌는지. 화면에 그대로 보여준다 — 조용히 사라지지 않게. */
  note: string | null;
};

/**
 * `detail` — `probe()` 가 돌려준 **실패 사유 한 줄**. 늘어나는 것은 `note` 의 내용뿐이고,
 * 켜고 끄는 판단은 이 값에 영향받지 않는다 (`stt/availability.ts` 와 같은 규칙).
 */
export function capabilities(status: GenerateStatus, detail?: string | null): GenerateCapabilities {
  const always = { scriptPlayback: true, replay: true, canvas: true, commands: true } as const;
  if (status === 'unavailable') {
    return {
      canGenerate: false,
      ...always,
      note: [
        '생성 서비스에 닿지 않습니다. 발화에서 임무를 만드는 길만 꺼졌고, 대본 재생·되감기·캔버스는 그대로 돕니다.',
        detail ?? null,
      ]
        .filter((line): line is string => line !== null && line.length > 0)
        .join(' '),
    };
  }
  if (status === 'probing') {
    return { canGenerate: false, ...always, note: '생성 서비스 확인 중입니다.' };
  }
  return { canGenerate: true, ...always, note: null };
}
