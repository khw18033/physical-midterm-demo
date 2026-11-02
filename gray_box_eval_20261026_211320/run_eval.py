"""20261026_211320(같은 회색 박스를 여러 각도에서 찍은 로봇 프레임)으로 gray box 탐지를 평가한다 (2026-10-27).

class_features.json에 등록된 "gray box"를 그대로 쓰고, 서비스 코드는 RUN_DIR만 바꾼다.
- 표본: STEP장마다 1장. 카메라가 얼면 같은 그림이 반복되므로(4572장 중 sha1 고유 3493장)
  이미 뽑은 그림과 sha1이 같으면 건너뛴다.
- provider별 원본 출력을 detect() 래핑으로 그대로 받아 둔다(다시 추론하지 않음) -- 확정이
  "사진 전체 크기 CLIP 후보가 GDINO 박스를 포함해서 생긴 가짜 동의"인지 가려내기 위함.
결과: records.jsonl(프레임별 1줄), 프레임별 산출물은 frames/<stem>/.
"""
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SRC = REPO / "20261026_211320"
TAG = "gray box"
STEP = int(sys.argv[1]) if len(sys.argv) > 1 else 20
sys.path.insert(0, str(REPO / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402  (ctypes 우회가 torch보다 먼저 돌아야 함)

cfs.RUN_DIR = HERE / "frames"


def _wrap(provider, key, stash):
    orig = provider.detect

    def detect(*a, **kw):
        out = orig(*a, **kw)
        stash[key] = out
        return out
    provider.detect = detect


def main():
    meta = [json.loads(l) for l in open(SRC / "frames.jsonl", encoding="utf-8")]
    sha_by_n = {m["n"]: m["sender"].get("X-Sha1") for m in meta}

    finder = cfs.ClassFinderService()
    finder.on_class_discovery_command(TAG)
    stash = {}
    _wrap(finder.dictionary, "dictionary", stash)
    _wrap(finder.grounding_dino, "grounding_dino", stash)
    _wrap(finder.yolo_world, "yolo_world", stash)

    seen = set()
    out_path = HERE / "records.jsonl"
    out_path.unlink(missing_ok=True)
    t_start = time.perf_counter()
    for n in range(1, len(meta) + 1, STEP):
        if sha_by_n.get(n) in seen:
            continue
        seen.add(sha_by_n.get(n))
        frame = SRC / "frames" / f"{n:09d}.jpg"
        finder.on_frame(frame, 0.0, n)
        det = finder.get_detections()[TAG][0.0]
        rec = {
            "n": n, "frame": frame.name, "found": det["found"],
            "instances": [{"box_xyxy": i["box_xyxy"], "final_score": i["final_score"],
                           "supporting_sources": list(i["supporting_sources"])} for i in det["instances"]],
            "raw": {
                "dictionary": [{"box_xyxy": d["box_xyxy"], "score": d["score"]}
                               for d in stash["dictionary"].get(TAG, [])],
                "grounding_dino": [d for d in stash["grounding_dino"] if TAG in d["label"]],
                "yolo_world": [d for d in stash["yolo_world"] if d["label"] == TAG],
            },
        }
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"[gray_box_eval] {frame.name} found={det['found']} "
              f"elapsed={time.perf_counter() - t_start:.0f}s", flush=True)


if __name__ == "__main__":
    main()
