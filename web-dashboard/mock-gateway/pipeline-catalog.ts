/**
 * mock-gateway/pipeline-catalog.ts
 *
 * REQ-1003 — 노드 카탈로그를 **등록된 디스크립터·렌더러·데이터소스에서 파생**한다.
 *
 * 이전에는 `NODE_CATALOG`라는 코드 상수 배열이었다. 그러면 노드를 하나 늘릴 때마다
 * 게이트웨이 코드를 고쳐야 하고, 요건이 못박은 "개발자가 편집기 코드를 고쳐 노드를
 * 추가하는 일이 없어야 한다"가 위치만 UI에서 서버로 옮겨간 채 그대로 깨진다.
 *
 * 지금 단계의 **등록처는 `contracts/examples/` 아래 파일들**이다. 실물 레지스트리가
 * 생기면 이 파일의 `load*()` 세 함수만 그 조회로 바꾸면 되고, 파생 규칙은 그대로다.
 *
 * **목이라는 사실을 감추지 않는다** — 각 항목은 자기가 어느 파일에서 나왔는지를
 * `derivedFrom`에 달고 다니고, 화면이 그걸 그대로 보여준다.
 *
 * 파생 규칙 (전부 선언에서 끌어온다. 코드에 타입 표를 다시 적지 않는다)
 *  - **포트 타입** = 컴포넌트 디스크립터의 `field.type` 어휘. 렌더러의
 *    `acceptsFieldTypes`도 같은 어휘라 맞대기만 하면 된다.
 *  - **스트리밍 타입**이 무엇인지도 코드가 정하지 않는다. `streaming: true`인 렌더러가
 *    받겠다고 선언한 필드 타입이 곧 스트리밍 타입이다.
 *  - **source** = 컴포넌트 필드 하나당 하나. 그 필드를 읽어줄 수 있는 데이터소스를
 *    `capabilities` 선언에서 고른다.
 *  - **transform** = 등록된 파이프라인 예시에 실제로 쓰인 연산자. 포트 타입은 그
 *    연산자가 도달하는 sink의 필드 타입에서 온다.
 *  - **sink** = 렌더러 하나당 하나.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type {
  CatalogNode,
  ExecutionLocation,
  PipelineContract,
  PortType,
  QueryMode,
} from '../shared/pipeline-contract.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXAMPLES_DIR = join(HERE, '..', '..', 'contracts', 'examples');

// ── 등록처 읽기 ──────────────────────────────────────────────────────────────
// `invalid-`로 시작하는 예시는 스키마 위반을 보여주려고 둔 것이므로 등록으로 치지 않는다.

type Loaded<T> = { file: string; body: T };

function loadRegistered<T>(kind: string): Array<Loaded<T>> {
  let names: string[];
  try {
    names = readdirSync(join(EXAMPLES_DIR, kind));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith('valid-') && n.endsWith('.json'))
    .sort()
    .map((n) => ({
      file: 'contracts/examples/' + kind + '/' + n,
      body: JSON.parse(readFileSync(join(EXAMPLES_DIR, kind, n), 'utf8')) as T,
    }));
}

type DescriptorField = {
  name: string;
  type: PortType;
  required: boolean;
  unit?: string;
  samplingIntervalMs?: number;
  representationHint?: string;
  description?: string;
};
type ComponentDescriptor = { id: string; displayName?: string; fields: DescriptorField[] };
type RendererDescriptor = {
  type: string;
  displayName?: string;
  acceptsFieldTypes: PortType[];
  streaming: boolean;
  executionLocation?: 'client' | 'server' | 'any';
};
type DataSourceDescriptor = {
  id: string;
  displayName?: string;
  capabilities?: { instantQuery?: boolean; rangeQuery?: boolean; streaming?: boolean };
};

const loadComponents = () => loadRegistered<ComponentDescriptor>('component-descriptor');
const loadRenderers = () => loadRegistered<RendererDescriptor>('renderer');
const loadDataSources = () => loadRegistered<DataSourceDescriptor>('datasource');
const loadPipelines = () => loadRegistered<PipelineContract>('pipeline');

// ── 파생 ─────────────────────────────────────────────────────────────────────

/**
 * 계약의 `executionLocation`은 `server` / `client` 둘뿐인데 렌더러는 `any`도 선언할 수
 * 있다. `any`는 계약에 그대로 쓸 수 없으므로 표현 노드의 기본값인 `client`로 좁힌다.
 */
function narrowLocation(v: RendererDescriptor['executionLocation']): ExecutionLocation {
  return v === 'server' ? 'server' : 'client';
}

function sourceEntries(
  components: Array<Loaded<ComponentDescriptor>>,
  dataSources: Array<Loaded<DataSourceDescriptor>>,
  streamingTypes: ReadonlySet<PortType>,
): CatalogNode[] {
  const entries: CatalogNode[] = [];
  for (const component of components) {
    for (const field of component.body.fields) {
      const needsStream = streamingTypes.has(field.type);
      // 주기 필드는 구간 질의로, 단발 값은 즉시 질의로 읽는다. 어느 쪽이 가능한지는
      // 데이터소스가 capabilities로 선언한다 — 여기서 정하지 않는다.
      const wants: QueryMode[] = needsStream
        ? ['stream']
        : field.samplingIntervalMs !== undefined
          ? ['range', 'instant']
          : ['instant', 'range'];
      let chosen: { ds: Loaded<DataSourceDescriptor>; mode: QueryMode } | null = null;
      for (const mode of wants) {
        const supports = (c: DataSourceDescriptor['capabilities']) =>
          mode === 'stream' ? c?.streaming === true : mode === 'range' ? c?.rangeQuery === true : c?.instantQuery === true;
        const ds = dataSources.find((d) => supports(d.body.capabilities));
        if (ds) {
          chosen = { ds, mode };
          break;
        }
      }
      // 읽어줄 데이터소스가 하나도 등록돼 있지 않으면 노드로 세우지 않는다.
      // 없는 경로를 카탈로그에 올리면 시험 실행이 반드시 실패한다.
      if (chosen === null) continue;
      const unit = field.unit ? ' (' + field.unit + ')' : '';
      entries.push({
        type: 'source:' + chosen.ds.body.id + ':' + chosen.mode + ':' + component.body.id + '/' + field.name,
        label: (component.body.displayName ?? component.body.id) + ' · ' + field.name + unit,
        kind: 'source',
        accepts: null,
        emits: field.type,
        // REQ-404 — 원본 읽기는 데이터소스가 있는 서버 쪽이다.
        executionLocation: 'server',
        derivedFrom: [component.file, chosen.ds.file],
        defaults: {
          source: {
            dataSourceRef: chosen.ds.body.id,
            queryMode: chosen.mode,
            query: component.body.id + '/' + field.name,
          },
        },
      });
    }
  }
  return entries;
}

/**
 * 등록된 파이프라인이 실제로 쓴 연산자만 카탈로그에 올린다.
 * 포트 타입은 **그 연산자가 도달하는 sink의 필드 타입**에서 끌어온다 — 연산자 자신은
 * 타입을 선언하지 않고, 코어가 타입 표를 갖는 것도 요건 위반이기 때문이다.
 */
function transformEntries(
  pipelines: Array<Loaded<PipelineContract>>,
  fieldTypeOf: (componentRef: string, fieldRef: string) => PortType | null,
): CatalogNode[] {
  const byOperator = new Map<string, CatalogNode>();
  for (const pipeline of pipelines) {
    const byId = new Map(pipeline.body.nodes.map((n) => [n.id, n]));
    const downstream = (id: string): string[] => pipeline.body.edges.filter((e) => e.from === id).map((e) => e.to);

    const reachedTypes = (start: string): PortType[] => {
      const seen = new Set<string>();
      const types: PortType[] = [];
      const walk = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        const node = byId.get(id);
        if (!node) return;
        if (node.kind === 'sink' && node.sink) {
          const t = fieldTypeOf(node.sink.componentRef, node.sink.fieldRef);
          if (t !== null && !types.includes(t)) types.push(t);
          return;
        }
        for (const next of downstream(id)) walk(next);
      };
      for (const next of downstream(start)) walk(next);
      return types;
    };

    for (const node of pipeline.body.nodes) {
      if (node.kind !== 'transform' || !node.transform) continue;
      const operator = node.transform.operator;
      const types = reachedTypes(node.id);
      const existing = byOperator.get(operator);
      if (existing) {
        if (!existing.derivedFrom.includes(pipeline.file)) existing.derivedFrom.push(pipeline.file);
        for (const t of types) if (!existing.accepts?.includes(t)) existing.accepts?.push(t);
        continue;
      }
      byOperator.set(operator, {
        type: 'transform:' + operator,
        label: operator,
        kind: 'transform',
        accepts: [...types],
        // 전처리는 타입을 바꾸지 않는 것이 기본이다. 바꾸는 연산자는 자기 params로
        // 그 사실을 드러내야 하고, 그건 연산자 구현체가 소유한다(계약 §transformConfig).
        emits: types[0] ?? null,
        executionLocation: node.executionLocation,
        derivedFrom: [pipeline.file],
        defaults: { transform: { operator, ...(node.transform.params ? { params: node.transform.params } : {}) } },
      });
    }
  }
  return [...byOperator.values()].sort((a, b) => a.type.localeCompare(b.type));
}

function sinkEntries(
  renderers: Array<Loaded<RendererDescriptor>>,
  components: Array<Loaded<ComponentDescriptor>>,
): CatalogNode[] {
  return renderers.map((renderer) => {
    // 이 렌더러가 받을 수 있는 첫 필드를 기본 대상으로 삼는다. 사용자가 바꿀 수 있는
    // 값이지만, 계약이 `componentRef`·`fieldRef`를 필수로 요구하므로 비워 둘 수 없다.
    let target: { component: Loaded<ComponentDescriptor>; field: DescriptorField } | null = null;
    for (const component of components) {
      const field = component.body.fields.find((f) => renderer.body.acceptsFieldTypes.includes(f.type));
      if (field) {
        target = { component, field };
        break;
      }
    }
    return {
      type: 'sink:' + renderer.body.type,
      label: (renderer.body.displayName ?? renderer.body.type) + ' 렌더러',
      kind: 'sink' as const,
      accepts: [...renderer.body.acceptsFieldTypes],
      emits: null,
      executionLocation: narrowLocation(renderer.body.executionLocation),
      derivedFrom: target ? [renderer.file, target.component.file] : [renderer.file],
      defaults: {
        sink: {
          rendererType: renderer.body.type,
          componentRef: target?.component.body.id ?? '',
          fieldRef: target?.field.name ?? '',
        },
      },
    };
  });
}

export type DerivedCatalog = {
  nodes: CatalogNode[];
  /** 카탈로그를 만든 등록 파일 목록. 화면이 "이건 목이고 근거는 이 파일들"을 말할 재료. */
  registrationSources: string[];
  /** 파생된 포트 타입 어휘. 코드가 아니라 디스크립터·렌더러가 정한 값이다. */
  portTypes: PortType[];
};

/**
 * 매 호출마다 등록처를 다시 읽는다. 캐시하면 예시 파일을 하나 넣었을 때 카탈로그가
 * 따라오지 않고, 그러면 REQ-1003의 판정 기준 자체를 확인할 수 없다.
 */
export function deriveCatalog(): DerivedCatalog {
  const components = loadComponents();
  const renderers = loadRenderers();
  const dataSources = loadDataSources();
  const pipelines = loadPipelines();

  // "무엇이 스트리밍 타입인가"를 코드가 정하지 않는다 — streaming 렌더러의 선언이 정한다.
  const streamingTypes = new Set<PortType>(
    renderers.filter((r) => r.body.streaming === true).flatMap((r) => r.body.acceptsFieldTypes),
  );

  const fieldTypeOf = (componentRef: string, fieldRef: string): PortType | null => {
    const component = components.find((c) => c.body.id === componentRef);
    return component?.body.fields.find((f) => f.name === fieldRef)?.type ?? null;
  };

  const nodes = [
    ...sourceEntries(components, dataSources, streamingTypes),
    ...transformEntries(pipelines, fieldTypeOf),
    ...sinkEntries(renderers, components),
  ];

  const portTypes = [...new Set(components.flatMap((c) => c.body.fields.map((f) => f.type)))].sort();
  const registrationSources = [...components, ...renderers, ...dataSources, ...pipelines].map((x) => x.file).sort();

  return { nodes, registrationSources, portTypes };
}
