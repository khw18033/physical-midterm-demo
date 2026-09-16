// 관제 웹 → 로봇 제어 명령 (MQTT over WebSocket + protobuf)
//
//   npm i mqtt protobufjs
//
// 상태(JSON)와 달리 명령 경로는 protobuf 다. 토픽에는 **방향만** 담기고
// 메시지 종류는 봉투의 oneof body 가 정한다.
//
//   terminal/<device>/downlink   상위 → 로봇 (command / cancel_request)
//   terminal/<device>/uplink     로봇 → 상위 (acceptance / status / result / capability)
//
// 구동 브리지(go1-sdk)는 **평시에 내려가 있다.** 기동하는 순간 로봇이 일어서기
// 때문이다. 이동 명령(turn/moveForward/scan)은 필요하면 스스로 브리지를 띄우고,
// 그 사이에 진행 보고로 sdk_starting → sdk_ready 가 온다. 미리 준비시키거나
// 자동 기동을 끄고 싶으면 sdkStart / sdkStop / sdkAuto 를 쓴다.
//
// 응답 흐름은 **수락 1건 → 진행 n건 → 종료 1건**이다.
// 거부되면 종료가 아예 오지 않으므로, 종료만 기다리면 화면이 영원히 걸린다.
// 아래 run() 은 거부·중단·시한초과를 전부 reject 로 바꿔 그 함정을 막는다.

import mqtt from "mqtt"
import protobuf from "protobufjs"

const PROTO = `
syntax = "proto3";
package physical;
message PhysicalCommandEnvelope {
  oneof body {
    Command command = 1;
    CancelCommandRequest cancel_request = 2;
    CommandAcceptance acceptance = 3;
    CommandStatus status = 4;
    CommandResult result = 5;
    CancelCommandResponse cancel_response = 6;
    Capability capability = 7;
  }
}
message Command {
  string command_id = 1;
  string target = 2;
  string action = 3;
  map<string, double> parameters = 4;
  int64 deadline_unix_ms = 5;
}
message CancelCommandRequest { string command_id = 1; }
message Rejection { string code = 1; string message = 2; }
message Failure   { string code = 1; string message = 2; }
message CommandAcceptance {
  string command_id = 1; bool accepted = 2; Rejection rejection = 3;
}
message CommandStatus { string command_id = 1; string state = 2; string detail = 3; }
message CommandResult {
  string command_id = 1;
  TerminalStatus status = 2;
  map<string, double> result = 3;
  Failure failure = 4;
}
message CancelCommandResponse { string command_id = 1; bool accepted = 2; }
message Capability { string device_id = 1; repeated string actions = 2; }
enum TerminalStatus {
  TERMINAL_STATUS_UNSPECIFIED = 0;
  SUCCEEDED = 1;
  ABORTED = 2;
  CANCELED = 3;
}
`

const Envelope = protobuf.parse(PROTO).root.lookupType("physical.PhysicalCommandEnvelope")
const TERMINAL = { 0: "UNSPECIFIED", 1: "SUCCEEDED", 2: "ABORTED", 3: "CANCELED" }

/** 수락 거부. **아무것도 실행되지 않았다** — 재시도해도 안전하다. */
export class CommandRejected extends Error {
  constructor(action, code, message) {
    super(`${action} 거부: ${code} ${message}`)
    this.name = "CommandRejected"
    Object.assign(this, { action, code, detail: message })
  }
}

/** 실행에 들어갔다가 중단·취소됐다. 로봇이 움직였을 수 있다. */
export class CommandFailed extends Error {
  constructor(action, status, code, message) {
    super(`${action} ${status}: ${code ?? ""} ${message ?? ""}`.trim())
    this.name = "CommandFailed"
    Object.assign(this, { action, status, code, detail: message })
  }
}

/** 시한 안에 종료 보고가 오지 않았다. 로봇이 아직 돌고 있을 수 있다 — abort 를 고려할 것. */
export class CommandTimeout extends Error {
  constructor(action, ms) {
    super(`${action} 응답 없음 (${ms}ms)`)
    this.name = "CommandTimeout"
    Object.assign(this, { action, ms })
  }
}

export function createRobotControl({
  broker = "ws://pi7.local:9001/mqtt",
  device = "go1-001",
  // ({commandId, action, detail}) — 임무 진행 ACK.
  // detail.event 가 "sdk_starting" 이면 **로봇이 지금 일어서는 중**이다.
  // 이어서 "sdk_ready" 가 오고 그 뒤에야 실제 이동이 시작된다.
  onProgress = () => {},
  onCapability = () => {},      // (actions[]) — 노드 접속 시 1회. retain 이 아니라 놓칠 수 있다
  onLink = () => {},            // (connected: bool) — 브라우저↔브로커 구간
} = {}) {
  const client = mqtt.connect(broker, {
    clientId: "web-cmd-" + Math.random().toString(16).slice(2, 8),
    protocolVersion: 5,
    reconnectPeriod: 2000,
  })

  const inflight = new Map()    // command_id -> {action, resolve, reject, timer, statuses}
  let n = 0

  // 구독이 **확정된 뒤에야** 준비 완료로 본다. subscribe 를 걸어 놓고 곧바로 명령을
  // 보내면 SUBACK 이 오기 전에 로봇의 수락 응답이 지나가 첫 명령만 시한초과가 난다
  // (실측: 연결 직후 첫 ping 이 항상 실패하고 두 번째부터 성공).
  let ready = null                        // 구독 완료를 기다리는 Promise
  let markReady
  const resetReady = () => { ready = new Promise((r) => { markReady = r }) }
  resetReady()

  client.on("connect", () => {
    client.subscribe(`terminal/${device}/uplink`, { qos: 1 }, (err) => {
      if (err) return                     // 재접속이 다시 시도한다
      markReady()
      onLink(true)
    })
  })
  client.on("close", () => { resetReady(); onLink(false) })

  client.on("message", (_topic, payload) => {
    let env
    try { env = Envelope.decode(payload) } catch { return }

    switch (env.body) {
      case "capability":
        onCapability(env.capability.actions)
        break

      case "acceptance": {
        const a = env.acceptance
        const p = inflight.get(a.commandId)
        if (!p || a.accepted) break
        // 거부에는 결과가 따라오지 않는다. 여기서 끝내야 한다.
        finish(a.commandId)
        p.reject(new CommandRejected(p.action, a.rejection.code, a.rejection.message))
        break
      }

      case "status": {
        const s = env.status
        let detail = s.detail
        try { detail = JSON.parse(s.detail) } catch {}   // 임무 진행은 JSON, 단계명은 문자열
        const p = inflight.get(s.commandId)
        if (p) p.statuses.push(detail)
        onProgress({ commandId: s.commandId, action: p?.action, detail })
        break
      }

      case "result": {
        const r = env.result
        const p = inflight.get(r.commandId)
        if (!p) break
        finish(r.commandId)
        const status = TERMINAL[r.status]
        if (status === "SUCCEEDED") {
          p.resolve({ commandId: r.commandId, result: { ...r.result }, statuses: p.statuses })
        } else {
          p.reject(new CommandFailed(p.action, status, r.failure?.code, r.failure?.message))
        }
        break
      }
    }
  })

  function finish(commandId) {
    const p = inflight.get(commandId)
    if (p) clearTimeout(p.timer)
    inflight.delete(commandId)
  }

  function publish(env) {
    client.publish(`terminal/${device}/downlink`, Envelope.encode(env).finish(), { qos: 1 })
  }

  /**
   * 명령 1건. 종료 보고까지 기다리는 Promise 를 돌려준다.
   * parameters 는 **숫자만** 실린다 — 규약이 map<string,double> 이라 문자열을 못 담는다.
   */
  function run(action, parameters = {}, timeoutMs = 30000) {
    for (const [k, v] of Object.entries(parameters)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return Promise.reject(new TypeError(`${action}.${k} 는 숫자여야 한다 (받은 값: ${v})`))
      }
    }
    // 새로고침해도 안 겹치는 id. 겹치면 로봇이 재실행하지 않고 옛 응답만 돌려준다.
    const commandId = `web-${Date.now().toString(36)}-${++n}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(commandId)
        reject(new CommandTimeout(action, timeoutMs))
      }, timeoutMs)
      inflight.set(commandId, { action, resolve, reject, timer, statuses: [] })
      // 구독이 확정된 뒤에 보낸다 — 그 전에 보내면 응답을 놓친다.
      ready.then(() => publish(Envelope.create({
        command: { commandId, target: "", action, parameters, deadlineUnixMs: 0 },
      })))
    })
  }

  return {
    // ---------- 로봇이 움직이지 않는 것 ----------
    ping: () => run("ping", {}, 10000),
    diag: () => run("diag", {}, 10000),

    // ---------- 기본 제어 (로봇이 움직인다) ----------

    /** 제자리 회전. **오른쪽이 +** 다. 5~360도. 다 돌면 그 방향에 그대로 선다. */
    turn: (deg) => run("turn", { deg }, 45000),

    /** 직진. distance_m 0.05~10, vx 0.05~0.30(생략 시 기본값). */
    moveForward: (distance_m, vx) =>
      run("move_forward",
          vx == null ? { distance_m } : { distance_m, vx },
          Math.max(30000, (distance_m / (vx || 0.15)) * 4000 + 20000)),

    /** 문 탐색 스캔. 오른쪽으로 step_deg 씩 steps 번 돈 뒤 문 방향 1회, 그리고 직진. */
    scan: ({ steps = 8, step_deg = 45, forward_m = 1.0, vx } = {}) =>
      run("scan_mission",
          vx == null ? { steps, step_deg, forward_m } : { steps, step_deg, forward_m, vx },
          // 노드의 시한 산정과 같은 식으로 잡는다. 짧으면 정상 임무를 실패로 만든다.
          ((steps + 1) * 19 + forward_m / (vx || 0.15) * 4 + 19) * 1000),

    // ---------- 구동 브리지 (온디맨드) ----------

    /**
     * 브리지를 띄운다. **로봇이 일어선다.** 기립해서 상태가 올라올 때까지 기다린다.
     * 이동 명령이 알아서 띄우므로 필수는 아니다 — 임무 전에 미리 세워 두고 싶을 때 쓴다.
     */
    sdkStart: () => run("sdk_start", {}, 40000),

    /** 브리지를 내린다. 구동을 먼저 멈추고 내린다. 로봇은 **선 채로** 남는다. */
    sdkStop: () => run("sdk_stop", {}, 30000),

    /**
     * 이동 명령이 왔을 때 브리지를 자동으로 띄울지 (true/false).
     * 끄면 브리지가 없을 때 이동 명령이 `go1_sdk_not_running` 으로 거부된다 —
     * "로봇이 스스로 일어서는 일이 절대 없게" 하고 싶을 때 끈다.
     */
    sdkAuto: (on) => run("sdk_auto", { on: on ? 1 : 0 }, 10000),

    // ---------- 임무 중단 ----------

    /** 진행 중인 임무만 접는다. */
    abortMission: () => run("abort_mission", {}, 15000),

    /**
     * **무엇이 돌고 있든 멈춘다.** 다른 쪽(Unity·촬영 도구)이 흘리는 텔레옵까지 끊는다.
     * 통신 경로의 정지이지 비상정지가 아니다 — 통신이 끊긴 상황에서는 닿지 않는다.
     */
    abort: () => run("abort", {}, 15000),

    /** 특정 명령 하나만 취소. run() 이 돌려준 commandId 가 필요하다. */
    cancel: (commandId) => publish(Envelope.create({ cancelRequest: { commandId } })),

    /** 어휘에 없는 것을 직접 부를 때. 파라미터는 숫자만. */
    raw: run,

    close: () => client.end(),
  }
}
