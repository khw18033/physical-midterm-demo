// input_modality: 'voice' 인데 voice 감사 필드가 없으면 발행이 막히는지 검사한다 (REQ-1305).
//
// **타입만으로는 못 막는다.** 나중에 다른 사람이 음성 경로를 하나 더 붙일 때 `as any`
// 한 번이면 타입 검사는 통과하고 기록만 조용히 빈다. 그래서 여기서는 규칙을 텍스트로
// 훑지 않고 **실제 가드 함수를 불러 본다** (Node 의 타입 스트리핑으로 .ts 를 그대로 import).
//
// 통합 이후 감사 필드는 두 파일이 나눠 맡는다.
//   voiceAudit.ts     — 검사만 한다 (발행 전에 막는 자리)
//   auditFieldMap.ts  — 이름을 붙인다 (감사 필드 이름을 한 파일에 가두는 곳)
// 그래서 이 검사도 둘 다 본다. 이름이 두 벌로 갈라지는 것이 막고 싶은 일이다.
//
// 다섯 가지를 본다.
//   1. 가드가 실제로 거부하는가 — voice 를 뺀 대조군, 키 하나만 뺀 대조군 포함
//   2. 통과한 값이 auditFieldMap 을 거쳐 **세 수치가 각각 살아서** 실리는가
//   3. 명령 출구가 그 두 단계를 실제로 거치는가 — 호출을 지운 대조군 포함
//   4. 가드를 무력화한 사본이 잡히는가
//   5. **그 세 수치가 임무 계약으로 갈 때도 각각 살아 있는가** (260906 · §7.8 결정).
//      기록(감사 필드)과 계약(utterance)은 자리가 다르고, 갈라지면 화면이 보여주는 수치와
//      임무에 실린 수치가 달라진다. `confidence` 에 **가중합을 넣은 사본**이 잡히는지도 본다 —
//      가중합이 들어가는 순간 세 자리를 만든 이유가 사라진다.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sharedDir = new URL('../src/shared/', import.meta.url);
const sttDir = new URL('../src/stt/', import.meta.url);
const guardPath = new URL('voiceAudit.ts', sharedDir);
const fieldMapPath = new URL('auditFieldMap.ts', sharedDir);
const egressPath = new URL('commandEgress.ts', sharedDir);
const centerPath = new URL('commandCenter.ts', sharedDir);

const { buildAudit, CommandAuditError, VOICE_AUDIT_KEYS } = await import(guardPath.href);
const { buildAuditPayload, toAuditEntry } = await import(fieldMapPath.href);

const full = {
  transcript: '503 구역 로봇 상태 보여줘',
  transcript_edited: '503 구역 로봇 상태 보여줘',
  avg_logprob: -0.2,
  no_speech_prob: 0.0001,
  mean_word_prob: 0.91,
  engine: 'faster-whisper',
  model: 'large-v3-turbo',
  audio_ref: 'recordings/20260828T000000-abcdef.webm',
};

const failures = [];
const rejects = (label, run) => {
  try {
    run();
    failures.push(`${label} — 거부되지 않고 통과했다`);
  } catch (error) {
    if (!(error instanceof CommandAuditError)) failures.push(`${label} — CommandAuditError 가 아닌 ${error?.name} 로 실패했다`);
  }
};

// --- 1. 정상 경로는 통과해야 한다. 무엇이든 다 막는 가드는 가드가 아니다. -----------
let checked;
try {
  checked = buildAudit('voice', full);
  if (checked.inputMode !== 'voice') failures.push(`정상 음성 요청의 inputMode 가 '${checked.inputMode}' 다`);
  if (!checked.voice) failures.push('정상 음성 요청에서 voice 가 사라졌다');
} catch (error) {
  failures.push(`정상 음성 요청이 거부됐다: ${error?.message}`);
}
try {
  const pointer = buildAudit('pointer');
  if (pointer.inputMode !== 'click') failures.push(`화면 조작의 inputMode 가 '${pointer.inputMode}' 다`);
  if (pointer.voice) failures.push('화면 조작인데 voice 가 실렸다');
} catch (error) {
  failures.push(`화면 조작 요청이 거부됐다: ${error?.message}`);
}

// --- 2. 이름 붙이기 — 세 수치가 각각 살아 있는가 -----------------------------------
if (checked) {
  const payload = buildAuditPayload({ inputMode: checked.inputMode, decisionSource: 'human', voice: checked.voice });
  if (payload.input_mode !== 'voice') failures.push('감사 필드에 input_mode 가 실리지 않았다');
  if (payload.decision_source !== 'human') failures.push('감사 필드에 decision_source 가 실리지 않았다');
  if (!payload.voice) failures.push('감사 필드에 voice 가 실리지 않았다 (REQ-1305)');
  else {
    for (const key of VOICE_AUDIT_KEYS) {
      if (!(key in payload.voice)) failures.push(`감사 필드 voice 에 ${key} 가 실리지 않았다`);
    }
    // 세 수치가 하나로 뭉개지지 않았는지. 뭉치면 VZ-L-03 임계를 실측할 근거가 사라진다.
    const numbers = [payload.voice.avg_logprob, payload.voice.no_speech_prob, payload.voice.mean_word_prob];
    if (new Set(numbers).size !== 3) failures.push('세 수치가 같은 값으로 뭉쳐졌다');
    if (payload.voice.transcript === undefined || payload.voice.transcript_edited === undefined) {
      failures.push('원문과 수정본 중 한쪽만 실렸다');
    }
  }
  // 화면 표시 경로도 이 이름을 실제로 읽는가 (auditFieldMap 안에서 이름이 갈라지는 것 방지).
  const entry = toAuditEntry({ ...payload, command_id: 'cmd-1' });
  const labels = entry.rows.map((row) => row.label);
  for (const label of ['입력 수단', '전사(원문)', 'STT 엔진', '녹음']) {
    if (!labels.includes(label)) failures.push(`감사 표시행에 '${label}' 이 없다 — 이름이 갈라졌다`);
  }
}

// --- 3. 음성 대조군 — 빠뜨린 요청은 반드시 잡혀야 한다 ------------------------------
rejects("voice 필드 없이 input_modality='voice'", () => buildAudit('voice'));
rejects('voice 필드가 빈 객체', () => buildAudit('voice', {}));
for (const key of VOICE_AUDIT_KEYS) {
  const partial = { ...full };
  delete partial[key];
  rejects(`voice.${key} 를 뺀 요청`, () => buildAudit('voice', partial));
}
rejects('audio_ref 가 빈 문자열인 요청', () => buildAudit('voice', { ...full, audio_ref: '   ' }));
rejects("input_modality='pointer' 인데 voice 가 실린 요청", () => buildAudit('pointer', full));

// 세 수치는 null 일 수 있다(무음이라 세그먼트가 0건인 경우). 키만 있으면 통과해야 한다.
try {
  buildAudit('voice', { ...full, avg_logprob: null, no_speech_prob: null, mean_word_prob: null });
} catch (error) {
  failures.push(`수치가 null 인 정상 요청이 거부됐다: ${error?.message}`);
}

// --- 4. 출구가 두 단계를 실제로 거치는가 -------------------------------------------
const egressSource = readFileSync(egressPath, 'utf8');
const centerSource = readFileSync(centerPath, 'utf8');
if (!/buildAudit\s*\(/.test(egressSource)) {
  failures.push('commandEgress.ts 가 buildAudit() 을 부르지 않는다 — 가드가 우회됐다');
}
if (!/commandTracker\.issue\s*\(/.test(egressSource)) {
  failures.push('commandEgress.ts 가 commandTracker.issue() 를 부르지 않는다 — 출구가 갈라졌다');
}
if (!/buildAuditPayload\s*\(/.test(centerSource)) {
  failures.push('commandCenter.ts 가 buildAuditPayload() 를 부르지 않는다 — 이름이 두 벌이 됐다');
}
if (!/voice:\s*options\.voice/.test(centerSource)) {
  failures.push('commandCenter.ts 가 voice 를 감사 필드로 넘기지 않는다');
}
// 그 검사의 대조군 — 호출을 지운 사본은 반드시 잡혀야 한다.
if (/buildAudit\s*\(/.test(egressSource.replace(/buildAudit\s*\(/g, 'noGuard('))) {
  failures.push('대조군을 만들지 못했다 (buildAudit 호출 제거 실패)');
}

// --- 5. 가드 자체를 무력화한 대조군 -------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'verify-voice-audit-'));
const mutantPath = join(scratch, 'voiceAudit.ts');
const mutant = readFileSync(guardPath, 'utf8').replace(
  /const missing = VOICE_AUDIT_KEYS\.filter\(\(key\) => !\(key in voice\)\);/,
  'const missing = [];',
);
writeFileSync(mutantPath, mutant, 'utf8');
// 옆 모듈(auditFieldMap.ts)을 타입으로만 참조하므로 사본만 옮겨도 import 가 성립한다.
writeFileSync(join(scratch, 'auditFieldMap.ts'), readFileSync(fieldMapPath, 'utf8'), 'utf8');
const mutantModule = await import(pathToFileURL(mutantPath).href);
let mutantCaught = false;
try {
  const partial = { ...full };
  delete partial.avg_logprob;
  mutantModule.buildAudit('voice', partial);
} catch {
  mutantCaught = true;
}
if (mutantCaught) {
  failures.push('가드를 지운 대조군이 여전히 거부됐다 — 이 검사가 무엇을 보고 있는지 불분명하다');
}

// --- 5. 같은 세 수치가 임무 계약으로도 각각 실리는가 (260906 · §7.8) ---------------
//
// 감사 필드(위 2번)와 임무 계약은 **자리가 다르다.** 한쪽만 살아 있으면 화면이 보여주는
// 수치와 임무에 실린 수치가 갈라진다. 옮기는 규칙이 한 곳(stt/confidence.ts)인지 여기서 본다.
{
  const { toUtterance } = await import(new URL('confidence.ts', sttDir).href);

  /** 2026-08-28 실측의 무음 반복 환각. **세 수치를 전부 통과한 그 값이다.** */
  const hallucination = {
    audio_ref: 'recordings/20260828T000000-silence.webm',
    text: '감사합니다. 감사합니다. 감사합니다.',
    engine: 'faster-whisper',
    avg_logprob: -0.088,
    no_speech_prob: 0.02,
    mean_word_prob: 0.933,
    word_count: 12,
  };
  const mapped = toUtterance(hallucination);
  if (mapped.utterance === null) {
    failures.push(`정상 결과가 계약으로 안 옮겨졌다 — ${mapped.blocked}`);
  } else {
    const { confidence, confidence_signals: signals } = mapped.utterance;
    if (signals.primary !== hallucination.avg_logprob) failures.push('confidence_signals.primary 가 엔진 값과 다르다');
    if (signals.no_speech !== hallucination.no_speech_prob) failures.push('confidence_signals.no_speech 가 엔진 값과 다르다');
    if (signals.unit_mean !== hallucination.mean_word_prob) failures.push('confidence_signals.unit_mean 이 엔진 값과 다르다');
    if (new Set([signals.primary, signals.no_speech, signals.unit_mean]).size !== 3) {
      failures.push('세 수치가 계약에서 같은 값으로 뭉개졌다');
    }
    // **가중합이 아니라 unit_mean 그대로여야 한다.** 이것이 이 검사의 알맹이다.
    if (confidence !== signals.unit_mean) {
      failures.push(`utterance.confidence 가 unit_mean 과 다르다 (${confidence} ≠ ${signals.unit_mean}) — 가중합이 들어갔나`);
    }
    // 계약이 요구하는 문장이 사람이 고친 쪽인가.
    if (toUtterance(hallucination, '수정한 문장').utterance?.text !== '수정한 문장') {
      failures.push('사람이 고친 문장이 계약에 오르지 않는다');
    }
  }

  // 못 재는 경우를 0 으로 메우지 않는가 — 0 은 「쟀는데 0점」이고 이 경우는 「못 쟀다」다.
  const noUnit = toUtterance({ ...hallucination, mean_word_prob: null, word_count: 0 });
  if (noUnit.utterance !== null) {
    failures.push(`단위 확신도가 없는데 confidence 를 ${noUnit.utterance.confidence} 로 채웠다 — 0 이나 임의값으로 메우면 안 된다`);
  } else if (!noUnit.blocked) {
    failures.push('못 옮긴 사유를 버렸다 — 화면이 이유를 못 적는다');
  }

  // 대조군 — **가중합을 넣은 사본은 반드시 잡혀야 한다.**
  {
    const scratch = mkdtempSync(join(tmpdir(), 'verify-utterance-'));
    const mutantPath = join(scratch, 'confidence.ts');
    writeFileSync(join(scratch, 'types.ts'), readFileSync(new URL('types.ts', sttDir), 'utf8'), 'utf8');
    writeFileSync(
      mutantPath,
      readFileSync(new URL('confidence.ts', sttDir), 'utf8').replace(
        '      confidence: unitMean,',
        '      confidence: 0.5 * unitMean + 0.5 * (1 - (confidence_signals.no_speech ?? 0)),',
      ),
      'utf8',
    );
    const mutant = await import(pathToFileURL(mutantPath).href);
    const weighted = mutant.toUtterance(hallucination).utterance;
    if (weighted === null || weighted.confidence === weighted.confidence_signals.unit_mean) {
      failures.push('가중합을 넣은 대조군을 만들지 못했다 — 이 검사는 무의미하다');
    }
  }
}

if (failures.length) {
  console.error(`❌ 음성 감사 필드 검사 실패:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`✅ 통과 — voice 감사 필드 ${VOICE_AUDIT_KEYS.length}개 중 하나라도 빠지면 발행 거부, 세 수치가 각각 실림, 출구가 가드→이름붙이기 두 단계를 거침, 가드 제거 대조군 검출`);
console.log('✅ 같은 세 수치가 임무 계약의 confidence_signals 세 자리로도 각각 실린다 · confidence 는 unit_mean 그대로 (가중합 대조군 검출) · 못 재면 0 으로 메우지 않고 사유를 낸다');
