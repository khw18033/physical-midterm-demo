# 이식: stt-lab/server/engines/faster_whisper.py @ 6552346 — 무수정
# 원본을 고치지 말 것. 이 파일도 고치지 말 것.
# verify:stt-port 가 이 머리 주석을 뺀 나머지의 바이트 동일성을 검사한다.
"""faster-whisper 구현체 — 현재 유일한 엔진.

CTranslate2 런타임을 쓰므로 PyTorch가 필요 없다. 의존성에 torch가 끌려 들어왔다면
엔진을 잘못 잡은 것이다.

이 파일에만 있어야 하는 것: Whisper 고유의 파라미터 이름, CUDA/cuDNN 폴백 처리,
모델 캐시. 이것들이 라우터나 화면으로 새어 나가면 두 번째 엔진을 붙일 때 전부 다시 짜야 한다.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Optional

from faster_whisper import WhisperModel

from .base import TranscribeOptions, TranscribeResult, register_engine

# 드롭다운에 그대로 나가는 목록. 기본은 large-v3-turbo — 정확도 대비 속도가 가장 실용적이다.
AVAILABLE_MODELS = ("tiny", "base", "small", "medium", "large-v3", "large-v3-turbo")
DEFAULT_MODEL = "large-v3-turbo"

# Whisper 내부 판정 임계. 기본값을 그대로 쓰되 응답에 실어 보낸다.
# REQ-1306 임계값을 정할 때 "그때 엔진이 어떤 문턱으로 걸렀는지"를 모르면
# 측정한 avg_logprob 분포를 해석할 수 없다.
NO_SPEECH_THRESHOLD = 0.6
COMPRESSION_RATIO_THRESHOLD = 2.4
LOG_PROB_THRESHOLD = -1.0


def _download_root() -> Optional[str]:
    """모델 캐시 경로. 지정이 없으면 HuggingFace 기본 캐시(HF_HOME 포함)에 맡긴다."""
    return os.environ.get("STT_LAB_MODEL_DIR") or None


def _detect_device() -> tuple[str, str, Optional[str]]:
    """(device, compute_type, 사유) — CUDA가 잡히면 float16, 아니면 CPU int8.

    torch 없이 판정해야 하므로 CTranslate2에게 직접 묻는다. 여기서 CUDA가 잡혀도
    실제 로드는 cuDNN 미설치로 실패할 수 있어서, 진짜 폴백은 `_load()` 에서 한 번 더 한다.
    """
    forced = os.environ.get("STT_LAB_DEVICE")
    if forced:
        compute = os.environ.get(
            "STT_LAB_COMPUTE_TYPE", "float16" if forced == "cuda" else "int8"
        )
        return forced, compute, f"STT_LAB_DEVICE={forced} 로 강제 지정됨"

    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16", None
        return "cpu", "int8", "CUDA 장치가 잡히지 않음 (ctranslate2.get_cuda_device_count() == 0)"
    except Exception as exc:
        return "cpu", "int8", f"CUDA 판정 실패: {type(exc).__name__}: {exc}"


class FasterWhisperEngine:
    engine_id = "faster-whisper"
    display_name = "faster-whisper (CTranslate2)"

    def __init__(self) -> None:
        self._device, self._compute_type, self._device_note = _detect_device()
        self._fallback_reason: Optional[str] = None
        # 모델은 프로세스 수명 동안 캐시한다. 같은 모델을 매 요청마다 다시 로드하면
        # 로드 시간이 추론 시간에 섞여 RTF 측정이 무의미해진다.
        self._models: dict[tuple[str, str, str], WhisperModel] = {}
        self._load_secs: dict[tuple[str, str, str], float] = {}
        # 폴백은 잠금 안(_load)과 밖(transcribe) 양쪽에서 불린다. 재진입 가능해야 한다.
        self._lock = threading.RLock()

    # --- 계약 구현 -----------------------------------------------------------

    def available_models(self) -> list[str]:
        return list(AVAILABLE_MODELS)

    def default_model(self) -> str:
        return DEFAULT_MODEL

    def runtime_info(self) -> dict[str, Any]:
        return {
            "engine": self.engine_id,
            "display_name": self.display_name,
            "device": self._device,
            "compute_type": self._compute_type,
            "device_note": self._device_note,
            "fallback_reason": self._fallback_reason,
            "loaded_models": sorted({name for name, _, _ in self._models}),
            "model_dir": _download_root() or "(HuggingFace 기본 캐시)",
            "thresholds": {
                "no_speech_threshold": NO_SPEECH_THRESHOLD,
                "compression_ratio_threshold": COMPRESSION_RATIO_THRESHOLD,
                "log_prob_threshold": LOG_PROB_THRESHOLD,
            },
        }

    def transcribe(self, audio_path: str, options: TranscribeOptions) -> TranscribeResult:
        """CUDA가 죽으면 CPU로 한 번 다시 시도한다.

        폴백을 여기에도 두는 이유: Windows에서 cuBLAS/cuDNN이 없으면 `WhisperModel(...)`
        생성자는 멀쩡히 성공하고, **첫 추론에서** `Library cublas64_12.dll is not found`
        로 터진다. 로드 시점만 감싸면 이 흔한 실패를 못 잡는다.
        """
        try:
            return self._run(audio_path, options)
        except Exception as exc:
            if self._device != "cuda":
                raise
            self._demote_to_cpu(f"추론 중 CUDA 실패: {type(exc).__name__}: {exc}")
            return self._run(audio_path, options)

    def _run(self, audio_path: str, options: TranscribeOptions) -> TranscribeResult:
        model, load_sec = self._load(options.model)

        kwargs: dict[str, Any] = {
            # 자동 감지를 쓰면 1~3초짜리 명령 발화에서 언어를 틀리게 잡는다. 고정한다.
            "language": options.language,
            "beam_size": options.beam_size,
            # 스칼라를 주면 Whisper의 temperature fallback 사다리가 꺼진다.
            # 재현 가능한 비교가 목적이므로 이쪽이 맞다.
            "temperature": options.temperature,
            "vad_filter": options.vad_filter,
            "word_timestamps": True,
            # 짧은 발화 반복 환각의 주된 원인. 이 하네스에서는 끄는 것이 기본이고
            # 토글로 노출하지도 않는다 — 켜고 비교할 값이 아니다.
            "condition_on_previous_text": False,
            "no_speech_threshold": NO_SPEECH_THRESHOLD,
            "compression_ratio_threshold": COMPRESSION_RATIO_THRESHOLD,
            "log_prob_threshold": LOG_PROB_THRESHOLD,
        }
        if options.initial_prompt:
            kwargs["initial_prompt"] = options.initial_prompt
        if options.hotwords:
            kwargs["hotwords"] = options.hotwords

        started = time.perf_counter()
        segment_iter, info = model.transcribe(audio_path, **kwargs)
        # transcribe()는 제너레이터를 돌려준다. 실제 추론은 이 list()에서 일어나므로
        # 계측 구간이 여기를 감싸야 한다.
        raw_segments = list(segment_iter)
        elapsed = time.perf_counter() - started

        segments: list[dict[str, Any]] = []
        words: list[dict[str, Any]] = []
        for idx, seg in enumerate(raw_segments):
            segments.append(
                {
                    "index": idx,
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "text": seg.text.strip(),
                    "avg_logprob": seg.avg_logprob,
                    "no_speech_prob": seg.no_speech_prob,
                    "compression_ratio": seg.compression_ratio,
                }
            )
            for word in seg.words or []:
                words.append(
                    {
                        "segment": idx,
                        "start": round(word.start, 3),
                        "end": round(word.end, 3),
                        "word": word.word,
                        "probability": word.probability,
                    }
                )

        return TranscribeResult(
            text=" ".join(s["text"] for s in segments).strip(),
            segments=segments,
            words=words,
            duration_sec=float(info.duration),
            elapsed_sec=elapsed,
            load_sec=load_sec,
            engine=self.engine_id,
            model=options.model,
            device=self._device,
            compute_type=self._compute_type,
            applied_options={
                "language": options.language,
                "beam_size": options.beam_size,
                "temperature": options.temperature,
                "vad_filter": options.vad_filter,
                "word_timestamps": True,
                "condition_on_previous_text": False,
                "hotwords": options.hotwords or None,
                "initial_prompt": options.initial_prompt or None,
                "no_speech_threshold": NO_SPEECH_THRESHOLD,
                "compression_ratio_threshold": COMPRESSION_RATIO_THRESHOLD,
                "log_prob_threshold": LOG_PROB_THRESHOLD,
            },
            extra={
                # VAD를 켰을 때 실제로 얼마나 잘려 나갔는지. 무음 구간 환각을 볼 때 필요하다.
                "duration_after_vad_sec": float(
                    getattr(info, "duration_after_vad", info.duration)
                ),
                "language_probability": float(getattr(info, "language_probability", 0.0)),
                "detected_language": getattr(info, "language", options.language),
                "fallback_reason": self._fallback_reason,
            },
        )

    # --- 내부 -----------------------------------------------------------------

    def _load(self, model_name: str) -> tuple[WhisperModel, float]:
        """모델을 캐시에서 꺼내거나 로드한다. 캐시가 맞으면 로드 시간은 0이다."""
        with self._lock:
            key = (model_name, self._device, self._compute_type)
            if key in self._models:
                return self._models[key], 0.0

            try:
                model, load_sec = self._build(model_name, self._device, self._compute_type)
            except Exception as exc:
                if self._device != "cuda":
                    raise
                self._demote_to_cpu(f"모델 로드 중 CUDA 실패: {type(exc).__name__}: {exc}")
                key = (model_name, self._device, self._compute_type)
                model, load_sec = self._build(model_name, self._device, self._compute_type)

            self._models[key] = model
            self._load_secs[key] = load_sec
            return model, load_sec

    def _demote_to_cpu(self, reason: str) -> None:
        """CUDA를 포기하고 CPU int8로 내려간다. 에러를 내지 않되 사실은 화면까지 전달한다.

        캐시에 남은 cuda 모델은 버린다 — 못 쓰는 모델이 VRAM만 잡고 있고,
        `loaded_models` 배지도 거짓말을 하게 된다.
        """
        with self._lock:
            self._fallback_reason = f"{reason} → CPU int8 폴백"
            self._device, self._compute_type = "cpu", "int8"
            for key in [k for k in self._models if k[1] == "cuda"]:
                self._models.pop(key, None)
                self._load_secs.pop(key, None)

    @staticmethod
    def _build(model_name: str, device: str, compute_type: str) -> tuple[WhisperModel, float]:
        started = time.perf_counter()
        model = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
            download_root=_download_root(),
        )
        return model, time.perf_counter() - started


register_engine(FasterWhisperEngine())
