/**
 * src/stt/availability.ts
 *
 * **STT 서비스가 없어도 화면이 뜬다** 는 제약을 코드로 붙잡아 두는 곳 (VZ-C-02 / VZ-G-01).
 *
 * 이 판단을 화면 컴포넌트 안에 조건문으로 흩어 놓으면, 나중에 누가 조건 하나를 넓히면서
 * 수동 입력까지 같이 잠가도 아무도 모른다. 그래서 **"무엇이 켜지고 무엇이 꺼지는가"를
 * 의존 없는 순수 함수 하나**로 뽑아 두고, `verify:no-stt` 가 이 함수를 실제로 불러 검사한다.
 */

export type SttStatus = 'probing' | 'ready' | 'unavailable';

export type UtteranceCapabilities = {
  /** 마이크 녹음 버튼 */
  canRecord: boolean;
  /** 녹음·파일을 서비스로 보내는 경로 */
  canTranscribe: boolean;
  /**
   * 사람이 문장을 직접 넣는 길. **타입이 `true` 로 고정되어 있다.**
   * 상태에 따라 잠글 수 있게 만들면 언젠가 잠기기 때문이다.
   */
  manualInput: true;
  /** 무엇이 왜 꺼졌는지. 화면에 그대로 보여준다 — 조용히 사라지지 않게. */
  note: string | null;
};

/**
 * `detail` — `probe()` 가 돌려준 **실패 사유 한 줄** (260901 요구 3).
 *
 * 늘어나는 것은 `note` 의 내용뿐이다. 켜고 끄는 판단(특히 `manualInput`)은 이 값에
 * **영향받지 않는다** — 사유를 못 만들었다고 수동 입력이 잠기면 안 된다.
 */
export function capabilities(
  status: SttStatus,
  mediaRecorderSupported: boolean,
  detail?: string | null,
): UtteranceCapabilities {
  const manualInput = true as const;
  if (status === 'unavailable') {
    return {
      canRecord: false,
      canTranscribe: false,
      manualInput,
      // 사유가 있으면 붙인다 — 「서비스가 없다」와 「떠 있는데 브라우저가 막았다」는
      // 고치는 방법이 전혀 다른데 8/31까지는 화면에서 구별되지 않았다.
      note: [
        'STT 서비스에 닿지 않습니다. 음성 인식만 꺼졌고, 아래에 문장을 직접 넣을 수 있습니다.',
        detail ?? null,
      ]
        .filter((line): line is string => line !== null && line.length > 0)
        .join(' '),
    };
  }
  if (status === 'probing') {
    return { canRecord: false, canTranscribe: false, manualInput, note: 'STT 서비스 확인 중입니다.' };
  }
  if (!mediaRecorderSupported) {
    return {
      canRecord: false,
      canTranscribe: true,
      manualInput,
      note: '이 브라우저가 MediaRecorder 를 지원하지 않습니다. 파일 업로드나 직접 입력을 쓰세요.',
    };
  }
  return { canRecord: true, canTranscribe: true, manualInput, note: null };
}
