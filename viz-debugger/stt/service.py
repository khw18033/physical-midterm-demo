"""viz-debugger STT 서비스 — 엔드포인트 하나 (VZ-L-01 / REQ-1301~1306).

stt-lab 의 실험용 라우팅 8개(`/api/score`·`/api/runs`·`/api/presets`·CSV·정적 서빙 …)를
가져오지 않는다. 그것들은 모델 비교 하네스의 일이고, 이 프로세스는 **가시화 화면이
발화 한 건을 인식하는 데 필요한 것만** 갖는다.

  POST /stt/transcribe   오디오 한 건 → 텍스트 + 원본 수치 + audio_ref

엔진 이름이 이 파일에 나오면 안 된다 (REQ-1302). 엔진은 `engines/` 뒤에 있고
여기서는 `get_engine()` 이 준 것을 그대로 쓴다.

실행: `python -m uvicorn service:app --port 8801`  또는 `python service.py`
"""

from __future__ import annotations

import os
import shutil
import sys
import time
import traceback
import types
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

STT_DIR = Path(__file__).resolve().parent
# uvicorn 을 다른 폴더에서 띄워도 옆 모듈을 찾을 수 있게 한다.
if str(STT_DIR) not in sys.path:
    sys.path.insert(0, str(STT_DIR))

import vocab  # noqa: E402

RECORDINGS_DIR = Path(os.environ.get("VIZ_STT_RECORDINGS") or (STT_DIR / "recordings"))
PORT = int(os.environ.get("VIZ_STT_PORT", "8801"))

# 브라우저에서 직접 부른다. 개발 서버(5174)와 포트가 다르므로 출처를 열어 둔다.
# 127.0.0.1 바인딩이라 이 목록 밖에서는 애초에 닿지 않는다.
ALLOWED_ORIGINS = [
    "http://127.0.0.1:5174",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
]

ALLOWED_SUFFIXES = {".wav", ".mp3", ".m4a", ".webm", ".ogg", ".flac", ".mp4"}


def _install_engines() -> Any:
    """이식본 `engines/__init__.py` 를 **무수정으로 두기 위한** 이름 공간 연결.

    stt-lab 의 `engines/__init__.py` 는 구현체를 `server.engines.faster_whisper` 라는
    절대 경로로 import 한다. 여기에는 `server` 패키지가 없으므로 그대로 두면 로드가
    실패하는데, 그 실패는 예외로 터지지 않고 `load_errors()` 에 담겨 조용히 "엔진 없음"이 된다.

    **파일을 고치는 대신 이름을 맞춰 준다.** `server` 라는 껍데기 모듈의 `__path__` 를
    이 폴더로 두면 `server.engines` 가 곧 `stt/engines/` 가 되고, 이식본을 한 글자도
    고치지 않은 채(=verify:stt-port 통과) 등록이 정상 동작한다.

    `engines` 가 아니라 `server.engines` 로 import 하는 것이 중요하다. 두 이름으로
    각각 import 하면 모듈이 두 벌 생겨 `register_engine()` 이 다른 사전에 등록된다.
    """
    shim = types.ModuleType("server")
    shim.__path__ = [str(STT_DIR)]  # type: ignore[attr-defined]
    sys.modules.setdefault("server", shim)
    import server.engines as engines_pkg  # noqa: E402

    return engines_pkg


engines = _install_engines()
TranscribeOptions = engines.TranscribeOptions

RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="viz-debugger stt", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


def _store_audio(audio: UploadFile) -> str:
    """녹음을 보관하고 `audio_ref` 를 돌려준다.

    `contracts/mission.schema.json` 의 `utterance.audio_ref` 가 요구한다. 오디오를 버리면
    오인식을 나중에 다시 들어볼 수 없고, `VZ-L-03` 임계값 실측의 원자료도 사라진다.
    """
    suffix = Path(audio.filename or "").suffix.lower() or ".webm"
    if suffix not in ALLOWED_SUFFIXES:
        suffix = ".webm"
    name = "{}-{}{}".format(time.strftime("%Y%m%dT%H%M%S"), uuid.uuid4().hex[:6], suffix)
    path = RECORDINGS_DIR / name
    with path.open("wb") as fp:
        shutil.copyfileobj(audio.file, fp)
    return "recordings/{}".format(name)


def _numbers(result: Dict[str, Any]) -> Dict[str, Any]:
    """임계 판정의 근거가 될 세 수치.

    **하나로 뭉치지 않는다.** Whisper 는 단일 confidence 를 주지 않으므로 셋을 각각
    들고 다닌다. 임의 가중합을 만들면 `VZ-L-03` 임계를 실측할 근거가 사라진다.

    세그먼트가 여럿일 때의 대표값은 **불리한 쪽**으로 고른다 — `avg_logprob` 은 최소,
    `no_speech_prob` 은 최대. 평균을 내면 한 구간의 오인식이 나머지에 묻힌다.
    원본 세그먼트·단어 배열도 그대로 함께 내보내므로 화면에서 분포를 다시 볼 수 있다.
    """
    segments: List[Dict[str, Any]] = result["segments"]
    words: List[Dict[str, Any]] = result["words"]
    probs = [w["probability"] for w in words if w.get("probability") is not None]
    return {
        "avg_logprob": min((s["avg_logprob"] for s in segments), default=None),
        "no_speech_prob": max((s["no_speech_prob"] for s in segments), default=None),
        "mean_word_prob": (sum(probs) / len(probs)) if probs else None,
        "min_word_prob": min(probs, default=None),
        "word_count": len(probs),
        "segment_count": len(segments),
    }


@app.post("/stt/transcribe")
def transcribe(
    audio: UploadFile = File(...),
    engine_id: Optional[str] = Form(default=None),
    model: Optional[str] = Form(default=None),
    language: str = Form(default="ko"),
    use_hotwords: bool = Form(default=True),
    vad_filter: bool = Form(default=True),
) -> Any:
    try:
        engine = engines.get_engine(engine_id)
    except (RuntimeError, KeyError) as exc:
        return JSONResponse(
            status_code=503,
            content={"error": "{}: {}".format(type(exc).__name__, exc), "load_errors": engines.load_errors()},
        )

    audio_ref = _store_audio(audio)
    audio_path = STT_DIR / audio_ref

    # hotwords 는 registry 원본에서 매번 새로 뽑는다. 화면이 보내온 문자열을 믿으면
    # 레지스트리가 바뀌었을 때 조용히 옛 어휘로 인식하게 된다. 그래서 요청은
    # **켬/끔 플래그만** 받는다 (REQ-305).
    hotwords = None
    hotword_count = 0
    registry_version = None
    vocab_error = None
    if use_hotwords:
        try:
            terms = vocab.vocabulary()
            hotwords = terms["hotwords"]
            hotword_count = terms["count"]
            registry_version = terms["registry_version"]
        except FileNotFoundError as exc:
            # 어휘를 못 읽었다고 인식을 막지 않는다. 대신 안 먹었다는 사실을 응답에 남긴다.
            vocab_error = str(exc)

    options = TranscribeOptions(
        model=model or engine.default_model(),
        language=language,
        hotwords=hotwords,
        initial_prompt=None,
        vad_filter=vad_filter,
    )

    try:
        result = engine.transcribe(str(audio_path), options).to_dict()
    except Exception as exc:
        # 모델 다운로드 실패·오디오 디코딩 실패가 여기로 온다. 원문을 그대로 보여준다.
        return JSONResponse(
            status_code=500,
            content={
                "error": "{}: {}".format(type(exc).__name__, exc),
                "traceback": traceback.format_exc(limit=6),
                "audio_ref": audio_ref,
            },
        )

    applied = dict(result["applied_options"])
    # "요청했지만 안 먹은 옵션"이 응답에 드러나야 한다 — engines/base.py 의 규칙.
    applied["hotword_count"] = hotword_count
    applied["registry_version"] = registry_version
    applied["use_hotwords_requested"] = use_hotwords
    if vocab_error:
        applied["hotwords_error"] = vocab_error

    return {
        "audio_ref": audio_ref,
        "text": result["text"],
        "segments": result["segments"],
        "words": result["words"],
        "engine": result["engine"],
        "model": result["model"],
        "device": result["device"],
        "compute_type": result["compute_type"],
        "duration_sec": result["duration_sec"],
        "elapsed_sec": result["elapsed_sec"],
        "load_sec": result["load_sec"],
        "rtf": result["rtf"],
        "applied_options": applied,
        "extra": result["extra"],
        **_numbers(result),
    }


def main() -> None:
    import uvicorn

    print("viz-debugger stt  →  http://127.0.0.1:{}/stt/transcribe".format(PORT))
    print("registry          →  {}".format(vocab.registry_path()))
    print("recordings        →  {}".format(RECORDINGS_DIR))
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
