/**
 * scripts/extract-equipment.mjs — 마일스톤 분리 7단계 (6단계 §5 「다음에 할 것」 1번)
 *
 * **장소에 들은 처방을 장비에 그대로 준다.**
 *
 * 260906 실측에서 장소 어휘 위반은 세 모델 모두 0건이고 장비 어휘 위반은 22~48% 였다.
 * 같은 모델·같은 프롬프트·같은 디코딩·같은 응답 안에서 갈린 것이 하나뿐이다 —
 * **장소는 목록을 줬고 장비는 안 줬다.** 그래서 장비에도 목록을 준다.
 *
 *   places/places.json      ← extract-places.mjs   (Unity 씬)
 *   equipment/equipment.json ← 이 스크립트          (레지스트리 + 정답셋)
 *
 * ## 원천이 둘인 이유 — 정답셋만 쓰면 축이 자기 자신을 채점한다
 *
 * 채점기(`score-generation.mjs` 축 2d)의 어휘는 **정답셋 4편의 `assigned_targets`
 * 합집합 8건**이다. 그것만 프롬프트에 실으면 「목록에서 고를 줄 아는가」가 아니라
 * 「준 8개를 옮겨 적는가」를 재게 된다 — **오답 선택지가 없는 시험**이다.
 *
 * 그래서 목 게이트웨이 레지스트리의 장비를 합집합으로 넣는다. 레지스트리에만 있는
 * 장비(`robot-02`·`sensor-04` …)가 곧 오답 선택지다. 프롬프트 목록이 채점 어휘보다
 * **넓어야** 이 축이 살아 있고, 같아지는 순간 죽는다 — `verify:no-leak` 이 검사한다.
 *
 * ## 레지스트리를 복사하지 않는다
 *
 * `gateway/hub.ts` 와 `stt/vocab.py` 가 같은 파일을 읽는다. 복사본을 두면 화면의 장치
 * 목록·음성 인식 어휘·생성 어휘가 조용히 갈라진다. 경로는 `VIZ_REGISTRY_DIR` 로 바꾼다.
 *
 * ## 이름을 지어내지 않는다
 *
 * 지금 정답셋 3편의 장비는 전부 레지스트리에 있어서 이 자리가 비어 있다. 그런데 `e2c3f0f`
 * 가 들어낸 415 편이 4층을 재고 돌아오면 `go1-02`·`arm-03`·`cam-4f`·`cam-5f` 가 함께
 * 돌아오고, 그 넷은 레지스트리에 없다. 옛 대본의 `hardware[]` 에 이름이 있지만 그 값은
 * **기종**이다(「Unitree Go1」) — 프롬프트 규칙 4가 금지하는 바로 그것이라 실으면 모델에게
 * 금지어를 쥐여 주는 꼴이다.
 *
 * 그래서 그때도 **식별자만 싣고 label·kind 는 null 로 둔다.** 없는 것은 없는 대로 둔다 —
 * `places.json` 의 자리표시와 같은 원칙이고, 그 자리는 지금 비어 있어도 열어 둔다.
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContracts, validate } from './lib/json-schema.mjs';

const vizRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(vizRoot, '..');
const registryDir = process.env.VIZ_REGISTRY_DIR ?? join(repoRoot, 'web-dashboard', 'mock-gateway');
const registryRel = 'web-dashboard/mock-gateway/registry.json';
const goldDir = join(repoRoot, 'gen-lab', 'goldset', 'missions');
const outDir = join(repoRoot, 'equipment');

// ── 원천 1: 목 게이트웨이 레지스트리 ─────────────────────────────────────────
//
// `entities[]` 를 통째로 옮긴다. **손으로 고르지 않는다** — 「이건 임무 대상이 아닌 것
// 같다」로 빼기 시작하면 추출이 사람의 판단에 기대게 되고, 그때부터 목록이 흔들린다.
// (`extract-places.mjs` 가 문을 좌표로 가르고 이름으로 안 가른 것과 같은 이유다.)
const registry = JSON.parse(readFileSync(join(registryDir, 'registry.json'), 'utf8'));
const fromRegistry = new Map();
for (const entity of registry.entities ?? []) {
  fromRegistry.set(entity.id, {
    equipment_id: entity.id,
    label: entity.display_name ?? null,
    aliases: [...new Set((entity.aliases ?? []).filter(Boolean))].sort(),
    kind: entity.entity_type ?? null,
    zone_id: entity.zone ?? null,
  });
}

// ── 원천 2: 정답셋의 assigned_targets ────────────────────────────────────────
//
// 채점 어휘와 **같은 것을 같은 방법으로** 센다(`score-generation.mjs` 의
// `targetVocabulary`). 이 8건이 목록에 다 있어야 정답을 낼 길이 열린다 — 빠지면
// 「정답의 장비를 쓰지 말라」고 말한 셈이 되고, 그것도 `verify:no-leak` 이 잡는다.
const goldTargets = new Set();
for (const name of readdirSync(goldDir).filter((file) => file.endsWith('.json'))) {
  const mission = JSON.parse(readFileSync(join(goldDir, name), 'utf8'));
  for (const milestone of mission.milestones ?? []) {
    for (const target of milestone.assigned_targets ?? []) goldTargets.add(target);
  }
}

// ── 합집합 ───────────────────────────────────────────────────────────────────
const equipment = [];
for (const id of [...new Set([...fromRegistry.keys(), ...goldTargets])].sort()) {
  equipment.push(fromRegistry.get(id) ?? {
    // 레지스트리에 없다 — 이름도 종류도 모른다. **지어내지 않는다.**
    equipment_id: id, label: null, aliases: [], kind: null, zone_id: null,
  });
}

// ── 계약 ─────────────────────────────────────────────────────────────────────
//
// 쓰기 전에 검사한다. 계약을 어긴 파일을 남기면 그것을 읽는 쪽이 먼저 깨지고,
// 그때는 원인이 추출기인지 읽는 쪽인지 가릴 수 없다.
const contracts = loadContracts(join(repoRoot, 'contracts'));
const schema = contracts.get('equipment.schema.json');
const contractErrors = equipment.flatMap((entry) => validate(entry, schema, contracts, `$[${entry.equipment_id}]`).errors ?? []);
if (contractErrors.length) {
  console.error(`❌ equipment.schema.json 위반 ${contractErrors.length}건\n- ${contractErrors.join('\n- ')}`);
  process.exit(1);
}

const registryOnly = equipment.filter((entry) => !goldTargets.has(entry.equipment_id));
const goldOnly = equipment.filter((entry) => entry.label === null);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'equipment.json'), JSON.stringify({
  schema: 'contracts/equipment.schema.json',
  extracted_from: {
    registry: registryRel,
    goldset: 'gen-lab/goldset/missions/*.json 의 assigned_targets',
    script: 'scripts/extract-equipment.mjs',
  },
  note: '손으로 고치지 마라 — 원천은 레지스트리와 정답셋이고 `npm run extract:equipment` 로 다시 뽑는다. 레지스트리에 없는 식별자는 label·kind 가 null 이다: 이름을 지어내지 않는다.',
  vocabulary_note: `프롬프트에 싣는 목록은 채점 어휘(정답셋 assigned_targets 합집합 ${goldTargets.size}건)보다 **넓어야 한다.** 같아지면 오답 선택지가 없는 시험이 되어 이 축이 자기 자신을 채점한다. verify:no-leak 이 검사한다.`,
  counts: { total: equipment.length, registry: fromRegistry.size, goldset_targets: goldTargets.size, wider_by: equipment.length - goldTargets.size },
  equipment,
}, null, 2) + '\n', 'utf8');

const kinds = [...new Set(equipment.map((entry) => entry.kind).filter(Boolean))].sort();
console.log(`장비 ${equipment.length}건 — 레지스트리 ${fromRegistry.size} · 정답셋 ${goldTargets.size} (겹침 ${fromRegistry.size + goldTargets.size - equipment.length})`);
console.log(`채점 어휘보다 ${equipment.length - goldTargets.size}건 넓다 — 오답 선택지: ${registryOnly.map((entry) => entry.equipment_id).join(' · ') || '없다(축이 죽는다)'}`);
console.log(`이름을 모르는 식별자 ${goldOnly.length}건 (label·kind = null): ${goldOnly.map((entry) => entry.equipment_id).join(' · ') || '없다'}`);
console.log(`종류 ${kinds.length}종 — ${kinds.join(' · ')}  (레지스트리의 entity_type 을 그대로 옮긴다)`);
