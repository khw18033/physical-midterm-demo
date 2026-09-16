/** VZ-U-04 — 초안과 운영 상태를 분리한 노드 그래프 편집기. */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  canConnect,
  commitPipeline,
  fetchNodeCatalog,
  fetchObservation,
  fetchPipelineState,
  fromContract,
  nextNodeId,
  nodeFromCatalog,
  resolveCatalog,
  rollbackPipeline,
  starterDraft,
  testPipeline,
  toContract,
  type CatalogNode,
  type CatalogResponse,
  type ContractNode,
  type NodeObservation,
  type ObservationReport,
  type PipelineContract,
  type PipelineDraft,
  type PipelineState,
  type TestResult,
} from '../data/pipelineEditor.ts';
import { decidePlan, playScenario, type Plan, type PlanSegment, SEGMENT_STATUS_LABEL } from '../data/index.ts';
import type { RegistryEntity } from '../data/registry.ts';
import type { EntityRecord } from '../data/store.ts';
import { useEntities } from '../data/hooks.ts';

export function NodeGraphView() {
  const [mode, setMode] = useState<'mission' | 'pipeline'>('mission');
  return <main className="board graphpage">
    <header className="board__head"><div><h1 className="board__title">노드 그래프 관제</h1><p className="board__sub">임무와 서브태스크를 중심으로 실행·영상·센서·제어 근거를 연결한다</p></div><div className="graphactions"><button className={'btn' + (mode === 'mission' ? ' btn--on' : '')} onClick={() => setMode('mission')}>임무 관제</button><button className={'btn' + (mode === 'pipeline' ? ' btn--on' : '')} onClick={() => setMode('pipeline')}>데이터 파이프라인</button></div></header>
    {mode === 'mission' ? <MissionGraph /> : <PipelineGraphEditor />}
  </main>;
}

// ── 임무 관제 그래프 ─────────────────────────────────────────────────────────

/**
 * 근거 후보는 **레지스트리에서 온다.** 대상 id를 코드에 적어 두면 장치가 늘 때
 * 화면이 따라가지 못하고, "하드웨어에 의존적이지 않은 범용 프레임워크"라는 전제가
 * 화면에서만 깨진다(`VZ-C-05`의 설계 전제는 장치 20이다).
 *
 * 어떤 종류의 근거인지도 대상 종류가 아니라 **선언된 채널**에서 판정한다 —
 * 채널이 곧 그 대상에서 무엇을 볼 수 있는가이기 때문이다.
 */
type EvidenceKind = 'video' | 'control' | 'state';
type EvidenceLink = { entity: string; kind: EvidenceKind; label: string; zone: string | null };

const EVIDENCE_ROLE: Record<EvidenceKind, string> = { video: '영상 관측', control: '실행 결과', state: '판단 입력' };

function evidenceKindOf(registry: RegistryEntity): EvidenceKind {
  if (registry.channels.includes('video_meta')) return 'video';
  if (registry.channels.includes('actuator_state')) return 'control';
  return 'state';
}

function evidenceCandidates(entities: ReadonlyMap<string, EntityRecord>): EvidenceLink[] {
  return [...entities.values()]
    .filter((r): r is EntityRecord & { registry: RegistryEntity } => r.registry !== null)
    .map((r) => ({ entity: r.id, kind: evidenceKindOf(r.registry), label: r.registry.display_name, zone: r.registry.zone }))
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

/** 계획이 도착한 대상이 곧 임무 대상이다. 대상이 늘면 여기 목록이 늘어난다. */
function missionTargets(entities: ReadonlyMap<string, EntityRecord>): string[] {
  return [...entities.values()].filter((r) => r.plan !== null).map((r) => r.id).sort();
}

function MissionGraph() {
  const entities = useEntities();
  const targets = missionTargets(entities);
  const [target, setTarget] = useState<string | null>(null);
  const active = target !== null && targets.includes(target) ? target : (targets[0] ?? null);

  const record = active === null ? null : (entities.get(active) ?? null);
  const plan = (record?.plan?.payload as Plan | undefined) ?? null;
  const progress = record?.planProgress?.payload ?? null;
  const segments: PlanSegment[] = progress !== null && progress.plan_id === plan?.plan_id ? progress.segments : (plan?.segments ?? []);

  const candidates = evidenceCandidates(entities);
  const [selected, setSelected] = useState(1);
  const [links, setLinks] = useState<Record<number, string[]>>({});
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);

  /**
   * 기본 연결도 레지스트리에서 만든다 — 임무 대상 자신과, 그 구간의 구역에서
   * 영상을 볼 수 있는 대상. 카메라가 하나 늘면 기본 연결이 따라 늘어난다.
   */
  const defaultLinks = useMemo(() => {
    const map: Record<number, string[]> = {};
    for (const segment of segments) {
      const inZone = candidates.filter((c) => c.kind === 'video' && (c.zone === null || c.zone === segment.zone));
      map[segment.index] = [...(active ? [active] : []), ...inZone.map((c) => c.entity)];
    }
    return map;
  }, [plan?.plan_id, segments.length, candidates.length, active]);

  useEffect(() => { setSelected(1); setLinks(defaultLinks); }, [plan?.plan_id, active]);

  if (plan === null || active === null) {
    return <><p className="notice">관제할 임무가 없다. 계획을 내려받으면 임무 그래프가 만들어진다.</p><button className="btn" onClick={() => playScenario('plan-propose')}>계획 내려받기</button></>;
  }

  const linksOf = (index: number) => links[index] ?? defaultLinks[index] ?? [];
  const toggle = (entity: string) => setLinks((current) => {
    const list = current[selected] ?? defaultLinks[selected] ?? [];
    return { ...current, [selected]: list.includes(entity) ? list.filter((v) => v !== entity) : [...list, entity] };
  });
  const statusOfEvidence = (link: EvidenceLink) => {
    const r = entities.get(link.entity);
    if (link.kind === 'video') return r?.videoMeta ? '수신중' : '미수신';
    if (link.kind === 'control') return r?.actuator?.payload.phase ?? '미수신';
    return r?.state?.payload.availability ?? '미수신';
  };

  const width = Math.max(980, segments.length * 245 + 170);
  const deepest = Math.max(1, ...segments.map((s) => linksOf(s.index).length));
  const height = Math.max(500, 260 + deepest * 74);
  return <>
    <section className="missionbar"><div><b>{plan.evidence.mission.title}</b><span>{plan.plan_id} · {plan.entity}</span></div>
      {targets.length > 1 && <label className="missionpick">임무 대상<select value={active} onChange={(e) => setTarget(e.target.value)}>{targets.map((id) => <option key={id} value={id}>{entities.get(id)?.registry?.display_name ?? id}</option>)}</select></label>}
      <span className={'badge badge--plan-' + plan.decision}>{plan.decision === 'pending' ? '승인 대기' : plan.decision === 'approved' ? '승인됨' : '거부됨'}</span>{plan.decision === 'pending' && <button className="btn btn--on" onClick={() => decidePlan(plan.plan_id, 'approve')}>승인 후 실행</button>}</section>
    <p className="notice">노드를 누르면 해당 서브태스크에 관측 근거를 붙이거나 뗄 수 있다. 연결은 표시 장식이 아니라 실패 원인을 함께 관제할 근거다. 후보 {candidates.length}개는 모두 레지스트리에서 왔다.</p>
    <div className="missioncanvaswrap"><div className="missioncanvas" style={{ width, height }}>
      <svg className="canvas__edges missionedges" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <line x1="145" y1="105" x2="205" y2="105" />
        {segments.slice(0, -1).map((s, i) => <line key={'seq-' + s.index} x1={205 + i * 235 + 190} y1="105" x2={205 + (i + 1) * 235} y2="105" />)}
        {segments.flatMap((s, i) => linksOf(s.index).map((entity, j) => <line className="missionedges__evidence" key={`${s.index}-${entity}`} x1={205 + i * 235 + 95} y1="145" x2={205 + i * 235 + 95} y2={238 + j * 74} />))}
      </svg>
      <article className={'missionnode missionnode--root missionnode--' + plan.decision} style={{ left: 10, top: 62 }}><b>전체 임무</b><small>{plan.evidence.mission.id}</small><span>{plan.decision === 'pending' ? '승인 전 · 실행 금지' : plan.relay_stage}</span></article>
      {segments.map((s, i) => <div key={s.index}>
        <button className={'missionnode missionnode--task missionnode--' + s.status + (selected === s.index ? ' missionnode--selected' : '')} style={{ left: 205 + i * 235, top: 62 }} onClick={() => setSelected(s.index)}><b>Sub task {s.index}/{s.total}</b><small>{s.title}</small><span>{SEGMENT_STATUS_LABEL[s.status]} · {s.zone}</span>{s.failure && <em>{s.failure.reason}</em>}</button>
        {linksOf(s.index).map((entity, j) => {
          const evidence = candidates.find((c) => c.entity === entity);
          if (!evidence) return null;
          const key = s.index + '-' + entity;
          const role = entity === active ? '실행 주체' : EVIDENCE_ROLE[evidence.kind];
          return <button key={key} className={'evidencenode evidencenode--' + (entity === active ? 'robot' : evidence.kind === 'state' ? 'sensor' : evidence.kind)} style={{ left: 205 + i * 235, top: 238 + j * 74 }} onClick={() => setOpenEvidence(openEvidence === key ? null : key)}><b>{evidence.label}</b><span>{statusOfEvidence(evidence)}</span>{openEvidence === key && <small>{evidence.entity} · task {s.index}의 {role} 근거</small>}</button>;
        })}
      </div>)}
    </div></div>
    <section className="evidencetools"><h2>Sub task {selected} 연결 관리</h2>{candidates.map((e) => <button key={e.entity} className={'btn' + (linksOf(selected).includes(e.entity) ? ' btn--on' : '')} onClick={() => toggle(e.entity)}>{linksOf(selected).includes(e.entity) ? '연결됨' : '연결'} · {e.label}</button>)}<p>현재 연결: {linksOf(selected).join(', ') || '없음'}</p></section>
    <section className="devpanel"><h2 className="devpanel__title">임무 진행 재생</h2><div className="devpanel__row"><button className="btn" onClick={() => playScenario('plan-propose')}>정상 임무 새로 받기</button><button className="btn" onClick={() => playScenario('plan-propose-failing')}>4번 Sub task 실패 임무</button></div></section>
  </>;
}

// ── 데이터 파이프라인 편집기 ─────────────────────────────────────────────────

/** 반영된 그래프의 관측을 몇 초마다 물을 것인가. 흐르는 값이라 시점이 이산적이지 않다. */
const OBSERVATION_POLL_MS = 3000;

function PipelineGraphEditor() {
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [draft, setDraft] = useState<PipelineDraft | null>(null);
  const [state, setState] = useState<PipelineState>({ active: null, previous: null, activeLayout: {}, previousLayout: {}, audit: [] });
  const [observation, setObservation] = useState<ObservationReport | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [message, setMessage] = useState('카탈로그 조회 중');
  const [contractText, setContractText] = useState<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => {
    void Promise.all([fetchNodeCatalog(), fetchPipelineState()]).then(([c, s]) => {
      setCatalog(c);
      setState(s);
      setDraft(s.active ? fromContract(s.active, s.activeLayout) : starterDraft(c.nodes));
      setMessage('편집 초안 — 시험 실행 전');
    }, (e: unknown) => setMessage('조회 실패: ' + String(e)));
  }, []);

  /**
   * REQ-1007 — 반영된 그래프가 지금 무엇을 받고 있는지. **게이트웨이 왕복으로만** 본다.
   * 편집기가 스토어 내부를 직접 읽으면 실물 백엔드로 갈아탈 때 그 경로가 통째로 사라진다.
   * 반영된 그래프가 없으면 물어볼 것도 없으므로 아예 걸지 않는다.
   */
  useEffect(() => {
    if (state.active === null) { setObservation(null); return; }
    let alive = true;
    const pull = () => void fetchObservation().then((r) => { if (alive) setObservation(r); }, () => { /* 관측 실패는 편집을 막지 않는다 */ });
    pull();
    const timer = setInterval(pull, OBSERVATION_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [state.active?.id, state.active?.version]);

  const nodes = draft?.pipeline.nodes ?? [];
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const entryOf = useMemo(() => {
    const map = new Map<string, CatalogNode | null>();
    for (const node of nodes) map.set(node.id, catalog ? resolveCatalog(catalog.nodes, node) : null);
    return map;
  }, [nodes, catalog]);
  const observed = useMemo(() => new Map((observation?.nodes ?? []).map((o) => [o.node_id, o])), [observation]);

  if (!draft || !catalog) return <main className="board"><p className="notice">{message}</p></main>;

  /** 계약 본문이 바뀌면 시험 증명이 무효다. **좌표만 옮긴 것은 여기 오지 않는다.** */
  const mutate = (pipeline: PipelineContract, layout?: Record<string, { x: number; y: number }>) => {
    setDraft({ pipeline, layout: layout ?? draft.layout });
    setTest(null);
    setMessage('초안 변경됨 — 다시 시험 실행해야 반영 가능');
  };

  const addNode = (spec: CatalogNode) => {
    const id = nextNodeId(draft.pipeline, spec.kind);
    const node = nodeFromCatalog(spec, id);
    const x = 40 + (spec.kind === 'source' ? 0 : spec.kind === 'transform' ? 1 : 2) * 270;
    const y = 40 + (nodes.length % 4) * 110;
    mutate({ ...draft.pipeline, nodes: [...nodes, node] }, { ...draft.layout, [id]: { x, y } });
  };

  const selectPort = (node: ContractNode) => {
    const entry = entryOf.get(node.id) ?? null;
    if (from === null) {
      if (entry?.emits) { setFrom(node.id); setMessage(entry.label + ' 출력 선택 — 연결할 입력을 누르세요'); }
      return;
    }
    const source = byId.get(from);
    if (!source) { setFrom(null); return; }
    const reason = canConnect(catalog.nodes, source, node);
    if (reason) { setMessage(reason); return; }
    if (draft.pipeline.edges.some((e) => e.from === from && e.to === node.id)) { setMessage('이미 연결돼 있다'); return; }
    mutate({ ...draft.pipeline, edges: [...draft.pipeline.edges, { from, to: node.id }] });
    setFrom(null);
  };

  const remove = (id: string) => {
    const layout = { ...draft.layout };
    delete layout[id];
    mutate({ ...draft.pipeline, nodes: nodes.filter((n) => n.id !== id), edges: draft.pipeline.edges.filter((e) => e.from !== id && e.to !== id) }, layout);
    setFrom(null);
  };

  // 좌표는 계약 밖이므로 옮겨도 계약은 그대로다 — 시험 증명을 무효로 만들지 않는다.
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width - 190, e.clientX - rect.left - drag.current.dx));
    const y = Math.max(0, Math.min(rect.height - 84, e.clientY - rect.top - drag.current.dy));
    const id = drag.current.id;
    setDraft((g) => g && ({ ...g, layout: { ...g.layout, [id]: { x, y } } }));
  };

  const runTest = () => void testPipeline(draft).then((r) => { setTest(r); setMessage(r.ok ? '시험 실행 통과 — 이 초안을 반영할 수 있다' : '시험 실행 실패'); }, (e: unknown) => setMessage(String(e)));
  const commit = () => { if (!test?.token) return; void commitPipeline(draft, test.token).then((r) => { setState(r.state); setMessage(r.message); setTest(null); }, (e: unknown) => setMessage(String(e))); };
  const rollback = () => void rollbackPipeline().then((r) => {
    setState(r.state);
    if (r.state.active) setDraft(fromContract(r.state.active, r.state.activeLayout));
    setMessage(r.message);
    setTest(null);
  }, (e: unknown) => setMessage(String(e)));

  /** REQ-1002를 화면에서 확인하는 자리 — 내보낸 계약 JSON에 좌표가 없어야 한다. */
  const showContract = () => setContractText(contractText === null ? JSON.stringify(toContract(draft), null, 2) : null);
  const loadContract = () => {
    if (contractText === null) return;
    try {
      const parsed = JSON.parse(contractText) as PipelineContract;
      setDraft(fromContract(parsed, draft.layout));
      setTest(null);
      setMessage('계약 JSON에서 초안을 복원했다 — 좌표는 편집기 레이아웃에서 왔다');
    } catch (e) {
      setMessage('계약 JSON을 읽을 수 없다: ' + String(e));
    }
  };

  const activeIds = new Set(state.active?.nodes.map((n) => n.id) ?? []);

  return <section className="pipelineeditor">
    <header className="pipelineeditor__head"><div><h2>데이터 해석 파이프라인</h2><p>임무 그래프와 별개인 source → transform → sink 구성 편집기</p></div><div className="graphactions"><button className="btn" onClick={runTest}>시험 실행</button><button className="btn btn--on" disabled={!test?.token} onClick={commit}>운영에 반영</button><button className="btn" disabled={!state.previous} onClick={rollback}>직전 버전 되돌리기</button><button className="btn" onClick={showContract}>{contractText === null ? '계약 JSON 보기' : '계약 JSON 닫기'}</button></div></header>
    <p className={'notice' + (test && !test.ok ? ' notice--warn' : '')}>{message}</p>
    {contractText !== null && <section className="contractio">
      <h2>F4 계약 JSON (REQ-1002)</h2>
      <p>이 본문에는 좌표가 없다. 좌표는 편집기 레이아웃에만 있고 계약과 함께 저장되지만 계약 안으로는 들어가지 않는다. 고쳐서 다시 불러오면 같은 화면으로 복원된다.</p>
      <textarea value={contractText} spellCheck={false} onChange={(e) => setContractText(e.target.value)} />
      <button className="btn" onClick={loadContract}>이 계약으로 초안 복원</button>
    </section>}
    <div className="grapheditor">
      <aside className="catalog">
        <h2>노드 카탈로그</h2>
        <p className="catalog__note">{catalog.nodes.length}종 · 등록처 {catalog.registration_sources.length}개 파일에서 파생 (REQ-1003). {catalog.note}</p>
        {catalog.nodes.map((n) => <button key={n.type} className="catalog__node" onClick={() => addNode(n)}><b>{n.label}</b><span>{n.kind} · {(n.accepts ?? ['—']).join('|')} → {n.emits ?? '—'}</span><span>{n.derivedFrom.join(' · ')}</span></button>)}
        <p className="catalog__note">포트 타입 어휘: {catalog.port_types.join(', ')} — 디스크립터·렌더러 선언에서 왔다.</p>
      </aside>
      <div className="canvas" onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
        <svg className="canvas__edges">{draft.pipeline.edges.map((edge) => { const a = draft.layout[edge.from]; const b = draft.layout[edge.to]; return a && b ? <line key={edge.from + edge.to} x1={a.x + 185} y1={a.y + 38} x2={b.x} y2={b.y + 38} /> : null; })}</svg>
        {nodes.map((n) => {
          const entry = entryOf.get(n.id) ?? null;
          const pos = draft.layout[n.id] ?? { x: 0, y: 0 };
          const live = activeIds.has(n.id) ? observed.get(n.id) ?? null : null;
          return <article key={n.id} className={'graphnode graphnode--' + n.kind + (from === n.id ? ' graphnode--selected' : '')} style={{ left: pos.x, top: pos.y }} onPointerDown={(e) => { const rect = e.currentTarget.getBoundingClientRect(); drag.current = { id: n.id, dx: e.clientX - rect.left, dy: e.clientY - rect.top }; e.currentTarget.setPointerCapture(e.pointerId); }}>
            <button className="graphnode__remove" onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(n.id)}>×</button>
            <b>{entry?.label ?? '(카탈로그에 없는 노드)'}</b>
            <small>{n.id} · {n.executionLocation}</small>
            {live && <span className={'graphnode__live graphnode__live--' + live.origin}>운영 {live.received}건 · {live.origin === 'live' ? '실수신' : live.origin === 'mock-propagated' ? '목 전달' : '없음'}</span>}
            <button className="graphnode__port" onPointerDown={(e) => e.stopPropagation()} onClick={() => selectPort(n)}>{from === null ? (entry?.emits ? '출력 선택' : '입력') : (entry?.accepts ? '여기에 연결' : '입력 없음')} · {entry?.accepts?.join('|') ?? entry?.emits ?? '—'}</button>
          </article>;
        })}
      </div>
    </div>
    <section className="graphresult">
      <h2>시험 결과 <small>초안의 모의 실행</small></h2>
      {test?.executor && <p className="notice">{test.executor}</p>}
      {test?.issues.map((i) => <p className="notice notice--warn" key={i.code + i.message}>{i.message}</p>)}
      {test?.outputs.map((o) => <span className="chip" key={o.node_id}>{o.node_id} · {o.status} · {o.rows}행 · {o.elapsed_ms}ms</span>)}
      {test === null && <p>아직 시험 실행하지 않았다.</p>}
      <p>운영: {state.active ? `${state.active.id} v${state.active.version}` : '미반영'} · 직전 버전: {state.previous ? state.previous.version : '없음'}</p>
    </section>
    <ObservationPanel report={observation} />
  </section>;
}

/**
 * REQ-1007 — 반영된 그래프의 역방향 관측.
 *
 * 시험 결과와 **같은 자리에 섞지 않는다.** 하나는 초안의 모의 결과이고 하나는 운영
 * 그래프가 실제로 받고 있는 값이다. 한 상자에 넣으면 "이 숫자가 지어낸 것인지 받은
 * 것인지"를 화면에서 가를 수 없고, 그 순간 요건이 깨진 것이다.
 */
function ObservationPanel({ report }: { report: ObservationReport | null }) {
  if (report === null || report.graph_id === null) {
    return <section className="graphobserve"><h2>운영 그래프 관측 <small>REQ-1007</small></h2><p>반영된 그래프가 없다. 반영하면 그 그래프가 지금 무엇을 받고 있는지 여기에 뜬다.</p></section>;
  }
  const timeOf = (iso: string | null) => iso === null ? '—' : new Date(iso).toLocaleTimeString();
  return <section className="graphobserve">
    <h2>운영 그래프 관측 <small>REQ-1007 · {report.graph_id} v{report.version}</small></h2>
    <p className="notice">{report.executor}</p>
    <table className="observetable"><thead><tr><th>노드</th><th>붙은 대상</th><th>최근 수신</th><th>건수</th><th>마지막 값</th></tr></thead>
      <tbody>{report.nodes.map((n) => <ObservationRow key={n.node_id} row={n} timeOf={timeOf} />)}</tbody>
    </table>
    <p>관측 시작: {timeOf(report.since)} — 반영 시점부터 다시 센다.</p>
  </section>;
}

function ObservationRow({ row, timeOf }: { row: NodeObservation; timeOf: (iso: string | null) => string }) {
  return <tr className={'observerow observerow--' + row.origin}>
    <td>{row.node_id} <small>{row.kind}</small></td>
    <td>{row.bound_to ?? <span className="muted">대응 대상 없음</span>}</td>
    <td>{timeOf(row.last_at)}</td>
    <td>{row.received}</td>
    <td>{row.last_value ?? <span className="muted">수신 없음</span>}{row.origin === 'mock-propagated' && <em> (목 실행기 전달)</em>}</td>
  </tr>;
}
