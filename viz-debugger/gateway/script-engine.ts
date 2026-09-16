/**
 * gateway/script-engine.ts (260831 신설)
 *
 * 대본 라이브러리 — **문장에서 재생까지.**
 *
 *   발화 (mission_from_utterance) → 키워드 대조 (src/scenarios/matcher.ts — 브라우저와 같은 파일)
 *     ├─ 없음/모호 → command_result reason_code = no_script_match. 억지로 고르지 않는다
 *     └─ 하나 → PlanEngine.proposeScript() — **승인 전에는 아무것도 재생되지 않는다**
 *   승인 (VZ-U-07) → 재생: trace_event(탭①) + worldTimeline(탭②~⑤) + commands(탭③) 배속 재생
 *
 * **이것은 LLM이 아니다** — 마일스톤·태스크는 미리 써 둔 대본에서 읽고, 그 사실이
 * 계획 근거와 command_result 문구에 그대로 실린다 (REQ-1207의 정신).
 *
 * 재생 규칙:
 *  - trace_event 는 mission-trace.ts 와 같은 봉투 규칙(hub.publish · fromDevice: false).
 *  - worldTimeline 은 장치의 평소 발행 경로(drive())로 나간다. 대본이 봉투를 만들지 않는다.
 *  - commands 는 CommandEngine.submit() 을 실제로 통과한다. 감사의 actor 는 임무이고
 *    input_mode 는 click·voice 가 아니다 — 임무가 낸 명령이 사람이 누른 것처럼 남으면 안 된다.
 *  - 배속은 mission-trace.ts 와 같은 VIZ_SCENARIO_SPEED 하나다. 대본마다 다른 배속을 두지 않는다.
 *
 * ※ 시간축 주의 — 대본은 배속(기본 20×)으로 돌지만 CommandEngine 의 4단계(ACK 300ms ·
 *   개폐 6초)는 실시간이다. 3편에서 close_gate 뒤 개도율이 대본 시각 기준 늦게 따라온다.
 *   엔진 타이밍을 배속에 맞춰 줄이면 명령 채널의 실측 성격이 사라지므로 그대로 둔다 —
 *   보고서에 기록했다.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { matchLibrary } from '../src/scenarios/matcher.ts';
import { LEGACY_ID, SCRIPT_IDS } from '../src/scenarios/manifest.ts';
import type { ScriptLibraryEntry, ScriptMatch, ScriptScenario, WorldDrive } from '../src/scenarios/types.ts';
import { SCENARIO_TIMING } from './config.ts';
import type { CommandEngine, SubmitOutcome } from './commands.ts';
import type { Fleet } from './devices.ts';
import type { Hub } from './hub.ts';
import { registerMission } from './mission-trace.ts';
import type { Plan, PlanEngine, SegmentStatus } from './plans.ts';
import type { Channel, CommandRequest, CommandResult } from './protocol.ts';
import type { VisionEmitter } from './vision.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, '..', 'scenarios');

/** 재생 배속 — mission-trace.ts 와 같은 축. 둘을 비교할 때 축이 달라지면 안 된다. */
const SPEED = Number(process.env.VIZ_SCENARIO_SPEED ?? 20);

/** 옛 편의 최소 형태 — 파일은 무수정이고, 재생에 필요한 만큼만 읽는다. */
type LegacyScenario = {
  missionId: string;
  utterance: { text: string };
  durationSec: number;
  milestones: Array<{ id: string; title: string }>;
  tasks: Array<{ id: string }>;
  events: Array<{ seq: number; atSec: number; nodeId: string; status: string; kind: string; producedBy: string; attempt?: number }>;
};

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(SCENARIO_DIR, name), 'utf-8')) as T;
}

type Deps = {
  hub: Hub;
  fleet: Fleet;
  commands: CommandEngine;
  plans: PlanEngine;
  vision: VisionEmitter;
  log: (message: string) => void;
};

type PlaybackState = {
  missionId: string;
  planId: string;
  timers: Array<ReturnType<typeof setTimeout>>;
  /** 태스크 → 마지막 상태(마일스톤 접기 재료). */
  taskStatus: Map<string, string>;
  /** 2편 coverage 누적 — 발행은 항상 전체 스냅샷이다(캐시가 마지막 봉투 하나라서). */
  coverage: Map<string, number | null>;
  ended: boolean;
  /** 우상단 모드 스위치의 정지 미리보기인가 (260831 요구 4). 타이머가 없다. */
  preview: boolean;
};

export class ScriptEngine {
  private readonly deps: Deps;
  private readonly library: ScriptLibraryEntry[];
  private readonly legacy: LegacyScenario;
  private commandSeq = 0;

  /** 재생(또는 미리보기) 중인 대본. 타이머 정리와 「대본 닫기」의 대상. */
  private playback: PlaybackState | null = null;

  /** 제안이 승인될 때까지 들고 있는 발화 수치 (7.8 잠정 — trace_event.payload 로 나간다). */
  private pendingVoice: { missionId: string; metrics: Record<string, unknown> } | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
    // 게이트웨이는 Node ESM 이라 JSON 을 fs 로 읽는다. **목록은 manifest, 매칭은 matcher** —
    // 브라우저(src/scenarios/library.ts)와 같은 파일을 쓰므로 두 벌이 아니다.
    const scripts = SCRIPT_IDS.map((id) => readJson<ScriptScenario>(id + '.json'));
    this.legacy = readJson<LegacyScenario>(LEGACY_ID + '.json');
    const sidecar = readJson<{ missionId: string; match: ScriptMatch }>(LEGACY_ID + '.match.json');
    this.library = [
      ...scripts.map((script) => ({
        missionId: script.missionId,
        world: 'registry' as const,
        match: script.match,
        script,
      })),
      { missionId: sidecar.missionId, world: 'legacy' as const, match: sidecar.match, script: null },
    ];

    // 대본 임무를 허브 런타임에 등록한다 — publish() 가 미등록 대상을 거부한다.
    // /registry 응답에는 넣지 않는다(임무는 장비가 아니다 — mission-trace.ts 와 같은 규칙).
    for (const entry of this.library) {
      if (entry.world === 'registry') registerMission(deps.hub, entry.missionId);
    }

    deps.plans.onScriptApproved = (plan) => this.startPlayback(plan);
  }

  describe(): string {
    return '대본 ' + this.library.length + '편 (registry ' + SCRIPT_IDS.length + ' + legacy 1) · ' + SPEED + '배속';
  }

  /** 이 엔진이 접수하는 액션인가. server.ts 의 명령 분기가 묻는다. */
  handles(action: string): boolean {
    return action === 'mission_from_utterance' || action === 'script_close' || action === 'script_preview';
  }

  /**
   * 발화·대본 명령 접수. CommandEngine.submit() 과 같은 계약 — 상관 키를 발급하고,
   * 거부도 command_result 로 내려보내며, 감사는 같은 저장소에 남는다.
   */
  submit(req: CommandRequest): SubmitOutcome {
    this.commandSeq += 1;
    const commandId = 'cmd-' + Date.now().toString(36) + '-scr' + String(this.commandSeq).padStart(2, '0');
    if (req.action === 'script_close') return this.closeScript(req, commandId);
    if (req.action === 'script_preview') return this.previewScript(req, commandId);
    return this.handleUtterance(req, commandId);
  }

  /**
   * 정지 미리보기 (260831 요구 4 — 우상단 모드 스위치).
   *
   * 대본의 `worldTimeline` 중 **`atSec === 0` 프레임만** 한 번 반영하고 끝낸다 —
   * `trace_event` 도 `commands` 도 내보내지 않고 타이머도 세우지 않는다.
   * **승인 선을 우회하지 않는다** — 재생(시간축·명령)은 여전히 VZ-U-07 승인 뒤다.
   * 반영은 재생과 같은 applyWorldFrame() 한 곳을 지난다 — 두 벌이면 갈라진다.
   */
  private previewScript(req: CommandRequest, commandId: string): SubmitOutcome {
    const missionId = String((req.params as { mission_id?: unknown } | undefined)?.mission_id ?? req.entity);
    const entry = this.library.find((candidate) => candidate.missionId === missionId) ?? null;
    if (!entry?.script) {
      return this.reject(req, commandId, 'no_script_match', '미리보기할 대본이 없다 — ' + missionId);
    }
    this.stopPlayback('미리보기로 교체');
    const script = entry.script;
    const playback: PlaybackState = {
      missionId,
      planId: '(preview)',
      timers: [],
      taskStatus: new Map(),
      coverage: new Map(),
      ended: false,
      preview: true,
    };
    this.playback = playback;

    // 출발 상태 — **재생 경로와 같은 한 곳**을 쓴다 (applyInitial). 미리보기만 이 단계를
    // 건너뛰면 3편의 수문이 「열려 있던 것을 닫는」 이야기와 정반대인 0%(닫힘)로 선다.
    this.applyInitial(script);
    if (script.map) {
      for (const cell of script.map.blind_cells) playback.coverage.set(cell.id, null);
      this.publishCoverage(script, 0);
    }
    if (script.cast.includes(this.deps.vision.entity)) {
      this.deps.vision.scriptView = { missionId: script.missionId, visible: [] };
    }
    for (const frame of script.worldTimeline ?? []) {
      if (frame.atSec === 0) this.applyWorldFrame(script, frame, playback);
    }

    const detail = '대본 미리보기 — ' + missionId + ' 의 초기 조건 + t=0 프레임 반영 (정지 · 재생은 승인 뒤)';
    this.emitResult(req, commandId, { status: 'completed', reason_code: null, detail });
    this.deps.commands.recordExternal(req, commandId, 'completed', detail);
    this.deps.log(detail);
    return { clientRequestId: req.client_request_id, commandId, accepted: true, reasonCode: null, message: detail };
  }

  private handleUtterance(req: CommandRequest, commandId: string): SubmitOutcome {
    const { plans, log, commands } = this.deps;
    const text = String((req.params as { text?: unknown } | undefined)?.text ?? '').trim();

    if (text.length === 0) {
      return this.reject(req, commandId, 'no_script_match', '발화 문장이 비어 있다');
    }

    const outcome = matchLibrary(text, this.library);
    if (outcome.kind !== 'matched') {
      // 없으면 없다고 한다. 모호해도 고르지 않는다 — 대본 조회는 LLM이 아니다.
      return this.reject(req, commandId, 'no_script_match', outcome.reason + ' — 문장: 「' + text + '」');
    }

    const entry = outcome.entry;
    // 새 제안은 진행 중 재생을 멈춘다 — 두 대본이 같은 장치를 몰면 기록 열이 섞인다.
    this.stopPlayback('새 제안으로 교체');

    // 실제 STT 발화였다면 세 수치를 들고 있다가 재생 첫 trace_event.payload 에 싣는다
    // (7.8 미결 — 안 ①의 형태로 **잠정**. 결정이 나면 옮긴다).
    const voice = (req.audit as { voice?: Record<string, unknown> } | undefined)?.voice;
    this.pendingVoice = voice
      ? {
          missionId: entry.missionId,
          metrics: {
            avg_logprob: voice.avg_logprob ?? null,
            no_speech_prob: voice.no_speech_prob ?? null,
            mean_word_prob: voice.mean_word_prob ?? null,
            provisional: '7.8 미결 — utterance.confidence 계약 확정 전 잠정 위치',
          },
        }
      : null;

    const seed = this.seedFor(entry, text, outcome.keywords);
    const plan = plans.proposeScript(seed);

    const detail =
      '대본 매칭 — ' + entry.missionId + ' 「' + seed.title + '」 · 맞은 키워드 [' +
      outcome.keywords.join(' · ') + '] · 계획 제안(승인 대기 ' + plan.plan_id + '). 키워드 대조이지 LLM이 아니다';
    this.emitResult(req, commandId, { status: 'completed', reason_code: null, detail });
    commands.recordExternal(req, commandId, 'completed', detail);
    log('발화 매칭 — 「' + text + '」 → ' + entry.missionId + ' [' + outcome.keywords.join(', ') + ']');
    return { clientRequestId: req.client_request_id, commandId, accepted: true, reasonCode: null, message: detail };
  }

  private seedFor(entry: ScriptLibraryEntry, text: string, keywords: string[]) {
    if (entry.script !== null) {
      const zone = this.deps.hub.runtime.get(entry.script.cast[0])?.zone ?? 'zone-503';
      return {
        missionId: entry.missionId,
        title: entry.script.title,
        world: 'registry' as const,
        utteranceText: text,
        matchedKeywords: keywords,
        zone,
        milestones: entry.script.milestones.map((m) => ({ id: m.id, title: m.title })),
      };
    }
    return {
      missionId: entry.missionId,
      title: '415호 → 503호 이동 (구판 세계)',
      world: 'legacy' as const,
      utteranceText: text,
      matchedKeywords: keywords,
      zone: '구판 세계 — registry 연결 없음',
      milestones: this.legacy.milestones.map((m) => ({ id: m.id, title: m.title })),
    };
  }

  private closeScript(req: CommandRequest, commandId: string): SubmitOutcome {
    if (this.playback === null) {
      return this.reject(req, commandId, 'no_active_script', '닫을 대본 재생이 없다');
    }
    const missionId = this.playback.missionId;
    this.stopPlayback('대본 닫기');
    // 닫기는 자리표시 복귀다 — 장치는 평소 랜덤 워크로, 탭⑤는 평소 합성 대상으로 돌아간다.
    this.deps.vision.scriptView = null;
    const detail = '대본 닫기 — ' + missionId + ' 재생 종료 · 장치 평시 복귀';
    this.emitResult(req, commandId, { status: 'completed', reason_code: null, detail });
    this.deps.commands.recordExternal(req, commandId, 'completed', detail);
    return { clientRequestId: req.client_request_id, commandId, accepted: true, reasonCode: null, message: detail };
  }

  private reject(req: CommandRequest, commandId: string, reasonCode: string, detail: string): SubmitOutcome {
    this.emitResult(req, commandId, { status: 'rejected', reason_code: reasonCode, detail });
    this.deps.commands.recordExternal(req, commandId, 'rejected', detail);
    this.deps.log('발화 거부 — ' + detail);
    return { clientRequestId: req.client_request_id, commandId, accepted: false, reasonCode, message: detail };
  }

  /** command_result 발행 — CommandEngine.emitResult 와 같은 봉투 모양. */
  private emitResult(
    req: CommandRequest,
    commandId: string,
    partial: { status: CommandResult['status']; reason_code: string | null; detail: string },
  ): void {
    if (!this.deps.hub.runtime.has(req.entity)) return; // 미등록 대상이면 ACK 만으로 알린다.
    const result: CommandResult = {
      command_id: commandId,
      entity: req.entity,
      action: req.action,
      status: partial.status,
      stage: 'settled',
      progress_pct: null,
      detail: partial.detail,
      reason_code: partial.reason_code,
      expires_at: req.expires_at,
      ts: new Date().toISOString(),
      restored: false,
    };
    this.deps.hub.publish(req.entity, 'command_result', result, { fromDevice: false });
  }

  // ── 재생 ───────────────────────────────────────────────────────────────────

  /** 승인된 대본의 재생. PlanEngine.onScriptApproved 가 부른다 — 승인 전에는 오지 않는다. */
  private startPlayback(plan: Plan): void {
    const info = plan.script;
    if (info === undefined) return;
    this.stopPlayback('재시작');

    const entry = this.library.find((e) => e.missionId === info.mission_id) ?? null;
    const { hub, plans, vision, commands, log } = this.deps;

    const playback: PlaybackState = {
      missionId: info.mission_id,
      planId: plan.plan_id,
      timers: [],
      taskStatus: new Map(),
      coverage: new Map(),
      ended: false,
      preview: false,
    };
    this.playback = playback;
    const at = (sec: number, fn: () => void) => {
      playback.timers.push(setTimeout(fn, Math.max(0, (sec * 1000) / SPEED)));
    };

    if (entry?.script) {
      const script = entry.script;

      // 초기 조건 — 세계의 출발 상태 (예: 3편 수문 열림 100%). 명령 우회가 아니다.
      // 미리보기(previewScript)와 **같은 한 곳**을 지난다 — 두 벌로 적으면 갈라진다.
      this.applyInitial(script);

      // 2편 맵 — 커버리지 초기 스냅샷(전부 빈 칸). 캐시가 마지막 봉투 하나라 전체를 싣는다.
      if (script.map) {
        for (const cell of script.map.blind_cells) playback.coverage.set(cell.id, null);
        this.publishCoverage(script, 0);
      }

      // 탭⑤ — 대본 시야 모드 진입. 시야 밖이면 박스가 없어야 한다.
      if (script.cast.includes(vision.entity)) {
        vision.scriptView = { missionId: script.missionId, visible: [] };
      }

      // 세계 채널 — 장치의 평소 발행 경로로 몰아 준다. 반영은 미리보기와 같은 한 곳이다.
      for (const w of script.worldTimeline ?? []) {
        at(w.atSec, () => this.applyWorldFrame(script, w, playback));
      }

      // 뷰포인트 채널 (260909 §6) — **실제 로봇·탐지 AI 가 낼 채널과 같은 이름·같은 값**이다.
      // 봉투만 여기서 만들고 값은 대본이 든 그대로 나간다. 로봇이 붙는 날 이 for 문이
      // 사라지고 장치가 같은 채널로 내면, 화면은 한 줄도 안 고친다.
      for (const frame of script.viewpointTimeline ?? []) {
        at(frame.atSec, () => {
          hub.publish(
            info.mission_id,
            frame.channel as Channel,
            { ...frame.payload, at_sec: frame.atSec, mock: true },
            { fromDevice: false },
          );
        });
      }

      // 명령 — CommandEngine 을 실제로 통과한다. actor 는 임무이고 사람이 아니다.
      for (const c of script.commands ?? []) {
        at(c.atSec, () => {
          const req: CommandRequest = {
            client_request_id: 'scr-' + Date.now().toString(36) + '-' + c.taskId,
            entity: c.entity,
            action: c.action,
            params: {},
            expires_at: new Date(Date.now() + SCENARIO_TIMING.COMMAND_TTL_MS).toISOString(),
            audit: {
              // 감사의 서버 주입값(khw·operator)을 임무로 덮는다 — 임무가 낸 명령이
              // 사람이 누른 것처럼 남으면 안 된다. input_mode 는 click·voice 가 아니다.
              input_mode: 'api',
              decision_source: 'automatic',
              actor_id: script.missionId,
              actor_display_name: '임무 ' + script.missionId,
              actor_role: 'mission',
              produced_by: c.producedBy,
              task_id: c.taskId,
            },
          };
          const outcome = commands.submit(req);
          log(
            '대본 명령 [' + String(c.atSec) + 's] ' + c.entity + '/' + c.action + ' → ' +
              (outcome.accepted ? '접수 (' + outcome.commandId + ')' : '거부 — ' + outcome.message),
          );
        });
      }
    }

    // 기록 열 — 대본이든 옛 편이든 같은 trace_event 채널로 나간다.
    const events = entry?.script?.events ?? this.legacy.events;
    const tasks = entry?.script?.tasks ?? null;
    const durationSec = entry?.script?.durationSec ?? this.legacy.durationSec;
    const voiceMetrics =
      this.pendingVoice?.missionId === info.mission_id ? this.pendingVoice.metrics : null;

    events.forEach((event, index) => {
      at(event.atSec, () => {
        hub.publish(
          info.mission_id,
          'trace_event',
          {
            layer: 'task',
            node_id: event.nodeId,
            kind: event.kind,
            produced_by: event.producedBy,
            status: event.status,
            attempt: event.attempt ?? 1,
            seq: event.seq,
            at_sec: event.atSec,
            // 평가 근거값·파생 사유 — trace-event.schema 의 payload 자리.
            payload: (event as { payload?: Record<string, unknown> }).payload ?? {},
            ...(('derivedFrom' in event) ? { derived_from: (event as { derivedFrom?: string }).derivedFrom } : {}),
            // 발화 세 수치 — 첫 사건에만. 7.8 미결이라 **잠정 위치**다 (안 ①의 형태).
            ...(index === 0 && voiceMetrics !== null ? { utterance_metrics: voiceMetrics } : {}),
            mock: true,
          },
          { fromDevice: false },
        );
        // 마일스톤 = 태스크 상태를 접은 결과. 계획 구간(=마일스톤)에 되돌려 준다.
        playback.taskStatus.set(event.nodeId, event.status);
        if (tasks !== null) {
          plans.applyScriptMilestones(playback.planId, foldMilestones(tasks, playback.taskStatus));
        }
      });
    });

    at(durationSec, () => {
      playback.ended = true;
      // 끝 — **마지막 상태 유지** (§흐름). 장치마다 평시 발행의 성질이 달라 갈린다:
      //  - 센서: 랜덤 워크가 현재 값에서 이어지므로 풀어도 마지막 값에서 다시 흔들린다.
      //  - 로봇: 평시 발행이 **고정 원 궤도 공식**이라 풀면 마지막 위치를 버리고
      //    옛 궤도로 순간이동한다(is_moving 도 true 로 돌아간다). 그래서 로봇은
      //    「대본 닫기」까지 마지막 구동 값에 얼려 둔다 — 8/31 점검에서 잡힌 결함.
      // 탭⑤의 시야 상태도 「대본 닫기」까지 유지한다(끝났다고 합성 대상이 돌아오면 안 된다).
      this.releaseDevices(entry?.script ?? null, { robots: false });
      log('대본 재생 끝 — ' + info.mission_id + ' (' + String(durationSec) + 's × ' + SPEED + '배속) · 로봇은 마지막 위치 유지');
    });

    log(
      '대본 재생 시작 — ' + info.mission_id + ' · 사건 ' + events.length + '건 · 세계 채널 ' +
        (entry?.script?.worldTimeline?.length ?? 0) + '건 · 명령 ' + (entry?.script?.commands?.length ?? 0) +
        '건 · ' + SPEED + '배속',
    );
  }

  /**
   * 대본의 `initial` — **세계의 출발 상태**를 놓는다 (260901 요구 0-2).
   *
   * 재생(startPlayback)과 정지 미리보기(previewScript)가 **같은 이 한 곳**을 지난다.
   * 미리보기가 이 단계를 건너뛰던 것이 3편의 결함이었다 — 대본은 「열려 있던 수문(100%)을
   * 닫는」 이야기인데 미리보기의 개도율이 평시값 0%(닫힘)로 서서 이야기와 정반대였다.
   *
   * **값을 지어내는 것이 아니다.** `initial` 은 대본이 적어 둔 t=0 세계 그 자체이고,
   * 명령 우회도 아니다 — primeState() 는 수행 중인 대상을 건드리지 않는다.
   */
  private applyInitial(script: ScriptScenario): void {
    const { commands, log } = this.deps;
    for (const [entityId, state] of Object.entries(script.initial ?? {})) {
      const pct = typeof state.position_pct === 'number' ? state.position_pct : null;
      const physical = typeof state.physical_state === 'string' ? state.physical_state : null;
      if (pct !== null && physical !== null) {
        const ok = commands.primeState(entityId, pct, physical);
        log('대본 초기 조건 — ' + entityId + ' ' + physical + ' ' + pct + '%' + (ok ? '' : ' (수행 중이라 거부)'));
      }
    }
  }

  /**
   * `worldTimeline` 한 프레임 반영 — **재생과 미리보기(t=0)가 같은 이 한 곳을 쓴다** (260831 요구 2).
   * 봉투는 대본이 만들지 않는다 — 장치의 `drive()` 로 넣고 장치가 평소 경로로 낸다.
   */
  private applyWorldFrame(script: ScriptScenario, frame: WorldDrive, playback: PlaybackState): void {
    const { fleet, vision } = this.deps;
    const robot = fleet.robots.get(frame.entity);
    if (robot) {
      robot.drive(frame.drive);
      return;
    }
    const sensor = fleet.sensors.get(frame.entity);
    if (sensor) {
      sensor.drive(frame.drive);
      return;
    }
    if (frame.entity === vision.entity) {
      const view = frame.drive.in_view;
      if (Array.isArray(view) && vision.scriptView !== null) {
        vision.scriptView = { missionId: script.missionId, visible: view.map(String) };
      }
      const coverage = frame.drive.coverage;
      if (Array.isArray(coverage)) {
        for (const c of coverage as Array<{ cell: string; last_scan_at_sec: number | null }>) {
          playback.coverage.set(c.cell, c.last_scan_at_sec);
        }
        this.publishCoverage(script, frame.atSec);
      }
    }
  }

  /** 2편 커버리지 — 항상 전체 스냅샷을 발행한다. 재접속 화면이 캐시 한 건으로 복원해야 한다. */
  private publishCoverage(script: ScriptScenario, atSec: number): void {
    if (this.playback === null || script.map === undefined) return;
    this.deps.hub.publish(
      script.map.camera.entity,
      'coverage',
      {
        mission_id: script.missionId,
        at_sec: atSec,
        rescan_threshold_sec: (script.params as { rescan_threshold_sec?: number } | undefined)?.rescan_threshold_sec ?? null,
        cells: [...this.playback.coverage.entries()].map(([id, lastScanAtSec]) => ({
          cell: id,
          last_scan_at_sec: lastScanAtSec,
        })),
      },
      { fromDevice: false },
    );
  }

  /**
   * 장치를 평시 발행으로 되돌린다. 재생 **끝**에서는 `robots: false` 로 부른다 —
   * 로봇의 평시 발행은 고정 궤도라 풀면 마지막 위치가 버려진다(위 at(durationSec) 주석).
   * 닫기·교체(stopPlayback)에서는 전부 되돌린다.
   */
  private releaseDevices(script: ScriptScenario | null, opts: { robots: boolean } = { robots: true }): void {
    if (script === null) return;
    for (const id of script.cast) {
      if (opts.robots) this.deps.fleet.robots.get(id)?.endScript();
      this.deps.fleet.sensors.get(id)?.endScript();
    }
  }

  private stopPlayback(reason: string): void {
    const playback = this.playback;
    if (playback === null) return;
    for (const timer of playback.timers) clearTimeout(timer);
    const entry = this.library.find((e) => e.missionId === playback.missionId) ?? null;
    this.releaseDevices(entry?.script ?? null);
    this.playback = null;
    this.deps.log('대본 재생 중지 — ' + playback.missionId + ' (' + reason + ')');
  }
}

/**
 * 태스크 상태 → 마일스톤 상태 접기.
 * 전부 done → done / 하나라도 failed → failed / 전부 skipped → skipped /
 * 무엇이든 움직였으면 running / 아니면 pending. 정적 status 필드는 쓰지 않는다.
 */
export function foldMilestones(
  tasks: ReadonlyArray<{ id: string; milestone: string }>,
  taskStatus: ReadonlyMap<string, string>,
): Record<string, SegmentStatus> {
  const byMilestone = new Map<string, string[]>();
  for (const task of tasks) {
    const list = byMilestone.get(task.milestone) ?? [];
    list.push(taskStatus.get(task.id) ?? 'pending');
    byMilestone.set(task.milestone, list);
  }
  const folded: Record<string, SegmentStatus> = {};
  for (const [milestone, statuses] of byMilestone) {
    if (statuses.every((s) => s === 'done')) folded[milestone] = 'done';
    else if (statuses.some((s) => s === 'failed' || s === 'not_executed')) folded[milestone] = 'failed';
    else if (statuses.every((s) => s === 'skipped')) folded[milestone] = 'skipped';
    else if (statuses.every((s) => s === 'pending')) folded[milestone] = 'pending';
    else folded[milestone] = 'running';
  }
  return folded;
}
