// scripts/lib/json-schema.mjs (260904 신설)
//
// `contracts/*.schema.json` 을 **의존성 없이** 검사하는 최소 검증기.
//
// ## 왜 ajv 를 넣지 않았나
//
// 이 저장소의 검사 스크립트는 전부 의존성 0으로 돈다 — `npm ci` 없이 `node scripts/*.mjs`
// 한 줄이면 검사가 된다는 것이 지금까지의 성질이다. 채점기 하나 때문에 그 성질을 깨면
// 「검사를 돌리려면 먼저 설치해야 한다」가 되고, 그건 안 돌리게 되는 지름길이다.
//
// ## 어디까지 하나
//
// **`contracts/` 가 실제로 쓰는 문법만** 다룬다. 임의의 JSON Schema 를 다 받지 않는다 —
// 못 다루는 키워드를 만나면 **조용히 통과시키지 않고 그 사실을 알린다**(`unsupported`).
// 조용히 통과하는 검증기는 없는 검증기보다 나쁘다.
//
//   type(문자열·배열) · required · properties · additionalProperties(false) · items
//   $ref(형제 파일 $id · '#/$defs/…') · $defs · enum · anyOf
//   minLength · minimum · maximum · minItems · uniqueItems
//
// 오류는 **경로와 함께** 모은다. 「어디가 왜 틀렸는지」가 채점기의 재료다.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const KNOWN = new Set([
  '$schema', '$id', '$comment', 'title', 'description', '$defs',
  'type', 'required', 'properties', 'additionalProperties', 'items',
  '$ref', 'enum', 'anyOf',
  'minLength', 'minimum', 'maximum', 'minItems', 'uniqueItems',
]);

/**
 * `contracts/` 디렉터리를 통째로 읽어 `$id` 로 찾을 수 있게 만든다.
 * 계약 파일들이 서로를 `$id` 이름(`task.schema.json`)으로 참조하기 때문이다.
 */
export function loadContracts(dir) {
  const byId = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.schema.json')) continue;
    const schema = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    byId.set(schema.$id ?? name, schema);
  }
  return byId;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value === 'number' ? 'number' : typeof value;
}

function typeMatches(actual, expected) {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

/**
 * `instance` 가 `schema` 를 통과하는가.
 * @returns {{ok: boolean, errors: string[], unsupported: string[]}}
 */
export function validate(instance, schema, contracts, path = '$') {
  const errors = [];
  const unsupported = [];
  walk(instance, schema, schema, path);
  return { ok: errors.length === 0, errors, unsupported };

  function resolve(ref, root) {
    if (ref.startsWith('#/$defs/')) {
      const key = ref.slice('#/$defs/'.length);
      const found = root.$defs?.[key];
      if (found === undefined) throw new Error(`$ref 를 못 찾았다: ${ref}`);
      return { schema: found, root };
    }
    const file = contracts.get(ref);
    if (file === undefined) throw new Error(`$ref 파일을 못 찾았다: ${ref}`);
    return { schema: file, root: file };
  }

  function walk(value, node, root, at) {
    if (node === true || node === undefined) return;
    for (const key of Object.keys(node)) {
      if (!KNOWN.has(key)) unsupported.push(`${at}: 다루지 않는 키워드 '${key}'`);
    }

    if (node.$ref !== undefined) {
      const target = resolve(node.$ref, root);
      walk(value, target.schema, target.root, at);
      return;
    }

    if (node.anyOf !== undefined) {
      // 가지마다 따로 재 보고, 하나라도 통과하면 통과다. 전부 실패하면 **가지별 사유**를 남긴다.
      const branchErrors = [];
      for (const branch of node.anyOf) {
        const sub = validate(value, { ...branch, $defs: root.$defs }, contracts, at);
        if (sub.ok) return;
        branchErrors.push(sub.errors.join(' / '));
      }
      errors.push(`${at}: anyOf 의 어느 가지도 통과하지 않았다 — ${branchErrors.join(' | ')}`);
      return;
    }

    const actual = typeOf(value);
    if (node.type !== undefined) {
      const expected = Array.isArray(node.type) ? node.type : [node.type];
      if (!expected.some((one) => typeMatches(actual, one))) {
        errors.push(`${at}: 타입이 ${actual} 다 — ${expected.join('|')} 여야 한다`);
        return; // 타입이 다르면 아래 검사는 의미가 없다.
      }
    }

    if (node.enum !== undefined && !node.enum.includes(value)) {
      errors.push(`${at}: '${String(value)}' 는 허용 목록에 없다 — [${node.enum.join(', ')}]`);
    }
    if (node.minLength !== undefined && typeof value === 'string' && value.length < node.minLength) {
      errors.push(`${at}: 길이 ${value.length} — 최소 ${node.minLength}`);
    }
    if (node.minimum !== undefined && typeof value === 'number' && value < node.minimum) {
      errors.push(`${at}: ${value} < 최소 ${node.minimum}`);
    }
    if (node.maximum !== undefined && typeof value === 'number' && value > node.maximum) {
      errors.push(`${at}: ${value} > 최대 ${node.maximum}`);
    }

    if (actual === 'array') {
      if (node.minItems !== undefined && value.length < node.minItems) {
        errors.push(`${at}: 원소 ${value.length}개 — 최소 ${node.minItems}`);
      }
      if (node.uniqueItems === true) {
        const seen = new Set(value.map((item) => JSON.stringify(item)));
        if (seen.size !== value.length) errors.push(`${at}: 중복 원소가 있다`);
      }
      if (node.items !== undefined) {
        value.forEach((item, index) => walk(item, node.items, root, `${at}[${index}]`));
      }
      return;
    }

    if (actual === 'object') {
      for (const key of node.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${at}: 필수 항목 '${key}' 가 없다`);
      }
      if (node.additionalProperties === false && node.properties !== undefined) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(node.properties, key)) {
            errors.push(`${at}: 계약에 없는 항목 '${key}'`);
          }
        }
      }
      for (const [key, sub] of Object.entries(node.properties ?? {})) {
        if (Object.prototype.hasOwnProperty.call(value, key)) walk(value[key], sub, root, `${at}.${key}`);
      }
    }
  }
}
