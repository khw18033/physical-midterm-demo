# 이식: stt-lab/server/engines/__init__.py @ 6552346 — 무수정
# 원본을 고치지 말 것. 이 파일도 고치지 말 것.
# verify:stt-port 가 이 머리 주석을 뺀 나머지의 바이트 동일성을 검사한다.
"""엔진 로딩 지점 (REQ-1302).

새 엔진을 붙일 때 손대는 파일은 여기 하나다. `engines/rtzr.py` 를 만들고
아래 `_ENGINE_MODULES` 에 이름 한 줄을 더하면 `/api/models` 와 화면 드롭다운에
자동으로 나타난다.

임포트 실패를 예외로 터뜨리지 않는 이유: 엔진 하나가 설치 안 됐다고 하네스 전체가
안 뜨면 다른 엔진으로 비교할 수가 없다. 대신 실패 사실을 `load_errors()` 로 보관해
`/api/models` 응답에 실어 보낸다 — 조용히 사라지는 것이 제일 나쁘다.
"""

from __future__ import annotations

import importlib
import traceback

from .base import (  # noqa: F401  (외부에서 engines.<이름>으로 쓰라고 재수출한다)
    SttEngine,
    TranscribeOptions,
    TranscribeResult,
    get_engine,
    list_engines,
    register_engine,
)

_ENGINE_MODULES = (
    "server.engines.faster_whisper",
    # 다음 엔진은 여기에 한 줄 추가 (예: "server.engines.rtzr")
)

_LOAD_ERRORS: list[dict[str, str]] = []


def _load_all() -> None:
    for module_name in _ENGINE_MODULES:
        try:
            importlib.import_module(module_name)
        except Exception as exc:  # 설치 안 된 엔진 하나가 전체를 막지 않게 한다
            _LOAD_ERRORS.append(
                {
                    "module": module_name,
                    "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc(limit=3),
                }
            )


def load_errors() -> list[dict[str, str]]:
    return list(_LOAD_ERRORS)


_load_all()
