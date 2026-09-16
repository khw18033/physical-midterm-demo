"""pipeline/summary_before.json vs summary_after.json 비교 출력."""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
b = json.loads((HERE / "pipeline" / "summary_before.json").read_text(encoding="utf-8"))
a = json.loads((HERE / "pipeline" / "summary_after.json").read_text(encoding="utf-8"))
for s in ("rot8", "robot"):
    print(f"===== {s}")
    for k in ("detections", "navigation", "fallback_chain"):
        same = b[s][k] == a[s][k]
        print(f"-- {k}: {'같음' if same else '다름'}")
        if not same:
            print("   before:", json.dumps(b[s][k], ensure_ascii=False))
            print("   after :", json.dumps(a[s][k], ensure_ascii=False))
