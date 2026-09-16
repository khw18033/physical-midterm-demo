// STT 서비스가 없어도 화면이 뜨고 수동 텍스트 입력 경로가 살아 있는지 검사한다
// (제약 5 · VZ-C-02 · VZ-G-01).
//
// 화면 전체가 죽거나 무한 로딩에 걸리는 것을 막는 검사다. 세 가지를 본다.
//   1. SttClient 가 전부 실패하는 상태에서 probe() 가 **던지지 않고** alive:false 를 돌려주는가
//      (여기서 예외가 새면 패널 첫 렌더가 통째로 날아간다). 260901 부터 **사유도 함께** 온다 —
//      사유를 버리면 「서비스가 없다」와 「떠 있는데 브라우저가 막았다」가 화면에서 같은
//      한 문장이 되고, 그 둘은 고치는 방법이 전혀 다르다.
//   2. 그 상태의 capabilities() 가 음성만 끄고 manualInput 은 남기는가 — 값을 지운 대조군 포함
//   3. STT 주소를 아는 코드가 src/stt/ 밖에 없는가 — 두 번째 호출을 주입한 대조군 포함
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcRoot = new URL('../src/', import.meta.url);
const srcDir = fileURLToPath(srcRoot);
const failures = [];

// --- 1. 전부 실패하는 SttClient ------------------------------------------------
// 서비스가 꺼져 있을 때 브라우저 fetch 가 하는 것과 같은 실패를 심는다.
globalThis.fetch = async () => {
  throw new TypeError('Failed to fetch');
};

const client = await import(new URL('stt/SttClient.ts', srcRoot).href);
const { SttUnavailableError } = await import(new URL('stt/types.ts', srcRoot).href);

let probed;
try {
  probed = await client.probe();
} catch (error) {
  failures.push(`probe() 가 예외를 던졌다 (${error?.name}) — 패널 첫 렌더가 통째로 죽는다`);
}
if (probed?.alive !== false) failures.push(`probe() 가 ${JSON.stringify(probed)} 를 돌려줬다 — 꺼진 서비스를 살아 있다고 봤다`);
// 사유를 버리지 않는가. 주소가 들어 있어야 「어디에 못 닿았는지」가 화면에서 읽힌다.
if (!probed?.reason) failures.push('probe() 가 실패 사유를 버렸다 — 화면이 「닿지 않습니다」 한 문장밖에 못 적는다');
else if (!probed.reason.includes('8801')) failures.push(`실패 사유에 주소가 없다 — ${probed.reason}`);

try {
  await client.transcribe(new Blob(['x'], { type: 'audio/webm' }));
  failures.push('transcribe() 가 실패를 던지지 않았다');
} catch (error) {
  if (!(error instanceof SttUnavailableError)) failures.push(`transcribe() 가 SttUnavailableError 가 아닌 ${error?.name} 를 던졌다`);
  else if (error.kind !== 'offline') failures.push(`서비스가 꺼진 실패를 kind='${error.kind}' 로 분류했다 (offline 이어야 한다)`);
}

// --- 2. 그 상태의 화면 기능 ----------------------------------------------------
const availabilityPath = new URL('stt/availability.ts', srcRoot);
const { capabilities } = await import(availabilityPath.href);

for (const status of ['probing', 'ready', 'unavailable']) {
  for (const supported of [true, false]) {
    const able = capabilities(status, supported);
    if (able.manualInput !== true) failures.push(`capabilities('${status}', ${supported}) 가 수동 입력을 잠갔다`);
  }
}
const down = capabilities('unavailable', true);
if (down.canRecord || down.canTranscribe) failures.push('서비스가 꺼졌는데 음성 경로가 켜져 있다');
if (!down.note) failures.push('무엇이 왜 꺼졌는지 화면에 알려 줄 문구가 없다 — 조용히 사라진다');
// 사유가 오면 문구에 실려야 한다. 받아 놓고 안 적으면 사유를 버린 것과 같다 (260901).
const withReason = capabilities('unavailable', true, probed?.reason ?? '테스트 사유 8801');
if (!withReason.note?.includes('8801')) failures.push('probe() 사유를 넘겼는데 화면 문구에 실리지 않는다');
if (withReason.manualInput !== true) failures.push('사유를 넘겼더니 수동 입력이 잠겼다 — note 말고는 아무것도 바뀌면 안 된다');
if (withReason.canRecord || withReason.canTranscribe) failures.push('사유를 넘겼더니 음성 경로 판단이 바뀌었다');

// 음성 대조군 — 수동 입력을 상태에 묶은 사본은 반드시 잡혀야 한다.
const scratch = mkdtempSync(join(tmpdir(), 'verify-no-stt-'));
const mutantPath = join(scratch, 'availability.ts');
const mutantSource = readFileSync(availabilityPath, 'utf8')
  .replace('const manualInput = true as const;', 'const manualInput = (status === \'ready\') as unknown as true;');
writeFileSync(mutantPath, mutantSource, 'utf8');
const mutant = await import(pathToFileURL(mutantPath).href);
if (mutant.capabilities('unavailable', true).manualInput === true) {
  failures.push('수동 입력을 상태에 묶은 음성 대조군을 만들지 못했다 — 이 검사는 무의미하다');
}

// --- 3. STT 호출 경계 ----------------------------------------------------------
const files = [];
(function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name)) files.push(path);
  }
})(srcDir);

// **STT 주소를 아는 곳**을 센다. `fetch` 를 세지 않는 이유: 탭②~⑥의 데이터 계층도
// 게이트웨이를 fetch 로 부르는데 그건 STT 와 아무 상관이 없다. 막고 싶은 것은
// "STT 를 부르는 두 번째 길"이지 "fetch 를 쓰는 코드"가 아니다.
// 엔드포인트 경로와 환경변수 이름만 본다. `STT_BASE_URL` **식별자**를 import 해서
// 화면에 표시하는 것은 두 번째 길이 아니다 — 그 값 자체가 하나뿐인 면에서 나온 것이다.
const STT_MARKERS = /VITE_STT_URL|['"`][^'"`]*\/stt\/transcribe/;

function sttCallers(extra = '') {
  return files.flatMap((path) => {
    // src/stt/ 안은 STT 를 보는 면 그 자체다. 그 밖에서 주소를 알면 면이 둘이 된다.
    const inside = path.replaceAll('\\', '/').includes('/src/stt/');
    const source = readFileSync(path, 'utf8') + (inside ? extra : '');
    return STT_MARKERS.test(source) && !inside ? [relative(srcDir, path)] : [];
  });
}

const outside = sttCallers();
if (outside.length) {
  failures.push(`src/stt/ 밖에서 STT 주소를 안다: ${outside.join(', ')} — STT 를 보는 면이 하나가 아니게 된다`);
}
// 음성 대조군 — src/stt/ 밖에 STT 호출을 넣으면 반드시 잡혀야 한다.
const decoy = join(scratch, 'decoy.ts');
writeFileSync(decoy, 'export const x = () => fetch("http://127.0.0.1:8801/stt/transcribe");\n', 'utf8');
files.push(decoy);
if (sttCallers().length === 0) {
  failures.push('SttClient 밖의 fetch 를 주입한 음성 대조군을 검출하지 못했다 — 이 검사는 무의미하다');
}

if (failures.length) {
  console.error(`❌ STT 없이 뜨는지 검사 실패:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('✅ 통과 — 서비스가 전부 실패해도 probe()는 조용히 alive:false + 사유(주소 포함), 수동 입력은 모든 상태에서 살아 있음, 사유는 note 에만 실림, STT 주소를 아는 곳은 src/stt/ 뿐, 대조군 3종 검출');
