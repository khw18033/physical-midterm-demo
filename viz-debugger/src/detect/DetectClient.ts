/**
 * src/detect/DetectClient.ts (260912 신설)
 *
 * **탐지를 아는 면 하나.** 주소·경로·시료 위치가 여기 밖으로 나가지 않는다 —
 * `src/physical/` 이 브로커·토픽·장비 id 를 가두는 것과 같은 규칙이고 같은 이유다
 * (`verify:detect-port`).
 *
 * ## 우리가 받아 간다
 *
 * 관제 웹은 브라우저 페이지라 남이 보내는 요청을 못 받는다. 그래서 **밀어 주지 말고 열어만
 * 달라**고 했고, 우리가 주기적으로 물어본다(`문서/탐지_명령규약_260910.md` §2).
 *
 * ## 테스트 모드 (260912 지시)
 *
 * 연결 관리의 「테스트」를 켜면 같은 자리에서 **받아 둔 실제 산출물**(`door_example/`)을
 * 읽는다. 목을 지어내는 것이 아니라 **탐지 담당이 준 진짜 값**이다 — 그래서 화면이
 * 「테스트 자료」라고 적되 값 자체는 손대지 않는다.
 *
 * 시료는 개발 서버와 빌드가 `/detect-sample/` 로 내준다(`vite.config.ts`) — 저장소에 사본을
 * 만들지 않는다.
 */

import { connectionAddress, registerConnectionDefault } from '../shared/connections.ts';
import { DETECT_PRESETS } from './presets.ts';
import { detectImagePath, recordFileUrl } from '../record/recordClient.ts';
import type {
  DetectFeatures, DetectFrameEvidence, DetectLocalization, DetectPath, DetectSummary,
} from './types.ts';

const meta = import.meta as unknown as { env?: { VITE_DETECT_URL?: string } };

/**
 * **기본값이 Tailscale 주소다** (260914 지시).
 *
 * 전에는 비어 있어서 연결 관리에 주소를 손으로 넣어야 붙었다. 탐지가 시연장 밖의 데스크톱에서
 * 돌게 되면서 주소가 하나로 정해졌다 — 테일넷 이름이다(`presets.ts`). 로봇과 같은 규칙으로
 * 환경변수가 있으면 그것이 이기고, 연결 관리에서 넣은 값이 그 위에서 이긴다.
 */
const TAILSCALE = DETECT_PRESETS.find((preset) => preset.id === 'tailscale')?.url ?? '';
registerConnectionDefault('detect', 'base', meta.env?.VITE_DETECT_URL ?? TAILSCALE);

/** 탐지 서비스 주소. **이 함수 밖에서 주소 문자열을 만들지 않는다.** */
export function detectBaseUrl(): string {
  return connectionAddress('detect', 'base');
}

/** 받아 둔 실제 산출물이 서 있는 자리. 경로는 여기 한 줄이다. */
const SAMPLE_BASE = '/detect-sample';

/** 시료의 클래스 폴더. 문이 목표이고 받침대는 자세를 역산하는 기준점이다. */
export type DetectClass = 'door' | 'pedestal';

export type DetectSource = { kind: 'live'; base: string } | { kind: 'sample' };

/** 지금 어디서 읽는가. 테스트가 켜져 있으면 시료, 아니면 실제 서비스. */
export function sourceOf(testMode: boolean): DetectSource {
  return testMode ? { kind: 'sample' } : { kind: 'live', base: detectBaseUrl() };
}

/**
 * **그림을 어디서 읽는가** (260914 — 임무 기록). 결과를 묻는 곳(`DetectSource`)과 달리 그림에는
 * 자리가 하나 더 있다 — 다시보기 중이면 그 판의 기록 폴더다. 지난 판의 그림은 탐지 창구에 이미 없다.
 */
export type ImageSource = DetectSource | { kind: 'record'; date: string; run: string };

/** 화면이 그릴 그림의 자리 — 다시보기 중이면 기록, 아니면 `sourceOf`. */
export function viewSourceOf(state: { testMode: boolean; recordRun: { date: string; run: string } | null }): ImageSource {
  return state.recordRun !== null ? { kind: 'record', ...state.recordRun } : sourceOf(state.testMode);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return await response.json() as T;
}

/**
 * **테스트 자료도 한 각도씩 내놓는다** (260912 지시).
 *
 * 파일에는 여덟 각도가 다 들어 있다. 그걸 그대로 돌려주면 **시작하자마자 정답이 이미
 * 정해진 채로** 화면이 뜬다 — 실제 서비스는 그렇게 안 온다. 한 각도 스캔이 끝날 때마다
 * 하나씩 온다.
 *
 * 그래서 시료도 같은 박자로 내놓는다. 기준 시계는 **로봇이 돌기 시작한 뒤 몇 초째**
 * (`scanElapsedSec`)다 — 준비 단계(`T-A1`·`T-A2`)가 지나간 뒤부터 센다. 시작을 누른
 * 시각으로 재면 로봇이 아직 서 있는 동안 각도가 열려, 안 본 방향의 결과가 먼저 뜬다.
 */
const SAMPLE_STEP_SEC = 4;

/** 지금까지 몇 각도를 봤는가. 돌기 전(0초)이면 아무것도 안 봤다. */
export function sampleRevealed(elapsedSec: number, total: number): number {
  if (!(elapsedSec > 0)) return 0;
  return Math.max(0, Math.min(total, Math.floor(elapsedSec / SAMPLE_STEP_SEC)));
}

/** 각도별 결과 — 한 각도 스캔이 끝날 때마다 늘어난다 (260912 확인). */
export async function fetchSummary(
  source: DetectSource, target: DetectClass = 'door', elapsedSec = Infinity,
): Promise<DetectSummary> {
  if (source.kind !== 'sample') return getJson<DetectSummary>(`${source.base}/detect/results?target=${target}`);
  const all = await getJson<DetectSummary>(`${SAMPLE_BASE}/${target}/target_summary.json`);
  const frames = all.frames ?? [];
  return { ...all, frames: frames.slice(0, sampleRevealed(elapsedSec, frames.length)) };
}

/** 한 각도의 근거. 못 찾은 각도에는 없다 — 없는 것이 정상이라 null 로 돌려준다. */
export async function fetchFrameEvidence(
  source: DetectSource, frame: string, target: DetectClass = 'door',
): Promise<DetectFrameEvidence | null> {
  const dir = frame.replace(/\.jpg$/, '');
  const url = source.kind === 'sample'
    ? `${SAMPLE_BASE}/${target}/${dir}/evidence.json`
    : `${source.base}/detect/evidence?target=${target}&frame=${encodeURIComponent(frame)}`;
  try {
    return await getJson<DetectFrameEvidence>(url);
  } catch {
    return null;
  }
}

/**
 * 경로 산출. 스캔이 끝나야 나온다 — 그 전에는 없다.
 *
 * **셋을 가른다** (260914). 없음(아직 · 404) · 성공(`ok: true`) · **실패(`ok: false` + reason +
 * fallback_chain)**. 전에는 실패도 null 로 삼켜서, 경로가 영영 안 나오는데 화면은 계속 기다렸고
 * 그 사이 「경로대로 이동」이 대본 거리로 열렸다.
 */
export type PathAnswer = { path: DetectPath | null; failure: DetectPath | null };

export async function fetchPath(
  source: DetectSource, target: DetectClass = 'door', complete = true,
): Promise<PathAnswer> {
  // **스캔이 끝나야 나온다.** 시료도 그 순서를 지킨다 — 여덟을 다 보기 전에 경로가 뜨면
  // 「아직 안 돌았는데 갈 곳이 정해져 있다」가 된다.
  if (!complete) return { path: null, failure: null };
  const url = source.kind === 'sample'
    ? `${SAMPLE_BASE}/${target}/evidence.json`
    : `${source.base}/detect/path?target=${target}`;
  try {
    const answer = await getJson<DetectPath>(url);
    return answer.ok === false ? { path: null, failure: answer } : { path: answer, failure: null };
  } catch {
    return { path: null, failure: null };
  }
}

/**
 * **자세 역산.** 스캔을 돌기 전에 나오는 둘 — 도면상 문의 자리와 로봇 자신의 자리·방위.
 *
 * 시료에서는 클래스 폴더 밖(`unidepth_localization/`)에 있다. 문·받침대 어느 한쪽의
 * 산출물이 아니라 **둘을 합쳐 만든 것**이라 그 자리에 있는 것이고, 그래서 `target` 을
 * 받지 않는다.
 */
export async function fetchLocalization(source: DetectSource): Promise<DetectLocalization | null> {
  const url = source.kind === 'sample'
    ? `${SAMPLE_BASE}/unidepth_localization/localization_evidence.json`
    : `${source.base}/detect/localization`;
  try {
    return await getJson<DetectLocalization>(url);
  } catch {
    return null;
  }
}

/** 무엇을 그 클래스라고 물었나. 근거 가시화가 쓴다. */
export async function fetchFeatures(source: DetectSource, target: DetectClass = 'door'): Promise<DetectFeatures | null> {
  const url = source.kind === 'sample'
    ? `${SAMPLE_BASE}/${target}/features_sent.json`
    : `${source.base}/detect/features?target=${target}`;
  try {
    return await getJson<DetectFeatures>(url);
  } catch {
    return null;
  }
}

/**
 * 그 각도의 그림 주소. **경로 문자열을 화면이 만들지 않는다.**
 *
 * 시료의 `evidence.json` 에는 탐지 기계의 로컬 절대경로가 들어 있다
 * (`/home/jin24/…/original.jpg`). 브라우저는 그걸 못 연다 — 그 값을 화면에 넘기면
 * 깨진 그림이 뜬다. 여기서 **우리가 열 수 있는 주소**로 바꾼다.
 */
export function frameImageUrl(
  source: ImageSource, frame: string, kind: 'original' | 'rpn_overlay' | 'target_overlay' | 'target_crop',
  target: DetectClass = 'door',
): string {
  const dir = frame.replace(/\.jpg$/, '');
  if (source.kind === 'record') return recordFileUrl(source.date, source.run, detectImagePath({ frame, kind }));
  if (source.kind === 'sample') return `${SAMPLE_BASE}/${target}/${dir}/${kind}.jpg`;
  return `${source.base}/detect/frame?target=${target}&frame=${encodeURIComponent(frame)}&kind=${kind}`;
}

/**
 * **아무것도 안 그린 도면.** 경로가 나오기 전에 2D 맵 자리에 서는 그림이다.
 *
 * 전에는 경로가 없는 동안 그 자리가 통째로 비어 있었다 — 도면은 임무 내내 있는 것인데
 * 「경로가 아직 없습니다」만 떠서, 발표 초반에 2D 맵 뷰 노드가 빈 상자로 보였다.
 */
export function mapImageUrl(source: ImageSource): string {
  if (source.kind === 'record') return recordFileUrl(source.date, source.run, detectImagePath('map'));
  if (source.kind === 'sample') return `${SAMPLE_BASE}/unidepth_localization/map_original.jpg`;
  return `${source.base}/detect/map`;
}

/**
 * **도면을 읽을 자리 둘 — 먼저 것이 안 되면 뒤의 것** (260914).
 *
 * 탐지 창구의 `/detect/map` 은 탐지가 자세 역산 단계에서 도면을 다시 써야 생긴다. 새 판이
 * 시작되면 지워지므로 **로봇이 돌기 전에는 404** 인 때가 있다. 그런데 `T-A1` 은 돌기 전에
 * 도면을 봐야 한다.
 *
 * 도면은 판마다 바뀌는 결과가 아니라 **방의 그림**이다 — 탐지는 `datasets/25300.png` 를 그대로
 * 옮겨 적는다. 저장소의 `door_example` 에 같은 그림이 있으므로 그것으로 대신한다. 각도 결과나
 * 경로 같은 **판의 산출물은 대신하지 않는다.**
 */
export function floorPlanUrls(source: ImageSource): readonly string[] {
  const bundled = `${SAMPLE_BASE}/unidepth_localization/map_original.jpg`;
  return source.kind === 'sample' ? [bundled] : [mapImageUrl(source), bundled];
}

/** 그 주소가 저장소 사본인가 — 로그에 어디서 읽었는지 적는다. */
export function isBundledFloorPlan(url: string): boolean {
  return url.startsWith(SAMPLE_BASE);
}

/**
 * **그림 주소에 판 번호를 붙인다** (260914 — `store.ts` 의 `imageRound`). 판마다 주소가 같아
 * 브라우저가 지난 판의 그림을 다시 쓰는 것을 막는다. 서버는 모르는 쿼리를 무시한다.
 */
export function roundedImageUrl(url: string, round: number): string {
  return `${url}${url.includes('?') ? '&' : '?'}round=${round}`;
}

/** 도면 위에 경로를 그린 그림. 스캔이 끝나야 나온다. */
export function pathImageUrl(source: ImageSource, target: DetectClass = 'door'): string {
  if (source.kind === 'record') return recordFileUrl(source.date, source.run, detectImagePath('path_overlay'));
  if (source.kind === 'sample') return `${SAMPLE_BASE}/${target}/path_overlay.jpg`;
  return `${source.base}/detect/path_overlay?target=${target}`;
}

/**
 * 살아 있는가. 발표 직전에 눌러 볼 버튼용이라 가벼워야 한다.
 *
 * 테스트 모드에서는 시료를 실제로 한 번 읽어 본다 — 「켰는데 파일이 없다」를 그때 잡는다.
 */
export async function probeDetect(source: DetectSource): Promise<{ alive: boolean; reason: string }> {
  try {
    if (source.kind === 'sample') {
      const summary = await fetchSummary(source);
      return { alive: true, reason: `테스트 자료 · 각도 ${summary.frames.length}개` };
    }
    if (source.base.trim() === '') return { alive: false, reason: '주소가 비어 있습니다' };
    const response = await fetch(`${source.base}/health`);
    return response.ok
      ? { alive: true, reason: `${response.status}` }
      : { alive: false, reason: `${response.status} ${response.statusText}` };
  } catch (error) {
    return { alive: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
