/**
 * src/generate/LlmClient.ts (260904 신설 — 마일스톤 분리 지시서 §3)
 *
 * **가시화 코드가 생성 서비스를 보는 유일한 면이다.** 이 파일 밖에서 `fetch` 로 생성
 * 서비스를 부르지 않는다. 엔진이 바뀌어도(llama.cpp · vLLM · 원격 API) 갈아끼우는 곳이
 * 여기 하나가 되게 하기 위한 제약이고, `verify:gen-port` 가 그것을 검사한다.
 *
 * `SttClient.ts` 의 구조를 그대로 따른다 — 같은 문제를 같은 모양으로 푼다.
 *
 * ## 브라우저 안이 아니다
 *
 * 모델은 번들에 들어가지 않는다. 이유 셋이 이 저장소의 기존 제약과 직접 충돌하기 때문이다.
 *  1. `verify:standalone` 이 단독 빌드 오염을 **KB 단위**로 감시한다. 모델을 번들에 넣으면
 *     그 검사가 의미를 잃는다. 사이드카면 이 파일은 fetch 래퍼라 몇 KB다.
 *  2. 문법 강제 디코딩이 브라우저 스택에서 안정적이지 않다 — **그것이 이 작업의 핵심 도구다.**
 *  3. 배포에서 모델을 빼는 선택지(배치 ① 생성 꺼짐)가 사라진다.
 *
 * ## 서비스가 꺼져 있어도 화면은 뜬다
 *
 * 그래서 이 모듈은 실패를 **던지기만 하고 잡지 않는다** — 무엇을 비활성화할지는 화면이
 * 정한다(`availability.ts`). 꺼지는 것은 **생성 하나**이고 대본 재생·되감기·캔버스는
 * 그대로 돈다 (`verify:no-llm`).
 *
 * ## 문법은 계약에서 뽑아 **요청에 실어 보낸다**
 *
 * 손으로 쓴 문법 파일을 두지 않는다(`gbnf.ts`). 클라이언트가 계약에서 뽑아 보내므로
 * **부르는 쪽이 계약 밖 출력을 요구할 수 없다.** 엔진이 붙으면 서비스도 같은 계약에서
 * 다시 뽑아 대조하는 것이 다음 단계다 — 지금은 스텁이라 받은 지문을 되돌려 주기만 한다.
 */

import { connectionAddress, registerConnectionDefault } from '../shared/connections.ts';
import missionContract from '../../../contracts/mission.schema.json' with { type: 'json' };
import milestoneContract from '../../../contracts/milestone.schema.json' with { type: 'json' };
import taskContract from '../../../contracts/task.schema.json' with { type: 'json' };
import actionItemContract from '../../../contracts/action-item.schema.json' with { type: 'json' };
import evaluationContract from '../../../contracts/evaluation.schema.json' with { type: 'json' };
import { digest, toGbnf, type JsonSchema } from './gbnf.ts';
import { LlmUnavailableError, type GenerateResult } from './types.ts';

const meta = import.meta as unknown as { env?: { VITE_GENERATE_URL?: string } };

/**
 * 목 게이트웨이(8790)·대시보드(5173/8787~8788)·STT(8801)·stt-lab(8799)과 겹치지 않는 포트.
 *
 * **환경변수는 기본값이다** (`VZ-C-07`). 화면의 「연결 관리」가 덮어쓸 수 있고, 덮어쓴 값이
 * 있으면 그것이 이긴다. 다만 **생성 주소를 아는 면은 `src/generate/` 하나**여야 하므로
 * (`verify:gen-port`) 환경변수는 이 파일에서만 읽고 연결 저장소에는 **기본값만 심는다.**
 */
registerConnectionDefault('generate', 'base', meta.env?.VITE_GENERATE_URL ?? 'http://127.0.0.1:8802');

/** 지금 쓰는 생성 서비스 주소. 상수가 아니라 **읽을 때마다 지금 값**이다. */
export function generateBaseUrl(): string {
  return connectionAddress('generate', 'base');
}

/** `$id` → 계약. `$ref` 를 푸는 데 쓴다. 계약 파일이 늘면 여기에 더한다. */
const CONTRACTS: ReadonlyMap<string, JsonSchema> = new Map<string, JsonSchema>(
  [missionContract, milestoneContract, taskContract, actionItemContract, evaluationContract]
    .map((schema) => [String((schema as JsonSchema).$id), schema as JsonSchema]),
);

let cachedGrammar: { text: string; digest: string } | null = null;

/**
 * 계약에서 뽑은 문법. **한 번 뽑아 들고 있는다** — 계약은 빌드에 박혀 있으므로 매 요청마다
 * 다시 뽑을 이유가 없다. 뽑다 실패하면 던진다(문법 없이 요청하면 강제 디코딩이 없다).
 */
export function missionGrammar(): { text: string; digest: string } {
  if (cachedGrammar === null) {
    const text = toGbnf(missionContract as JsonSchema, CONTRACTS);
    cachedGrammar = { text, digest: digest(text) };
  }
  return cachedGrammar;
}

export type GenerateOptions = {
  /**
   * 장소 위상 (`places.json` 의 내용). **기하 파일은 넘기지 않는다** — 좌표를 보면 모델이
   * 503호 전용이 된다(지시서 §1). 비어 있으면 그라운딩 없이 도는 것이고, 그 사실이
   * 응답의 `extra` 에 남는다.
   */
  places?: unknown;
  /**
   * 장비 어휘 (`equipment/equipment.json` 의 내용). 장소와 **같은 자리의 재료**다 —
   * 260906 실측에서 목록을 준 장소 축은 위반 0건이고 안 준 장비 축은 22~48% 였고,
   * 7단계가 그 대조를 처방으로 바꾼 것이 이 값이다.
   *
   * 안 주면 규칙도 목록도 붙지 않는다. 그것이 대조판(A)이고, 그 판이 있어야 차이를
   * 장비 목록에 돌릴 수 있다 — `enforceGrammar` 를 끌 수 있게 둔 것과 같은 이유다.
   */
  equipment?: unknown;
  /**
   * few-shot 예시. **채점 대상인 편은 예시에서 뺀다**(지시서 §4). 부르는 쪽이 고른다 —
   * 서비스는 어느 편이 채점 대상인지 모르기 때문이다. 뺐는지 검사하는 것이
   * `verify:no-leak` 이고, 이 값이 그 검사의 대상이다.
   */
  examples?: unknown[];
  /**
   * 노드 문법 5종(감지·판단·실행·검증·보고) 규칙을 붙일 것인가 (8단계 D 판).
   *
   * **장소·장비와 성질이 다르다.** 그 둘은 부르는 쪽이 고르는 *재료*(목록)이지만 이것은
   * *규칙*이라 넘길 목록이 없다 — 다섯 종류는 규칙 문장 안에 있고, 그 문장은 서비스의
   * `prompt.rules_for()` 한 곳이 정한다. 여기서 넘기는 것은 켜고 끄는 스위치 하나다.
   *
   * `enforceGrammar` 와 같은 이유로 끌 수 있다: 「이 규칙이 실제로 드는가」는 안 붙인
   * 판(B)과 비교해야 답이 된다.
   */
  nodeKinds?: boolean;
  /**
   * 마일스톤 안에 **태스크까지** 내게 할 것인가 (10단계 E 판 · `VZ-G-02`).
   *
   * 켜면 규칙이 갈린다 — 「`tasks` 는 빈 배열로 둔다」가 태스크를 내라는 규칙들로
   * 바뀐다. **`deps` 는 그래도 모델의 것이 아니다**: 모델은 빈 배열을 내고
   * `proposal.ts` 의 `tasksFromGenerated()` 가 `solveDeps()` 로 매단다(지시서 §5).
   * 실행 전에는 병렬의 근거가 없어 모델이 낸 의존은 순환·고아 노드를 만든다.
   */
  tasks?: boolean;
  /**
   * 마일스톤에 **분기·되풀이**를 적게 할 것인가 (분기와루프 3단계 G 판).
   *
   * **없는 것이 정상이다.** 발화가 요구하지 않았는데 나오면 지어내기이고, 채점이 그것을
   * 따로 센다 — 8단계 D 판이 「새 자리를 열면 모델이 그 자리를 채운다」를 보였기 때문이다.
   */
  branch?: boolean;
  model?: string;
  /**
   * 임무 식별자. **부르는 쪽이 준다** — 모델이 지어낼 것이 아니다. `audio_ref` 와 같은
   * 성질이고, `VZ-G-01` 이 만드는 것은 마일스톤이지 식별자가 아니다.
   */
  missionId?: string;
  /** 계약의 `utterance` 를 그대로 넘긴다. 모델은 옮겨 적기만 하면 된다. */
  utteranceMeta?: unknown;
  /**
   * 문법을 걸 것인가. 기본은 건다.
   *
   * **끌 수 있어야 하는 이유가 있다.** 「강제 디코딩이 실제로 듣는가」는 안 걸었을 때와
   * 비교해야 답이 된다 — 걸고 잰 통과율 하나만으로는 그 숫자가 문법 덕분인지 모델이
   * 원래 잘하는 것인지 모른다. 화면은 이 값을 건드리지 않는다(대조군은 CLI 의 일이다).
   */
  enforceGrammar?: boolean;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  signal?: AbortSignal;
};

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${generateBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // 서비스가 안 떠 있는 흔한 경우가 여기로 온다. 화면은 이 문장을 그대로 보여주고
    // 생성 기능만 끈다.
    throw new LlmUnavailableError('offline', `생성 서비스에 닿지 않습니다 (${generateBaseUrl()})`, String(error));
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmUnavailableError('service', `생성 응답을 해석할 수 없습니다 (HTTP ${response.status})`, text.slice(0, 400));
  }
  if (!response.ok) {
    const detail = parsed as { error?: string; traceback?: string };
    throw new LlmUnavailableError('service', detail.error ?? `생성 실패 (HTTP ${response.status})`, detail.traceback);
  }
  return parsed;
}

/**
 * 문장 하나 → 임무 객체. **이 함수가 생성의 전부다.**
 *
 * 결과는 **제안**이다 — 사람이 수락하기 전에는 아무것도 실행되지 않는다(`VZ-U-07`).
 * 그 규칙을 지키는 것은 화면이고, 여기서는 만들어 돌려주기만 한다.
 */
export async function generateMission(utterance: string, options: GenerateOptions = {}): Promise<GenerateResult> {
  const grammar = missionGrammar();
  const parsed = await post('/generate/mission', {
    utterance,
    // **계약에서 뽑은 문법을 함께 보낸다.** 부르는 쪽이 계약 밖 출력을 요구할 수 없다.
    grammar: { source: 'contracts/mission.schema.json', digest: grammar.digest, text: grammar.text },
    places: options.places ?? null,
    equipment: options.equipment ?? null,
    examples: options.examples ?? [],
    node_kinds: options.nodeKinds ?? false,
    tasks: options.tasks ?? false,
    branch: options.branch ?? false,
    model: options.model ?? null,
    mission_id: options.missionId ?? null,
    utterance_meta: options.utteranceMeta ?? null,
    enforce_grammar: options.enforceGrammar ?? true,
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  }, options.signal);
  return parsed as GenerateResult;
}

/** `probe()` 의 결과. **사유를 버리지 않는다** (`SttProbe` 와 같은 규칙). */
export type GenerateProbe = {
  alive: boolean;
  /** 못 닿았으면 왜인지. 화면이 이 문장을 그대로 적는다. 닿았으면 null. */
  reason: string | null;
  /** 닿았으면 무엇이 떠 있는지. 스텁이면 그렇게 적힌다 — 목임을 감추지 않는다. */
  engine: string | null;
  /**
   * 쓸 수 있는 가중치 이름들. **화면이 하나를 골라야 한다** — 엔진은 모델을 안 주면
   * 거부한다(「아무거나 고르면 무엇을 쟀는지 알 수 없습니다」). 그 규칙은 측정에서
   * 나왔지만 화면에도 그대로 걸린다: 어느 모델이 답했는지 모르는 제안은 근거가 없다.
   *
   * **목록을 코드에 두지 않는다.** `models/` 에 있는 것을 서비스가 그대로 읽고
   * (`gen-lab/README.md`), 화면은 받은 것을 보여주기만 한다 — 새 모델을 재는 일이
   * 화면 수정이 되면 「무엇을 쟀는가」가 커밋 사이에 흩어진다.
   */
  models: Array<{
    id: string;
    /**
     * 따로 받아 둔 라이선스 파일의 이름. 없으면 null.
     *
     * **있으면 조건이 붙은 가중치다.** 이 저장소는 그런 것에만 라이선스 전문을 함께
     * 받아 두었고(`gen-lab/README.md`), EXAONE 은 비상업 연구용이라 시연·배포 경로가
     * **조용히** 물어서는 안 된다. 화면은 이 값으로 기본 선택을 피하고 배지를 붙인다 —
     * 고르지 못하게 막지는 않는다(연구용 대조군으로는 정당하다).
     */
    licenseFile: string | null;
    /** 가중치 파일 크기. 화면의 기본 선택이 이름이 아니라 이 값으로 정해진다 (아래 주석). */
    bytes: number;
  }>;
  /** 지금 물고 있는 가중치. 없으면 null — 첫 요청이 적재를 부른다. */
  loaded: string | null;
};

/**
 * 서비스가 살아 있는가.
 *
 * `SttClient.probe()` 와 달리 **전용 경로를 하나 둔다**(`GET /generate/health`). STT 는 면이
 * 전사 엔드포인트 하나뿐이라 같은 경로에 GET 을 던져 405 를 살아 있음의 신호로 썼다
 * (그쪽 경로를 여기 적지 않는다 — `verify:no-stt` 는 STT 경로 문자열이 `src/stt/` 밖에
 * 나오면 잡는다. 주석이라도 잡는 것이 맞다: 문자열은 언젠가 코드가 된다).
 * 생성은 「무엇이 떠 있는가」(엔진·모델·스텁 여부)를 화면이 적어야 하므로 405 로는 부족하다 —
 * **목임을 감추지 않는다**는 이 저장소의 규칙이 그 자리를 요구한다.
 *
 * **던지지 않는다** — 여기서 예외가 새면 첫 렌더가 통째로 날아간다 (`verify:no-llm`).
 */
export async function probe(signal?: AbortSignal): Promise<GenerateProbe> {
  try {
    const response = await fetch(`${generateBaseUrl()}/generate/health`, { method: 'GET', signal });
    if (!response.ok) {
      return { alive: false, reason: `생성 서비스가 오류를 냈습니다 (HTTP ${response.status}, ${generateBaseUrl()})`, engine: null, models: [], loaded: null };
    }
    const body = (await response.json()) as {
      engine?: string; model?: string | null;
      models?: Array<{ id?: string; license_file?: string | null; bytes?: number }>;
    };
    return {
      alive: true,
      reason: null,
      engine: body.engine ?? null,
      models: (body.models ?? [])
        .filter((entry): entry is { id: string; license_file?: string | null; bytes?: number } => typeof entry.id === 'string')
        .map((entry) => ({ id: entry.id, licenseFile: entry.license_file ?? null, bytes: entry.bytes ?? 0 })),
      loaded: body.model ?? null,
    };
  } catch (error) {
    return { alive: false, reason: await describeProbeFailure(error, signal), engine: null, models: [], loaded: null };
  }
}

/**
 * 왜 못 닿았는가 — 사람이 읽고 **다음 행동을 고를 수 있는** 한 줄.
 *
 * 브라우저의 `fetch` 는 「서비스가 없다」와 「서비스는 있는데 CORS 로 막혔다」를 똑같은
 * `TypeError: Failed to fetch` 로 던진다. 그 둘을 가르려고 `mode: 'no-cors'` 로 한 번 더
 * 던진다 (`SttClient` 가 260901 에 같은 문제를 같은 방법으로 풀었다).
 */
async function describeProbeFailure(error: unknown, signal?: AbortSignal): Promise<string> {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if ((error as { name?: string } | null)?.name === 'AbortError') return '확인이 취소됐습니다.';
  if (!(error instanceof TypeError)) return raw;
  try {
    await fetch(`${generateBaseUrl()}/generate/health`, { method: 'GET', mode: 'no-cors', signal });
    return `서비스는 떠 있는데 브라우저가 막았습니다 (${generateBaseUrl()}) — gen-lab/server/main.py 의 ALLOWED_ORIGINS 에 이 페이지 주소가 있는지 확인하세요.`;
  } catch {
    return `서비스가 떠 있지 않습니다 (${generateBaseUrl()}) — gen-lab/README.md 의 절차로 따로 띄워 사유를 보세요. 원문: ${raw}`;
  }
}
