/**
 * src/views/UtterancePanel.tsx
 *
 * 발화 패널 (VZ-L-01 / REQ-1301~1305 / REQ-305).
 *
 * 1단계에서 이 패널은 전부 껍데기였다 — 파형은 고정 문자열, 인용문은 시나리오 JSON의
 * 목 문장, 진행 막대는 다섯 칸 전부 체크 하드코딩. 이제 **다섯 칸이 다 실제**다 (260907).
 *
 * ## 뒤 세 칸이 채워졌다 (9단계 · 지시서 §6)
 *
 * | 칸 | 무엇 | 누가 |
 * |---|---|---|
 * | 의도 분석 · 마일스톤 분리 | `generateMission()` | **모델** (`VZ-G-01`) |
 * | 태스크 생성 | `solveDeps()` | **규칙** (`VZ-G-02`) — 모델이 아니다 |
 *
 * 새 화면을 만들지 않았다. `목` 배지가 있던 그 자리를 채운다.
 *
 * ## 배지가 셋이다 — 「이 마일스톤은 누가 썼나」에 답하는 자리
 *
 * ```
 * 목    아직 아무것도 안 했다 — 눌러야 무언가 뜬다
 * 대본  키워드 대조로 미리 써 둔 편을 꺼냈다. LLM 이 아니다
 * AI    모델이 방금 만들었다 — 모델 이름·프롬프트 지문·적용된 규칙이 함께 붙는다
 * ```
 *
 * 셋이 화면에서 갈리지 않으면 그 물음에 답이 없다. **대본이 맞으면 대본이 이긴다** —
 * 대본 조회는 LLM 뒤의 대조군이자 시연 안전망이고(원래 주석), 모델이 그 자리를 조용히
 * 가져가면 시연에서 무엇이 답했는지 아무도 모른다. 모델의 답은 그때 **나란히** 뜨고,
 * 사람이 원하면 버튼 하나로 제안을 바꿀 수 있다 — 바꾸는 것도 승인 선 앞이다.
 *
 * ## 승인 전에는 아무것도 실행되지 않는다 (`VZ-U-07`)
 *
 * 이 패널이 하는 일은 **제안까지**다. 캔버스에 올리는 문은 `acceptProposal()` 하나이고
 * (`data/scenario.ts`), `verify:proposal-gate` 가 그 문을 지킨다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { proposeGenerated, proposeMission, scenario as legacyScenario, type MissionView } from '../data/scenario.ts';
import { SCRIPT_LIBRARY } from '../scenarios/library.ts';
import { matchLibrary, type MatchOutcome } from '../scenarios/matcher.ts';
import { issueCommand } from '../shared/commandEgress.ts';
import { CommandAuditError } from '../shared/voiceAudit.ts';
import type { AiProvenance } from '../shared/provenance.ts';
import { capabilities, type SttStatus } from '../stt/availability.ts';
import { authoredUtterance, decide, PROVISIONAL_NOTE, toUtterance, VERDICT_LABEL, type ConfidenceDecision } from '../stt/confidence.ts';
import { probe, sttBaseUrl, transcribe } from '../stt/SttClient.ts';
import { SttUnavailableError, type SttResult } from '../stt/types.ts';
import { capabilities as generateCapabilities, type GenerateStatus } from '../generate/availability.ts';
import { examplesForUtterance } from '../generate/fewshot.ts';
import { generateBaseUrl, generateMission, probe as generateProbe, type GenerateProbe } from '../generate/LlmClient.ts';
import { provenanceOf, tasksFromGenerated, viewFromGenerated } from '../generate/proposal.ts';
import { LlmUnavailableError } from '../generate/types.ts';
import { Explain } from '../shared/Explain.tsx';
/**
 * 그라운딩 재료 — **부르는 쪽이 고른다** (`gen-lab/README.md` 의 재료 표).
 * 측정 경로(`scripts/run-baseline.mjs`)가 같은 두 파일을 읽는다: 화면과 표가 같은 조건이어야
 * 표의 숫자가 화면을 설명한다.
 *
 * **기하 파일은 넘기지 않는다** — 좌표를 보면 모델이 503호 전용이 된다(지시서 §1).
 * 여기서 읽는 것은 위상 하나뿐이고, 그래서 실수로 좌표를 실을 방법이 없다.
 */
import placesTopology from '../../../places/places.json';
import equipmentVocabulary from '../../../equipment/equipment.json';
import { noteHumanAction } from '../shared/humanAction.ts';

const LEVEL_BARS = 22;
/** 레벨 갱신 주기. 60fps로 setState 하면 이 작은 패널이 렌더 예산을 먹는다. */
const LEVEL_INTERVAL_MS = 60;
const PREFERRED_MIME = 'audio/webm;codecs=opus';

type StepState = 'idle' | 'active' | 'done' | 'failed';
type Phase = 'idle' | 'recording' | 'transcribing' | 'reviewing' | 'failed';

function mediaRecorderSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';
}

function pickMimeType(): string | undefined {
  if (!mediaRecorderSupported()) return undefined;
  return MediaRecorder.isTypeSupported(PREFERRED_MIME) ? PREFERRED_MIME : undefined;
}

/** 앞 두 칸만 실제 상태를 따라간다. 뒤 세 칸은 목이다. */
function realSteps(phase: Phase, hasAudio: boolean, hasResult: boolean): Array<{ label: string; state: StepState }> {
  const capture: StepState = phase === 'recording' ? 'active' : phase === 'failed' && !hasAudio ? 'failed' : hasAudio ? 'done' : 'idle';
  const stt: StepState = phase === 'transcribing' ? 'active' : phase === 'failed' && hasAudio && !hasResult ? 'failed' : hasResult ? 'done' : 'idle';
  return [
    { label: '음성 수신', state: capture },
    { label: 'STT 변환', state: stt },
  ];
}

/** 접힌 줄에 적는 한 낱말 — 지금 이 마일스톤을 무엇이 썼는가. */
function producerWord(producer: string): string {
  if (producer === 'running') return '생성 중…';
  if (producer === 'ai') return 'AI 가 만들었습니다';
  if (producer === 'script') return '대본에서 꺼냈습니다';
  return '아직 아무것도 안 했습니다';
}

const STEP_MARK: Record<StepState, string> = { idle: '·', active: '…', done: '✓', failed: '✕' };
const MOCK_STEPS = ['의도 분석', '마일스톤 분리', '태스크 생성'];

/**
 * 생성 응답이 얼마나 걸리는가 — **실측값이다.** 8B·정답셋 3편 15건에서 최대 12.23초
 * (`reports/2026-09-07_마일스톤분리_7단계.md` 축 5). 실시간이 아니고 사람이 수락하는
 * 단계이므로 이 정도는 허용되지만, **그동안 화면이 멎으면 안 된다** — 이 숫자를 화면에
 * 그대로 적어 「얼마나 더 기다리면 되나」에 답한다.
 */
const GENERATE_MAX_SEC = 12.2;
/**
 * 태스크까지 낼 때의 실측 최대 (10단계 E3 · 15건 · 31.34초 · 중앙값 25.98초).
 *
 * **판마다 다르므로 판마다 적는다.** 12.2초짜리 막대를 26초 걸리는 판에 쓰면 막대가
 * 절반쯤에서 끝까지 차 버리고, 그때부터 화면은 「곧 끝난다」를 계속 거짓말한다.
 * 프롬프트가 4,400 → 7,600 토큰이 되고 출력이 마일스톤에서 태스크까지 늘어난 값이다.
 */
const GENERATE_MAX_SEC_TASKS = 31.4;
/** 경과 표시 간격. 초 단위 숫자 하나를 갱신하는 데 60fps 를 쓸 이유가 없다. */
const GENERATE_TICK_MS = 200;
/**
 * 대본이 맞았을 때의 뒤 세 칸 (260831). **이것은 LLM이 아니다** — 키워드 대조로 미리 써 둔
 * 대본을 꺼낸 것이고, 배지 이름을 `목`과 갈라 두는 이유는 나중에 LLM(VZ-G-01)이 들어오면
 * 대본 조회가 그 뒤의 대조군·시연 안전망으로 남아 둘이 화면에서 구별되어야 하기 때문이다.
 */
const SCRIPT_STEPS = ['의도 분석 → 대본 조회', '마일스톤 분리 → 대본에서 읽음', '태스크 생성 → 대본에서 읽음'];

/**
 * 모델이 냈을 때의 뒤 세 칸 (260907 · 9단계).
 *
 * **앞 둘과 셋째의 주체가 다르다.** 의도 분석·마일스톤 분리는 모델(`VZ-G-01`)이고,
 * 태스크 생성은 규칙(`VZ-G-02` · `solveDeps()`)이다. 한 배지 아래 묶여 있어도 그 사실을
 * 칸 문구가 말해야 한다 — 「AI 가 deps 를 만들었다」로 읽히면 §5 의 결정이 화면에서
 * 뒤집힌다.
 */
function aiSteps(milestones: number, nodes: number, edges: number): string[] {
  return [
    '의도 분석 → VZ-G-01',
    `마일스톤 분리 → ${milestones}건`,
    // 노드가 0개인 것을 감추지 않는다. 확정된 프롬프트는 `tasks: []` 를 내고, 규칙은
    // 붙어 있으나 매달 노드가 없다 — 그 사실이 그대로 적힌다.
    nodes === 0
      ? '태스크 생성 → 노드 0개 (규칙 대기)'
      : `태스크 생성 → 노드 ${nodes} · 의존 ${edges} (규칙)`,
  ];
}

/** 생성 한 판의 결과. **근거를 요약하지 않는다** — 화면이 그대로 편다. */
type GenerationOutcome = {
  provenance: AiProvenance;
  view: MissionView;
  nodeCount: number;
  edgeCount: number;
  /** 모델이 규칙을 어기고 적은 의존의 수. **0이 정상이다** — 10단계 실측에서 15건 전부 0이었다. */
  modelDeps: number;
  /** 지금 이 결과가 **제안으로 서 있는가.** 대본이 맞은 경우에는 나란히 뜨기만 한다. */
  proposed: boolean;
};

/**
 * 이 생성이 만들 임무 식별자. **부르는 쪽이 준다** — 모델이 지어낼 것이 아니다
 * (`audio_ref` 와 같은 성질 · `VZ-G-01` 이 만드는 것은 마일스톤이지 식별자가 아니다).
 *
 * 시각을 넣는 이유는 되짚기다. 같은 발화를 두 번 부르면 두 개의 임무이고, 기록 열은
 * 임무당 하나이므로 식별자가 같으면 **뒤엣것이 앞엣것의 열을 덮는다.**
 */
function nextGeneratedMissionId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `MSN-GEN-${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const LEGACY_TITLE = '415호 → 503호 이동 (구판 세계)';

/**
 * 시연 문장 목록 — **대본 라이브러리에서 읽는다.** 여기 하드코딩하면 대본이 늘 때
 * 화면이 못 따라간다. 각 편의 `utterance.text`가 그 대본을 부르는 기준 문장이고,
 * 옛 편(사이드카 — script 없음)은 번들의 옛 시나리오에서 문장을 가져온다.
 */
const DEMO_SENTENCES = SCRIPT_LIBRARY.map((entry) => ({
  missionId: entry.missionId,
  title: entry.script?.title ?? LEGACY_TITLE,
  text: entry.script?.utterance.text ?? legacyScenario.utterance.text,
}));

/**
 * 문장을 대본 라이브러리에 대조하고, 맞으면 제안 상태로 올린다.
 * 게이트웨이(있으면)가 같은 매처·같은 대본으로 권위 있는 제안(plan)을 만들고,
 * 단독 빌드에서는 이 로컬 매칭이 곧 제안이다 — **같은 파일을 import 하므로 결과가 같다.**
 */
function matchScript(text: string): MatchOutcome {
  const outcome = matchLibrary(text, SCRIPT_LIBRARY);
  if (outcome.kind === 'matched') {
    proposeMission({
      origin: 'script',
      missionId: outcome.entry.missionId,
      title: outcome.entry.script?.title ?? LEGACY_TITLE,
      keywords: outcome.keywords,
      planId: null,
      world: outcome.entry.world,
    });
  }
  return outcome;
}

function LevelMeter({ levels, live }: { levels: number[]; live: boolean }) {
  return (
    <div className={live ? 'waveform live' : 'waveform'} aria-label="입력 레벨">
      {levels.map((level, index) => (
        <i key={index} style={{ height: `${Math.max(3, Math.round(level * 100))}%` }} />
      ))}
    </div>
  );
}

function Numbers({ result, decision }: { result: SttResult; decision: ConfidenceDecision }) {
  const show = (value: number | null, digits = 3) => (value === null ? '—' : value.toFixed(digits));
  return (
    <details className="stt-numbers">
      <summary>원본 수치 세 개 · 판정 근거</summary>
      <dl>
        <dt>avg_logprob</dt>
        <dd>{show(result.avg_logprob)} <small>세그먼트 중 최소</small></dd>
        <dt>no_speech_prob</dt>
        <dd>{show(result.no_speech_prob, 4)} <small>세그먼트 중 최대</small></dd>
        <dt>평균 단어 확률</dt>
        <dd>{show(result.mean_word_prob)} <small>단어 {result.word_count}개 · 최소 {show(result.min_word_prob)}</small></dd>
      </dl>
      <Explain id="utt-1" className="hint">셋을 하나의 점수로 합치지 않습니다. 합치면 임계값을 실측할 근거가 사라집니다.</Explain>
      <ul>
        {decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
      <Explain id="utt-2" className="hint">
        {result.device}/{result.compute_type} · 추론 {result.elapsed_sec.toFixed(2)}s · 로드 {result.load_sec.toFixed(2)}s · RTF {result.rtf.toFixed(2)}
      </Explain>
    </details>
  );
}

export function UtterancePanel({ fallbackText }: { fallbackText: string }) {
  const [status, setStatus] = useState<SttStatus>('probing');
  const [phase, setPhase] = useState<Phase>('idle');
  const [levels, setLevels] = useState<number[]>(() => new Array(LEVEL_BARS).fill(0));
  const [result, setResult] = useState<SttResult | null>(null);
  const [decision, setDecision] = useState<ConfidenceDecision | null>(null);
  const [edited, setEdited] = useState('');
  const [manual, setManual] = useState('');
  /** 시연 문장을 누르면 직접 입력을 펼쳐 채운다 — 접힌 채로 채워지면 채워진 줄도 모른다. */
  const [manualOpen, setManualOpen] = useState(false);
  /**
   * **시연 화면에서 접어 둔다** (260910 지시 — 「필요 없는 목·시나리오 UI 를 최대한 없앤다」).
   *
   * 둘 다 지우지는 않는다. 예시 문장은 발표자가 무엇을 말해야 하는지 볼 자리이고, 생성
   * 진행 칸은 막혔을 때 어디서 막혔는지 보는 자리다 — 없애면 그때 볼 것이 없다.
   * 평소에는 접어 두고 **필요할 때 펴게** 한다.
   */
  const [sentencesOpen, setSentencesOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [useHotwords, setUseHotwords] = useState(true);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  /** 마지막 제출 문장의 대본 매칭 결과 — 뒤 세 칸이 `목`에서 `대본`으로 바뀌는 근거. */
  const [scriptMatch, setScriptMatch] = useState<MatchOutcome | null>(null);

  /** probe() 가 돌려준 실패 사유. 화면 문구에 주소와 함께 그대로 실린다 (260901 요구 3). */
  const [sttReason, setSttReason] = useState<string | null>(null);

  // ── 생성 (VZ-G-01 · VZ-G-02 · 260907) ─────────────────────────────────────
  // **STT 와 완전히 갈라진 상태다.** 하나가 꺼져도 다른 하나는 돈다 — 두 서비스를 한
  // 상태로 묶으면 「인식이 나쁜 건지 해석이 나쁜 건지」를 못 가른다(이 패널의 원래 규칙).
  const [genStatus, setGenStatus] = useState<GenerateStatus>('probing');
  const [genReason, setGenReason] = useState<string | null>(null);
  /** 무엇이 떠 있는가 — 스텁이면 그렇게 적는다. **목임을 감추지 않는다.** */
  const [genEngine, setGenEngine] = useState<string | null>(null);
  /**
   * 쓸 수 있는 가중치와 지금 고른 것.
   *
   * **화면이 골라야 한다.** 엔진은 모델 이름 없이 오는 요청을 거부한다 —
   * 「아무거나 고르면 무엇을 쟀는지 알 수 없습니다」. 그 규칙은 측정에서 나왔지만
   * 화면에도 그대로 걸린다: 어느 모델이 답했는지 모르는 제안에는 근거가 없다.
   *
   * 목록은 서비스가 준다(`models/` 를 읽는다). **여기에 이름을 박지 않는다** — 박으면
   * 새 모델을 재는 일이 화면 수정이 되고, 그 순간 「무엇을 쟀는가」가 커밋에 흩어진다.
   */
  const [genModels, setGenModels] = useState<GenerateProbe['models']>([]);
  const [genModel, setGenModel] = useState<string | null>(null);
  /**
   * 태스크까지 낼 것인가 (10단계 E · `VZ-G-02` 의 모델 쪽 절반).
   *
   * **기본은 켜짐이다.** 15건 실측에서 형식은 완전히 안정적이었고(스키마 15/15 ·
   * 모델이 낸 `deps` 0건 · 순환 0건 · 라벨은 계약의 enum 이 강제), 결과는 제안일 뿐
   * 사람이 승인한다. 다만 응답이 6.4 → 26초로 네 배가 되므로 **끌 수 있게 둔다** —
   * 시연에서 기다릴 수 없을 때 마일스톤만 받는 길이 남아 있어야 한다.
   *
   * 정답 재현이 높아서 켠 것이 아니다. 낮다 — 그리고 그 원인의 대부분이 마일스톤 층에
   * 있다(10단계 보고서). 켠 근거는 **형식이 안정적이고 제안일 뿐**이라는 것이다.
   */
  const [genTasks, setGenTasks] = useState(true);
  const [genPhase, setGenPhase] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  /** 진행 표시 — 최대 12.2초다. 그동안 화면이 멎으면 안 된다(지시서 §6). */
  const [genElapsed, setGenElapsed] = useState(0);
  const [genError, setGenError] = useState<{ message: string; detail?: string } | null>(null);
  const [genOutcome, setGenOutcome] = useState<GenerationOutcome | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);

  const able = capabilities(status, mediaRecorderSupported(), sttReason);
  const fileDisabled = !able.canTranscribe || phase === 'transcribing';
  const genAble = generateCapabilities(genStatus, genReason);

  useEffect(() => {
    const controller = new AbortController();
    // 사유를 함께 받는다 (260901 요구 3) — 「서비스가 없다」와 「떠 있는데 브라우저가
    // 막았다」가 같은 문장으로 보이면 다음에 또 막혔을 때 진단이 처음부터 시작된다.
    void probe(controller.signal).then((result) => {
      setStatus(result.alive ? 'ready' : 'unavailable');
      setSttReason(result.reason);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // **던지지 않는 probe 다** (`verify:no-llm` 1번). 여기서 예외가 새면 첫 렌더가
    // 통째로 날아가고, 그러면 「생성만 꺼진다」가 아니라 「생성 때문에 다 꺼진다」가 된다.
    void generateProbe(controller.signal).then((result) => {
      setGenStatus(result.alive ? 'ready' : 'unavailable');
      setGenReason(result.reason);
      setGenEngine(result.engine);
      setGenModels(result.models);
      // 기본 선택 둘. **어느 쪽도 모델 이름을 보지 않는다** — 이름을 보는 순간 새 가중치를
      // 넣는 일이 화면 수정이 되고, 「모델 목록은 코드에 없다」가 무너진다.
      //
      //  1. **이미 물고 있는 것**이 있으면 그것 — 다른 것을 고르면 적재에 수십 초가 들고,
      //     사람은 화면이 멈춘 줄 안다.
      //  2. 없으면 **조건이 붙지 않은 가중치 중 가장 큰 것.** 두 가지를 동시에 피한다:
      //     이름순 첫 번째는 지금 비상업 연구용 대조 모델이라 시연·배포 경로가 그것을
      //     조용히 물면 라이선스를 화면 밖에서 어기고, 이름순은 또 「작은 모델이 먼저」가
      //     되기도 한다(4B 의 개수 일치는 0% 였다). 크기는 이름이 아니면서 능력과 같은
      //     방향으로 간다. 고르지 못하게 막지는 않는다 — 대조군으로는 정당하다.
      const byCapacity = [...result.models].sort((a, b) => b.bytes - a.bytes);
      const free = byCapacity.filter((entry) => entry.licenseFile === null);
      setGenModel(result.loaded ?? free[0]?.id ?? byCapacity[0]?.id ?? null);
    });
    return () => controller.abort();
  }, []);

  /** 도는 동안 경과를 민다. 멈춰 있는 화면과 죽은 화면은 사용자에게 같아 보인다. */
  useEffect(() => {
    if (genPhase !== 'running') return;
    const started = Date.now();
    setGenElapsed(0);
    const timer = setInterval(() => setGenElapsed((Date.now() - started) / 1000), GENERATE_TICK_MS);
    return () => clearInterval(timer);
  }, [genPhase]);

  const stopMeter = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopMeter, [stopMeter]);

  /** 진짜 입력 레벨. AnalyserNode 하나면 되고 오디오 라이브러리를 넣지 않는다. */
  const startMeter = useCallback((stream: MediaStream) => {
    const context = new AudioContext();
    audioContextRef.current = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    let last = 0;
    const tick = (now: number) => {
      frameRef.current = requestAnimationFrame(tick);
      if (now - last < LEVEL_INTERVAL_MS) return;
      last = now;
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const sample of buffer) sum += sample * sample;
      const rms = Math.sqrt(sum / buffer.length);
      // 목소리 대부분이 0.02~0.3 RMS 구간에 들어와서, 선형으로 그리면 막대가 거의 안 움직인다.
      const level = Math.min(1, Math.sqrt(rms) * 2.2);
      setLevels((current) => [...current.slice(1), level]);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, []);

  const send = useCallback(async (blob: Blob) => {
    setPhase('transcribing');
    setError(null);
    try {
      const next = await transcribe(blob, { useHotwords });
      setResult(next);
      setDecision(decide(next));
      setEdited(next.text);
      setConfirmed(false);
      setIssued(null);
      setPhase('reviewing');
    } catch (caught) {
      const unavailable = caught instanceof SttUnavailableError;
      setError({ message: unavailable ? caught.message : String(caught), detail: unavailable ? caught.detail : undefined });
      // 서비스가 죽은 것이면 기능만 끄고 수동 입력을 남긴다. 화면은 계속 뜬다.
      if (unavailable && caught.kind === 'offline') setStatus('unavailable');
      setPhase('failed');
    }
  }, [useHotwords]);

  const startRecording = useCallback(async () => {
    setError(null);
    setResult(null);
    setDecision(null);
    setIssued(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        stopMeter();
        void send(new Blob(chunks, { type: mime ?? 'audio/webm' }));
      };
      recorderRef.current = recorder;
      recorder.start();
      startMeter(stream);
      setPhase('recording');
    } catch (caught) {
      stopMeter();
      setError({ message: `마이크를 열 수 없습니다: ${String(caught)}` });
      setPhase('failed');
    }
  }, [send, startMeter, stopMeter]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }, []);

  /**
   * 발화 하나 → 임무 제안 (`VZ-G-01` + `VZ-G-02`).
   *
   * ## 대본이 맞았으면 제안을 빼앗지 않는다
   *
   * 대본 조회는 LLM 뒤의 **대조군이자 시연 안전망**이다. 모델이 그 자리를 조용히 가져가면
   * 시연에서 무엇이 답했는지 아무도 모른다. 그래서 대본이 맞은 경우 모델의 답은 **나란히
   * 뜨기만 하고**, 바꾸는 것은 사람이 버튼으로 한다 — 그것도 승인 선 앞이다.
   *
   * ## 예시에서 그 편을 뺀다
   *
   * 화면의 시연 문장이 곧 대본의 기준 문장이라, 맞은 편을 예시로 실으면 **정답을 주고
   * 정답을 맞히라고 하는 것**이 된다. 규칙은 `generate/fewshot.ts` 한 곳이다.
   *
   * ## 확정된 프롬프트로 부른다
   *
   * 8단계가 B 판(장비 목록 + 예시)을 확정했고 D 판(노드 종류 5종)은 **채택하지 않았다.**
   * 그래서 `nodeKinds` 를 넘기지 않는다 — 여기서 켜면 화면이 잰 적 없는 조건으로 돈다.
   */
  const runGeneration = useCallback(async (utteranceMeta: { text: string }, matchedMissionId: string | null) => {
    if (!genAble.canGenerate) return;
    if (genModel === null) {
      // **지어내지 않는다.** 이름을 하나 박아 넣으면 그 이름이 없는 기기에서 조용히 실패하고,
      // 있는 기기에서는 「무엇이 답했는지」가 화면에 안 적힌 채 돈다.
      setGenError({ message: '쓸 수 있는 가중치가 없습니다 — gen-lab/models/ 에 GGUF 를 두고 서비스를 다시 띄우세요.' });
      setGenPhase('failed');
      return;
    }
    setGenPhase('running');
    setGenError(null);
    setGenOutcome(null);
    const missionId = nextGeneratedMissionId();
    try {
      const generated = await generateMission(utteranceMeta.text, {
        places: placesTopology,
        equipment: equipmentVocabulary,
        // **규칙과 예시를 함께 켠다.** 규칙만 바꾸고 예시를 그대로 두면 프롬프트가 서로
        // 반대되는 지시 둘을 들고, 실측에서 예시가 이겼다 (10단계 E 판 15건 중 10건).
        examples: examplesForUtterance(SCRIPT_LIBRARY, matchedMissionId, { tasks: genTasks }),
        tasks: genTasks,
        model: genModel,
        missionId,
        utteranceMeta,
      });
      const provenance = provenanceOf(generated);
      if (generated.mission == null) {
        // 계약을 못 읽은 응답이다. **버리지 않고 사유를 보인다** — 무엇이 왜 실패했는지가
        // 곧 측정값이고, 화면에서 감추면 그 사실이 사라진다.
        setGenError({
          message: '모델 응답을 임무 객체로 읽지 못했습니다.',
          detail: provenance.schemaErrors.join(' · ') || undefined,
        });
        setGenPhase('failed');
        return;
      }
      const { nodeCount, edgeCount, modelDeps } = tasksFromGenerated(generated.mission);
      const view = viewFromGenerated(generated.mission, `발화에서 생성 — ${utteranceMeta.text}`);
      // 대본이 맞았으면 대본이 제안으로 남는다. 아니면 이것이 제안이다.
      const proposed = matchedMissionId === null && proposeGenerated(view, provenance);
      setGenOutcome({ provenance, view, nodeCount, edgeCount, modelDeps, proposed });
      setGenPhase('done');
    } catch (caught) {
      const unavailable = caught instanceof LlmUnavailableError;
      setGenError({ message: unavailable ? caught.message : String(caught), detail: unavailable ? caught.detail : undefined });
      // 서비스가 죽은 것이면 **생성 경로만** 끈다. 화면과 STT·대본 재생은 그대로다.
      if (unavailable && caught.kind === 'offline') setGenStatus('unavailable');
      setGenPhase('failed');
    }
  }, [genAble.canGenerate, genModel, genTasks]);

  /** 나란히 뜬 AI 결과를 제안으로 올린다. **여전히 승인 앞이다** — 올리는 것과 승인은 다르다. */
  const switchToGenerated = useCallback(() => {
    setGenOutcome((current) => {
      if (current === null || current.proposed) return current;
      if (!proposeGenerated(current.view, current.provenance)) return current;
      return { ...current, proposed: true };
    });
  }, []);

  const submitVoice = useCallback(async () => {
    if (!result || !decision) return;
    // 매칭은 발행 전에 로컬에서도 한다 — 게이트웨이와 **같은 매처·같은 대본**이라 결과가
    // 같고, 단독 빌드(게이트웨이 없음)에서는 이 결과가 곧 제안이 된다.
    const matched = matchScript(edited.trim());
    setScriptMatch(matched);
    try {
      // 임계 미만이면 여기 오지 못한다. 조용히 통과시키지 않는다.
      // **사람이 냈다.** 이 뒤부터 계획 채널을 받는다 — 열자마자 캐시된 계획이
      // 화면을 채우지 않게 하는 빗장이다(`missionBridge.noteHumanAction`).
      noteHumanAction();
      await issueCommand({
        action: 'mission_from_utterance',
        params: { text: edited.trim(), verdict: decision.verdict, threshold_status: PROVISIONAL_NOTE },
        inputModality: 'voice',
        voice: {
          transcript: result.text,
          transcript_edited: edited.trim(),
          avg_logprob: result.avg_logprob,
          no_speech_prob: result.no_speech_prob,
          mean_word_prob: result.mean_word_prob,
          engine: result.engine,
          model: result.model,
          audio_ref: result.audio_ref,
        },
      });
      setIssued(`음성 발화로 발행했습니다 · audio_ref=${result.audio_ref}`);
    } catch (caught) {
      setError({ message: caught instanceof CommandAuditError ? caught.message : String(caught) });
      return; // 감사에 걸린 명령으로 임무를 만들지 않는다.
    }
    // 생성은 **발행 뒤**다. 사람의 요청이 먼저 기록되고, 그 다음에 모델이 답한다.
    //
    // 계약의 `utterance` 를 채우는 규칙은 `stt/confidence.ts` 한 곳이다. 못 채우면
    // (`unit_mean` 이 없을 때) **0 으로 메우지 않고** 생성을 걸지 않는다 — 그 자리는
    // 「쟀는데 0점」과 「못 쟀다」가 다른 자리다.
    const mapped = toUtterance(result, edited.trim());
    if (mapped.utterance === null) {
      setGenError({ message: '이 인식 결과로는 임무를 만들 수 없습니다.', detail: mapped.blocked });
      setGenPhase('failed');
      return;
    }
    await runGeneration(mapped.utterance, matched.kind === 'matched' ? matched.entry.missionId : null);
  }, [decision, edited, result, runGeneration]);

  const submitManual = useCallback(async () => {
    if (!manual.trim()) return;
    const matched = matchScript(manual.trim());
    setScriptMatch(matched);
    try {
      noteHumanAction();   // 사람이 냈다 — 이 뒤부터 계획 채널을 받는다
      await issueCommand({ action: 'mission_from_utterance', params: { text: manual.trim(), source: 'manual_text' }, inputModality: 'pointer' });
      setIssued('직접 입력한 문장으로 발행했습니다 (음성 아님)');
    } catch (caught) {
      setError({ message: String(caught) });
      return;
    }
    // 직접 입력은 **저작된 문장**이다 — 인식이 없으므로 confidence 는 정의상 1이고
    // `confidence_signals` 는 없다 (대본의 `engine: 'script'` 와 같은 성질).
    await runGeneration(
      authoredUtterance(manual.trim(), 'manual_text'),
      matched.kind === 'matched' ? matched.entry.missionId : null,
    );
  }, [manual, runGeneration]);

  const hasAudio = phase === 'transcribing' || phase === 'reviewing' || Boolean(result);
  const steps = realSteps(phase, hasAudio, Boolean(result));
  const blocked = decision?.verdict === 'reject' || (decision?.verdict === 'confirm' && !confirmed);
  const appliedHotwords = Number(result?.applied_options?.hotword_count ?? 0);

  /**
   * 뒤 세 칸을 무엇이 채우는가. **이 한 줄이 세 배지의 유일한 근거다** — 조건을 화면
   * 여기저기에 흩어 놓으면 「이 마일스톤은 누가 썼나」의 답이 렌더 순서에 달리게 된다.
   *
   * 대본이 이긴다 (위 `runGeneration` 의 근거). 사람이 버튼으로 바꾸면 `proposed` 가
   * 참이 되고 그때 `ai` 로 넘어간다.
   */
  /** 이 판의 실측 최대. 태스크까지 내면 네 배가 걸린다 (10단계). */
  const generateMaxSec = genTasks ? GENERATE_MAX_SEC_TASKS : GENERATE_MAX_SEC;

  const producer: 'mock' | 'script' | 'ai' | 'running' =
    genOutcome?.proposed ? 'ai'
      : scriptMatch?.kind === 'matched' ? 'script'
        : genPhase === 'running' ? 'running'
          : genOutcome !== null ? 'ai' : 'mock';

  return (
    <aside className="utterance-panel">
      <h2>발화 · Utterance</h2>

      <LevelMeter levels={levels} live={phase === 'recording'} />

      <div className="stt-controls">
        {phase === 'recording'
          ? <button className="rec-stop" onClick={stopRecording}>■ 녹음 정지</button>
          : <button disabled={!able.canRecord || phase === 'transcribing'} onClick={() => void startRecording()}>● 녹음</button>}
        {/* 파일 입력의 기본 모양은 브라우저마다 다르고 "선택된 파일 없음"이 붙어 나온다.
            좁은 패널에서는 그 문구가 잘려 읽을 수 없는 글자만 남으므로 입력을 감추고
            라벨을 버튼처럼 쓴다. 기능은 그대로다. */}
        <label className={fileDisabled ? 'file-fallback is-disabled' : 'file-fallback'}>
          파일 선택
          <input type="file" accept="audio/*" disabled={fileDisabled}
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void send(file); }} />
        </label>
        <label className="hotword-toggle" title="레지스트리에 등록된 구역·장비 이름 쪽으로 인식을 맞춥니다. 끄면 편향 없이 인식합니다 — VZ-L-03 임계 실측의 대조군입니다.">
          <input type="checkbox" checked={useHotwords} onChange={(event) => setUseHotwords(event.target.checked)} />
          등록 이름 우선
        </label>
      </div>
      <Explain id="utt-3" className="stt-hint">
        <b>등록 이름 우선</b> — 레지스트리에 등록된 구역·장비 이름(<code>503 구역</code>·<code>엣지 노드 A</code> …)
        쪽으로 인식을 맞춥니다. 끄면 그 편향 없이 인식합니다.
      </Explain>

      {able.note && <p className="stt-note">{able.note}</p>}
      {phase === 'transcribing' && <p className="stt-note">인식 중입니다. 모델을 처음 읽는 경우 오래 걸립니다.</p>}
      {error && <p className="stt-error">{error.message}{error.detail ? <small>{error.detail}</small> : null}</p>}

      {/*
        임무 생성 진행 — **접어 둔다** (260910 지시). 뒤 세 칸은 배지가 셋이고,
        **무엇이 이 마일스톤을 썼는가**가 여기서 갈린다.

        접혀 있어도 **돌고 있거나 막혔으면 저절로 펴진다.** 접었다는 이유로 「왜 안 되지」의
        답이 감춰지면 안 된다 — 접기는 평소를 조용하게 하려는 것이지 사실을 감추려는 것이 아니다.
      */}
      <details className="steps-box" open={stepsOpen || producer === 'running' || phase === 'failed'}
        onToggle={(event) => setStepsOpen((event.target as HTMLDetailsElement).open)}>
        <summary>임무 생성 진행 <small>{producerWord(producer)}</small></summary>
      <div className="progress-steps">
        {steps.map((step) => <span key={step.label} className={`step-${step.state}`}>{STEP_MARK[step.state]} {step.label}</span>)}
        {producer === 'running' && MOCK_STEPS.map((label, index) => (
          <span key={label} className="step-generating" title={`생성 중입니다 — 실측 최대 ${GENERATE_MAX_SEC}초`}>
            <b>AI</b> {label}{index === 0 ? ` … ${genElapsed.toFixed(1)}초` : ''}
          </span>
        ))}
        {producer === 'ai' && genOutcome !== null && aiSteps(genOutcome.view.milestones.length, genOutcome.nodeCount, genOutcome.edgeCount).map((label) => (
          <span key={label} className="step-ai" title={`모델이 만들었습니다 — ${genOutcome.provenance.model} · 태스크 칸은 모델이 아니라 규칙(solveDeps)입니다`}>
            <b>AI</b> {label}
          </span>
        ))}
        {producer === 'script' && SCRIPT_STEPS.map((label) => (
          <span key={label} className="step-script" title="키워드 대조로 미리 써 둔 대본을 꺼냈습니다 — LLM(VZ-G-01)이 아닙니다">
            <b>대본</b> {label}
          </span>
        ))}
        {producer === 'mock' && MOCK_STEPS.map((label) => (
          <span key={label} className="step-mock" title="아직 아무것도 안 했습니다 — 문장을 넣으면 대본 조회 또는 생성(VZ-G-01)이 돕니다">
            <b>목</b> {label}
          </span>
        ))}
      </div>
      </details>

      {/* 생성 서비스가 없으면 **이 경로만** 꺼진다. 문구를 감추지 않는다 (`verify:no-llm`). */}
      {genAble.note && <p className="gen-note">{genAble.note}</p>}
      {genStatus === 'ready' && genEngine !== null && genEngine !== 'stub' && (
        <p className="gen-note">
          생성 서비스가 떠 있습니다 ({genEngine} · {generateBaseUrl()}). 문장을 넣으면 임무를 <b>제안</b>합니다 — 승인 전에는 실행되지 않습니다.
          {/* **어느 모델이 답할 것인가를 화면이 적는다.** 서비스는 이름 없이 오는 요청을
              거부하고(「아무거나 고르면 무엇을 쟀는지 알 수 없습니다」), 그 규칙은 화면에도
              그대로 걸린다 — 어느 모델이 냈는지 모르는 제안에는 근거가 없다.
              목록은 서비스가 준다: 여기에 이름을 박지 않는다. */}
          <label className="gen-model">
            가중치
            <select value={genModel ?? ''} disabled={genPhase === 'running' || genModels.length === 0}
              onChange={(event) => setGenModel(event.target.value)}>
              {genModels.length === 0 && <option value="">쓸 수 있는 가중치가 없습니다</option>}
              {genModels.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.id}{entry.licenseFile === null ? '' : ' — 별도 라이선스 (비상업 연구용)'}
                </option>
              ))}
            </select>
            <small>물고 있지 않은 것을 고르면 적재에 수십 초가 걸립니다</small>
          </label>
          {/* 태스크까지 낼 것인가 — `VZ-G-02` 의 모델 쪽 절반. 끌 수 있어야 하는 이유는
              시간이다: 켜면 6.4 → 26초다(10단계 실측). 의존은 어느 쪽이든 규칙이 만든다. */}
          <label className="gen-model">
            <input type="checkbox" checked={genTasks} disabled={genPhase === 'running'}
              onChange={(event) => setGenTasks(event.target.checked)} />
            태스크까지 생성 <small>끄면 마일스톤만 (6초) · 켜면 태스크까지 (실측 최대 {GENERATE_MAX_SEC_TASKS}초) · 의존은 어느 쪽이든 규칙이 만듭니다</small>
          </label>
        </p>
      )}
      {genEngine === 'stub' && (
        <p className="gen-note">생성 서비스는 떠 있으나 <b>스텁</b>입니다 — 가중치나 엔진 바이너리가 없습니다. 돌려주는 임무는 계약을 만족하는 최소 임무이지 생성 결과가 아닙니다.</p>
      )}
      {genPhase === 'running' && (
        <p className="gen-progress" role="status">
          <b>생성 중</b> {genElapsed.toFixed(1)}초 <small>실측 최대 {generateMaxSec}초 · 실시간이 아닙니다 (사람이 수락하는 단계)</small>
          <progress max={generateMaxSec} value={Math.min(genElapsed, generateMaxSec)} />
          {/* 상한을 넘으면 **넘었다고 적는다.** 막대가 끝에 붙은 채로 멈춰 있으면
              사람은 화면이 죽었다고 읽는다. */}
          {genElapsed > generateMaxSec && <small>실측 최대를 넘었습니다 — 처음 부르는 가중치라면 적재 중일 수 있습니다.</small>}
        </p>
      )}
      {genError && <p className="stt-error">{genError.message}{genError.detail ? <small>{genError.detail}</small> : null}</p>}

      {/* 어느 키워드가 맞아서 어느 대본이 골라졌는지 — 그 자리에서 보여준다 (REQ-1207의 정신). */}
      {scriptMatch?.kind === 'matched' && (
        <p className="script-match">
          대본 <code>{scriptMatch.entry.missionId}</code> — 맞은 키워드 {scriptMatch.keywords.map((k) => <b key={k}>{k}</b>)}
          <small>키워드 대조 결과입니다. LLM이 아니며, 마일스톤·태스크는 대본에서 읽습니다</small>
        </p>
      )}
      {(scriptMatch?.kind === 'none' || scriptMatch?.kind === 'ambiguous') && (
        <p className="stt-error">{scriptMatch.reason}</p>
      )}

      {/* ── 생성 근거 (`VZ-G-01` — 「역추적이 맨 위까지 닿는다」) ──────────────────
          모델 이름 한 줄로 뭉개지 않는다. 같은 모델도 프롬프트가 다르면 다른 것을 낸다. */}
      {genOutcome !== null && (
        <section className="gen-result">
          <h3>
            <b className="badge-ai">AI</b> 생성 결과 <code>{genOutcome.view.missionId}</code>
            <small>{genOutcome.proposed ? '제안으로 서 있습니다 — 승인해야 캔버스에 올라갑니다' : '대본이 맞아 대본이 제안입니다 — 이 결과는 나란히 보기만 합니다'}</small>
          </h3>
          <ol className="gen-milestones">
            {genOutcome.view.milestones.map((milestone) => (
              <li key={milestone.id}>
                <b>{milestone.id}</b> {milestone.title}
                <small>{milestone.assignedTargets.join(' · ') || '미배정'}</small>
              </li>
            ))}
          </ol>
          {/* 발화가 요구한 모양과 계획의 모양이 어긋났는가 (11단계).
              **경고이지 차단이 아니다** — 제안은 그대로 뜨고, 사람이 승인을 판단할 재료가
              하나 는다. 이것이 없으면 「분기를 순차로 꿴 계획」이 스키마도 통과하고 순환도
              없어서 화면에서 아무 표시 없이 승인 대기에 선다. */}
          {genOutcome.provenance.shapeWarnings.map((note) => (
            <p key={note.kind} className="gen-shape-warning">
              <b>{note.kind === 'loop' ? '되풀이' : '갈래'}</b> {note.message}
              <small>발화에서 잡힌 말: {note.markers.map((m) => `「${m}」`).join(' · ')} — 지금 생성 경로가 못 만드는 모양입니다. 승인 전에 사람이 봐야 합니다</small>
            </p>
          ))}
          {/* 문법이 값의 범위는 못 잡는다 (7단계 §5 — confidence 5 가 문법을 통과했다).
              **잡은 것을 안 보이면 잡은 의미가 없다.** */}
          {genOutcome.provenance.schemaErrors.length > 0 && (
            <p className="stt-error">
              계약 위반 {genOutcome.provenance.schemaErrors.length}건 — 제안은 뜨지만 사람이 보고 판단할 자리입니다
              <small>{genOutcome.provenance.schemaErrors.join(' · ')}</small>
            </p>
          )}
          {/* 모델이 규칙을 어기고 적은 의존은 **버렸다는 사실을 적는다.** 조용히 버리면
              「모델이 지시를 지켰는가」를 영영 못 잰다 (utterance 덮어쓰기와 같은 규칙). */}
          {genOutcome.modelDeps > 0 && (
            <p className="gen-note">
              모델이 적은 의존 {genOutcome.modelDeps}건을 버렸습니다 — 의존은 규칙(<code>solveDeps</code>)이 만듭니다
              <small>실행 전에는 병렬의 근거가 없어, 모델이 낸 의존은 순환·고아 노드를 만듭니다 (지시서 §5)</small>
            </p>
          )}
          {genOutcome.provenance.overwritten.length > 0 && (
            <p className="gen-note">
              부르는 쪽 값으로 덮어쓴 자리 {genOutcome.provenance.overwritten.length}건 — {genOutcome.provenance.overwritten.map((entry) => entry.field).join(' · ')}
              <small>모델이 되받아 적은 값 대신 이 화면이 준 값을 씁니다. 감추지 않고 적습니다</small>
            </p>
          )}
          {!genOutcome.proposed && (
            <button type="button" className="gen-switch" onClick={switchToGenerated}>
              이 AI 제안으로 바꾸기 <small>바꿔도 승인 전에는 실행되지 않습니다</small>
            </button>
          )}
          <details className="gen-provenance">
            <summary>생성 근거 — produced_by=ai · 모델 · 프롬프트 지문 · 적용된 규칙</summary>
            <dl>
              <dt>생성 주체</dt><dd>produced_by=ai · {genOutcome.provenance.engine}{genOutcome.provenance.stub ? ' (스텁 — 생성 결과가 아닙니다)' : ''}</dd>
              <dt>모델</dt><dd><code>{genOutcome.provenance.model}</code></dd>
              <dt>프롬프트 지문</dt><dd><code>{genOutcome.provenance.promptDigest ?? '해당 없음 (스텁에는 프롬프트가 없습니다)'}</code>{genOutcome.provenance.promptChars !== null ? <small>{genOutcome.provenance.promptChars}자</small> : null}</dd>
              <dt>문법</dt><dd>{genOutcome.provenance.grammar ? <><code>{genOutcome.provenance.grammar.digest}</code> <small>{genOutcome.provenance.grammar.source} · {genOutcome.provenance.grammar.bytes}B</small></> : '없음'}</dd>
              <dt>재료</dt><dd>장소 {genOutcome.provenance.placesGiven ? '줌' : '없음'} · 장비 {genOutcome.provenance.equipmentGiven}건 · 예시 {genOutcome.provenance.examplesGiven}편 · 노드 종류 규칙 {genOutcome.provenance.nodeKindsGiven ? '붙임' : '없음'}</dd>
              <dt>소요</dt><dd>{genOutcome.provenance.elapsedSec.toFixed(2)}초</dd>
            </dl>
            {/* **규칙 목록은 서비스가 준 그대로다.** 화면이 따로 적으면 모델이 지킨 규칙과
                사람이 본 규칙이 갈라진다. 줄이지도 않는다 — 줄이면 역추적이 거기서 끊긴다. */}
            <ol className="gen-rules">
              {(genOutcome.provenance.rules ?? []).map((rule, index) => <li key={index}>{rule}</li>)}
            </ol>
            {genOutcome.provenance.rules === null && (
              <Explain id="utt-6" className="hint">규칙 목록이 없습니다 — 스텁이라 프롬프트가 만들어지지 않았습니다. 「규칙 0개」와 다른 말입니다.</Explain>
            )}
            <Explain id="utt-5" className="hint">
              이 목록은 서비스의 <code>rules_for()</code> 가 준 그대로입니다. 승인하면 이 근거가 기록 열에
              <code>produced_by=ai</code> 사건으로 들어가고, 되감기 화면의 <b>AI</b> 줄에 뜹니다.
            </Explain>
          </details>
        </section>
      )}

      {result && decision ? (
        <>
          <label className="transcript-edit">
            <span>인식 결과 — 고칠 수 있습니다 (1차 확인 · REQ-1303)</span>
            <textarea value={edited} rows={2} onChange={(event) => { setEdited(event.target.value); setConfirmed(false); }} />
          </label>
          {edited.trim() !== result.text && (
            <p className="transcript-original">원문: “{result.text}” <small>원문과 수정본을 둘 다 보관합니다</small></p>
          )}
          <dl>
            <dt>엔진</dt><dd>{result.engine} · {result.model}</dd>
            <dt>판정</dt>
            <dd className={`verdict-${decision.verdict}`}>
              {VERDICT_LABEL[decision.verdict]} <small>{PROVISIONAL_NOTE}</small>
            </dd>
            <dt>등록 이름</dt>
            <dd>
              {useHotwords ? `${appliedHotwords}개 반영` : '끔 (대조군)'}
              {useHotwords && appliedHotwords === 0 ? <small>요청했으나 적용되지 않음</small> : null}
            </dd>
            <dt>생성 주체</dt><dd>produced_by=human · input_modality=voice</dd>
          </dl>
          <Numbers result={result} decision={decision} />
          {decision.verdict === 'confirm' && (
            <label className="reconfirm">
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
              위 문장이 맞는지 확인했습니다
            </label>
          )}
          {decision.verdict === 'reject' && <p className="stt-error">임계 미만입니다. 다시 녹음하거나 아래에 문장을 직접 넣으세요.</p>}
          <button className="submit-utterance" disabled={blocked || !edited.trim()} onClick={() => void submitVoice()}>
            이 발화로 임무 생성 요청
          </button>
        </>
      ) : (
        <blockquote>“{fallbackText}”<small>시나리오 목 문장 — 녹음하면 실제 인식 결과로 바뀝니다</small></blockquote>
      )}

      {/* 시연 문장 — 대본 라이브러리의 기준 문장. 보고 말하거나(녹음), 누르면 아래 입력창에 채워진다.
          이 문장이 그대로일 필요는 없다 — 매칭은 키워드 대조라 「월류방어벽 가동해」도 통한다. */}
      <details className="script-sentences" open={sentencesOpen}
        onToggle={(event) => setSentencesOpen((event.target as HTMLDetailsElement).open)}>
        <summary>예시 문장 <small>보고 말하거나 · 누르면 아래 입력창에 채워집니다</small></summary>
        <ul>
          {DEMO_SENTENCES.map((demo) => (
            <li key={demo.missionId}>
              <button type="button" title={`${demo.missionId} — 누르면 「문장을 직접 넣기」에 채워집니다`}
                onClick={() => { setManual(demo.text); setManualOpen(true); }}>
                “{demo.text}”
              </button>
              <small>{demo.missionId} · {demo.title}</small>
            </li>
          ))}
        </ul>
      </details>

      <details className="manual-input" open={manualOpen || status === 'unavailable'}
        onToggle={(event) => setManualOpen((event.target as HTMLDetailsElement).open)}>
        <summary>문장을 직접 넣기</summary>
        <Explain id="utt-4" className="hint">STT 서비스({sttBaseUrl()})가 없어도 이 경로는 항상 열려 있습니다.</Explain>
        <textarea value={manual} rows={2} placeholder="예: 503 구역 로봇을 5층 복도로 이동시켜"
          onChange={(event) => setManual(event.target.value)} />
        <button disabled={!manual.trim()} onClick={() => void submitManual()}>직접 입력으로 요청</button>
      </details>

      {issued && <p className="stt-issued">{issued}</p>}
    </aside>
  );
}
