"""llama.cpp 엔진 — `llama-server` 바이너리를 자식 프로세스로 띄우고 HTTP 로 넘긴다.

**엔진 이름이 나오는 유일한 파일이다.** 라우터도 화면도 이 이름을 모른다 (`REQ-1302`).

## 왜 llama.cpp 인가

3단계가 만든 `viz-debugger/src/generate/gbnf.ts` 가 계약에서 GBNF 를 뽑는다. Ollama 는
GBNF 를 직접 받지 않으므로 그 산출물이 죽는다. **문법 강제 디코딩이 이 작업의 핵심
도구**이고(지시서 §3), 그것을 그대로 받는 쪽으로 간다.

## 왜 in-process(`llama-cpp-python`) 가 아닌가

Windows + CUDA 휠 설치가 까다롭다. 거기서 막히면 「모델이 나쁜 것」과 「설치가 안 된 것」이
섞인다. 바이너리 + HTTP 는 설치가 **압축 해제 하나**이고, 안정되면 그때 in-process 를
판단한다 (지시서 §4-1 이 정한 순서).

## 프로세스를 이 파일이 관리한다

모델 셋을 같은 정답셋으로 재려면 **모델을 갈아 끼워야** 한다. 사람이 매번 손으로
`llama-server` 를 껐다 켜는 절차를 두면 그 절차가 측정의 일부가 되어 재현이 흔들린다.
그래서 이 엔진이 자식 프로세스를 띄우고, 다른 모델을 요구받으면 **내리고 다시 띄운다.**
그것이 곧 12 GB 안에서 STT 와 자리를 나누는 언로드 정책의 실행부다.

## 주소

`llama-server` 는 **8803** 이다. 목 게이트웨이(8790) · 대시보드(5173/5174) · STT(8801) ·
stt-lab(8799) · gen-lab(8802) 과 겹치지 않는다. 이 주소는 gen-lab 안쪽의 사정이라
화면의 「연결 관리」에는 올리지 않는다 — 화면이 아는 생성 주소는 8802 하나다.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Optional

from .base import GenerateOptions, GenerateOutput, register_engine

LAB_ROOT = Path(__file__).resolve().parent.parent.parent

#: 바이너리와 가중치는 **저장소에 올리지 않는다** (`gen-lab/.gitignore`).
#: 12 GB 를 커밋할 수는 없고, 각자 받는 편이 낫다 — 절차는 `gen-lab/README.md` 에 있다.
BIN = Path(os.environ.get("GEN_LAB_LLAMA_BIN", LAB_ROOT / "vendor" / "llama.cpp" / "llama-server.exe"))
MODEL_DIR = Path(os.environ.get("GEN_LAB_MODEL_DIR", LAB_ROOT / "models"))
PORT = int(os.environ.get("GEN_LAB_LLAMA_PORT", "8803"))
NGL = int(os.environ.get("GEN_LAB_NGL", "99"))
#: 컨텍스트 길이. **8192 에서 16384 로 올렸다** (260907 · 10단계).
#:
#: 예시에 태스크가 실리면서 프롬프트가 4,400 → 7,600 토큰이 됐고, 8192 에서는 출력에
#: 567 토큰밖에 안 남아 **15건 전부 중간에 잘렸다.** 스키마 실패 15/15 로 나타났지만
#: 모델이 못 한 것이 아니라 자리가 없었던 것이다 — 그 둘은 다른 실패다.
#:
#: 이 값은 `applied_options.ctx_size` 로 매 건에 기록된다. 8192 로 돈 옛 실행들은
#: 잘리지 않았으므로(프롬프트 4,400 + 출력 2,048 < 8192) 그 숫자는 그대로 쓴다.
CTX = int(os.environ.get("GEN_LAB_CTX", "16384"))
#: 적재가 이보다 오래 걸리면 뭔가 잘못된 것이다. 무한정 기다리면 요청이 매달린다.
BOOT_TIMEOUT_SEC = float(os.environ.get("GEN_LAB_BOOT_TIMEOUT", "300"))
BASE = f"http://127.0.0.1:{PORT}"


def _post(path: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _get(path: str, timeout: float) -> dict[str, Any]:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _vram_used_mib() -> Optional[int]:
    """지금 GPU 가 쓰고 있는 메모리. 못 재면 **`None` 이지 0 이 아니다.**

    `nvidia-smi` 가 없는 기기가 있고, 그때 0 을 적으면 「쟀는데 0」이 된다.
    이 저장소의 다른 자리와 같은 규칙이다.
    """
    exe = shutil.which("nvidia-smi")
    if exe is None:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        )
        return int(out.stdout.strip().splitlines()[0])
    except Exception:
        return None


class LlamaCppServerEngine:
    id = "llama.cpp"

    def __init__(self) -> None:
        self._process: Optional[subprocess.Popen] = None
        self._model: Optional[str] = None
        self._load_sec = 0.0
        self._vram_after_load: Optional[int] = None
        self._vram_before_load: Optional[int] = None
        self._last_error: Optional[str] = None

    # --- 가중치 ------------------------------------------------------------

    def models(self) -> list[dict[str, Any]]:
        """`models/` 에 실제로 있는 파일만. **목록을 코드에 적지 않는다.**

        모델 이름을 코드에 적으면 새 모델을 재는 일이 코드 수정이 되고, 그러면
        「무엇을 쟀는가」가 커밋 사이에 흩어진다.
        """
        if not MODEL_DIR.is_dir():
            return []
        licences = {path.name[: -len(".LICENSE.txt")]: path.name for path in MODEL_DIR.glob("*.LICENSE.txt")}
        found = []
        for path in sorted(MODEL_DIR.glob("*.gguf")):
            found.append({
                "id": path.stem,
                "file": path.name,
                "bytes": path.stat().st_size,
                "loaded": path.stem == self._model,
                # **따로 받아 둔 라이선스 파일이 있는가** (260907 · 9단계).
                #
                # 이름을 코드에 적지 않고 **파일이 있는가**로 판단한다. 이 저장소는
                # 조건이 붙은 가중치에만 라이선스 전문을 함께 받아 두었고(README 의 절차),
                # 그 사실이 곧 「이건 아무 데나 쓰면 안 된다」의 표식이다. 모델 이름으로
                # 가르면 새 모델이 늘 때마다 코드를 고쳐야 하고, 그러면 위 머리말이
                # 지키려는 것이 무너진다.
                #
                # 화면은 이 값으로 기본 선택을 피하고 배지를 붙인다 — 시연·배포 경로가
                # 조건이 붙은 가중치를 **조용히** 물지 않게 하는 것이 목적이다.
                "license_file": next(
                    (name for stem, name in licences.items() if path.stem.startswith(stem) or stem.startswith(path.stem)),
                    None,
                ),
            })
        return found

    def _resolve(self, model: Optional[str]) -> Path:
        available = {item["id"]: MODEL_DIR / item["file"] for item in self.models()}
        if not available:
            raise RuntimeError(
                f"가중치가 하나도 없습니다 ({MODEL_DIR}). gen-lab/README.md 의 절차로 GGUF 를 받으세요."
            )
        if model is None:
            if self._model is not None:
                return available[self._model]
            if len(available) == 1:
                return next(iter(available.values()))
            raise RuntimeError(
                f"모델을 지정해야 합니다 — {sorted(available)} 중 하나. "
                "아무거나 고르면 무엇을 쟀는지 알 수 없습니다."
            )
        if model not in available:
            raise RuntimeError(f"그런 가중치가 없습니다: {model} — 있는 것: {sorted(available)}")
        return available[model]

    # --- 프로세스 ----------------------------------------------------------

    def _served(self) -> Optional[str]:
        """포트에서 지금 **실제로 답하는** 가중치 파일 이름. 안 뜨면 `None`.

        `/health` 만 보면 안 된다 — 260906 에 이것으로 측정이 한 번 통째로 무효가 됐다.
        gen-lab 을 다시 띄우면 앞선 실행이 낳은 `llama-server` 가 **유령으로 남아** 같은
        포트를 잡고 있다. 새 gen-lab 은 자기가 띄운 자식이 없으니 새로 띄우려 하지만,
        `/health` 는 유령이 ok 로 답한다. 그러면 「8B 를 쟀다」고 적힌 표가 실제로는
        **4B 의 답**이 된다 — 실제로 두 모델의 20건이 글자 하나까지 같게 나왔다.
        """
        try:
            return str(_get("/props", timeout=3).get("model_path") or "") or None
        except Exception:
            return None

    def _alive(self, expect: Optional[Path] = None) -> bool:
        """살아 있는가 — **그리고 우리가 물으려는 그 가중치인가.**"""
        try:
            if _get("/health", timeout=2).get("status") != "ok":
                return False
        except Exception:
            return False
        if expect is None:
            return True
        served = self._served()
        return served is not None and Path(served).name == expect.name

    def unload(self) -> None:
        if self._process is not None and self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=30)
        self._process = None
        self._model = None
        self._vram_after_load = None

    def _ensure(self, model: Optional[str]) -> None:
        path = self._resolve(model)
        if self._model == path.stem and self._alive(path):
            return
        # **모델이 바뀌면 내리고 다시 띄운다.** 둘을 동시에 물면 12 GB 를 넘긴다.
        self.unload()

        # 우리가 띄우지 않은 서버가 포트를 잡고 있는가.
        squatter = self._served()
        if squatter is not None:
            if Path(squatter).name == path.name:
                # 원하는 가중치를 이미 물고 있다 — **받아 쓴다.** 다시 띄울 이유가 없고,
                # 띄우려 해도 포트가 막혀 있어 조용히 그쪽으로 붙게 된다(그것이 위험하다).
                self._model = path.stem
                self._load_sec = 0.0
                self._vram_before_load = None
                self._vram_after_load = None
                return
            # 다른 가중치다. **여기서 멈춘다** — 그냥 띄우면 포트를 못 잡고 유령에게
            # 물어보게 되어, 표에는 이 모델 이름이 적히고 답은 저 모델이 낸 것이 된다.
            raise RuntimeError(
                f"포트 {PORT} 를 다른 가중치의 llama-server 가 잡고 있습니다 "
                f"(그쪽: {Path(squatter).name} · 요청: {path.name}). "
                "앞선 gen-lab 이 남긴 유령입니다 — 그 프로세스를 끄고 다시 부르세요. "
                "그대로 두고 재면 모델 이름과 답이 어긋난 표가 나옵니다."
            )

        if not BIN.is_file():
            raise RuntimeError(
                f"llama-server 바이너리가 없습니다 ({BIN}). gen-lab/README.md 의 절차로 받으세요 — "
                "이 서비스는 바이너리를 저장소에 두지 않습니다."
            )
        self._vram_before_load = _vram_used_mib()
        started = time.perf_counter()
        self._process = subprocess.Popen(
            [
                str(BIN),
                "--model", str(path),
                "--port", str(PORT), "--host", "127.0.0.1",
                "--n-gpu-layers", str(NGL),
                "--ctx-size", str(CTX),
                # 병렬 슬롯 하나. 베이스라인은 한 건씩 재는 것이라 슬롯을 늘리면
                # KV 캐시만 나눠 가져 컨텍스트가 줄어든다.
                "--parallel", "1",
                "--no-webui",
            ],
            cwd=str(BIN.parent),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
        )
        deadline = time.perf_counter() + BOOT_TIMEOUT_SEC
        while time.perf_counter() < deadline:
            code = self._process.poll()
            if code is not None:
                tail = (self._process.stdout.read() if self._process.stdout else "")[-2000:]
                self._process = None
                raise RuntimeError(f"llama-server 가 뜨지 못하고 종료했습니다 (exit={code}).\n{tail}")
            if self._alive(path):
                self._model = path.stem
                self._load_sec = time.perf_counter() - started
                self._vram_after_load = _vram_used_mib()
                return
            time.sleep(0.5)
        self.unload()
        raise RuntimeError(f"llama-server 가 {BOOT_TIMEOUT_SEC}초 안에 뜨지 않았습니다 ({path.name})")

    # --- 면 ----------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        before, after = self._vram_before_load, self._vram_after_load
        return {
            "engine": self.id,
            "binary": str(BIN),
            "binary_present": BIN.is_file(),
            "model_dir": str(MODEL_DIR),
            "loaded_model": self._model,
            # **포트에서 실제로 답하는 가중치.** loaded_model 은 우리가 띄웠다고 믿는 것이고
            # 이쪽은 물어본 것이다. 둘이 다르면 그 사실이 바로 보여야 한다.
            "serving_model": (Path(self._served()).name if self._served() else None),
            "alive": self._alive(),
            "load_sec": round(self._load_sec, 3) if self._model else None,
            # 실측이다. 못 재면 null 이다.
            "vram_used_mib": _vram_used_mib(),
            "vram_model_mib": (after - before) if (before is not None and after is not None) else None,
            "ctx_size": CTX,
            "n_gpu_layers": NGL,
            "last_error": self._last_error,
        }

    def _templated(self, prompt: str, system: Optional[str]) -> tuple[str, bool]:
        """모델 자신의 대화 틀을 씌운다.

        `llama-server` 의 `/apply-template` 가 **그 GGUF 안에 든 틀**을 그대로 적용한다.
        틀을 우리가 손으로 적으면 모델마다 다른 특수 토큰을 우리가 관리하게 되고, 그 순간
        「모델이 나쁜 것」과 「틀을 잘못 씌운 것」이 섞인다 — 모델 비교가 무의미해진다.

        틀이 없는 모델(순수 base)도 있으므로 실패하면 **날 프롬프트로 내려가고 그 사실을
        응답에 남긴다.** 조용히 다른 것을 재지 않는다.
        """
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": prompt}
        ]
        try:
            return _post("/apply-template", {"messages": messages}, timeout=30)["prompt"], True
        except Exception:
            return (f"{system}\n\n" if system else "") + prompt, False

    def generate(self, prompt: str, options: GenerateOptions) -> GenerateOutput:
        self._ensure(options.model)
        templated, template_applied = self._templated(prompt, options.system)
        body: dict[str, Any] = {
            "prompt": templated,
            "n_predict": options.max_tokens,
            "temperature": options.temperature,
            "seed": options.seed,
            "cache_prompt": True,
            # 모델이 스스로 멈추지 못하고 뒤에 말을 더 붙이는 것을 막는다. 문법이 걸려
            # 있으면 문법이 끝나는 자리에서 멈추므로 이 목록은 문법 없는 대조군용이다.
            "stop": ["\n\n\n"],
        }
        if options.grammar:
            body["grammar"] = options.grammar
        started = time.perf_counter()
        try:
            result = _post("/completion", body, timeout=600)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:800]
            self._last_error = detail
            # **문법이 거절당한 것을 조용히 넘기지 않는다.** 여기서 문법을 떼고 다시
            # 부르면 강제 디코딩 없이 돈 결과가 강제 디코딩 결과로 기록된다.
            raise RuntimeError(f"llama-server 가 요청을 거절했습니다 (HTTP {error.code}): {detail}") from error
        elapsed = time.perf_counter() - started
        timings = result.get("timings") or {}
        load_sec, self._load_sec = self._load_sec, 0.0  # 적재 시간은 그 요청에만 실린다
        return GenerateOutput(
            text=result.get("content", ""),
            engine=self.id,
            model=self._model or "?",
            elapsed_sec=round(elapsed, 3),
            load_sec=round(load_sec, 3),
            prompt_tokens=int(result.get("tokens_evaluated") or timings.get("prompt_n") or 0),
            completion_tokens=int(result.get("tokens_predicted") or timings.get("predicted_n") or 0),
            # 요청했다고 참이 되지 않는다 — 문법을 실제로 보냈고 서버가 거절하지 않았을 때만.
            grammar_enforced=bool(options.grammar),
            stop_reason=str(result.get("stop_type") or ("eos" if result.get("stopped_eos") else "")),
            applied_options={
                "temperature": options.temperature,
                "seed": options.seed,
                "n_predict": options.max_tokens,
                "ctx_size": CTX,
                "n_gpu_layers": NGL,
            },
            extra={
                "vram_used_mib": _vram_used_mib(),
                "vram_model_mib": (
                    self._vram_after_load - self._vram_before_load
                    if self._vram_after_load is not None and self._vram_before_load is not None
                    else None
                ),
                # 그 요청에 **실제로 답한** 파일. 기록이 모델 이름을 지어낼 수 없게 한다.
                "served_model_file": (Path(self._served()).name if self._served() else None),
                "predicted_per_sec": timings.get("predicted_per_second"),
                "prompt_per_sec": timings.get("prompt_per_second"),
                "truncated": result.get("truncated"),
                # 모델의 대화 틀을 씌웠는가. 못 씌웠으면 그 사실이 여기 남는다.
                "chat_template_applied": template_applied,
            },
        )


register_engine(LlamaCppServerEngine())
