/**
 * scripts/dev-all.mjs
 *
 * 목 게이트웨이 · Vite 개발 서버 · STT 서비스 · 생성 서비스를 한 번에 띄운다.
 * 라이브러리를 늘리지 않으려고 concurrently 같은 도구 대신 child_process만 쓴다.
 *
 * **목 게이트웨이는 하나다.** 통합 전에는 10줄짜리 시나리오 재생기(server.mjs)와
 * web-dashboard 의 4,757줄짜리 게이트웨이가 따로 있었지만, 지금은 후자가 본체가 되고
 * 시나리오 재생이 그 안의 `trace_event` 채널로 접혔다. 게이트웨이가 둘이면
 * transport 가 싱글턴이라 탭 중 절반이 빈 화면이 된다.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGenerate, stopGenerate } from './dev-generate.mjs';
import { startStt } from './dev-stt.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const children = [
  // shell 없이 스크립트 파일을 직접 실행한다 — shell:true + args 조합은 인자가
  // 이스케이프되지 않고 이어붙기만 해서 Node가 경고한다(DEP0190).
  spawn(process.execPath, ['gateway/server.ts'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js')], { cwd: root, stdio: 'inherit' }),
];
// STT 서비스는 **없어도 되는 프로세스**다. 죽어도 나머지를 끌어내리지 않는다 (제약 5).
// 그래서 위 children 배열에 넣지 않고 따로 들고 있다가 종료할 때만 같이 정리한다.
const stt = startStt();
// 생성 서비스도 **없어도 되는 프로세스**다 (260914 — 전에는 따로 띄워야 했다).
// 끌 때는 트리째 내린다 — 자식 `llama-server` 가 남으면 다음 실행이 그 유령에게 묻는다.
const generate = startGenerate();

const stop = () => { children.forEach((child) => child.kill()); stt?.kill(); stopGenerate(generate); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stop(); process.exit(0); });

/**
 * 필수 프로세스(게이트웨이·vite) 하나가 죽으면 전부 내린다 — STT 도 함께.
 *
 * **그 사실을 적는다** (260901). 8/31~9/1 에 실제로 났던 일이 이것이다: 이전 세션의
 * 게이트웨이가 8790 을 잡고 있어 새 `npm run dev` 가 즉시 죽었고, 그러면서 **자기 STT 까지
 * 같이 내렸다.** 브라우저는 옛 세션의 vite·게이트웨이에 그대로 붙어 있었으므로 화면도 뜨고
 * 「게이트웨이 연결됨」이었고, **STT 만 없었다.** 증상이 「STT 서비스에 닿지 않습니다」 한
 * 줄로만 보여서 원인이 STT 쪽에 있는 것처럼 읽혔다. 종료 사유를 마지막에 한 번 더 적으면
 * 그 오해가 안 생긴다 — 위쪽 로그는 vite 출력에 묻힌다.
 */
for (const child of children) child.on('exit', (code) => {
  if (code) {
    console.error(`
[dev] 필수 프로세스가 코드 ${code} 로 종료됐다 — 개발 스택 전체를 내린다.`);
    console.error('[dev] **STT·생성 서비스도 함께 내려간다.** 화면에 「STT 서비스에 닿지 않습니다」만 보이더라도');
    console.error('[dev] 원인은 STT 가 아니라 위 로그의 종료 사유다. 포트가 이미 사용 중이라면');
    console.error('[dev] 이전 세션이 살아 있는 것이고, 그때 브라우저는 옛 세션에 붙어 있어 화면은 멀쩡해 보인다.');
    console.error('[dev]   Get-NetTCPConnection -LocalPort 8790,5174,8801,8802,8803 -State Listen |');
    console.error('[dev]     ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
  }
  stop();
  process.exit(code ?? 0);
});
