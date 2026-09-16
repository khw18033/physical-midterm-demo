/**
 * src/stt/confidence.ts
 *
 * 신뢰도 판정이 일어나는 **유일한 지점** (VZ-L-03 / REQ-1306).
 *
 * ## 값은 아직 정해지지 않았다 — 잠정 · 실측 미완
 *
 * `reports/2026-08-25_1506_stt-model-comparison-lab.md` §주요 판단의 결론이 그대로 남아 있다.
 * "정답·오답·무음·소음, hotwords/VAD 조합을 반복 측정한 뒤 정답 오거부율과 오답 통과율을
 * 비교해야 `REQ-1306` 임계값을 확정할 수 있다." 그 측정은 아직 하지 않았다.
 *
 * 그래서 이 파일이 하는 일은 **값을 정하는 것이 아니라 값이 놓일 자리를 만드는 것**이다.
 * 판정이 여기 한 곳에서만 일어나면, 실측이 끝났을 때 고칠 곳도 여기 하나다.
 *
 * ## 세 수치를 하나로 합치지 않는다
 *
 * Whisper 는 단일 confidence 를 주지 않는다. 세 수치를 가중합해 0~1 점수 하나로 뭉개면
 * 판정은 간단해지지만 **임계를 실측할 근거가 사라진다** — 어느 수치가 걸렀는지 알 수 없고,
 * 가중치 자체가 또 하나의 미확정 값이 되기 때문이다. 그래서 셋을 각각 따로 본다.
 *
 * ## 이 판정이 못 잡는 것 — 알고 남겨 둔다
 *
 * **무음에 대한 반복 환각은 세 수치를 전부 통과한다.** 실측에서 VAD 를 끈 3초 무음 입력이
 * `avg_logprob -0.088` · 평균 단어 확률 `0.933` 으로 나왔다 — 정답 발화보다 좋은 값이다
 * (`reports/2026-08-28_1620_STT이식.md` §실측). 모델이 자기가 만들어낸 반복을 확신한다.
 *
 * 그 케이스를 실제로 거르는 것은 둘이다.
 *   1. **VAD** — 기본으로 켜져 있고, 켜면 세그먼트가 0건이 되어 빈 문자열로 온다.
 *      지금 무음이 거절되는 것은 아래 임계가 아니라 VAD 덕분이다.
 *   2. **`compression_ratio`** — 위 두 경우 각각 `12.42`·`3.48`. 반복을 직접 재는 유일한 수치이고
 *      응답의 `segments[]` 에 이미 실려 온다.
 *
 * 네 번째 축으로 `compression_ratio` 를 넣을지는 **계약 결정과 같이 가야 하는 문제**라
 * (어디에 실을 것인가가 같은 문제다) 여기서 혼자 정하지 않았다. 다음 작업의 미결 항목이다.
 */

import type { SttResult } from './types.ts';

export type Verdict = 'accept' | 'confirm' | 'reject';

export type ConfidenceThresholds = {
  rejectNoSpeechProbAtLeast: number;
  rejectAvgLogprobBelow: number;
  acceptAvgLogprobAtLeast: number;
  acceptMeanWordProbAtLeast: number;
  acceptNoSpeechProbAtMost: number;
};

/**
 * **잠정값. 실측 미완.** 근거의 세기가 항목마다 다르므로 항목별로 적는다.
 *
 * - `rejectNoSpeechProbAtLeast` / `rejectAvgLogprobBelow`
 *   — 근거 있음. faster-whisper 가 자기 디코딩에서 쓰는 문턱 그대로다
 *     (`engines/faster_whisper.py` 의 `NO_SPEECH_THRESHOLD = 0.6`,
 *      `LOG_PROB_THRESHOLD = -1.0`). 엔진이 "이건 말이 아니다 / 이건 못 믿겠다"고
 *     판단하는 선과 화면의 거절선을 다르게 둘 이유가 지금은 없다. 임의로 고른 숫자가
 *     아니라 **엔진의 기본 문턱을 빌려 온 것**이고, 응답의 `applied_options` 에 그 값이
 *     실려 오므로 나중에 분포와 대조할 수 있다.
 * - `acceptAvgLogprobAtLeast` / `acceptMeanWordProbAtLeast` / `acceptNoSpeechProbAtMost`
 *   — **근거 약함. 감이다.** 1~3초짜리 명령 발화 몇 건을 눈으로 보고 "이 정도면 맞더라"
 *     수준에서 잡은 선이다. 정답 오거부율·오답 통과율을 재서 정한 값이 아니다.
 *     실측 전까지 이 선을 근거로 어떤 결정도 정당화하지 않는다.
 *
 * 위 두 묶음의 사이는 전부 `confirm` 이다. **확실하지 않으면 사람에게 묻는다** —
 * 조용히 통과시키는 쪽으로 기울이지 않는다.
 */
export const PROVISIONAL_THRESHOLDS: ConfidenceThresholds = {
  rejectNoSpeechProbAtLeast: 0.6,
  rejectAvgLogprobBelow: -1.0,
  acceptAvgLogprobAtLeast: -0.4,
  acceptMeanWordProbAtLeast: 0.8,
  acceptNoSpeechProbAtMost: 0.2,
};

/** 화면에 그대로 붙는 문구. 값이 잠정이라는 사실을 감추지 않는다. */
export const PROVISIONAL_NOTE = '잠정 — 실측 미완 (VZ-L-03)';

export type ConfidenceDecision = {
  verdict: Verdict;
  /** 어느 수치가 이 판정을 만들었는가. 사람이 재확인할 때 읽는다. */
  reasons: string[];
  /** 판정에 쓰인 세 수치. 뭉치지 않고 그대로 옮긴다. */
  metrics: {
    avgLogprob: number | null;
    noSpeechProb: number | null;
    meanWordProb: number | null;
  };
  provisional: true;
};

/**
 * 세 수치 → `accept` / `confirm` / `reject`.
 *
 * 수치가 없으면(단어가 하나도 안 나온 경우 등) `confirm` 이다. 없는 것을 통과시키지 않는다.
 */
export function decide(result: SttResult, thresholds: ConfidenceThresholds = PROVISIONAL_THRESHOLDS): ConfidenceDecision {
  const metrics = {
    avgLogprob: result.avg_logprob,
    noSpeechProb: result.no_speech_prob,
    meanWordProb: result.mean_word_prob,
  };
  const reasons: string[] = [];
  const base: Omit<ConfidenceDecision, 'verdict'> = { reasons, metrics, provisional: true };

  if (!result.text.trim()) {
    reasons.push('인식된 문장이 비어 있습니다');
    return { ...base, verdict: 'reject' };
  }
  if (metrics.noSpeechProb !== null && metrics.noSpeechProb >= thresholds.rejectNoSpeechProbAtLeast) {
    reasons.push(`no_speech_prob ${metrics.noSpeechProb.toFixed(3)} ≥ ${thresholds.rejectNoSpeechProbAtLeast} — 말소리가 아닐 가능성이 높습니다`);
  }
  if (metrics.avgLogprob !== null && metrics.avgLogprob < thresholds.rejectAvgLogprobBelow) {
    reasons.push(`avg_logprob ${metrics.avgLogprob.toFixed(3)} < ${thresholds.rejectAvgLogprobBelow} — 엔진이 자기 디코딩을 믿지 못하는 구간입니다`);
  }
  if (reasons.length) return { ...base, verdict: 'reject' };

  if (metrics.avgLogprob === null || metrics.noSpeechProb === null || metrics.meanWordProb === null) {
    reasons.push('판정에 필요한 수치가 비어 있습니다 — 사람이 확인해야 합니다');
    return { ...base, verdict: 'confirm' };
  }
  const accepted =
    metrics.avgLogprob >= thresholds.acceptAvgLogprobAtLeast &&
    metrics.meanWordProb >= thresholds.acceptMeanWordProbAtLeast &&
    metrics.noSpeechProb <= thresholds.acceptNoSpeechProbAtMost;
  if (accepted) {
    reasons.push(`세 수치가 모두 잠정 수락 구간입니다 (${PROVISIONAL_NOTE})`);
    return { ...base, verdict: 'accept' };
  }
  if (metrics.avgLogprob < thresholds.acceptAvgLogprobAtLeast) reasons.push(`avg_logprob ${metrics.avgLogprob.toFixed(3)} < ${thresholds.acceptAvgLogprobAtLeast}`);
  if (metrics.meanWordProb < thresholds.acceptMeanWordProbAtLeast) reasons.push(`평균 단어 확률 ${metrics.meanWordProb.toFixed(3)} < ${thresholds.acceptMeanWordProbAtLeast}`);
  if (metrics.noSpeechProb > thresholds.acceptNoSpeechProbAtMost) reasons.push(`no_speech_prob ${metrics.noSpeechProb.toFixed(3)} > ${thresholds.acceptNoSpeechProbAtMost}`);
  return { ...base, verdict: 'confirm' };
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  accept: '수락',
  confirm: '재확인 필요',
  reject: '거절',
};

// ── 계약으로 옮기는 자리 (260906 · §7.8 결정) ────────────────────────────────
//
// **결정: 안 ② + 이름 일반화. `confidence` 는 남긴다.**
//
// 세 안 중 ②(`utterance` 를 열어 명시 필드로)를 골랐다. ①(세 수치를 trace-event 로)은
// 임계 근거가 임무 기록 밖에 남아 조인을 요구하고, ③(`confidence` 재정의)은 위 환각이
// **최고 점수로** 통과하므로 판정의 실질을 잃는다. ②가 포기하는 것은 계층 경계인데,
// 그 대가는 **이름을 일반화해서** 갚는다 — `avg_logprob`·`no_speech_prob` 는 Whisper 의
// 말이고 그 이름이 계약에 오르면 `REQ-1302`(엔진 추상화)가 깨진다.
//
//   primary    엔진이 「주된 확신도」로 내놓는 값   ← avg_logprob
//   no_speech  「이건 말이 아니다」 쪽 신호        ← no_speech_prob
//   unit_mean  인식 단위(단어)당 평균 확신도       ← mean_word_prob
//
// ## `confidence` 에 가중합을 넣지 않는다
//
// 남긴 `confidence` 에는 **`unit_mean` 을 그대로** 넣는다. 가중합을 넣는 순간 세 자리를
// 만든 이유가 사라진다 — 위 환각(평균 단어 확률 `0.933`)이 숫자 하나에 묻힌다.
// 셋 중 `unit_mean` 만 고른 이유는 그것이 **엔진과 무관하게 0~1 로 읽히는 유일한 축**이기
// 때문이다. `primary` 는 눈금이 엔진의 것이고(Whisper 는 상한 0의 음수), `no_speech` 는
// 방향이 반대다(높을수록 말이 아니다).
//
// **그래서 `confidence` 는 수락 판정의 근거가 아니다.** 판정은 위 `decide()` 한 곳에서
// 세 수치를 각각 보고 한다. `confidence` 는 계약이 0단계부터 요구해 온 자리이고, 그 자리에
// 무엇이 들어 있는지를 이제 한 줄로 말할 수 있게 된 것이 이 결정의 전부다.

/**
 * `contracts/mission.schema.json` 의 `utterance`. **계약이 원본이므로 여기서는 얇게만 적는다**
 * (`generate/types.ts` 와 같은 규칙).
 */
export type ContractUtterance = {
  audio_ref: string | null;
  text: string;
  engine: string;
  confidence: number;
  confidence_signals: {
    primary: number | null;
    no_speech: number | null;
    unit_mean: number | null;
  };
};

/**
 * 계약으로 옮긴 결과. **둘 중 하나만 값이 있다.**
 *
 * 옮기지 못하는 경우가 실제로 있고(아래), 그때 조용히 아무 숫자나 채우면 계약은 통과하고
 * 사실만 사라진다. 그래서 「못 옮겼다」를 **사유와 함께** 돌려준다 — `probe()` 가 실패
 * 사유를 버리지 않는 것과 같은 규칙이다.
 */
export type UtteranceMapping =
  | { utterance: ContractUtterance; blocked: null }
  | { utterance: null; blocked: string };

/**
 * STT 결과 한 건 → 계약의 `utterance`.
 *
 * @param text 사람이 고친 문장. 화면에서 손댈 수 있으므로 **수락된 문장**이 계약에 오른다.
 *             안 넘기면 인식 원문 그대로다.
 *
 * ## 못 옮기는 경우 — `0` 으로 메우지 않는다
 *
 * `unit_mean` 이 없으면(단어가 하나도 안 나온 경우 · 단어 타임스탬프를 끈 엔진) 계약의
 * `confidence` 에 넣을 정직한 0~1 값이 없다. `0` 은 「쟀는데 0점」이라 뜻이 다르고,
 * `confidence` 자리는 계약상 `null` 을 받지 않는다 — **`confidence` 를 남기기로 한 결정이
 * 실제로 치르는 값이 여기다.** 그 경우 임무를 만들지 않고 사유를 돌려준다.
 * (`decide()` 도 같은 입력을 `confirm` 으로 보낸다 — 없는 것을 통과시키지 않는다.)
 */
export function toUtterance(result: SttResult, text: string = result.text): UtteranceMapping {
  const confidence_signals = {
    primary: result.avg_logprob,
    no_speech: result.no_speech_prob,
    unit_mean: result.mean_word_prob,
  };
  const unitMean = confidence_signals.unit_mean;
  if (unitMean === null) {
    return {
      utterance: null,
      blocked: `인식 단위당 확신도가 없어 계약의 confidence 를 채울 수 없습니다 (단어 ${result.word_count}건 · engine=${result.engine}). 0 으로 메우지 않습니다 — 0 은 「쟀는데 0점」이고 이 경우는 「못 쟀다」입니다.`,
    };
  }
  if (unitMean < 0 || unitMean > 1) {
    // 잘라서 넣으면 계약은 통과하고 사실이 사라진다. 엔진이 확률 축이 아닌 값을 이 자리에
    // 실었다는 뜻이므로 매핑을 고쳐야 한다 — 여기서 감추지 않는다.
    return {
      utterance: null,
      blocked: `인식 단위당 확신도가 확률 범위 밖입니다 (${unitMean} · engine=${result.engine}). 잘라 넣지 않습니다 — 계약은 통과하고 사실만 사라집니다.`,
    };
  }
  return {
    utterance: {
      audio_ref: result.audio_ref,
      text,
      engine: result.engine,
      // **가중합이 아니다.** unit_mean 그대로다 (위 머리말).
      confidence: unitMean,
      confidence_signals,
    },
    blocked: null,
  };
}

/**
 * **저작된 문장** → 계약의 `utterance` (260907 · 9단계).
 *
 * 사람이 직접 타이핑한 문장에는 인식이 없다. 대본의 `engine: 'script'` 가 같은 성질이고
 * (「이 문장은 인식이 아니라 저작이다」 · `scenarios/types.ts`), 그때 `confidence` 는
 * **정의상 1**이고 `audio_ref` 는 null 이다 — 잰 값이 아니라 인식 단계가 없다는 뜻이다.
 *
 * `confidence_signals` 를 **넣지 않는다.** 계약이 그 자리를 선택 필드로 둔 이유가 정확히
 * 이것이다 — 저작된 문장에는 엔진이 준 수치가 없고, `null` 셋을 채워 넣으면 「엔진이
 * 못 준 값」과 「엔진이 없는 경우」가 같은 모양이 된다.
 *
 * 이 함수가 `toUtterance` 옆에 있는 이유: 계약이 「자리를 채우는 규칙은
 * `stt/confidence.ts` 한 곳」이라고 적어 두었다. 저작 경로만 다른 파일로 새면 그 문장이
 * 거짓이 된다.
 */
export type AuthoredUtterance = { audio_ref: null; text: string; engine: string; confidence: 1 };

export function authoredUtterance(text: string, engine: string): AuthoredUtterance {
  return { audio_ref: null, text, engine, confidence: 1 };
}
