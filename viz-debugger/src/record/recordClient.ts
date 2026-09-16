/**
 * src/record/recordClient.ts (260914 신설)
 *
 * **임무 기록 창구를 아는 면 하나.** 주소와 파일 이름이 여기 밖으로 안 나간다 — 탐지 주소를
 * `DetectClient.ts` 에 가두는 것과 같은 규칙이다. 창구 본체는 `scripts/mission-records.mjs`.
 *
 * 창구는 개발·미리보기 서버에만 있다. 단독 빌드를 파일로 열었거나 서버가 없으면 404 이고,
 * 그때 기록기는 조용히 멈추고 이력 목록은 「이 세션에서 본 것만」으로 돌아간다.
 */

const BASE = '/mission-records';

/** 목록 한 줄 — `mission.json` 에서 본문(`view`)을 뺀 것. */
export type RecordedRun = {
  date: string;
  run: string;
  mission: RecordMissionSummary | null;
};

export type RecordMissionSummary = {
  schema: string;
  missionId: string;
  label: string;
  startedAtIso: string;
  updatedAtIso: string;
  endedAtIso: string | null;
  outcome: 'done' | 'failed' | 'stopped' | null;
  done: number;
  of: number;
  failedTaskId: string | null;
  reason: string;
  headSec: number;
  robotDriven: boolean;
  testMode: boolean;
  imageCount: number;
  path: { mode: string | null; turnInstruction: string; forwardM: number } | null;
  pathFailure: string | null;
};

/** 판 폴더 이름. 날짜는 실행한 날(이 기기의 시계), 판은 시작 시각과 임무 id. */
export function runFolderOf(startedAt: Date, missionId: string): { date: string; run: string } {
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${String(startedAt.getFullYear()).slice(2)}${two(startedAt.getMonth() + 1)}${two(startedAt.getDate())}`;
  const safeId = missionId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'mission';
  const run = `${two(startedAt.getHours())}${two(startedAt.getMinutes())}${two(startedAt.getSeconds())}_${safeId}`;
  return { date, run };
}

const runUrl = (date: string, run: string) => `${BASE}/api/runs/${encodeURIComponent(date)}/${encodeURIComponent(run)}`;

/** 저장된 파일의 주소. 다시보기가 그림과 JSON 을 여기서 읽는다. */
export function recordFileUrl(date: string, run: string, path: string): string {
  return `${BASE}/files/${encodeURIComponent(date)}/${encodeURIComponent(run)}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** 탐지 그림의 저장 이름 — 기록기와 다시보기가 같은 함수를 쓴다. */
export function detectImagePath(name: 'path_overlay' | 'map' | { frame: string; kind: string }): string {
  if (typeof name === 'string') return `images/detect/${name}.jpg`;
  const stem = name.frame.replace(/\.(jpg|jpeg|png)$/i, '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return `images/detect/${stem}_${name.kind}.jpg`;
}

/** 로봇 원본의 저장 이름 — 각도 세 자리. */
export function robotImagePath(rotationDeg: number): string {
  const deg = ((Math.round(rotationDeg) % 360) + 360) % 360;
  return `images/robot/rot_${String(deg).padStart(3, '0')}.jpg`;
}

export async function putRecordJson(date: string, run: string, file: 'mission.json' | 'progress.json', body: string): Promise<void> {
  const response = await fetch(`${runUrl(date, run)}/${file}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
  });
  if (!response.ok) throw new Error(`${file} 저장 실패 — ${response.status}`);
}

/** `images/detect/x.jpg` 꼴의 경로로 그림 바이트를 올린다. */
export async function postRecordImage(date: string, run: string, path: string, bytes: Blob | Uint8Array): Promise<void> {
  const [, dir, name] = path.split('/');
  const response = await fetch(`${runUrl(date, run)}/images/${encodeURIComponent(dir)}/${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: bytes as BodyInit,
  });
  if (!response.ok) throw new Error(`그림 저장 실패 — ${response.status}`);
}

/** 판 목록. 창구가 없으면 null — 「못 읽었다」와 「비었다」를 가른다. */
export async function listRecordedRuns(): Promise<{ dir: string; runs: RecordedRun[] } | null> {
  try {
    const response = await fetch(`${BASE}/api/runs`, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json() as { dir?: string; runs?: RecordedRun[] };
    return Array.isArray(body.runs) ? { dir: body.dir ?? '', runs: body.runs } : null;
  } catch {
    return null;
  }
}

export async function fetchRecordJson<T>(date: string, run: string, file: 'mission.json' | 'progress.json'): Promise<T> {
  const response = await fetch(recordFileUrl(date, run, file), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${date}/${run}/${file} 를 못 읽었습니다 — ${response.status}`);
  return await response.json() as T;
}
