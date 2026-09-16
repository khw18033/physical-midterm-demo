/**
 * src/stt/SttClient.ts
 *
 * **가시화 코드가 STT 서비스를 보는 유일한 면이다.** 이 파일 밖에서 `fetch` 로
 * STT를 부르지 않는다. 서비스가 프로세스가 아니라 워커나 WASM으로 바뀌어도
 * 갈아끼우는 곳이 여기 하나가 되게 하기 위한 제약이다.
 *
 * 서비스가 꺼져 있어도 화면은 떠야 한다 (VZ-C-02 / VZ-G-01). 그래서 이 모듈은
 * 실패를 **던지기만 하고 잡지 않는다** — 무엇을 비활성화할지는 화면이 정한다.
 */

import { connectionAddress, registerConnectionDefault } from '../shared/connections.ts';
import { SttUnavailableError, type SttResult } from './types.ts';

const meta = import.meta as unknown as { env?: { VITE_STT_URL?: string } };

/**
 * 목 게이트웨이(8790)·대시보드(5173/8787~8788)·stt-lab(8799)과 겹치지 않는 포트.
 *
 * **환경변수는 이제 기본값이다** (260904 — `VZ-C-07`). 화면의 「연결 관리」가 덮어쓸 수
 * 있고, 덮어쓴 값이 있으면 그것이 이긴다. 다만 **STT 주소를 아는 면은 여기 하나**여야
 * 하므로(`verify:no-stt`) 환경변수는 이 파일에서만 읽고, 연결 저장소에는 **기본값만 심는다.**
 */
registerConnectionDefault('stt', 'base', meta.env?.VITE_STT_URL ?? 'http://127.0.0.1:8801');

/** 지금 쓰는 STT 주소. 상수가 아니라 **읽을 때마다 지금 값**이다. */
export function sttBaseUrl(): string {
  return connectionAddress('stt', 'base');
}

const transcribeUrl = () => `${sttBaseUrl()}/stt/transcribe`;

export type TranscribeOptions = {
  /** 켬/끔만 보낸다. **어휘 문자열은 보내지 않는다** — 서비스가 registry 원본에서 매번 새로 뽑는다 (REQ-305). */
  useHotwords?: boolean;
  vadFilter?: boolean;
  model?: string;
  signal?: AbortSignal;
};

async function post(body: FormData, signal?: AbortSignal): Promise<SttResult> {
  let response: Response;
  try {
    response = await fetch(transcribeUrl(), { method: 'POST', body, signal });
  } catch (error) {
    // 서비스가 안 떠 있는 흔한 경우가 여기로 온다. 화면은 이 문장을 그대로 보여주고
    // 음성 기능만 끈다.
    throw new SttUnavailableError('offline', `STT 서비스에 닿지 않습니다 (${sttBaseUrl()})`, String(error));
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SttUnavailableError('service', `STT 응답을 해석할 수 없습니다 (HTTP ${response.status})`, text.slice(0, 400));
  }
  if (!response.ok) {
    const detail = parsed as { error?: string; traceback?: string };
    throw new SttUnavailableError('service', detail.error ?? `STT 실패 (HTTP ${response.status})`, detail.traceback);
  }
  return parsed as SttResult;
}

/** 오디오 한 건 → 인식 결과. 이 함수가 STT의 전부다. */
export async function transcribe(blob: Blob, options: TranscribeOptions = {}): Promise<SttResult> {
  const body = new FormData();
  const suffix = blob.type.includes('wav') ? 'wav' : 'webm';
  body.append('audio', blob, `utterance.${suffix}`);
  body.append('use_hotwords', String(options.useHotwords ?? true));
  body.append('vad_filter', String(options.vadFilter ?? true));
  if (options.model) body.append('model', options.model);
  return post(body, options.signal);
}

/** `probe()` 의 결과. **사유를 버리지 않는다** (260901 — 후속 3건 요구 3). */
export type SttProbe = {
  alive: boolean;
  /** 못 닿았으면 왜인지. 화면이 이 문장을 그대로 적는다. 닿았으면 null. */
  reason: string | null;
};

/**
 * 서비스가 살아 있는가.
 *
 * **전용 헬스 엔드포인트를 두지 않는다.** 이 서비스의 면은 `POST /stt/transcribe`
 * 하나뿐이고, 살아 있는지 알려고 라우팅을 늘리면 stt-lab 이 실험용 라우팅 8개로
 * 불어난 길을 그대로 밟게 된다. 대신 같은 경로에 GET 을 던진다 —
 * **응답이 오면(405 Method Not Allowed) 프로세스가 살아 있다는 뜻**이고,
 * 네트워크 자체가 실패하면 꺼져 있다는 뜻이다.
 *
 * **던지지 않는다** — 여기서 예외가 새면 발화 패널의 첫 렌더가 통째로 날아간다
 * (`verify:no-stt`). 대신 실패 사유를 함께 돌려준다: 8/31까지는 `catch { return false }`
 * 로 사유를 통째로 버려서, 「서비스가 안 떠 있다」와 「떠 있는데 브라우저가 막았다」가
 * 화면에서 **같은 한 문장**으로 보였다. 그 둘은 고치는 방법이 전혀 다르다.
 */
export async function probe(signal?: AbortSignal): Promise<SttProbe> {
  try {
    await fetch(transcribeUrl(), { method: 'GET', signal });
    return { alive: true, reason: null };
  } catch (error) {
    return { alive: false, reason: await describeProbeFailure(error, signal) };
  }
}

/**
 * 왜 못 닿았는가 — 사람이 읽고 **다음 행동을 고를 수 있는** 한 줄.
 *
 * 브라우저의 `fetch` 는 「서비스가 없다」와 「서비스는 있는데 CORS 로 막혔다」를 **똑같은
 * `TypeError: Failed to fetch`** 로 던진다. 그 둘을 가르려고 `mode: 'no-cors'` 로 한 번 더
 * 던진다 — 프로세스가 살아 있으면 불투명(opaque) 응답이라도 돌아오고, 꺼져 있으면 여기서도
 * 실패한다. 실패 경로에서만 한 번 더 부르므로 평소에는 비용이 없다.
 */
async function describeProbeFailure(error: unknown, signal?: AbortSignal): Promise<string> {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if ((error as { name?: string } | null)?.name === 'AbortError') return '확인이 취소됐습니다.';
  // 망 실패가 아닌 것(그 외)은 원문 그대로 — 지어내는 것보다 낫다.
  if (!(error instanceof TypeError)) return raw;
  try {
    await fetch(transcribeUrl(), { method: 'GET', mode: 'no-cors', signal });
    return `서비스는 떠 있는데 브라우저가 막았습니다 (${sttBaseUrl()}) — stt/service.py 의 ALLOWED_ORIGINS 에 이 페이지 주소가 있는지 확인하세요.`;
  } catch {
    return `서비스가 떠 있지 않습니다 (${sttBaseUrl()}) — npm run dev:stt 로 따로 띄워 사유를 보세요. 원문: ${raw}`;
  }
}
