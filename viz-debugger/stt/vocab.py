# 이식: stt-lab/server/registry.py @ 6552346 — 부분 이식
#   가져온 것: load_registry() · _targets() · vocabulary() · hotwords_string() · registry_path()
#   버린 것:  utterance_presets() · UTTERANCE_TEMPLATES · _speakable() · NAMES_PER_TARGET
#             (시험 발화 67건 생성. 실험 하네스의 일이라 운영 경로에 두지 않는다)
#   고친 것:  registry.json 을 찾는 기준 경로와 환경변수 이름뿐. 어휘를 뽑는 논리는 그대로다.
# 부분 이식이라 바이트 동일성 검사(verify:stt-port) 대상이 아니다. engines/ 만 검사한다.
"""registry.json 에서 명령 어휘를 뽑아낸다 (REQ-305 / REQ-1304).

호칭 사전을 여기서 새로 만들지 않는다. `display_name` 과 `aliases[]` 가 원천이고
이 서비스는 그걸 읽기만 한다.

**복사본을 두지 않는다.** `../../web-dashboard/mock-gateway/registry.json` 을 실행 시점에
읽는다. 복사해 두면 원본이 바뀔 때 조용히 어긋나고, 그 어긋남은 인식이 왜 나빠졌는지를
설명할 수 없게 만든다. 경로는 `VIZ_STT_REGISTRY` 로 바꿀 수 있다.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

# viz-debugger/stt/vocab.py → viz-debugger/stt/ → viz-debugger/ → 저장소 루트
STT_DIR = Path(__file__).resolve().parent
REPO_ROOT = STT_DIR.parent.parent
DEFAULT_REGISTRY_PATH = REPO_ROOT / "web-dashboard" / "mock-gateway" / "registry.json"
# 대본 라이브러리 (260831). registry.json 에는 손대지 않으므로(aliases 추가 금지)
# 「월류방어벽」「사각지대」 같은 대본 키워드는 여기서 hotword 에 **더한다** — 대체가 아니다.
SCENARIO_DIR = STT_DIR.parent / "scenarios"


def registry_path() -> Path:
    override = os.environ.get("VIZ_STT_REGISTRY")
    return Path(override).expanduser().resolve() if override else DEFAULT_REGISTRY_PATH


_cache: Dict[str, Any] = {"mtime": None, "path": None, "data": None}


def load_registry() -> Dict[str, Any]:
    """원본을 읽는다. mtime이 바뀌면 다시 읽는다 — 서비스를 껐다 켜지 않아도 되게."""
    path = registry_path()
    if not path.exists():
        raise FileNotFoundError(
            "registry.json 을 찾을 수 없다: {}\n"
            "web-dashboard 옆에서 실행하고 있는지, 아니면 VIZ_STT_REGISTRY 를 지정했는지 확인할 것.".format(path)
        )
    mtime = path.stat().st_mtime
    if _cache["data"] is None or _cache["mtime"] != mtime or _cache["path"] != str(path):
        _cache.update(
            {"mtime": mtime, "path": str(path), "data": json.loads(path.read_text(encoding="utf-8"))}
        )
    return _cache["data"]


def _targets(reg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """zone/node/entity 를 (kind, id, display_name, aliases, entity_type) 로 평탄화한다."""
    out: List[Dict[str, Any]] = []
    for kind, singular in (("zones", "zone"), ("nodes", "node"), ("entities", "entity")):
        for item in reg.get(kind, []):
            display = item.get("display_name")
            if not display:
                continue
            out.append(
                {
                    "kind": singular,
                    "id": item.get("id"),
                    "display_name": display,
                    "aliases": [a for a in item.get("aliases", []) if a],
                    "entity_type": item.get("entity_type"),
                    "zone": item.get("zone"),
                }
            )
    return out


def _script_terms() -> List[Dict[str, str]]:
    """대본 라이브러리의 match 키워드 (260831 · REQ-1304 의 확장점).

    파일 목록을 하드코딩하지 않고 scenarios/*.json 에서 `match` 블록이 있는 파일
    (대본 세 편 + 옛 편 사이드카)을 전부 읽는다 — 대본이 늘면 hotword 도 같이 는다.
    verify:stt-port 는 engines/*.py 만 바이트 대조하므로(확인됨) 이 파일은 그 밖이다.
    """
    terms: List[Dict[str, str]] = []
    if not SCENARIO_DIR.exists():
        return terms
    for path in sorted(SCENARIO_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        match = data.get("match")
        if not isinstance(match, dict):
            continue
        mission = data.get("missionId") or path.stem
        words = [w for group in match.get("must", []) if isinstance(group, list) for w in group]
        words += list(match.get("any", []))
        for word in words:
            if word:
                terms.append(
                    {
                        "term": str(word),
                        "field": "script-match",
                        "kind": "script",
                        "source_id": str(mission),
                        "entity_type": "",
                    }
                )
    return terms


def vocabulary() -> Dict[str, Any]:
    """hotwords 어휘 + 각 어휘가 어디서 왔는지.

    어디서 왔는지를 같이 내보내는 이유: hotwords를 켰을 때 인식이 좋아졌다면
    어떤 항목 덕분인지 알아야 REQ-1304의 확장점을 어떻게 채울지 정할 수 있다.
    """
    reg = load_registry()
    terms: List[Dict[str, str]] = []
    seen = set()
    for target in _targets(reg):
        for field, value in [("display_name", target["display_name"])] + [
            ("alias", a) for a in target["aliases"]
        ]:
            if value in seen:
                continue
            seen.add(value)
            terms.append(
                {
                    "term": value,
                    "field": field,
                    "kind": target["kind"],
                    "source_id": target["id"] or "",
                    "entity_type": target["entity_type"] or "",
                }
            )
    # 대본 키워드는 레지스트리 어휘 **뒤에 더한다** (260831). 적용 수가 화면(등록 이름 N개
    # 반영)에 뜨므로 실렸는지 확인된다. 대조군(등록 이름 우선 끔)은 그대로 편향이 없다.
    for term in _script_terms():
        if term["term"] in seen:
            continue
        seen.add(term["term"])
        terms.append(term)
    return {
        "registry_path": str(registry_path()),
        "registry_version": reg.get("registry_version"),
        "count": len(terms),
        "terms": terms,
        "hotwords": hotwords_string(terms),
    }


def hotwords_string(terms: Optional[List[Dict[str, str]]] = None) -> str:
    """faster-whisper 의 `hotwords` 에 그대로 넘길 한 줄.

    `initial_prompt` 와 합치지 않는다. hotwords 는 이 어휘 쪽으로 디코딩을 편향시키는
    것이고, initial_prompt 는 문맥·문체를 유도하는 것이라 목적이 다르다.
    """
    if terms is None:
        terms = vocabulary()["terms"]
    return ", ".join(t["term"] for t in terms)
