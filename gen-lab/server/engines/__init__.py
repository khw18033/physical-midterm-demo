"""엔진 로딩 지점 (`REQ-1302`).

새 엔진을 붙일 때 손대는 파일은 여기 하나다. `engines/vllm.py` 를 만들고 아래
`_ENGINE_MODULES` 에 이름 한 줄을 더하면 `/generate/health` 에 자동으로 나타난다.
**교체가 파일 하나**여야 한다는 것이 지시서 §4-1 의 요구다.

임포트 실패를 예외로 터뜨리지 않는 이유: 엔진 하나가 설치 안 됐다고 서비스 전체가
안 뜨면 **꺼짐 규칙이 무너진다** — gen-lab 이 안 뜨는 것과 엔진이 없는 것은 다른 일이고,
화면 쪽에서는 둘 다 「생성 서비스에 닿지 않습니다」로 보여 구별이 안 된다. 대신 실패
사실을 `load_errors()` 로 보관해 health 응답에 실어 보낸다 — **조용히 사라지는 것이
제일 나쁘다** (`stt-lab/server/engines/__init__.py` 와 같은 판단).
"""

from __future__ import annotations

import importlib
import traceback

from .base import (  # noqa: F401  (외부에서 engines.<이름>으로 쓰라고 재수출한다)
    GenerateOptions,
    GenerateOutput,
    GenerationEngine,
    get_engine,
    list_engines,
    register_engine,
)

_ENGINE_MODULES = (
    "server.engines.llama_cpp_server",
    # 다음 엔진은 여기에 한 줄 추가 (예: "server.engines.vllm")
)

_LOAD_ERRORS: list[dict[str, str]] = []


def _load_all() -> None:
    for module_name in _ENGINE_MODULES:
        try:
            importlib.import_module(module_name)
        except Exception as exc:  # 설치 안 된 엔진 하나가 서비스 전체를 막지 않게 한다
            _LOAD_ERRORS.append(
                {
                    "module": module_name,
                    "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc(limit=3),
                }
            )


def load_errors() -> list[dict[str, str]]:
    return list(_LOAD_ERRORS)


def available() -> list[str]:
    """붙어 있는 엔진 이름. 하나도 없으면 빈 목록이고, 그 사실을 숨기지 않는다."""
    return list_engines()


_load_all()
