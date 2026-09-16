/**
 * mock-gateway/pipeline-editor.ts
 *
 * VZ-U-04 — **목** 파이프라인 편집 백엔드. 검증, 시험 실행, 반영과 되돌리기,
 * 그리고 반영된 그래프의 역방향 관측(REQ-1007).
 *
 * 여기서 오가는 그래프는 전부 **F4 계약형**(`contracts/pipeline.schema.json`)이다.
 * 편집기 좌표는 계약에 섞이지 않고 `layout`으로 따로 실려 온다 (REQ-1002).
 *
 * **실행기는 목이다.** 시험 실행의 `rows`·`elapsed_ms`는 지어낸 숫자고, 관측의
 * transform·sink 값은 source가 실제로 받은 것을 그대로 흘려보낸 것이다. 두 사실 모두
 * 응답에 표기로 실려 나가며 화면이 그대로 보여준다.
 */

import { deriveCatalog } from './pipeline-catalog.ts';
import {
  contractFingerprint,
  toContract,
  validateContract,
  type CatalogNode,
  type NodeLayout,
  type PipelineContract,
  type ValidationIssue,
} from '../shared/pipeline-contract.ts';
import type { Envelope } from './protocol.ts';
import type { Hub } from './hub.ts';

export type { CatalogNode, PipelineContract, ValidationIssue };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 계약이 아는 키만 남긴 사본. 좌표가 딸려 들어와도 여기서 끊긴다. */
const normalize = (graph: PipelineContract): PipelineContract => toContract({ pipeline: graph, layout: {} });

export function catalogNodes(): CatalogNode[] {
  return deriveCatalog().nodes;
}

/** 계약형 그래프 검증. 포트 타입은 파생된 카탈로그에서 온다. */
export function validateGraph(graph: PipelineContract, catalog?: readonly CatalogNode[]): ValidationIssue[] {
  return validateContract(graph, catalog ?? catalogNodes());
}

// ── 역방향 관측 (REQ-1007) ───────────────────────────────────────────────────

export type NodeObservation = {
  node_id: string;
  kind: 'source' | 'transform' | 'sink';
  /** 이 노드가 실제로 붙은 대상(레지스트리 entity). 붙지 못했으면 null. */
  bound_to: string | null;
  /** 반영 이후 이 노드를 지나간 봉투 수. */
  received: number;
  /** 마지막 수신 시각. **서버 시각**이다 — 화면이 `Date.now()`로 만들지 않는다. */
  last_at: string | null;
  /** 마지막 값 요약. 원본 payload를 짧게 줄인 것이다. */
  last_value: string | null;
  /**
   * `live` = 목 게이트웨이가 실제로 발행한 봉투를 이 노드가 받았다.
   * `mock-propagated` = 목 실행기가 상류에서 흘려보낸 값이다. 변환이 실제로 일어난 것이 아니다.
   * `none` = 반영 이후 이 노드에 도달한 것이 없다.
   */
  origin: 'live' | 'mock-propagated' | 'none';
};

export type ObservationReport = {
  /** 관측 대상 그래프. 반영된 것이 없으면 null이고 그때는 관측도 없다. */
  graph_id: string | null;
  version: string | null;
  since: string | null;
  /** 목이라는 사실을 응답이 직접 말한다. 화면이 이 문구를 그대로 보여준다. */
  executor: string;
  nodes: NodeObservation[];
};

function summarize(payload: unknown): string {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (text === undefined) return '(요약 불가)';
  return text.length > 90 ? text.slice(0, 90) + '…' : text;
}

/**
 * 컴포넌트 디스크립터 id → 그 디스크립터를 구현하는 실물 대상들.
 *
 * 디스크립터 스키마가 `id`를 "Zone/Node/Entity 레지스트리(F3)에서 참조되는 키"로
 * 정의하므로, 참조를 푸는 곳은 레지스트리다. **코드에 매핑 표를 두지 않는다** —
 * 레지스트리 항목의 `component` 선언이 곧 매핑이다.
 */
export type EntityBindings = {
  /** 레지스트리에 있는 대상 id 전부. */
  entityIds: ReadonlySet<string>;
  /** 컴포넌트 id → 대상 id 목록. */
  byComponent: ReadonlyMap<string, string[]>;
};

/**
 * source 노드가 어느 대상에 붙는가. 질의 문자열 앞자리(`<componentRef>/<field>`)를
 * 컴포넌트 참조로 보고 레지스트리에서 실물 대상을 찾는다. 찾지 못하면 붙지 않은
 * 채로 남고, 화면은 "이 노드에 대응하는 실데이터가 없다"를 그대로 본다.
 */
function boundEntity(query: string, bindings: EntityBindings): string | null {
  const head = query.split('/')[0];
  const mapped = bindings.byComponent.get(head);
  if (mapped && mapped.length > 0) return mapped[0];
  if (bindings.entityIds.has(head)) return head;
  for (const id of bindings.entityIds) if (query.includes(id)) return id;
  return null;
}

class ObservationRuntime {
  private graph: PipelineContract | null = null;
  private since: string | null = null;
  private readonly state = new Map<string, NodeObservation>();
  /** source 노드 id → 붙은 대상. 봉투가 올 때마다 역인덱스로 찾는다. */
  private readonly sourcesByEntity = new Map<string, string[]>();
  private downstream = new Map<string, string[]>();

  reset(graph: PipelineContract | null, bindings: EntityBindings): void {
    this.graph = graph;
    this.since = graph ? new Date().toISOString() : null;
    this.state.clear();
    this.sourcesByEntity.clear();
    this.downstream = new Map();
    if (!graph) return;

    for (const edge of graph.edges) {
      this.downstream.set(edge.from, [...(this.downstream.get(edge.from) ?? []), edge.to]);
    }
    for (const node of graph.nodes) {
      const bound = node.kind === 'source' && node.source ? boundEntity(node.source.query, bindings) : null;
      this.state.set(node.id, {
        node_id: node.id,
        kind: node.kind,
        bound_to: bound,
        received: 0,
        last_at: null,
        last_value: null,
        origin: 'none',
      });
      if (bound !== null) this.sourcesByEntity.set(bound, [...(this.sourcesByEntity.get(bound) ?? []), node.id]);
    }
  }

  observe(env: Envelope): void {
    const starts = this.sourcesByEntity.get(env.entity);
    if (!starts || starts.length === 0) return;
    const summary = env.channel + ' · ' + summarize(env.payload);
    const seen = new Set<string>();
    const walk = (id: string, origin: NodeObservation['origin']) => {
      if (seen.has(id)) return;
      seen.add(id);
      const record = this.state.get(id);
      if (!record) return;
      record.received += 1;
      record.last_at = env.ts;
      record.last_value = summary;
      record.origin = origin;
      for (const next of this.downstream.get(id) ?? []) walk(next, 'mock-propagated');
    };
    for (const id of starts) walk(id, 'live');
  }

  report(): ObservationReport {
    return {
      graph_id: this.graph?.id ?? null,
      version: this.graph?.version ?? null,
      since: this.since,
      executor:
        '목 실행기 — source 노드는 목 게이트웨이가 실제 발행한 봉투를 세고, 하류 노드는 그 값을 그대로 흘려보낸다. 변환이 실제로 수행되지는 않는다.',
      nodes: clone([...this.state.values()]),
    };
  }
}

// ── 편집 엔진 ────────────────────────────────────────────────────────────────

export type PipelineState = {
  /** 운영 중인 **계약**. 좌표는 여기 들어오지 않는다. */
  active: PipelineContract | null;
  previous: PipelineContract | null;
  /** 편집기 레이아웃. 계약 바깥에 계약과 나란히 보관한다 (REQ-1002). */
  activeLayout: Record<string, NodeLayout>;
  previousLayout: Record<string, NodeLayout>;
  audit: Array<{ action: 'commit' | 'rollback'; graph_id: string; version: string; at: string; actor: string }>;
};

export class PipelineEditorEngine {
  private active: PipelineContract | null = null;
  private previous: PipelineContract | null = null;
  private activeLayout: Record<string, NodeLayout> = {};
  private previousLayout: Record<string, NodeLayout> = {};
  private tested = new Map<string, string>();
  private readonly observation = new ObservationRuntime();
  private readonly bindings: EntityBindings;
  readonly audit: PipelineState['audit'] = [];

  /**
   * 허브를 받아 발행 흐름에 붙는다 (REQ-1007). 허브 없이도 편집 기능은 전부 돌지만
   * 그때 관측은 비어 있다 — 실데이터 경로가 없는 것을 있는 척하지 않기 위해서다.
   */
  constructor(hub?: Hub) {
    const byComponent = new Map<string, string[]>();
    for (const entity of hub?.registry.entities ?? []) {
      if (!entity.component) continue;
      byComponent.set(entity.component, [...(byComponent.get(entity.component) ?? []), entity.id]);
    }
    this.bindings = { entityIds: new Set(hub ? [...hub.runtime.keys()] : []), byComponent };
    hub?.onPublish((env) => this.observation.observe(env));
  }

  state(): PipelineState {
    return {
      active: clone(this.active),
      previous: clone(this.previous),
      activeLayout: clone(this.activeLayout),
      previousLayout: clone(this.previousLayout),
      audit: clone(this.audit),
    };
  }

  observations(): ObservationReport {
    return this.observation.report();
  }

  test(graph: PipelineContract) {
    const normalized = normalize(graph);
    const issues = validateGraph(normalized);
    if (issues.length > 0) return { ok: false, issues, token: null, outputs: [] };
    const token = 'test-' + Date.now().toString(36);
    // 증명은 **계약 본문**에 걸린다. 좌표를 옮긴 것만으로 시험을 무효로 만들면
    // 실행에 아무 영향이 없는 조작에 재시험을 요구하게 된다.
    this.tested.set(token, contractFingerprint(normalized));
    const outputs = normalized.nodes.map((n, i) => ({
      node_id: n.id,
      status: 'passed',
      rows: n.kind === 'source' ? 60 : Math.max(1, 60 - i * 4),
      elapsed_ms: 7 + i * 11,
    }));
    return { ok: true, issues: [], token, outputs, executor: '목 시험 실행 — 행 수와 소요 시간은 지어낸 값이다' };
  }

  commit(graph: PipelineContract, token: string, layout?: Record<string, NodeLayout>) {
    const normalized = normalize(graph);
    const issues = validateGraph(normalized);
    if (issues.length > 0) return { ok: false, issues, message: '검증 실패' };
    if (this.tested.get(token) !== contractFingerprint(normalized)) {
      return { ok: false, issues: [], message: '현재 초안의 시험 실행 증명이 없다' };
    }
    this.previous = this.active;
    this.previousLayout = this.activeLayout;
    this.active = normalized;
    this.activeLayout = clone(layout ?? {});
    this.audit.push({ action: 'commit', graph_id: normalized.id, version: normalized.version, at: new Date().toISOString(), actor: 'mock-operator' });
    // 반영 시점부터 다시 센다. 지난 그래프의 관측을 새 그래프에 이어 붙이면
    // "이 그래프가 지금 무엇을 받고 있는가"라는 질문의 답이 아니게 된다.
    this.observation.reset(this.active, this.bindings);
    return { ok: true, issues: [], message: '운영 그래프에 반영됨', state: this.state() };
  }

  rollback() {
    if (!this.previous) return { ok: false, message: '되돌릴 직전 버전이 없다', state: this.state() };
    const currentGraph = this.active;
    const currentLayout = this.activeLayout;
    this.active = this.previous;
    this.activeLayout = this.previousLayout;
    this.previous = currentGraph;
    this.previousLayout = currentLayout;
    this.audit.push({ action: 'rollback', graph_id: this.active.id, version: this.active.version, at: new Date().toISOString(), actor: 'mock-operator' });
    this.observation.reset(this.active, this.bindings);
    return { ok: true, message: '직전 운영 그래프로 되돌림', state: this.state() };
  }
}
