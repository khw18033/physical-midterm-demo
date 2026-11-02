"""박스 없는 연구실 회전 영상(20261102_154357)의 시험 구간에서 오탐률을 잰다 (2026-11-02).

build_dataset_neg.py가 학습에서 뺀 시간 구간(10구간 중 VAL_BLOCKS)의 프레임 전부를 쓴다(간격 없이).
같은 방을 여러 바퀴 돈 영상이라 학습 구간과 그림이 비슷해 낙관적인 수치다 -- 다른 날 찍은 live_test/와 함께 본다.
사용: python eval_neg.py <run> [<run> ...]
결과: neg_eval.json
"""
import json
import sys
from pathlib import Path

import cv2
from ultralytics import YOLO

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_dataset_neg import BOX_VISIBLE  # noqa: E402  (두 번째 회색 박스가 보이는 구간은 시험에서도 뺀다)

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "20261102_154357" / "frames"
CROP = (114, 80, 351, 321)
CONF, IMGSZ = 0.25, 256
N_BLOCKS, VAL_BLOCKS = 10, {3, 8}


def main():
    frames = sorted(SRC.glob("*.jpg"))
    test = [p for i, p in enumerate(frames) if i * N_BLOCKS // len(frames) in VAL_BLOCKS
            and not any(a <= i <= b for a, b in BOX_VISIBLE)]
    out = {"source": SRC.parent.name, "conf": CONF, "imgsz": IMGSZ, "test_frames": len(test), "runs": {}}
    for run in sys.argv[1:] or ["yolov8n_graybox_v5"]:
        model = YOLO(str(HERE / "runs" / run / "weights" / "best.pt"))
        hits = []
        for p in test:
            r = model.predict(cv2.imread(str(p))[CROP[1]:CROP[3], CROP[0]:CROP[2]], conf=CONF, imgsz=IMGSZ,
                              verbose=False)[0]
            if len(r.boxes):
                hits.append({"frame": p.name, "scores": [round(float(s), 3) for s in r.boxes.conf.tolist()]})
        out["runs"][run] = {"frames_with_detection": len(hits), "rate": round(len(hits) / len(test), 3),
                            "max_score": max((max(h["scores"]) for h in hits), default=None), "hits": hits}
        print(run, f"{len(hits)}/{len(test)}")
    (HERE / "neg_eval.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
