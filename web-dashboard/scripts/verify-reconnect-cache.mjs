/**
 * scripts/verify-reconnect-cache.mjs
 *
 * **재접속 시 금지 채널이 재생되지 않는지 확인한다** (BE-T-06 회신 자체 검증).
 *
 * 왜 시나리오가 아니라 스크립트인가 — 이 검증은 **두 번 접속해야** 성립한다.
 * 첫 접속에서 값을 흐르게 만들고(특히 영상 패널을 열어 video_frame·detections를 유발),
 * 끊고 다시 붙었을 때 구독 즉시 스냅샷에 그 채널이 섞여 오는지를 봐야 한다.
 * 서버 안에서 도는 시나리오는 클라이언트 재접속을 재현할 수 없다.
 *
 * 지금까지 이 버그를 못 본 이유가 정확히 여기에 있다 — 재접속 검증을 현황판(state)에서만
 * 했고, 영상 탭을 연 채로 재접속해 본 적이 없었다.
 *
 * 실행: node scripts/verify-reconnect-cache.mjs   (목 게이트웨이가 떠 있어야 한다)
 */

import { WebSocket } from 'ws';

const HTTP = process.env.MOCK_HTTP ?? 'http://127.0.0.1:8787';
const WS = process.env.MOCK_WS ?? 'ws://127.0.0.1:8787';

/** 회신한 캐시 허용 채널 7개. 서버의 정책 선언과도 대조한다. */
const ALLOWED = [
  'state',
  'telemetry',
  'actuator_state',
  'control_lock',
  'plan',
  'plan_progress',
  'video_meta',
];

/** 재접속 스냅샷에 절대 섞여서는 안 되는 채널. */
const FORBIDDEN = ['command_result', 'video_frame', 'detections'];

const CAMERA = 'camera-02';

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** 한 접속에서 구독하고 **구독 즉시 스냅샷만** 모은다. 경계는 아래 주석 참고. */
async function collectSnapshot(ws, { openVideo }) {
  const snapshot = [];

  // **스냅샷과 실시간 푸시를 무엇으로 가르는가.**
  //
  // 시간으로 가르면 안 된다 — 50ms 주기 로봇과 15fps 영상이 섞이면 어느 것이 캐시에서
  // 온 것인지 알 수 없다. 서버는 `subscribe` 처리에서 캐시 스냅샷을 **먼저 모두 보내고**
  // 그 다음에 `subscribed` 확인을 보낸다. 그래서 경계는 시간이 아니라 **메시지 순서**다:
  // subscribed 이전의 data = 구독 즉시 스냅샷, 이후 = 실시간 발행.
  let declared = null;

  const done = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'data' && declared === null) {
        snapshot.push(msg.envelope);
        return;
      }
      if (msg.type === 'subscribed') {
        declared = msg.snapshot_count;
        resolve();
      }
    });
    setTimeout(resolve, 2000);
  });

  if (openVideo) ws.send(JSON.stringify({ type: 'video', entity: CAMERA, open: true }));
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      id: 'verify-all',
      selector: { entity: '*', node: '*', channel: '*' },
      scope: 'all',
    }),
  );

  await done;
  return { snapshot, declared };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const failures = [];
  const note = (line) => process.stdout.write(line + '\n');

  note('■ 1차 접속 — 값을 흐르게 만든다 (영상 패널 열기 포함)');
  const first = await connect();
  const firstRun = await collectSnapshot(first, { openVideo: true });
  note('  구독 즉시 스냅샷 ' + firstRun.snapshot.length + '건 (서버 선언 ' + firstRun.declared + '건)');

  // 영상·탐지·명령 결과가 실제로 흐르도록 잠시 둔다. 흐르지 않으면 캐시될 것도 없다.
  note('  3초간 발행 유지 — video_frame · detections 를 흘린다');
  await sleep(3000);

  const seenChannels = new Set();
  first.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.type === 'data') seenChannels.add(msg.envelope.channel);
  });
  await sleep(1200);
  note('  1차 접속에서 실제로 흐른 채널: ' + [...seenChannels].sort().join(', '));
  for (const ch of FORBIDDEN) {
    if (ch === 'command_result') continue; // 명령을 보내지 않으면 흐르지 않는다
    if (!seenChannels.has(ch)) {
      failures.push('사전 조건 실패 — ' + ch + ' 가 1차 접속에서 흐르지 않았다. 캐시 검증이 무의미하다');
    }
  }

  note('■ 서버 캐시 실물 조회 (/health)');
  const health = await fetch(HTTP + '/health').then((r) => r.json());
  const cachedChannels = [...new Set(health.cache.cached_keys.map((k) => k.split('|')[1]))].sort();
  note('  캐시 키 ' + health.cache.cached_keys.length + '건 · 채널 ' + cachedChannels.join(', '));
  note('  서버 위반 보고: ' + (health.cache.violations.length === 0 ? '0건' : health.cache.violations.join(', ')));
  if (health.cache.violations.length > 0) {
    failures.push('서버가 자기 정책을 위반한 키를 캐시하고 있다: ' + health.cache.violations.join(', '));
  }
  for (const ch of cachedChannels) {
    if (!ALLOWED.includes(ch)) failures.push('허용 목록 밖 채널이 캐시됐다: ' + ch);
  }
  const declaredAllowed = [...health.cache.cacheable_channels].sort();
  if (declaredAllowed.join(',') !== [...ALLOWED].sort().join(',')) {
    failures.push(
      '서버 정책 선언이 회신 내용과 다르다 — 선언 ' + declaredAllowed.join(', ') + ' / 회신 ' + ALLOWED.join(', '),
    );
  }

  note('■ 2차 접속 — 재접속 스냅샷에 금지 채널이 섞이는지 본다');
  first.close();
  await sleep(300);
  const second = await connect();
  const secondRun = await collectSnapshot(second, { openVideo: false });
  const snapChannels = [...new Set(secondRun.snapshot.map((e) => e.channel))].sort();
  note(
    '  재접속 스냅샷 ' + secondRun.snapshot.length + '건 (서버 선언 ' + secondRun.declared + '건) · 채널 ' +
    snapChannels.join(', '),
  );
  if (secondRun.declared !== secondRun.snapshot.length) {
    failures.push(
      '서버가 선언한 스냅샷 수(' + secondRun.declared + ')와 실제 도착 수(' + secondRun.snapshot.length + ')가 다르다',
    );
  }

  for (const ch of FORBIDDEN) {
    if (snapChannels.includes(ch)) {
      failures.push('재접속 스냅샷에 금지 채널 ' + ch + ' 가 재생됐다');
    }
  }
  for (const ch of snapChannels) {
    if (!ALLOWED.includes(ch)) failures.push('재접속 스냅샷에 허용 밖 채널 ' + ch + ' 가 왔다');
  }

  note('■ 캐시된 값의 ts 보존 확인 (BE-T-06 — 푸시 시점으로 다시 찍지 않는다)');
  const nowMs = Date.now();
  let tsChecked = 0;
  for (const env of secondRun.snapshot) {
    const ageMs = nowMs - Date.parse(env.ts);
    tsChecked += 1;
    // 재접속 직후인데 ts가 방금이면 푸시 시점으로 다시 찍은 것이다.
    // 원래 발행 시각이 남아 있으면 과거여야 한다. 서버·이 스크립트가 같은 기계라도
    // 프로세스 간 ms 단위 오차는 나므로 그만큼은 허용한다.
    if (ageMs < -50) failures.push(env.channel + ' 의 ts가 미래다 (' + ageMs + 'ms)');
  }
  const ages = secondRun.snapshot.map((e) => nowMs - Date.parse(e.ts));
  note('  검사 ' + tsChecked + '건 · ts 나이 최소 ' + Math.min(...ages) + 'ms / 최대 ' + Math.max(...ages) + 'ms');
  if (Math.max(...ages) < 500) {
    failures.push('모든 ts가 0.5초 이내다 — 캐시 푸시 시점으로 다시 찍혔을 가능성이 높다');
  }

  second.close();

  note('');
  if (failures.length === 0) {
    note('✅ 통과 — 금지 채널 재생 0건, 허용 밖 채널 0건, ts 보존 확인');
    process.exit(0);
  }
  note('❌ 실패 ' + failures.length + '건');
  for (const f of failures) note('   - ' + f);
  process.exit(1);
}

main().catch((e) => {
  process.stdout.write('실행 실패 — ' + e.message + '\n');
  process.stdout.write('목 게이트웨이가 떠 있는지 확인할 것: npm run dev:mock\n');
  process.exit(2);
});
