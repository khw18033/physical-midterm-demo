// 이식: web-dashboard/vite.config.ts @ 605eb73 — 포트만 변경
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, join, normalize } from 'node:path';
import { createReadStream, cpSync, existsSync, statSync } from 'node:fs';
// 임무 기록을 파일로 남기는 창구 (260914) — 새로고침해도 리허설 기록이 남는다.
import { missionRecords } from './scripts/mission-records.mjs';

/**
 * **탐지 시료를 `/detect-sample` 로 내준다** (260912).
 *
 * `door_example/` 은 탐지 담당이 준 실제 산출물이고 저장소 루트에 있다. 연결 관리의
 * 「테스트」를 켜면 화면이 이것을 진짜 탐지 결과처럼 읽는다 — 그러려면 브라우저가 열 수
 * 있어야 한다.
 *
 * **사본을 만들지 않는다.** `public/` 으로 복사하면 같은 1.7MB 가 저장소에 두 벌이 되고,
 * 탐지 담당이 자료를 갱신했을 때 어느 쪽이 진짜인지 갈린다 — 계약 파일을 사본 없이
 * 직접 읽는 것과 같은 규칙이다(위 `fs.allow`).
 *
 * 개발·미리보기에서는 여기서 읽어 내주고, 빌드에서는 `dist/` 로 한 번 복사한다.
 */
const SAMPLE_URL = '/detect-sample/';
const SAMPLE_DIR = resolve(__dirname, '..', 'door_example', 'test');

function detectSample() {
  const serve = (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(b?: unknown): void }, next: () => void) => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith(SAMPLE_URL)) return next();
    // `..` 로 저장소 밖을 읽지 못하게 한다 — 시료 폴더 안쪽만 연다.
    const target = normalize(join(SAMPLE_DIR, decodeURIComponent(url.slice(SAMPLE_URL.length))));
    if (!target.startsWith(SAMPLE_DIR) || !existsSync(target) || !statSync(target).isFile()) {
      res.statusCode = 404; res.end('탐지 시료에 없는 파일'); return;
    }
    res.setHeader('Content-Type', target.endsWith('.json') ? 'application/json' : 'image/jpeg');
    createReadStream(target).pipe(res as never);
  };
  return {
    name: 'detect-sample',
    configureServer(server: { middlewares: { use(fn: unknown): void } }) { server.middlewares.use(serve); },
    configurePreviewServer(server: { middlewares: { use(fn: unknown): void } }) { server.middlewares.use(serve); },
    closeBundle() {
      if (!existsSync(SAMPLE_DIR)) return;
      cpSync(SAMPLE_DIR, resolve(__dirname, 'dist', 'detect-sample'), {
        recursive: true,
        // 파이썬 캐시는 산출물이 아니다 — 전달본에 넣지 않는다.
        filter: (from) => !from.includes('__pycache__'),
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), detectSample(), missionRecords()],
  server: {
    port: 5174,
    strictPort: true,
    // 계약(`contracts/*.schema.json`)이 저장소 루트에 있고 `src/generate/` 가 그것을
    // 직접 import 한다 — **계약이 원본**이므로 사본을 두지 않는다(260904 §3).
    // 개발 서버는 기본적으로 프로젝트 루트 밖 파일을 못 내주므로 그 한 칸만 연다.
    fs: { allow: ['..'] },
  },
  build: { rollupOptions: { input: { app: resolve(__dirname, 'index.html') } } },
});
