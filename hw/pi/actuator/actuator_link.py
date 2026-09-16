"""
피지컬팀 mk2 — 액추에이터 제어기 링크 (HW-A-01 / HW-A-02)
==========================================================
수문·차수벽·펌프 제어기와 제어노드 사이의 링크를 추상화한다. 실물이 미정이므로
인터페이스만 고정하고 구현체를 갈아끼운다(로봇의 ControllerLink 와 같은 방식).

**상태는 5종을 구분할 수 있어야 한다** (HW-A-01):

  idle      대기            — 명령을 받을 수 있는 정상 상태
  moving    동작 중          — 구동 중. 진행률을 20Hz로 보고한다(HW-A-04)
  done      동작 완료        — 목표 상태에 실제로 도달함
  error     오류            — 구동 실패·기계적 이상
  unknown   상태 확인 불가   — 피드백 자체가 오지 않는다

**`unknown` 이 따로 있는 이유**가 이 파일의 핵심이다. "닫혀 있다"와 "닫혔는지 모른다"를
같은 값으로 뭉치면, 피드백 선이 끊긴 수문을 시스템이 '닫힘'으로 오인한다. 재난 대응에서
이 오인은 사람을 위험에 빠뜨린다. 그래서 확인되지 않은 것은 확인되지 않았다고 말한다.
"""
import os
import time
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass

from common import config

IDLE, MOVING, DONE, ERROR, UNKNOWN = "idle", "moving", "done", "error", "unknown"


@dataclass
class ActuatorState:
    state: str                # 위 5종
    position: str             # open | close | up | down | on | off | unknown
    progress: float           # 0.0~1.0 — 동작 중 진행률 (HW-A-04)
    feedback_ok: bool         # 피드백 센서가 살아 있는가
    detail: str = ""

    def as_dict(self):
        return asdict(self)


class ActuatorLink(ABC):
    @abstractmethod
    def read_state(self) -> ActuatorState:
        """제어기·피드백 센서에서 현재 상태를 읽는다 (HW-A-01, 20Hz)."""

    @abstractmethod
    def command(self, device: str, target: str) -> None:
        """물리 제어 명령을 대상 액추에이터에 전달한다 (HW-A-02)."""

    @abstractmethod
    def safe_state(self) -> None:
        """사전 정의된 안전 상태로 만든다 (HW-A-05). 통신 두절·오류 시 호출."""


class SimActuator(ActuatorLink):
    """실물 없이 4단계 승격·안전 잠금·상태 5종 구분을 검증하기 위한 구현체.

    수문 하나를 흉내낸다. 구동에 시간이 걸리고, 피드백으로 목표 도달을 확인한다.
    `FEEDBACK_LOSS_FLAG` 파일을 만들면 피드백이 끊긴 상태가 되어 `unknown` 경로가
    실제로 코드에서 다뤄지는지 확인할 수 있다."""

    TRAVEL_S = 3.0            # 완전 개방/폐쇄에 걸리는 시간

    def __init__(self):
        self.position = "close"     # 안전 상태 = 닫힘
        self.target = None
        self.t_start = 0.0
        self.state = IDLE
        self.feedback_ok = True
        self.detail = ""

    def read_state(self):
        # 시연·시험용 주입구. 실물 결선 후에는 실제 피드백 센서 상태로 대체된다.
        self.feedback_ok = not os.path.exists(config.FEEDBACK_LOSS_FLAG)
        now = time.time()
        if self.state == MOVING:
            elapsed = now - self.t_start
            progress = min(1.0, elapsed / self.TRAVEL_S)
            if progress >= 1.0:
                self.position = self.target
                self.state = DONE
                self.detail = "목표 위치 도달"
                progress = 1.0
            return ActuatorState(self.state, self.position, round(progress, 3),
                                 self.feedback_ok, self.detail)

        if not self.feedback_ok:
            # 피드백이 없으면 위치를 안다고 말하면 안 된다.
            return ActuatorState(UNKNOWN, "unknown", 0.0, False, "피드백 없음")
        return ActuatorState(self.state, self.position, 0.0, True, self.detail)

    def command(self, device, target):
        if not self.feedback_ok:
            raise RuntimeError("피드백 없음 — 구동 금지")
        if target == self.position:
            self.state = DONE
            self.detail = "이미 목표 위치"
            return
        self.target = target
        self.t_start = time.time()
        self.state = MOVING
        self.detail = f"{self.position} -> {target}"

    def safe_state(self):
        """수문은 닫힘이 안전 상태다. 실제 설비의 안전 상태는 도메인이 정한다."""
        self.target = "close"
        self.t_start = time.time()
        self.state = MOVING
        self.detail = "안전 상태로 복귀"


def create(kind="sim"):
    if kind == "sim":
        return SimActuator()
    raise NotImplementedError(
        f"ActuatorLink '{kind}' 미구현 — 액추에이터 실물 확보 후 추가")
