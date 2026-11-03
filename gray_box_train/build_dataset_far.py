"""labels_box_*.jsonl(먼 거리 GDINO 라벨) -> dataset_far/ (2026-11-02).

box_2m / box_2.5m / box_3m: 사용자가 복도에서 박스까지 거리(카메라 렌즈 기준)를 정해 놓고 Go1을 옆으로 옮기고
돌려 가며 찍은 영상. 박스 높이가 crop에서 15~30px라 build_dataset.py의 조건 중 두 개를 바꾼다.
  ⑤ 높이 >= 65px -> 바닥 관계: 아랫변 y2가 학습 라벨에서 맞춘 y2 = 0.803*h + 135.7 에서 GROUND_TOL 안.
     65px는 가까운 책상 밑 검은 가방을 거르려던 값이라 먼 박스를 통째로 버린다. 바닥 위가 아닌 물체(벽 장식·
     복도 끝 물체)는 이 관계로 걸린다. 2026-11-02 v2 검출 149개로 잰 2m 잔차는 -6.8~-3.4px.
  ④ 색상 H 110~160 -> 끈다(HUE_RANGE=None). 처음엔 복도 조명의 박스 H(106~141, v2 검출 149개)에 맞춰 100~160으로
     낮췄으나, 감사(audit_drop_*.jpg)에서 hue로 떨어진 60장이 거의 전부 밝게 날아간 복도 끝 앞에 선 옆면 박스였다
     (역광이라 crop 색상이 배경 쪽으로 쏠림) -- 학습시키려던 어려운 장면을 버리는 셈이다. 색 조건은 사무실의
     갈색 종이상자·검은 가방을 거르려던 것인데 이 복도 영상에는 그런 물체가 없다. 되살린 장면은 audit_hue_*.jpg로 확인.
  ①(가로세로비)·③(윗변) 규칙과 화면 끝 처리는 build_dataset.py 그대로다. 높이 상한 MAX_H_PX로 가까운 물체를 막는다.
학습/검증 분리: 폴더마다 시간 순서 10구간 중 VAL_BLOCKS를 통째로 검증 겸 시험에 쓴다(바로 옆 프레임은 같은 그림).
결과: dataset_far/images|labels/{train,val}, dataset_far/data.yaml(기존 + 증강 + 먼 거리), far_stats.json, audit_*.jpg
"""
import json
import math
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = HERE / "dataset_far"
# 2026-11-02 밤 v9: sidebox_*(박스 정면 거리를 두고 로봇을 옆으로 왕복 -- 박스가 화면 왼쪽·오른쪽 가장자리를 오간다)를 더한다
FOLDERS = ["box_2m", "box_2.5m", "box_3m", "sidebox_2m", "sidebox_2.5m", "sidebox_3m"]
CROP = (114, 80, 351, 321)
W, H = CROP[2] - CROP[0], CROP[3] - CROP[1]
BOX_W_CM, BOX_D_CM, BOX_H_CM = 59.3, 21.0, 39.0
ASPECT_MIN = BOX_D_CM / BOX_H_CM * 0.9
ASPECT_MAX = math.hypot(BOX_W_CM, BOX_D_CM) / BOX_H_CM * 1.1
GROUND_A, GROUND_B, GROUND_TOL = 0.803, 135.7, 12.0
HUE_RANGE = None
MIN_H_PX, MAX_H_PX = 8.0, 60.0
TOP_Y1_MIN = 80.0
EDGE_PX = 2.0
N_BLOCKS, VAL_BLOCKS = 10, {3, 8}


def median_hue(img, b):
    x1, y1, x2, y2 = [int(round(max(0.0, v))) for v in b]
    c = img[y1:y2, x1:x2]
    return float(np.median(cv2.cvtColor(c, cv2.COLOR_BGR2HSV)[..., 0])) if c.size else -1.0


def check(b, img):
    """통과하면 None, 아니면 떨어진 이유."""
    x1, y1, x2, y2 = b
    w, h = x2 - x1, y2 - y1
    if not MIN_H_PX <= h <= MAX_H_PX:
        return "height"
    a = w / h
    cut_lr = x1 <= EDGE_PX or x2 >= W - EDGE_PX
    if (a < ASPECT_MIN and not cut_lr) or a > ASPECT_MAX:
        return "aspect"
    if abs(y2 - (GROUND_A * h + GROUND_B)) > GROUND_TOL:
        return "ground"
    if y1 < TOP_Y1_MIN:
        return "top"
    if HUE_RANGE and not HUE_RANGE[0] <= median_hue(img, b) <= HUE_RANGE[1]:
        return "hue"
    return None


def sheet(items, path, cols=8, n=48):
    tiles = []
    for name, img, b in items[:n]:
        t = img[60:200].copy()
        if b:
            cv2.rectangle(t, (int(b[0]), int(b[1]) - 60), (int(b[2]), int(b[3]) - 60), (0, 255, 0), 1)
        t = cv2.resize(t, (W * 2, 280))
        cv2.putText(t, name, (3, 272), 0, 0.45, (0, 255, 255), 1)
        tiles.append(t)
    if not tiles:
        return
    tiles += [np.zeros_like(tiles[0])] * (-len(tiles) % cols)
    cv2.imwrite(str(path), np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]))


def main():
    rng = np.random.default_rng(0)
    for s in ("train", "val"):
        for k in ("images", "labels"):
            d = OUT / k / s
            d.mkdir(parents=True, exist_ok=True)
            for p in d.iterdir():
                p.unlink()
    stats = {"ground": [GROUND_A, GROUND_B, GROUND_TOL], "hue_range": HUE_RANGE, "h_range": [MIN_H_PX, MAX_H_PX],
             "val_blocks": sorted(VAL_BLOCKS), "folders": {}}
    for folder in FOLDERS:
        recs = [json.loads(l) for l in open(HERE / f"labels_{folder}.jsonl", encoding="utf-8")]
        n_max = max(r["n"] for r in recs)
        st = {"frames": len(recs), "pos": {"train": 0, "val": 0}, "drop": 0, "drop_reasons": {}, "no_gdino": 0}
        pos_items, drop_items, hue_items, hs = [], [], [], []
        for r in recs:
            img = cv2.imread(str(REPO / folder / "frames" / r["frame"]))[CROP[1]:CROP[3], CROP[0]:CROP[2]]
            if not r["gdino"]:
                st["no_gdino"] += 1
                drop_items.append((r["frame"][-8:-4] + " none", img, None))
                continue
            ok, reasons = [], []
            for d in r["gdino"]:
                why = check(d["box_xyxy"], img)
                (reasons.append(why) if why else ok.append(d))
            if not ok:
                st["drop"] += 1
                top = max(r["gdino"], key=lambda d: d["score"])
                why = check(top["box_xyxy"], img)
                st["drop_reasons"][why] = st["drop_reasons"].get(why, 0) + 1
                drop_items.append((f"{r['frame'][-8:-4]} {why} {top['score']:.2f}", img, top["box_xyxy"]))
                continue
            d = max(ok, key=lambda d: d["score"])
            b = d["box_xyxy"]
            split = "val" if (r["n"] - 1) * N_BLOCKS // n_max in VAL_BLOCKS else "train"
            stem = f"far_{folder.replace('.', 'p')}_{Path(r['frame']).stem}"
            cv2.imwrite(str(OUT / "images" / split / f"{stem}.jpg"), img)
            x1, y1, x2, y2 = max(0.0, b[0]), max(0.0, b[1]), min(float(W), b[2]), min(float(H), b[3])
            (OUT / "labels" / split / f"{stem}.txt").write_text(
                f"0 {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}\n")
            st["pos"][split] += 1
            hs.append(y2 - y1)
            hue = median_hue(img, b)
            pos_items.append((f"{r['frame'][-8:-4]} {d['score']:.2f} h{y2 - y1:.0f} H{hue:.0f}", img, b))
            if not 100.0 <= hue <= 160.0:
                hue_items.append(pos_items[-1])
        st["h_px_p5_p50_p95"] = [round(float(v), 1) for v in np.percentile(hs, [5, 50, 95])] if hs else None
        stats["folders"][folder] = st
        rng.shuffle(pos_items)
        sheet(pos_items, OUT / f"audit_pos_{folder}.jpg")
        rng.shuffle(drop_items)
        sheet(drop_items, OUT / f"audit_drop_{folder}.jpg")
        st["outside_old_hue_100_160"] = len(hue_items)
        sheet(hue_items, OUT / f"audit_hue_{folder}.jpg", n=64)
    (OUT / "data.yaml").write_text(
        f"path: {HERE.as_posix()}\ntrain:\n  - dataset/images/train\n  - dataset_aug/images/train\n"
        f"  - dataset_far/images/train\nval:\n  - dataset/images/val\n  - dataset_far/images/val\nnames:\n  0: gray box\n")
    (OUT / "far_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
