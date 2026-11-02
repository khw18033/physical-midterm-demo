"""연구실 회전 + 박스 좌/우 배치(20261102_161617) -> dataset_lab/ (2026-11-02).

사용자가 같은 연구실에서 회색 박스를 완전히 치우고 로봇을 360도 돌린 뒤(앞부분), 박스를 카메라 왼쪽·오른쪽에 두고 찍었다(뒷부분).
- NEG_RANGE(박스 없음): 음성. v5가 conf 0.25 이상을 낸 프레임(어려운 음성)은 모두, 나머지는 STEP장 간격.
  2026-11-02 육안: v5 검출은 전부 책상 다리(0.32~0.66) -- 20261102_154357과 같은 오탐을 다른 날 다시 본다.
- POS_RANGE(박스 있음): labels_20261102_161617.jsonl(GDINO 「gray box.」) 중 build_dataset_far.py와 같은 기하 조건을 통과한 최고점.
  통과 후보가 없으면 버린다(음성으로 넣지 않는다) -- 박스가 테두리 crop 밖(카메라 왼쪽 가장자리)에 있거나 사람이 들고 있는 장면이다.
  높이 상한은 먼 거리용 60px이 아니라 MAX_H_PX(가까이 놓은 박스가 80px 넘게 잡힌다). 색 조건은 build_dataset_far.py처럼 끈다.
- 두 구간 사이(사람이 박스를 들고 들어오는 장면)는 쓰지 않는다.
- 박스를 왼쪽에 둔 뒷부분 절반은 박스가 crop 밖이라 어떤 모델도 못 잡는다(가운데 crop 103/154, 좌측 crop을 더해도 108/154,
  2026-11-02 v5). crop 가로 시야(약 80°)가 스캔 간격 45°보다 넓어 8방향 중 한 장에는 crop 안에 들어오므로 crop은 넓히지 않는다.
학습/검증: 시간 순 10구간 중 VAL_BLOCKS를 검증에.
결과: dataset_lab/images|labels/{train,val}, dataset_lab/data.yaml(기존 + 증강 + 먼 거리 + 연구실 음성 + 이 폴더), lab_stats.json, audit_*.jpg
"""
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
NAME = "20261102_161617"
SRC = REPO / NAME / "frames"
OUT = HERE / "dataset_lab"
CROP = (114, 80, 351, 321)
W, H = CROP[2] - CROP[0], CROP[3] - CROP[1]
NEG_RANGE = (0, 1840)       # 육안: 1850까지 박스 없음, 1872부터 사람이 박스를 들고 들어온다
POS_RANGE = (1990, 3477)
STEP = 2
N_BLOCKS, VAL_BLOCKS = 10, {3, 8}
BOX_W_CM, BOX_D_CM, BOX_H_CM = 59.3, 21.0, 39.0
ASPECT_MIN = BOX_D_CM / BOX_H_CM * 0.9
ASPECT_MAX = math.hypot(BOX_W_CM, BOX_D_CM) / BOX_H_CM * 1.1
GROUND_A, GROUND_B, GROUND_TOL = 0.803, 135.7, 12.0
MIN_H_PX, MAX_H_PX = 8.0, 150.0
TOP_Y1_MIN = 80.0
EDGE_PX = 2.0
MINE_RUN = sys.argv[1] if len(sys.argv) > 1 else "yolov8n_graybox_v5"


def check(b):
    x1, y1, x2, y2 = b
    w, h = x2 - x1, y2 - y1
    if not MIN_H_PX <= h <= MAX_H_PX:
        return "height"
    cut_lr = x1 <= EDGE_PX or x2 >= W - EDGE_PX
    cut_bottom = y2 >= H - EDGE_PX
    a = w / h
    if (a < ASPECT_MIN and not cut_lr) or (a > ASPECT_MAX and not cut_bottom):
        return "aspect"
    if not cut_bottom and abs(y2 - (GROUND_A * h + GROUND_B)) > GROUND_TOL:
        return "ground"
    if y1 < TOP_Y1_MIN:
        return "top"
    return None


def sheet(items, path, cols=8, n=48):
    tiles = []
    for name, img, b in items[:n]:
        t = img.copy()
        if b:
            cv2.rectangle(t, (int(b[0]), int(b[1])), (int(b[2]), int(b[3])), (0, 255, 0), 1)
        cv2.putText(t, name, (3, 236), 0, 0.4, (0, 255, 255), 1)
        tiles.append(t)
    if not tiles:
        return
    tiles += [np.zeros_like(tiles[0])] * (-len(tiles) % cols)
    cv2.imwrite(str(path), np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]))


def main():
    for s in ("train", "val"):
        for k in ("images", "labels"):
            d = OUT / k / s
            d.mkdir(parents=True, exist_ok=True)
            for p in d.iterdir():
                p.unlink()
    frames = sorted(SRC.glob("*.jpg"))
    n = len(frames)
    split_of = lambda i: "val" if i * N_BLOCKS // n in VAL_BLOCKS else "train"  # noqa: E731
    stats = {"source": NAME, "frames": n, "neg_range": NEG_RANGE, "pos_range": POS_RANGE, "mine_run": MINE_RUN,
             "neg": {"train": {"hard": 0, "easy": 0}, "val": {"hard": 0, "easy": 0}},
             "pos": {"train": 0, "val": 0}, "pos_drop": {}}
    model = YOLO(str(HERE / "runs" / MINE_RUN / "weights" / "best.pt"))
    hard_items = []
    for i in range(NEG_RANGE[0], NEG_RANGE[1] + 1):
        im = cv2.imread(str(frames[i]))[CROP[1]:CROP[3], CROP[0]:CROP[2]]
        r = model.predict(im, conf=0.25, imgsz=256, verbose=False)[0]
        hard = len(r.boxes) > 0
        if not hard and i % STEP:
            continue
        sp = split_of(i)
        stem = f"lab_{NAME}_{frames[i].stem}"
        cv2.imwrite(str(OUT / "images" / sp / f"{stem}.jpg"), im)
        (OUT / "labels" / sp / f"{stem}.txt").write_text("")
        stats["neg"][sp]["hard" if hard else "easy"] += 1
        if hard:
            hard_items.append((f"{i} {float(r.boxes.conf.max()):.2f}", im, r.boxes.xyxy[0].tolist()))
    recs = {json.loads(l)["frame"]: json.loads(l) for l in open(HERE / f"labels_{NAME}.jsonl", encoding="utf-8")}
    pos_items, drop_items = [], []
    for i in range(POS_RANGE[0], min(POS_RANGE[1] + 1, n)):
        r = recs.get(frames[i].name)
        if r is None:
            continue
        im = cv2.imread(str(frames[i]))[CROP[1]:CROP[3], CROP[0]:CROP[2]]
        ok = [d for d in r["gdino"] if check(d["box_xyxy"]) is None]
        if not ok:
            top = max(r["gdino"], key=lambda d: d["score"], default=None)
            why = check(top["box_xyxy"]) if top else "none"
            stats["pos_drop"][why] = stats["pos_drop"].get(why, 0) + 1
            drop_items.append((f"{i} {why}", im, top and top["box_xyxy"]))
            continue
        b = max(ok, key=lambda d: d["score"])["box_xyxy"]
        sp = split_of(i)
        stem = f"lab_{NAME}_{frames[i].stem}"
        cv2.imwrite(str(OUT / "images" / sp / f"{stem}.jpg"), im)
        x1, y1, x2, y2 = max(0.0, b[0]), max(0.0, b[1]), min(float(W), b[2]), min(float(H), b[3])
        (OUT / "labels" / sp / f"{stem}.txt").write_text(
            f"0 {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}\n")
        stats["pos"][sp] += 1
        pos_items.append((f"{i} h{y2 - y1:.0f}", im, b))
    rng = np.random.default_rng(0)
    for items, name in ((pos_items, "pos"), (drop_items, "drop"), (hard_items, "hardneg")):
        rng.shuffle(items)
        sheet(items, OUT / f"audit_{name}.jpg")
    (OUT / "data.yaml").write_text(
        f"path: {HERE.as_posix()}\ntrain:\n  - dataset/images/train\n  - dataset_aug/images/train\n"
        f"  - dataset_far/images/train\n  - dataset_neg/images/train\n  - dataset_lab/images/train\n"
        f"val:\n  - dataset/images/val\n  - dataset_far/images/val\n  - dataset_neg/images/val\n  - dataset_lab/images/val\n"
        f"names:\n  0: gray box\n")
    (OUT / "lab_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False))


if __name__ == "__main__":
    main()
