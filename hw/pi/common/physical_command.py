# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 물리 명령 통신 규약 서버 (Interface Specification 준수)
========================================================================
받은 통신 규약을 그대로 구현한 명령 경로 정본이다(구 JSON 4단계 엔진은 폐기).

  전송   MQTT 5 / payload = PhysicalCommandEnvelope(protobuf) 직렬화 바이트
  토픽   terminal/<device-id>/downlink (엣지→장치, 구독)
         terminal/<device-id>/uplink   (장치→엣지, 발행)
         — 토픽에는 방향만, 종류는 봉투 oneof 가 결정한다(§2)
  생사   MQTT LWT (봉투에 넣지 않는다, §2) — 연결 계층에서 등록
  메시지 Command / CancelCommandRequest (수신)
         CommandAcceptance / CommandStatus / CommandResult /
         CancelCommandResponse / Capability (발신)

반드시 지키는 행동 규칙(§5) — 형식이 아니라 **결과**로 보장한다:
  ① 같은 command_id 재수신: 물리 동작 재실행 안 함, 이전 응답 그대로 재송신.
     같은 id 인데 내용(target/action/parameters)이 다르면 ALREADY_EXISTS 거부.
  ② deadline 지난 명령: 시작하지 않고 FAILED_PRECONDITION 거부.
  ③ 취소 우선: 취소 수락 후에는 마침 성공했어도 CommandResult=CANCELED.
  ④ 미선언 action: execute 로직 전에 UNIMPLEMENTED 거부.
  §7 E-stop: 이 경로와 독립(장치 자체 안전장치) — 여기서 구현하지 않는다.

## 장치 로직 어댑터

명령 어휘·수행은 owner 가 제공한다(기존 노드와 동일 인터페이스):
  owner.ACTIONS         {action: handler}  — handler(owner, params) 는 (stage, detail) 제너레이터
  owner.PHYSICAL_ACTIONS 물리 동작 action 집합(선택)
  owner.validate(action, params)   수행 불가면 CommandError(code, message)
  owner.cancel(command_id)         (선택) 취소 시 실제 정지 유도
"""
import hashlib
import threading
import time

from common import physical_command_pb2 as pb

PB = pb.PhysicalCommandEnvelope
TS = pb.TerminalStatus


# gRPC 상태 코드(규약이 요구하는 어휘). 코드 없이 사유만 던진 raise 를
# 봉투로 번역할 때 "이게 코드인가 메시지인가"를 이 집합으로 가른다.
GRPC_CODES = frozenset({
    "OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED",
    "NOT_FOUND", "ALREADY_EXISTS", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED",
    "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE", "UNIMPLEMENTED",
    "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED",
})


class CommandError(Exception):
    """수행 불가. 규약 코드는 gRPC 관례를 쓴다.

    두 가지 호출을 모두 받는다:
      CommandError("FAILED_PRECONDITION", "battery too low")  # 코드+메시지(권장)
      CommandError("battery_too_low")                          # 사유만 - 코드는 기본값
    사유만 준 경우 그 문자열을 메시지로 삼고 코드는 FAILED_PRECONDITION 으로 둔다
    (규약상 "지금은 수행 불가"의 일반 코드). 단, 사유 자리에 gRPC 코드 문자열이
    오면 그대로 코드로 인식한다."""

    def __init__(self, code, message=None):
        if message is None and code not in GRPC_CODES:
            message, code = code, "FAILED_PRECONDITION"
        self.code = code
        self.message = message or ""
        super().__init__(f"{self.code}: {self.message}")


def _err(e, default_code):
    """예외에서 (code, message) 를 뽑는다. code(str) 속성이 있으면 그대로 —
    노드가 CommandError("사유")처럼 코드 없이 던져도 안전하게 다룬다."""
    code = getattr(e, "code", None)
    if not isinstance(code, str):
        code = default_code
    msg = getattr(e, "message", None)
    if not isinstance(msg, str) or not msg:
        msg = str(e)
    return code, msg


class PhysicalCommandServer:
    def __init__(self, client, device_id, owner, log=print, publish=None, subscribe=None):
        self.client = client
        self.device_id = device_id
        self.owner = owner
        self.log = log
        # publish(topic, payload_bytes, qos)/subscribe(topic, qos) — 없으면 client 사용.
        # 재접속으로 client 가 갈릴 수 있으므로 노드는 항상 어댑터를 넘긴다.
        self._publish = publish or (lambda t, p, qos: client.publish(t, p, qos=qos))
        self._subscribe = subscribe or (lambda t, qos: client.subscribe(t, qos=qos))
        self.downlink = f"terminal/{device_id}/downlink"
        self.uplink = f"terminal/{device_id}/uplink"
        self.seen = {}          # command_id -> {sig, acceptance(bytes), result(bytes|None), canceled}
        self._lock = threading.Lock()

    # ---------- 생애주기 ----------
    def start(self):
        """downlink 구독 + Capability 발행. LWT 는 연결 계층에서 이미 등록됐다고 본다."""
        self._subscribe(self.downlink, 1)
        self.publish_capability()
        self.log(f"[규약] downlink 구독 {self.downlink}, Capability 발행")

    def publish_capability(self):
        env = PB()
        env.capability.device_id = self.device_id
        env.capability.actions.extend(sorted(self.owner.ACTIONS.keys()))
        self._send(env)

    # ---------- 송신 ----------
    def _send(self, env):
        self._publish(self.uplink, env.SerializeToString(), 1)

    def _send_bytes(self, payload):
        self._publish(self.uplink, payload, 1)

    def _acceptance(self, cid, accepted, code=None, msg=None):
        env = PB()
        a = env.acceptance
        a.command_id = cid
        a.accepted = accepted
        if not accepted:
            a.rejection.code = code or ""
            a.rejection.message = msg or ""
        return env

    def _send_status(self, cid, state, detail=""):
        env = PB()
        env.status.command_id = cid
        env.status.state = state
        env.status.detail = str(detail) if detail else ""
        self._send(env)

    def _send_result(self, cid, status, result=None, fcode=None, fmsg=None):
        env = PB()
        r = env.result
        r.command_id = cid
        r.status = status
        if result and isinstance(result, dict):
            for k, v in result.items():
                try:
                    r.result[k] = float(v)
                except (TypeError, ValueError):
                    pass                       # double 로 못 넣는 값은 생략(규약 result 는 map<string,double>)
        if status == TS.ABORTED:
            r.failure.code = fcode or "INTERNAL"
            r.failure.message = fmsg or ""
        with self._lock:
            e = self.seen.get(cid)
            if e is not None:
                e["result"] = env.SerializeToString()
        self._send(env)

    # ---------- 수신 ----------
    def on_message(self, payload):
        env = PB()
        try:
            env.ParseFromString(payload)
        except Exception as ex:
            self.log(f"[규약] 봉투 파싱 실패: {ex}")
            return
        which = env.WhichOneof("body")
        if which == "command":
            self._on_command(env.command)
        elif which == "cancel_request":
            self._on_cancel(env.cancel_request)
        # acceptance/status/result/... 는 장치가 받을 일이 없다(uplink 전용) — 무시

    @staticmethod
    def _sig(cmd):
        params = tuple(sorted((k, cmd.parameters[k]) for k in cmd.parameters))
        return (cmd.target, cmd.action, params)

    def _on_command(self, cmd):
        cid = cmd.command_id
        if not cid:
            self._send(self._acceptance("", False, "INVALID_ARGUMENT", "missing command_id"))
            return

        # ── §5-1 멱등 ──
        with self._lock:
            prev = self.seen.get(cid)
        if prev is not None:
            if prev["sig"] != self._sig(cmd):
                # 같은 id, 다른 내용 → ALREADY_EXISTS
                self._send(self._acceptance(cid, False, "ALREADY_EXISTS",
                                            "command_id reused with different content"))
                self.log(f"[규약] {cid} ALREADY_EXISTS (내용 불일치)")
                return
            # 같은 내용 → 물리 동작 재실행 없이 이전 응답 그대로 재송신
            self._send_bytes(prev["acceptance"])
            if prev["result"] is not None:
                self._send_bytes(prev["result"])
            self.log(f"[규약] {cid} 중복 — 이전 응답 재송신(재실행 없음)")
            return

        # ── §5-2 deadline ──
        if cmd.deadline_unix_ms and time.time() * 1000.0 > cmd.deadline_unix_ms:
            self._send(self._acceptance(cid, False, "FAILED_PRECONDITION", "deadline passed"))
            self.log(f"[규약] {cid} 거부 FAILED_PRECONDITION (deadline)")
            return

        # ── §5-4 미선언 action ──
        if cmd.action not in self.owner.ACTIONS:
            self._send(self._acceptance(cid, False, "UNIMPLEMENTED", "action not supported"))
            self.log(f"[규약] {cid} 거부 UNIMPLEMENTED ({cmd.action})")
            return

        # ── 검증(거부는 여기서 사유와 함께) ──
        params = dict(cmd.parameters)
        try:
            self.owner.validate(cmd.action, params)
        except Exception as e:
            code, msg = _err(e, "INVALID_ARGUMENT")
            self._send(self._acceptance(cid, False, code, msg))
            self.log(f"[규약] {cid} 거부 {code}")
            return

        # ── 수락 ──
        acc = self._acceptance(cid, True)
        entry = {"sig": self._sig(cmd), "acceptance": acc.SerializeToString(),
                 "result": None, "canceled": False}
        with self._lock:
            self.seen[cid] = entry
            while len(self.seen) > 500:
                self.seen.pop(next(iter(self.seen)))
        self._send(acc)
        self.log(f"[규약] {cid} 수락 → {cmd.action}")
        threading.Thread(target=self._execute, args=(cmd, entry), daemon=True).start()

    def _execute(self, cmd, entry):
        cid = cmd.command_id
        params = dict(cmd.parameters)
        self._send_status(cid, "EXECUTING")
        last_detail = None
        try:
            for stage, detail in self.owner.ACTIONS[cmd.action](self.owner, params):
                last_detail = detail
                # 종료 stage 는 CommandResult 로만 보낸다(§4). 나머지는 CommandStatus.
                if stage not in ("completed", "done", "succeeded"):
                    self._send_status(cid, "EXECUTING", stage)
            # 정상 종료 — 단 §5-3 취소 우선
            with self._lock:
                canceled = entry["canceled"]
            if canceled:
                self._send_result(cid, TS.CANCELED)
                self.log(f"[규약] {cid} 완료됐으나 취소 우선 → CANCELED")
            else:
                res = last_detail if isinstance(last_detail, dict) else None
                self._send_result(cid, TS.SUCCEEDED, result=res)
                self.log(f"[규약] {cid} SUCCEEDED")
        except Exception as e:
            with self._lock:
                canceled = entry["canceled"]
            if canceled:
                self._send_result(cid, TS.CANCELED)
                return
            has_code = isinstance(getattr(e, "code", None), str)
            code, msg = _err(e, "INTERNAL")
            self._send_result(cid, TS.ABORTED, fcode=code, fmsg=msg)
            self.log(f"[규약] {cid} ABORTED ({code})" if has_code
                     else f"[규약] {cid} ABORTED (내부오류)")

    def _on_cancel(self, req):
        cid = req.command_id
        env = PB()
        env.cancel_response.command_id = cid
        with self._lock:
            e = self.seen.get(cid)
            # 진행 중(수락됐고 아직 결과 없음)일 때만 취소 절차 진입 수락
            accept = bool(e is not None and e["result"] is None)
            if e is not None:
                e["canceled"] = True          # §5-3 이후 성공해도 CANCELED
        env.cancel_response.accepted = accept
        self._send(env)
        self.log(f"[규약] {cid} 취소요청 → accepted={accept}")
        # 실제 정지 유도(선택 훅). CommandResult=CANCELED 는 handler 종료 시 _execute 가 보고.
        if accept and hasattr(self.owner, "cancel"):
            try:
                self.owner.cancel(cid)
            except Exception:
                pass
