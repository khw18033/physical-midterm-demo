"""생성 엔진 추상화 (`REQ-1302`).

구현체는 이 파일의 `GenerationEngine` 프로토콜만 만족하면 되고, 라우터(`server/main.py`)는
어떤 구현체가 붙어 있는지 모른다. **`if engine == "llama.cpp"` 같은 분기가 라우터에 나타나면
추상화가 깨진 것이다** — 그 분기는 `engines/` 안쪽, 구현체 파일 하나에만 있어야 한다.
`stt-lab/server/engines/base.py` 와 같은 규칙이고, 같은 이유다: 엔진을 바꾸는 일이
**파일 하나를 더하는 일**이어야 한다.

## 엔진은 문자열을 낸다 — JSON 을 파싱하지 않는다

파싱과 계약 검증은 라우터가 한다. 엔진마다 파싱을 따로 하면 「스키마를 통과했는가」의
기준이 엔진마다 달라지고, 그러면 **모델 비교의 첫 축이 무의미해진다**(지시서 §4 의 네 축).

## 옵션은 「가시화가 요구하는 의미」로 적는다

엔진마다 파라미터 이름이 다르다. 자기 엔진의 이름으로 옮기는 일은 구현체가 하고,
지원하지 않는 옵션은 **무시하되 `applied_options` 에서 빼서** 「요청했지만 안 먹었다」가
응답에 드러나게 한다 (`stt-lab` 의 규칙 그대로).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable


@dataclass
class GenerateOptions:
    """생성 한 건의 설정."""

    #: 어느 가중치인가. `None` 이면 엔진이 이미 물고 있는 것을 쓴다.
    model: Optional[str] = None
    #: 역할 지시. **대화 틀(chat template)을 씌우는 일은 구현체가 한다** — 모델마다 틀이
    #: 다르고, 라우터가 그것을 알면 「어떤 모델인가」가 라우터로 새어 나온다.
    system: Optional[str] = None
    #: **계약에서 뽑은 GBNF.** `None` 이면 강제 디코딩 없이 돈다 — 그것이 대조군이다
    #: (「강제 디코딩이 실제로 듣는가」는 안 걸었을 때와 비교해야 답이 된다).
    grammar: Optional[str] = None
    max_tokens: int = 2048
    #: 0 이 기본이다. 베이스라인은 **재현되어야** 하고, 온도가 있으면 같은 입력이 다른
    #: 결과를 내서 「모델이 나쁜 것」과 「운이 나빴던 것」을 가를 수 없다.
    temperature: float = 0.0
    seed: int = 0


@dataclass
class GenerateOutput:
    """생성 한 건의 결과. **요약하지 않는다** — 라우터가 파싱하고 검증한다."""

    text: str
    engine: str
    model: str
    #: 추론 시간. **모델 적재 시간과 분리한다** — 합치면 첫 요청만 크게 나와
    #: 모델 간 비교가 무의미해진다 (`stt-lab` 이 같은 이유로 나눠 둔 자리).
    elapsed_sec: float
    load_sec: float = 0.0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    #: 문법을 **실제로** 강제했는가. 요청했다고 참이 되면 안 된다.
    grammar_enforced: bool = False
    #: 왜 멈췄는가 (`stop` · `length` 등). 잘려서 JSON 이 깨진 것과 모델이 틀린 것은 다르다.
    stop_reason: str = ""
    applied_options: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "engine": self.engine,
            "model": self.model,
            "elapsed_sec": self.elapsed_sec,
            "load_sec": self.load_sec,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "grammar_enforced": self.grammar_enforced,
            "stop_reason": self.stop_reason,
            "applied_options": self.applied_options,
            "extra": self.extra,
        }


@runtime_checkable
class GenerationEngine(Protocol):
    """구현체가 만족해야 하는 것 전부."""

    id: str

    def models(self) -> list[dict[str, Any]]:
        """이 엔진이 지금 쓸 수 있는 가중치. 없으면 빈 목록 — **지어내지 않는다.**"""

    def status(self) -> dict[str, Any]:
        """무엇이 떠 있는가. 화면과 `/generate/health` 가 그대로 적는다."""

    def generate(self, prompt: str, options: GenerateOptions) -> GenerateOutput:
        """문자열 하나 → 문자열 하나. 실패는 **던진다** — 조용히 빈 문자열을 내지 않는다."""

    def unload(self) -> None:
        """가중치를 내린다. VRAM 을 STT 와 나눠 쓰는 배치에서 필요하다."""


_REGISTRY: dict[str, GenerationEngine] = {}


def register_engine(engine: GenerationEngine) -> None:
    _REGISTRY[engine.id] = engine


def list_engines() -> list[str]:
    return sorted(_REGISTRY)


def get_engine(engine_id: Optional[str]) -> Optional[GenerationEngine]:
    """이름 없이 부르면 **하나뿐일 때만** 그것을 준다.

    둘 이상 붙어 있는데 이름 없이 부르면 `None` 이다 — 아무거나 골라 주면 응답의
    `model` 이 무엇을 잰 것인지 알 수 없게 된다.
    """
    if engine_id is not None:
        return _REGISTRY.get(engine_id)
    if len(_REGISTRY) == 1:
        return next(iter(_REGISTRY.values()))
    return None
