/**
 * src/generate/gbnf.ts (260904 신설 — 마일스톤 분리 지시서 §3)
 *
 * **문법을 계약에서 뽑는다.** `contracts/mission.schema.json` → GBNF.
 *
 * ## 손으로 쓴 문법 파일을 두지 않는다
 *
 * 계약이 바뀌면 문법도 같이 바뀌어야 하는데, 문법을 별도 파일로 적어 두면 그 둘이
 * **조용히 갈라진다.** 이 저장소가 계속 피해 온 실패다(이식본 vs 원본 · 목록을 두 곳에
 * 적는 것 · 렌더 모드를 화면마다 읽는 것). 「계약이 원본」이라는 원칙을 생성기까지
 * 그대로 늘린다 — `verify:gen-port` 가 손으로 쓴 문법 파일이 없는지 검사한다.
 *
 * ## 어디까지 하나
 *
 * `contracts/` 가 실제로 쓰는 문법만 다룬다 (`scripts/lib/json-schema.mjs` 와 같은 범위).
 * 못 다루는 키워드를 만나면 **조용히 넘기지 않고 던진다** — 문법이 계약보다 느슨하면
 * 강제 디코딩이 계약 밖 출력을 통과시키고, 그러면 「강제 디코딩이 실제로 듣는가」를
 * 재는 축(스키마)이 무의미해진다.
 *
 * ## 순수 함수다
 *
 * 계약 JSON 을 인자로 받는다 — import 로 묶어 두면 `verify:gen-port` 가 **계약을 바꿔
 * 문법이 따라 바뀌는지**(대조군)를 볼 수 없다. 부르는 쪽(`LlmClient`)이 넣어 준다.
 */

export type JsonSchema = Record<string, unknown>;

/** GBNF 이름에 쓸 수 있는 글자로. 계약의 `$id` 는 점을 품고 있다(`mission.schema.json`). */
function ruleName(raw: string): string {
  return raw.replace(/\.schema\.json$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'root';
}

const PRIMITIVES = `
ws       ::= [ \\t\\n]*
string   ::= "\\"" char* "\\"" ws
char     ::= [^"\\\\] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
integer  ::= "-"? ("0" | [1-9] [0-9]*) ws
number   ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)? ws
boolean  ::= ("true" | "false") ws
null     ::= "null" ws
any      ::= string | number | boolean | null | any-array | any-object
any-array  ::= "[" ws (any ("," ws any)*)? "]" ws
any-object ::= "{" ws (string ":" ws any ("," ws string ":" ws any)*)? "}" ws
`.trim();

/**
 * 계약 하나(와 그것이 `$ref` 로 끌어오는 것들)를 GBNF 로.
 *
 * @param root      진입 계약 (`mission.schema.json`)
 * @param contracts `$id` → 계약. `$ref` 를 푸는 데 쓴다.
 */
export function toGbnf(root: JsonSchema, contracts: ReadonlyMap<string, JsonSchema>): string {
  const rules = new Map<string, string>();
  const pending: Array<{ name: string; schema: JsonSchema; owner: JsonSchema }> = [];

  const rootName = ruleName(String(root.$id ?? 'root'));
  pending.push({ name: rootName, schema: root, owner: root });

  while (pending.length > 0) {
    const job = pending.shift()!;
    if (rules.has(job.name)) continue;
    rules.set(job.name, ''); // 자기 참조를 막는 자리표시
    rules.set(job.name, body(job.schema, job.owner, job.name));
  }

  const lines = [
    '# 이 문법은 손으로 쓰지 않는다 — contracts/mission.schema.json 에서 뽑았다',
    '# (src/generate/gbnf.ts). 계약을 고치면 문법도 같이 바뀐다.',
    `root ::= ${rootName}`,
    '',
    ...[...rules].map(([name, rule]) => `${name} ::= ${rule}`),
    '',
    PRIMITIVES,
  ];
  return lines.join('\n') + '\n';

  /** `$ref` 를 풀어 (스키마, 그 스키마의 `$defs` 주인, 규칙 이름)을 낸다. */
  function deref(node: JsonSchema, owner: JsonSchema, hint: string): { schema: JsonSchema; owner: JsonSchema; name: string } {
    const ref = node.$ref as string | undefined;
    if (ref === undefined) return { schema: node, owner, name: hint };
    if (ref.startsWith('#/$defs/')) {
      const key = ref.slice('#/$defs/'.length);
      const defs = (owner.$defs ?? {}) as Record<string, JsonSchema>;
      const found = defs[key];
      if (found === undefined) throw new Error(`$ref 를 못 찾았다: ${ref}`);
      return { schema: found, owner, name: `${ruleName(String(owner.$id ?? hint))}-${ruleName(key)}` };
    }
    const file = contracts.get(ref);
    if (file === undefined) throw new Error(`$ref 파일을 못 찾았다: ${ref}`);
    return { schema: file, owner: file, name: ruleName(ref) };
  }

  function refer(node: JsonSchema, owner: JsonSchema, hint: string): string {
    const target = deref(node, owner, hint);
    if (target.schema !== node || node.$ref !== undefined) {
      if (!rules.has(target.name)) pending.push({ name: target.name, schema: target.schema, owner: target.owner });
      return target.name;
    }
    // 인라인 스키마 — 이름을 하나 만들어 규칙으로 올린다. 본문에 접으면 읽을 수 없다.
    const name = hint;
    if (!rules.has(name)) pending.push({ name, schema: node, owner });
    return name;
  }

  function literal(value: unknown): string {
    return JSON.stringify(JSON.stringify(value));
  }

  function body(node: JsonSchema, owner: JsonSchema, name: string): string {
    if (node.$ref !== undefined) {
      const target = deref(node, owner, name);
      if (!rules.has(target.name)) pending.push({ name: target.name, schema: target.schema, owner: target.owner });
      return target.name;
    }
    if (Array.isArray(node.enum)) {
      // **허용 목록이 문법이 된다.** 이것이 강제 디코딩의 알맹이다 — 모델이 목록 밖 값을
      // 아예 낼 수 없다. 상태·노드 문법 5종·판정 주체가 여기서 잠긴다.
      return `(${node.enum.map(literal).join(' | ')}) ws`;
    }
    if (Array.isArray(node.anyOf)) {
      return node.anyOf
        .map((branch, index) => refer(branch as JsonSchema, owner, `${name}-${index}`))
        .join(' | ');
    }

    const types = node.type === undefined ? [] : (Array.isArray(node.type) ? node.type : [node.type]) as string[];
    if (types.length === 0) return 'any';
    if (types.length > 1) return types.map((one) => scalar(one, node, owner, name)).join(' | ');
    return scalar(types[0], node, owner, name);
  }

  function scalar(type: string, node: JsonSchema, owner: JsonSchema, name: string): string {
    if (type === 'string') return 'string';
    if (type === 'integer') return 'integer';
    if (type === 'number') return 'number';
    if (type === 'boolean') return 'boolean';
    if (type === 'null') return 'null';
    if (type === 'array') {
      const items = node.items as JsonSchema | undefined;
      if (items === undefined) return 'any-array';
      const item = refer(items, owner, `${name}-item`);
      // minItems 는 1까지만 문법으로 강제한다. 그 이상은 세는 규칙이 폭발한다 —
      // 남는 것은 서비스의 스키마 검증이 잡는다(그래서 스텁도 검증을 한다).
      const min = typeof node.minItems === 'number' ? node.minItems : 0;
      const inner = min >= 1 ? `${item} ("," ws ${item})*` : `(${item} ("," ws ${item})*)?`;
      return `"[" ws ${inner} "]" ws`;
    }
    if (type === 'object') {
      const properties = (node.properties ?? {}) as Record<string, JsonSchema>;
      const required = (node.required ?? []) as string[];
      const keys = Object.keys(properties);
      if (keys.length === 0) return 'any-object';
      // **순서를 계약의 `properties` 차례로 고정한다.** JSON 객체는 원래 순서가 없지만,
      // 문법으로 순서를 풀면 규칙이 조합 폭발한다. 고정 순서는 계약을 어기지 않는다 —
      // 어느 순서든 같은 객체이고, 우리가 그중 하나를 고른 것뿐이다.
      //
      // 쉼표는 **필수 항목끼리만** 잇고, 선택 항목은 앞에 쉼표를 달아 뒤에 붙인다.
      // 섞어 두면 선택 항목이 빠졌을 때 쉼표가 하나 남는 문법이 된다.
      const pair = (key: string) =>
        `${JSON.stringify(JSON.stringify(key))} ws ":" ws ${refer(properties[key], owner, `${name}-${ruleName(key)}`)}`;
      const requiredPart = keys.filter((key) => required.includes(key)).map(pair).join(' "," ws ');
      const optionalPart = keys
        .filter((key) => !required.includes(key))
        .map((key) => ` ("," ws ${pair(key)})?`)
        .join('');
      if (requiredPart === '') {
        // 필수가 하나도 없는 객체 — 선택 항목만 있으므로 첫 항목의 쉼표를 떼야 한다.
        // 계약에는 아직 이런 모양이 없다. 생기면 여기서 알린다.
        throw new Error(`필수 항목이 없는 객체는 아직 옮기지 않는다: ${name}`);
      }
      return `"{" ws ${requiredPart}${optionalPart} "}" ws`;
    }
    throw new Error(`GBNF 로 옮길 수 없는 타입이다: ${type} (${name}) — 조용히 넘기면 문법이 계약보다 느슨해진다`);
  }
}

/**
 * 문법의 지문. 서비스가 「어느 계약으로 만든 문법을 강제했는가」를 기록에 남기는 데 쓴다.
 * 암호용이 아니다 — 두 문법이 같은지만 보면 된다.
 */
export function digest(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}
