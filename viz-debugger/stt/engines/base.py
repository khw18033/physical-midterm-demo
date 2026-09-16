# 이식: stt-lab/server/engines/base.py @ 6552346 — 무수정
# 원본을 고치지 말 것. 이 파일도 고치지 말 것.
# verify:stt-port 가 이 머리 주석을 뺀 나머지의 바이트 동일성을 검사한다.
"""STT 엔진 추상화 (REQ-1302).

엔진 구현체는 이 파일의 `SttEngine` 프로토콜만 만족하면 되고, 라우터(`server/main.py`)와
화면(`web/index.html`)은 어떤 구현체가 붙어 있는지 모른다. `if engine == "faster-whisper"`
같은 분기문이 라우터나 UI에 나타나면 추상화가 깨진 것이다 — 그 분기는 반드시
`engines/` 안쪽, 구현체 파일 하나에만 있어야 한다.

엔진마다 옵션 이름이 다를 것이므로(`hotwords`가 없는 엔진도 있다) 옵션은
'가시화가 요구하는 의미'로 정의해 두고, 자기 엔진의 파라미터로 옮기는 일은
각 구현체가 한다. 지원하지 않는 옵션은 무시하되 `applied_options`에서 빼서
"요청했지만 안 먹었다"는 사실이 응답에 드러나게 한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol, runtime_checkable


@dataclass
class TranscribeOptions:
    """전사 요청 한 건의 설정. 화면에서 조절 가능한 값만 여기 있다."""

    model: str
    language: str = "ko"
    # hotwords 와 initial_prompt 는 다른 것이다. 전자는 특정 어휘로 디코딩을 편향시키고
    # 후자는 전체 문맥·문체를 유도한다. 한 입력란으로 합치지 않는다.
    hotwords: Optional[str] = None
    initial_prompt: Optional[str] = None
    vad_filter: bool = True
    beam_size: int = 5
    temperature: float = 0.0


@dataclass
class TranscribeResult:
    """전사 결과 한 건.

    `segments`·`words`는 원본 수치를 그대로 담는다. Whisper 계열은 깔끔한 confidence를
    주지 않으므로, REQ-1306의 임계값은 `avg_logprob`·`no_speech_prob`·단어 `probability`
    세 수치를 실측해서 정해야 한다. 그래서 이 세 값은 요약하지 않고 원본으로 올려보낸다.
    """

    text: str
    segments: list[dict[str, Any]]
    words: list[dict[str, Any]]
    duration_sec: float
    elapsed_sec: float
    # 모델 로드 시간은 추론 시간과 분리한다. 합치면 첫 요청의 RTF만 크게 나와
    # 모델 간 비교가 무의미해진다.
    load_sec: float
    engine: str
    model: str
    device: str
    compute_type: str
    applied_options: dict[str, Any] = field(default_factory=dict)
    # VAD가 실제로 얼마나 잘라냈는지 등 엔진이 부수적으로 알려주는 값.
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def rtf(self) -> float:
        """Real-Time Factor. 1보다 작으면 실시간보다 빠르다."""
        if self.duration_sec <= 0:
            return 0.0
        return self.elapsed_sec / self.duration_sec

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "segments": self.segments,
            "words": self.words,
            "duration_sec": self.duration_sec,
            "elapsed_sec": self.elapsed_sec,
            "load_sec": self.load_sec,
            "rtf": self.rtf,
            "engine": self.engine,
            "model": self.model,
            "device": self.device,
            "compute_type": self.compute_type,
            "applied_options": self.applied_options,
            "extra": self.extra,
        }


@runtime_checkable
class SttEngine(Protocol):
    """엔진 구현체가 만족해야 하는 계약."""

    engine_id: str
    display_name: str

    def available_models(self) -> list[str]:
        """이 엔진이 받아들이는 모델 식별자 목록. 화면 드롭다운이 이걸 그린다."""
        ...

    def default_model(self) -> str:
        ...

    def runtime_info(self) -> dict[str, Any]:
        """현재 device/compute_type과 폴백 여부. 화면 배지가 이걸 그린다."""
        ...

    def transcribe(self, audio_path: str, options: TranscribeOptions) -> TranscribeResult:
        ...


# --- 엔진 레지스트리 -----------------------------------------------------------
# 새 엔진을 붙이는 절차는 "engines/ 에 파일 하나 추가 + _ENGINE_MODULES 에 한 줄"이다.
# 이 두 곳 말고 다른 파일을 고쳐야 한다면 추상화가 부족한 것이다.

_ENGINES: dict[str, SttEngine] = {}


def register_engine(engine: SttEngine) -> None:
    _ENGINES[engine.engine_id] = engine


def get_engine(engine_id: Optional[str] = None) -> SttEngine:
    if not _ENGINES:
        raise RuntimeError("등록된 STT 엔진이 없다. server/engines/__init__.py 의 로드 오류를 확인할 것.")
    if engine_id is None:
        return next(iter(_ENGINES.values()))
    if engine_id not in _ENGINES:
        raise KeyError(f"알 수 없는 엔진: {engine_id} (등록됨: {', '.join(_ENGINES)})")
    return _ENGINES[engine_id]


def list_engines() -> list[SttEngine]:
    return list(_ENGINES.values())
