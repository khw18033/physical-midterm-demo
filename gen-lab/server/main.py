"""gen-lab 서버 — 생성 서비스.

`stt-lab` 과 같은 모양의 FastAPI 다. npm·Vite·node_modules 가 없고, 실행은
`python -m server.main` (gen-lab/ 에서), 포트는 8802 다 — 목 게이트웨이(8790)·
대시보드(5173/8787~8788)·STT(8801)·stt-lab(8799) 과 겹치지 않는다.

## 엔진이 없어도 뜬다 — 스텁으로 내려간다

엔진(`engines/`)이 붙어 있고 가중치가 있으면 그것으로 낸다. 없으면 **계약을 만족하는
최소 임무**를 돌려주는 스텁으로 내려가고, 그 사실을 `extra.stub` 과 `/generate/health`
가 그대로 적는다. **목임을 감추지 않는다** (`renderMode` 의 목 배지와 같은 규칙).

스텁의 고정 응답은 **정답셋을 베껴 오지 않는다.** 정답을 돌려주면 채점기가 만점을 내고,
그 만점이 「스텁이라서」인지 「모델이 잘해서」인지 구별되지 않는다.

## 이 파일에 엔진 이름이 나오면 안 된다 (`REQ-1302`)

엔진을 더하는 일은 `engines/` 에 파일 하나를 더하고 그 폴더의 `__init__` 에 한 줄을
적는 일이다 (`stt-lab/server/main.py` 와 같은 규칙). 라우터는 어느 엔진이 붙었는지
모르고, 무엇이 붙었는지는 `engines.list_engines()` 가 말한다.

## 문법을 여기서 다시 뽑지 않는다 — 계약으로 **결과**를 검증한다

3단계는 「엔진이 붙으면 서비스도 같은 계약에서 문법을 다시 뽑아 클라이언트가 보낸 지문과
대조해야 한다」를 숙제로 남겼다. **하지 않기로 했다.** 파이썬으로 GBNF 변환기를 한 벌 더
쓰는 일이고, 그 순간 `gbnf.ts` 와 조용히 갈라지는 두 번째 구현이 생긴다 — 이 저장소가
계속 피해 온 실패가 문법에서 재현된다.

대신 **결과를 계약으로 검증한다.** 느슨한 문법이 들어오면 계약 밖 출력이 나오고, 그것은
`schema_errors` 에 그대로 잡힌다. 「강제 디코딩이 실제로 듣는가」를 재는 축이 바로 그
숫자이므로, 검사하려던 것이 측정값 자체가 된다. 문법 지문은 기록에만 남긴다.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import engines, prompt as prompt_builder
from .engines import GenerateOptions

LAB_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = LAB_ROOT.parent
CONTRACTS_DIR = REPO_ROOT / "contracts"
GOLDSET_DIR = LAB_ROOT / "goldset"
PORT = int(os.environ.get("VIZ_GENERATE_PORT", "8802"))

# 브라우저에서 직접 부른다. 개발 서버(5174)와 포트가 다르므로 출처를 열어 둔다.
# 127.0.0.1 바인딩이라 이 목록 밖에서는 애초에 닿지 않는다.
ALLOWED_ORIGINS = [
    "http://127.0.0.1:5174",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
]

app = FastAPI(title="gen-lab", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- 계약 ------------------------------------------------------------------


def _load_contracts() -> Dict[str, Any]:
    """`contracts/` 를 통째로 읽어 `$id` 로 찾을 수 있게 한다.

    **복사본을 두지 않는다.** 계약을 gen-lab 안에 베껴 두면 저장소가 계속 피해 온
    「두 벌이 조용히 갈라진다」가 그대로 난다. 저장소 루트의 원본을 읽는다.
    """
    by_id: Dict[str, Any] = {}
    for path in sorted(CONTRACTS_DIR.glob("*.schema.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        by_id[schema.get("$id", path.name)] = schema
    return by_id


CONTRACTS = _load_contracts()


def _validate(instance: Any, schema: Any, path: str = "$") -> List[str]:
    """`contracts/` 가 실제로 쓰는 문법만 다루는 최소 검증기.

    `jsonschema` 패키지를 끌어오지 않는다 — 이 서비스의 의존성은 FastAPI 뿐이고,
    검증 하나 때문에 늘리면 「띄우려면 먼저 설치해야 한다」가 는다.
    범위는 `viz-debugger/scripts/lib/json-schema.mjs` 와 같다(같은 계약을 본다).

    못 다루는 키워드는 **조용히 넘기지 않고** 오류 목록에 적는다.
    """
    errors: List[str] = []

    def type_of(value: Any) -> str:
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "boolean"
        if isinstance(value, int):
            return "integer"
        if isinstance(value, float):
            return "number"
        if isinstance(value, str):
            return "string"
        if isinstance(value, list):
            return "array"
        return "object"

    def matches(actual: str, expected: str) -> bool:
        if expected == "number":
            return actual in ("number", "integer")
        return actual == expected

    def walk(value: Any, node: Any, root: Any, at: str) -> None:
        known = {
            "$schema", "$id", "$comment", "title", "description", "$defs",
            "type", "required", "properties", "additionalProperties", "items",
            "$ref", "enum", "anyOf",
            "minLength", "minimum", "maximum", "minItems", "uniqueItems",
        }
        for key in node:
            if key not in known:
                errors.append(f"{at}: 다루지 않는 키워드 '{key}'")

        ref = node.get("$ref")
        if ref is not None:
            if ref.startswith("#/$defs/"):
                target = root.get("$defs", {}).get(ref[len("#/$defs/"):])
                if target is None:
                    errors.append(f"{at}: $ref 를 못 찾았다 — {ref}")
                    return
                walk(value, target, root, at)
            else:
                target = CONTRACTS.get(ref)
                if target is None:
                    errors.append(f"{at}: $ref 파일을 못 찾았다 — {ref}")
                    return
                walk(value, target, target, at)
            return

        if "anyOf" in node:
            branch_errors = []
            for branch in node["anyOf"]:
                sub = _validate(value, {**branch, "$defs": root.get("$defs")}, at)
                if not sub:
                    return
                branch_errors.append(" / ".join(sub))
            errors.append(f"{at}: anyOf 의 어느 가지도 통과하지 않았다 — {' | '.join(branch_errors)}")
            return

        actual = type_of(value)
        if "type" in node:
            expected = node["type"] if isinstance(node["type"], list) else [node["type"]]
            if not any(matches(actual, one) for one in expected):
                errors.append(f"{at}: 타입이 {actual} 다 — {'|'.join(expected)} 여야 한다")
                return

        if "enum" in node and value not in node["enum"]:
            errors.append(f"{at}: '{value}' 는 허용 목록에 없다")
        if "minLength" in node and isinstance(value, str) and len(value) < node["minLength"]:
            errors.append(f"{at}: 길이 {len(value)} — 최소 {node['minLength']}")
        if "minimum" in node and isinstance(value, (int, float)) and not isinstance(value, bool) and value < node["minimum"]:
            errors.append(f"{at}: {value} < 최소 {node['minimum']}")
        if "maximum" in node and isinstance(value, (int, float)) and not isinstance(value, bool) and value > node["maximum"]:
            errors.append(f"{at}: {value} > 최대 {node['maximum']}")

        if actual == "array":
            if "minItems" in node and len(value) < node["minItems"]:
                errors.append(f"{at}: 원소 {len(value)}개 — 최소 {node['minItems']}")
            if node.get("uniqueItems") and len({json.dumps(item, sort_keys=True) for item in value}) != len(value):
                errors.append(f"{at}: 중복 원소가 있다")
            if "items" in node:
                for index, item in enumerate(value):
                    walk(item, node["items"], root, f"{at}[{index}]")
            return

        if actual == "object":
            for key in node.get("required", []):
                if key not in value:
                    errors.append(f"{at}: 필수 항목 '{key}' 가 없다")
            if node.get("additionalProperties") is False and "properties" in node:
                for key in value:
                    if key not in node["properties"]:
                        errors.append(f"{at}: 계약에 없는 항목 '{key}'")
            for key, sub in node.get("properties", {}).items():
                if key in value:
                    walk(value[key], sub, root, f"{at}.{key}")

    walk(instance, schema, schema, path)
    return errors


# --- 고정 응답 -------------------------------------------------------------


def _fixed_mission(utterance: str) -> Dict[str, Any]:
    """스텁의 고정 응답. **정답셋을 베껴 오지 않는다.**

    정답셋(`goldset/`)을 그대로 돌려주면 채점기가 만점을 내고, 그 만점이 「스텁이라서」인지
    「모델이 잘해서」인지 구별되지 않는다. 그래서 **계약만 만족하는 최소 임무 하나**를
    돌려준다 — 스키마 축은 통과하고 나머지 축은 낮게 나오는 것이 스텁의 정직한 모습이다.
    """
    return {
        "mission_id": "MSN-STUB-0001",
        "utterance": {
            "audio_ref": None,
            "text": utterance,
            "engine": "stub",
            # 7.8 utterance.confidence 계약은 260906 에 닫혔다 — `confidence` 를 남기고
            # `confidence_signals` 세 자리를 열었다. 스텁은 **저작된 문장**이라 인식 수치가
            # 없으므로 대본과 같은 규칙으로 1 을 쓰고 `confidence_signals` 를 **넣지 않는다**
            # (그 필드가 required 가 아닌 이유가 이 경우다).
            "confidence": 1,
        },
        "milestones": [
            {
                "milestone_id": "MS-A",
                "title": "생성 서비스 스텁 — 엔진이 붙지 않았습니다",
                "order": 0,
                "status": "pending",
                "assigned_targets": [],
                "tasks": [],
            }
        ],
    }


def _equipment_count(equipment: Any) -> int:
    """프롬프트에 실린 장비가 몇 건인가. 안 줬으면 0.

    기록에 남길 숫자다. 축이 살아 있으려면 이 값이 채점 어휘보다 커야 하고,
    그 비교는 저장소 쪽 검사(`verify:no-leak`)가 한다 — 서비스는 정답을 모른다.
    """
    if not equipment:
        return 0
    entries = equipment.get("equipment", []) if isinstance(equipment, dict) else equipment
    return len(entries) if isinstance(entries, list) else 0


# --- 면 --------------------------------------------------------------------


class GenerateRequest(BaseModel):
    utterance: str
    grammar: Optional[Dict[str, Any]] = None
    places: Optional[Any] = None
    #: 장비 어휘 (`equipment/equipment.json` 의 내용). **부르는 쪽이 고른다** — 장소·예시와
    #: 같은 성질의 재료다. 안 주면 규칙도 목록도 안 붙고 6단계와 같은 프롬프트가 된다.
    equipment: Optional[Any] = None
    examples: List[Any] = []
    model: Optional[str] = None
    #: 임무 식별자는 **부르는 쪽이 준다.** 모델이 지어낼 것이 아니다 —
    #: `audio_ref` 와 같은 성질이고, `VZ-G-01` 이 만드는 것은 마일스톤이다.
    mission_id: Optional[str] = None
    #: 계약의 `utterance` 를 그대로 넘긴다. 모델은 옮겨 적기만 하면 된다.
    utterance_meta: Optional[Dict[str, Any]] = None
    #: **문법을 끌 수 있다.** 「강제 디코딩이 실제로 듣는가」는 안 걸었을 때와
    #: 비교해야 답이 되기 때문이다 (대조군).
    #: 노드 문법 5종(감지·판단·실행·검증·보고) 규칙을 붙일 것인가 (8단계 D 판).
    #: 장소·장비와 달리 **목록이 아니라 규칙**이라 재료가 아니고 켜고 끄는 스위치다.
    #: 무엇이 붙는지는 `prompt.rules_for()` 한 곳이 정한다.
    node_kinds: bool = False
    #: 마일스톤 안에 태스크까지 내게 할 것인가 (10단계 E 판 · `VZ-G-02` 의 모델 쪽 절반).
    #: **규칙을 더하는 것이 아니라 갈아 끼운다** — 「tasks 는 빈 배열로 둔다」와 정면으로
    #: 부딪히기 때문이다. `deps` 는 여전히 모델의 것이 아니다: 빈 배열로 받고 부르는 쪽의
    #: `solveDeps()` 가 매단다(지시서 §5).
    tasks: bool = False
    #: 분기·되풀이를 마일스톤에 적게 할 것인가 (분기와루프 3단계 G 판).
    #: **없는 것이 정상이다** — 발화가 요구하지 않았는데 나오면 지어내기이고, 채점이 센다.
    branch: bool = False
    enforce_grammar: bool = True
    max_tokens: int = 2048
    temperature: float = 0.0
    seed: int = 0


@app.get("/generate/health")
def health() -> Dict[str, Any]:
    """무엇이 떠 있는가. **목임을 감추지 않는다** — 엔진이 없으면 그 자리에 `stub` 이 적힌다."""
    engine = engines.get_engine(None)
    status = engine.status() if engine is not None else {}
    models = engine.models() if engine is not None else []
    ready = bool(models) and status.get("binary_present", False)
    return {
        "engine": engine.id if (engine is not None and ready) else "stub",
        "model": status.get("loaded_model"),
        "why": None if ready else (
            "엔진은 붙어 있지만 쓸 수 있는 가중치나 바이너리가 없습니다 — gen-lab/README.md 의 절차를 보세요. "
            "요청을 받으면 계약 검증만 하고 고정 응답을 돌려줍니다."
            if engine is not None else
            "엔진이 붙어 있지 않습니다. 요청을 받아 계약 검증만 하고 고정 응답을 돌려줍니다."
        ),
        "engines": engines.list_engines(),
        # 엔진 하나가 설치 안 된 사실이 조용히 사라지지 않게 한다.
        "engine_load_errors": engines.load_errors(),
        "engine_status": status,
        "models": models,
        "contracts": sorted(CONTRACTS.keys()),
        "goldset_missions": len(list((GOLDSET_DIR / "missions").glob("*.json"))) if (GOLDSET_DIR / "missions").exists() else 0,
    }


@app.on_event("shutdown")
def _release_engine() -> None:
    """서비스가 내려갈 때 자식 프로세스를 **반드시** 내린다.

    260906 에 이걸 안 해서 측정이 한 번 무효가 됐다 — gen-lab 을 다시 띄우자 앞선 실행의
    `llama-server` 가 포트를 잡은 채 남았고, 새 gen-lab 이 그 유령에게 물어보면서
    「8B 를 쟀다」는 표가 실제로는 4B 의 답이 됐다. `Ctrl+C` 로 끄면 여기가 돈다.
    """
    for name in engines.list_engines():
        engine = engines.get_engine(name)
        if engine is not None:
            engine.unload()


@app.post("/generate/unload")
def unload() -> Dict[str, Any]:
    """가중치를 내린다. **STT 와 12 GB 를 나눠 쓰는 배치에서 필요하다.**

    측정 스크립트가 재는 사이에 부르기도 한다 — 「모델이 없을 때의 VRAM」이 있어야
    「모델이 먹는 VRAM」이 뺄셈으로 나온다.
    """
    engine = engines.get_engine(None)
    if engine is None:
        return {"unloaded": False, "why": "엔진이 붙어 있지 않습니다"}
    engine.unload()
    return {"unloaded": True, "engine_status": engine.status()}


def _extract_json(text: str) -> "tuple[Optional[Any], Optional[str]]":
    """모델 출력에서 JSON 객체 하나를 꺼낸다.

    문법을 걸면 출력이 곧 JSON 이라 그냥 파싱된다. **문법 없는 대조군**에서는 앞뒤에
    설명이나 코드펜스가 붙으므로 첫 여는 중괄호부터 짝이 맞는 닫는 중괄호까지를 잘라 본다.
    그 관대함이 쓰였는지는 `extra.json_recovered` 에 남는다 — 조용히 넘기지 않는다.
    """
    try:
        return json.loads(text), None
    except Exception:
        pass
    start = text.find("{")
    if start < 0:
        return None, "출력에 JSON 객체가 없습니다"
    depth, in_string, escaped = 0, False, False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:index + 1]), None
                except Exception as exc:
                    return None, f"JSON 을 잘라 냈지만 파싱에 실패했습니다: {exc}"
    return None, "괄호가 닫히지 않았습니다 (n_predict 에서 잘렸을 수 있습니다)"


def _apply_caller_values(mission: Any, request: "GenerateRequest") -> "tuple[Any, List[Dict[str, Any]]]":
    """`mission_id` 와 `utterance` 를 **부르는 쪽 값으로 덮어쓴다** (9단계 · §6 「같이 고칠 것」).

    ## 왜 모델에게 맡기지 않나

    이 둘은 부르는 쪽이 이미 아는 값이다(6단계 §9 · `audio_ref` 와 같은 성질). 프롬프트가
    「그대로 옮겨 적어라」로 부탁하고 있었고, **되받아 적을 기회가 있으면 언젠가 틀린다** —
    7단계 A 판 1건이 `utterance.confidence` 를 1 대신 **5** 로 적어 계약을 어겼다
    (문법은 구조와 타입만 고정하고 `maximum` 같은 값 제약은 못 건다).

    여기서 덮어쓰면 그 실패 유형이 **원천에서 사라진다.** 계약상 required 라 문법에서는
    그대로 두고(모델은 여전히 낸다), 우리가 쓰는 값만 부르는 쪽 것으로 바꾼다.

    ## 덮어쓴 사실을 버리지 않는다

    「고쳐 놓고 안 고친 척」하지 않는다. 모델이 무엇을 적었는지를 그대로 남기고, 그것이
    `id_obeyed` 같은 축의 원천이 된다. 조용히 고치면 「모델이 지시를 지켰는가」를 영영
    못 재게 된다 — `run-baseline` 이 채점 짝을 맞추면서도 `id_obeyed` 를 따로 남긴 것과
    같은 규칙이다.
    """
    overwritten: List[Dict[str, Any]] = []
    if not isinstance(mission, dict):
        return mission, overwritten
    if request.mission_id is not None:
        before = mission.get("mission_id")
        if before != request.mission_id:
            overwritten.append({"field": "mission_id", "model": before, "used": request.mission_id})
        mission["mission_id"] = request.mission_id
    if request.utterance_meta is not None:
        before = mission.get("utterance")
        if before != request.utterance_meta:
            overwritten.append({"field": "utterance", "model": before, "used": request.utterance_meta})
        # 부르는 쪽 객체를 그대로 물리지 않는다 — 응답을 조립하다 요청을 고치면
        # 「무엇을 받았는가」가 흔들린다.
        mission["utterance"] = json.loads(json.dumps(request.utterance_meta))
    return mission, overwritten


@app.post("/generate/mission")
def generate_mission(request: GenerateRequest) -> JSONResponse:
    """발화 하나 → 임무 객체.

    **결과는 제안이다** — 사람이 수락하기 전에는 아무것도 실행되지 않는다(`VZ-U-07`).
    그 규칙을 지키는 것은 화면이고, 여기서는 만들어 돌려주기만 한다.
    """
    started = time.perf_counter()
    grammar = request.grammar or {}
    grammar_record = (
        {"source": grammar.get("source"), "digest": grammar.get("digest"), "bytes": len(grammar.get("text") or "")}
        if grammar else None
    )
    engine = engines.get_engine(None)
    usable = engine is not None and bool(engine.models()) and engine.status().get("binary_present", False)

    if not usable:
        # 엔진이 없다 — 스텁으로 내려간다. **정답셋을 베껴 오지 않는다.**
        mission = _fixed_mission(request.utterance)
        # 덮어쓰기는 엔진 경로와 **같은 함수**다. 스텁만 다른 값을 내면 화면이 스텁에서
        # 잘 돌다가 엔진에서 깨지고, 그 차이를 아무도 못 본다.
        mission, overwritten = _apply_caller_values(mission, request)
        errors = _validate(mission, CONTRACTS["mission.schema.json"])
        body: Dict[str, Any] = {
            "mission": mission,
            "engine": "stub",
            "model": request.model or "none",
            "grammar": grammar_record,
            "schema_checked": True,
            "schema_errors": errors,
            "elapsed_sec": round(time.perf_counter() - started, 6),
            "extra": {
                "stub": True,
                "why": "엔진이나 가중치가 없습니다. 이 응답은 계약을 만족하는 최소 임무이지 생성 결과가 아닙니다.",
                "places_given": request.places is not None,
                "equipment_given": _equipment_count(request.equipment),
                "examples_given": len(request.examples),
                # **판을 응답이 말한다.** 이름으로만 적으면 이름을 바꾼 순간 기록이 거짓말한다.
                "node_kinds_given": request.node_kinds,
                "tasks_given": request.tasks,
                "branch_given": request.branch,
                "grammar_enforced": False,
                # 화면(§6)이 생성 근거에 싣는 셋. **스텁에는 프롬프트가 없다** —
                # 빈 목록이 아니라 null 이다. 0 과 「해당 없음」을 가르는 이 저장소의 규칙.
                "rules_applied": None,
                "prompt_digest": None,
                "prompt_chars": None,
                "overwritten": overwritten,
            },
        }
        # 스텁의 고정 응답이 계약을 어기면 그건 계약이 바뀐 것이다. 숨기지 않고 500 으로 낸다.
        if errors:
            body["error"] = "스텁의 고정 응답이 계약을 통과하지 못했습니다 — 계약이 바뀌었는지 확인하세요"
            return JSONResponse(body, status_code=500)
        return JSONResponse(body, status_code=200)

    # 프롬프트는 **서비스가 만든다.** 부르는 쪽이 고르는 것은 재료(장소·예시)뿐이다.
    built = prompt_builder.build(
        utterance=request.utterance,
        mission_id=request.mission_id or "MSN-GEN-0001",
        places=request.places,
        equipment=request.equipment,
        node_kinds=request.node_kinds,
        tasks=request.tasks,
        branch=request.branch,
        examples=request.examples,
        utterance_meta=request.utterance_meta,
    )
    try:
        output = engine.generate(built["user"], GenerateOptions(
            model=request.model,
            system=built["system"],
            # 문법이 없으면 **강제 디코딩 없이** 돈다 — 그것이 대조군이다.
            grammar=(grammar.get("text") if request.enforce_grammar else None),
            max_tokens=request.max_tokens,
            temperature=request.temperature,
            seed=request.seed,
        ))
    except Exception as exc:  # 엔진 실패를 삼키지 않는다 — 화면이 문장을 그대로 보여준다
        return JSONResponse(
            {
                "error": f"{type(exc).__name__}: {exc}",
                "engine": engine.id,
                "model": request.model,
                "grammar": grammar_record,
                "elapsed_sec": round(time.perf_counter() - started, 6),
            },
            status_code=500,
        )

    mission, parse_error = _extract_json(output.text)
    # **검증은 덮어쓴 뒤에 한다.** 화면이 받는 것이 덮어쓴 객체이므로, 그 앞의 것을 재면
    # 「통과했다」가 화면이 든 것과 다른 객체의 이야기가 된다.
    mission, overwritten = _apply_caller_values(mission, request)
    errors = (
        [f"$: 모델 출력을 JSON 으로 읽지 못했습니다 — {parse_error}"]
        if mission is None else _validate(mission, CONTRACTS["mission.schema.json"])
    )
    body = {
        "mission": mission,
        "engine": output.engine,
        "model": output.model,
        "grammar": grammar_record,
        "schema_checked": True,
        "schema_errors": errors,
        "elapsed_sec": output.elapsed_sec,
        "extra": {
            "stub": False,
            "grammar_enforced": output.grammar_enforced,
            "places_given": request.places is not None,
            # **몇 건을 줬는지 센다.** 「줬다/안 줬다」만 남기면, 목록이 채점 어휘와 같은
            # 크기로 좁아진 채 돈 실행을 나중에 가려낼 수 없다 (`verify:no-leak` 5번).
            "equipment_given": _equipment_count(request.equipment),
            "examples_given": len(request.examples),
            # **판을 응답이 말한다.** 이름으로만 적으면 이름을 바꾼 순간 기록이 거짓말한다.
            "node_kinds_given": request.node_kinds,
            "tasks_given": request.tasks,
            "branch_given": request.branch,
            # 화면(§6)이 생성 근거에 싣는 셋 — 어느 규칙이 붙었는가 · 어느 프롬프트였는가.
            #
            # **규칙 목록은 `rules_for()` 가 준 그대로다.** 화면이 따로 적으면 모델이 지킨
            # 규칙과 사람이 본 규칙이 갈라지고, 그 순간 「역추적이 맨 위까지 닿는다」
            # (`VZ-G-01`)가 거짓이 된다. 그래서 여기서 한 번 더 만들지 않고 같은 함수를
            # 같은 인자로 부른다.
            "rules_applied": prompt_builder.rules_for(request.equipment, request.node_kinds, request.tasks, request.branch),
            # 프롬프트 지문. 문법 지문과 같은 성질이다 — 내용을 다 싣지 않고 「같은 것이었나」
            # 만 답할 수 있으면 된다. 원문은 프롬프트를 만드는 코드가 커밋에 있다.
            "prompt_digest": hashlib.sha256(
                (built["system"] + "\n" + built["user"]).encode("utf-8")
            ).hexdigest()[:16],
            "prompt_chars": len(built["system"]) + len(built["user"]),
            # 부르는 쪽 값으로 덮어쓴 자리. 비어 있으면 모델이 그대로 옮겨 적은 것이다.
            "overwritten": overwritten,
            "load_sec": output.load_sec,
            "prompt_tokens": output.prompt_tokens,
            "completion_tokens": output.completion_tokens,
            "stop_reason": output.stop_reason,
            "applied_options": output.applied_options,
            # 문법 없이 돌린 대조군에서 JSON 을 잘라 냈는가. 관대함을 기록에 남긴다.
            "json_recovered": mission is not None and output.text.strip()[:1] != "{",
            # **원문을 버리지 않는다.** 파싱이 실패했을 때 왜인지 볼 수 있어야 한다.
            "raw_text": output.text,
            **output.extra,
        },
    }
    # 모델이 계약을 어긴 것은 **서비스의 실패가 아니다** — 그것이 측정값이다.
    # 200 으로 내고 schema_errors 에 적는다. 500 을 내면 채점기가 그 건을 잃는다.
    return JSONResponse(body, status_code=200)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT)
