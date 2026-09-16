"""로봇 세트 before/after의 문 거리·방위 산출 근거(프레임별) 출력."""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def walk(o, keys, path=""):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in keys:
                print(f"   {path}.{k} = {json.dumps(v, ensure_ascii=False)[:900]}")
            else:
                walk(v, keys, f"{path}.{k}")
    elif isinstance(o, list):
        for i, v in enumerate(o):
            walk(v, keys, f"{path}[{i}]")


for tag in ("before", "after"):
    p = HERE / "pipeline" / tag / "robot" / "localization" / "localization_evidence.json"
    ev = json.loads(p.read_text(encoding="utf-8"))
    print(f"===== {tag}")
    walk(ev, {"door_distance_estimate", "door_rotation_estimate"})
