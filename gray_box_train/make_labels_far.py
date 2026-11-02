"""먼 거리 촬영(box_2m / box_2.5m / box_3m)에 GroundingDINO 라벨을 단다 (2026-11-02).

make_labels.py와 같은 방식(「gray box.」만 질의, 후보 전체 기록)이지만 두 가지가 다르다.
- UniDepth 거리는 재지 않는다: 이 영상들은 사용자가 거리를 정해 놓고 찍었다(폴더 이름 = 박스까지 거리).
- 비슷한 그림이 길게 이어져(로봇이 멈춰 있는 구간) STEP장 간격으로만 단다. sha1 중복은 0장이었다(2026-11-02 확인).
사용: python make_labels_far.py <폴더 이름> [STEP=3]
결과: labels_<폴더 이름>.jsonl (이어받기 지원 -- 이미 기록된 프레임은 건너뜀)
"""
import json
import sys
import time
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
NAME = sys.argv[1]
STEP = int(sys.argv[2]) if len(sys.argv) > 2 else 3
SRC = REPO / NAME
TAG = "gray box"
sys.path.insert(0, str(REPO / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402  (ctypes 우회가 torch보다 먼저 돌아야 함)


def main():
    meta = [json.loads(l) for l in open(SRC / "frames.jsonl", encoding="utf-8")][::STEP]
    out_path = HERE / f"labels_{NAME}.jsonl"
    done_frames = set()
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            try:
                done_frames.add(json.loads(line)["frame"])
            except (json.JSONDecodeError, KeyError):
                continue
    gd = cfs.GroundingDinoProvider()
    cl, ct, cr, cb = cfs.BORDER_CROP_BOX
    t0, done = time.perf_counter(), 0
    for m in meta:
        name = Path(m["frame_file"]).name
        if name in done_frames:
            continue
        bgr = cv2.imread(str(SRC / "frames" / name))[ct:cb, cl:cr]
        dets = [d for d in gd.detect(bgr, [TAG]) if TAG in d["label"]]
        rec = {"n": m["n"], "frame": name, "distance_cm_folder": NAME, "gdino": dets}
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        done += 1
        if done % 100 == 0:
            print(f"[make_labels_far] {NAME} {done}장 {time.perf_counter() - t0:.0f}s", flush=True)
    print(f"[make_labels_far] {NAME} 끝 {done}장", flush=True)


if __name__ == "__main__":
    main()
