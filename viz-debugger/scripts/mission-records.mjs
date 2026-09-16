/**
 * scripts/mission-records.mjs (260914 신설 — 「새로고침하면 임무 이력이 다 날아간다」)
 *
 * **임무 기록을 파일로 남기는 창구.** DB 가 붙기 전까지의 자리다. 개발 서버(`npm run dev`)와
 * 미리보기 서버에 미들웨어로 붙는다(`vite.config.ts`) — 프로세스를 하나 더 띄우지 않는다.
 *
 * ## 폴더
 *
 * ```
 * mission-history/                  저장소 루트 (MISSION_RECORDS_DIR 로 바꿀 수 있다)
 *   260914/                         임무를 실행한 날짜
 *     153012_MSN-260909-01/         시작 시각 + 임무 id — 한 판
 *       mission.json                어떤 임무였나 · 결과
 *       progress.json               어떻게 진행됐나 — 기록 열 · 로봇 명령과 응답 · 탐지 결과 · 로그
 *       images/detect/*.jpg         탐지가 내준 그림 (각도 원본 · 상자 · 잘라낸 것 · 경로 · 도면)
 *       images/robot/*.jpg          로봇이 찍어 보낸 원본
 * ```
 *
 * ## 창구
 *
 *   PUT  /mission-records/api/runs/<날짜>/<판>/<mission|progress>.json   JSON 본문을 통째로 쓴다
 *   POST /mission-records/api/runs/<날짜>/<판>/images/<detect|robot>/<이름>  그림 바이트를 쓴다
 *   GET  /mission-records/api/runs                                       판 목록 (mission.json 요약)
 *   GET  /mission-records/files/<날짜>/<판>/<경로>                        저장된 파일 — 다시보기가 읽는다
 *
 * **이름은 전부 형식을 먼저 본다** — `..` 로 폴더 밖을 쓰거나 읽지 못하게.
 * 쓰기는 임시 파일에 쓴 뒤 바꿔 끼운다. 쓰는 도중에 목록을 읽어도 반쯤 쓴 JSON 이 안 보인다.
 */

import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECORDS_URL = '/mission-records';
const DEFAULT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mission-history');

const DATE = /^\d{6}$/;
const RUN = /^\d{6}_[A-Za-z0-9_.-]{1,80}$/;
const JSON_FILE = /^(mission|progress)\.json$/;
const IMAGE_DIR = /^(detect|robot)$/;
const IMAGE_NAME = /^[A-Za-z0-9_.-]{1,120}\.(jpg|jpeg|png)$/;
/** 한 번에 받는 본문 상한. 기록 JSON 은 수백 KB, 그림 한 장은 수십 KB 다. */
const MAX_BODY = 32 * 1024 * 1024;

const TYPES = { '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

export function recordsDir() {
  return process.env.MISSION_RECORDS_DIR ? resolve(process.env.MISSION_RECORDS_DIR) : DEFAULT_DIR;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('본문이 너무 큽니다')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 임시 파일에 쓰고 바꿔 끼운다 — 읽는 쪽이 반쯤 쓴 파일을 안 본다. */
function writeAtomic(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, bytes);
  renameSync(temp, path);
}

/** 판 목록 — 최근 것이 먼저. 본문(`view`)은 빼고 요약만 준다. */
export function listRuns(root = recordsDir()) {
  if (!existsSync(root)) return [];
  const runs = [];
  for (const date of readdirSync(root)) {
    if (!DATE.test(date) || !statSync(join(root, date)).isDirectory()) continue;
    for (const run of readdirSync(join(root, date))) {
      if (!RUN.test(run)) continue;
      const file = join(root, date, run, 'mission.json');
      if (!existsSync(file)) continue;
      try {
        const { view: _view, ...mission } = JSON.parse(readFileSync(file, 'utf8'));
        runs.push({ date, run, mission });
      } catch {
        // 쓰는 도중이거나 깨진 파일 — 목록에서 빼되 나머지는 보여 준다.
        runs.push({ date, run, mission: null });
      }
    }
  }
  return runs.sort((a, b) => `${b.date}/${b.run}`.localeCompare(`${a.date}/${a.run}`));
}

/** 미들웨어 본체. 내 주소가 아니면 `next()`. */
export function missionRecordsMiddleware(root = recordsDir()) {
  return async (req, res, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith(`${RECORDS_URL}/`)) return next();
    const parts = url.slice(RECORDS_URL.length + 1).split('/').map((part) => decodeURIComponent(part));
    try {
      if (parts[0] === 'api' && parts[1] === 'runs') {
        if (parts.length === 2 && req.method === 'GET') return send(res, 200, { dir: root, runs: listRuns(root) });
        const [, , date, run, ...rest] = parts;
        if (!DATE.test(date ?? '') || !RUN.test(run ?? '')) return send(res, 400, { error: '날짜·판 이름 형식이 아닙니다' });
        const runDir = join(root, date, run);
        if (rest.length === 1 && JSON_FILE.test(rest[0]) && req.method === 'PUT') {
          const body = await readBody(req);
          JSON.parse(body.toString('utf8'));        // 깨진 JSON 은 안 쓴다
          writeAtomic(join(runDir, rest[0]), body);
          return send(res, 200, { ok: true, path: `${date}/${run}/${rest[0]}` });
        }
        if (rest.length === 3 && rest[0] === 'images' && IMAGE_DIR.test(rest[1]) && IMAGE_NAME.test(rest[2]) && req.method === 'POST') {
          const body = await readBody(req);
          if (body.length === 0) return send(res, 400, { error: '빈 그림입니다' });
          writeAtomic(join(runDir, 'images', rest[1], rest[2]), body);
          return send(res, 200, { ok: true, path: `${date}/${run}/images/${rest[1]}/${rest[2]}`, bytes: body.length });
        }
        return send(res, 404, { error: '없는 창구입니다' });
      }
      if (parts[0] === 'files' && req.method === 'GET') {
        const target = normalize(join(root, ...parts.slice(1)));
        if (!target.startsWith(normalize(root) + sep) || !existsSync(target) || !statSync(target).isFile()) {
          return send(res, 404, { error: '기록에 없는 파일입니다' });
        }
        const ext = target.slice(target.lastIndexOf('.')).toLowerCase();
        res.statusCode = 200;
        res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(target).pipe(res);
        return undefined;
      }
      return send(res, 404, { error: '없는 창구입니다' });
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** Vite 플러그인 — 개발 서버와 미리보기 서버에 같은 미들웨어를 붙인다. */
export function missionRecords() {
  return {
    name: 'mission-records',
    configureServer(server) { server.middlewares.use(missionRecordsMiddleware()); },
    configurePreviewServer(server) { server.middlewares.use(missionRecordsMiddleware()); },
  };
}
