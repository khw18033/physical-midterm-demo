"""박스 없는 연구실 360도 회전(20261102_154357) -> dataset_neg/ 음성 (2026-11-02).

왜: v5가 실연동 판에서 책상 다리·사람 등을 박스로 잡았다(학습보고서_261102.md 5절).
사용자가 회색 박스를 치운 같은 연구실에서 로봇을 돌려 2,156장을 찍었다. 그런데 연구실에 같은 회색 박스가 2개 있었고 하나를
치우지 못했다(사용자, 2026-11-02) -- 캐비닛 옆에서 다른 물체에 일부 가려져 세로로 길어 보이는 그 박스를 처음엔 "검은 캐리어 오탐"으로
잘못 보고 음성에 넣어 v6를 학습하다 멈췄다. v5가 이 영상에서 낸 검출 352장 대부분이 그 박스(정탐)였다.
- 그 박스가 보이는 구간(BOX_VISIBLE, v5 conf 0.05 검출 연속 구간 + 육안으로 경계 확인 후 앞뒤 여유)은 통째로 뺀다.
  박스가 일부만 보이는 장면이 섞여 있어 양성으로도 쓰지 않는다.
- 나머지는 박스 없음이다. v5 오탐은 책상 다리·책상 상판 등(육안). 라벨 파일은 비운다.
- v5가 검출을 낸 프레임(어려운 음성)은 모두, 나머지는 STEP장 간격으로 넣는다(3바퀴라 비슷한 그림이 많다).
- 시간 순 10구간 중 VAL_BLOCKS는 학습에서 빼 검증(ultralytics val)과 eval_neg.py 시험에 쓴다. 같은 방을 여러 바퀴 돈 영상이라
  이 구간도 학습 구간과 그림이 비슷해 낙관적이다 -- 진짜 시험은 다른 날 찍은 live_test/의 사무실 판.
결과: dataset_neg/images|labels/{train,val}, dataset_neg/data.yaml(기존 + 증강 + 먼 거리 + 음성), neg_stats.json
"""
import json
import sys
from pathlib import Path

import cv2
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SRC = REPO / "20261102_154357" / "frames"
OUT = HERE / "dataset_neg"
CROP = (114, 80, 351, 321)
STEP = 2
N_BLOCKS, VAL_BLOCKS = 10, {3, 8}
# 두 번째 회색 박스가 보이는 프레임 순번(0부터, 정렬 순서) -- 육안: 826까지 안 보임 ~ 930 안 보임, 1133~1240, 1900~1995
BOX_VISIBLE = [(800, 960), (1100, 1260), (1870, 2020)]
MINE_RUN = sys.argv[1] if len(sys.argv) > 1 else "yolov8n_graybox_v5"


def main():
    for s in ("train", "val"):
        for k in ("images", "labels"):
            d = OUT / k / s
            d.mkdir(parents=True, exist_ok=True)
            for p in d.iterdir():
                p.unlink()
    frames = sorted(SRC.glob("*.jpg"))
    model = YOLO(str(HERE / "runs" / MINE_RUN / "weights" / "best.pt"))
    stats = {"source": SRC.parent.name, "frames": len(frames), "mine_run": MINE_RUN, "step": STEP,
             "val_blocks": sorted(VAL_BLOCKS), "train": {"hard": 0, "easy": 0}, "val": {"hard": 0, "easy": 0}}
    stats["excluded_box_visible"] = 0
    for i, p in enumerate(frames):
        if any(a <= i <= b for a, b in BOX_VISIBLE):
            stats["excluded_box_visible"] += 1
            continue
        im = cv2.imread(str(p))[CROP[1]:CROP[3], CROP[0]:CROP[2]]
        hard = len(model.predict(im, conf=0.25, imgsz=256, verbose=False)[0].boxes) > 0
        split = "val" if i * N_BLOCKS // len(frames) in VAL_BLOCKS else "train"
        if not hard and i % STEP:
            continue
        stem = f"neg_{SRC.parent.name}_{p.stem}"
        cv2.imwrite(str(OUT / "images" / split / f"{stem}.jpg"), im)
        (OUT / "labels" / split / f"{stem}.txt").write_text("")
        stats[split]["hard" if hard else "easy"] += 1
    (OUT / "data.yaml").write_text(
        f"path: {HERE.as_posix()}\ntrain:\n  - dataset/images/train\n  - dataset_aug/images/train\n"
        f"  - dataset_far/images/train\n  - dataset_neg/images/train\n"
        f"val:\n  - dataset/images/val\n  - dataset_far/images/val\n  - dataset_neg/images/val\nnames:\n  0: gray box\n")
    (OUT / "neg_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(stats)


if __name__ == "__main__":
    main()
