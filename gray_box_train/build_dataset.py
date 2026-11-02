"""labels.jsonl -> YOLO 학습 데이터셋(dataset/) (2026-10-27).

- 이미지: 테두리 자른 237x241 crop(class_finder_service가 검출하는 좌표계 그대로).
- 라벨 고르기: GDINO 최고점을 그대로 쓰지 않는다. 육안 감사(audit_random.jpg)에서 점수 0.3 이상
  무작위 32장 중 5장이 틀렸다(칸막이 포함 세로 박스, 주황색 소품, 박스 윗면만 등) -- 점수만으로는
  못 가른다(audit_low.jpg: 0.27짜리도 정답이 많고 0.21~0.25는 박스가 화면 밖인 장면). 그래서 박스
  실측 치수(가로 59.3 / 깊이 21 / 높이 39cm)로 GDINO 후보 전체를 거른 뒤 통과한 것 중 최고점을 고른다.
  ① 가로세로비 w/h: 높이 39cm 기준 보일 수 있는 가로폭 21cm(옆면만)~62.9cm(대각선) -> 0.54~1.61,
     여유 10%. 좌우 끝에 닿아 잘렸으면 하한을, 아래 끝에 닿아 잘렸으면 상한을 풀어 준다.
  ② 바닥 위: 카메라가 낮아 바닥의 박스는 아래쪽 끝이 화면 아래 40% 안에 온다(y2 >= 0.6*H).
  ③ 윗변: 박스 높이 39cm는 카메라 높이와 비슷해서 가까이 찍어도 윗변이 y~95 아래다. ①②만으로는
     좌우 끝에 잘린 박스+칸막이/책상을 한 덩어리로 잡은 후보(윗변 y~44)가 175장 남았고, 윗변 80 미만
     후보 10개를 육안으로 본 결과 전부 박스 위의 물체까지 포함한 오답이었다 -> y1 >= 80(0.33*H).
  ④ 색상: ①~③ 뒤에도 높이 44~70px 라벨 88장 대부분이 책상 밑 갈색 종이상자였다(육안 16장 확인,
     회색 박스는 바로 옆에 라벨 없이 남음). 채도는 겹치지만(회색 박스가 이 카메라에서 보랏빛으로 찍혀
     S 중앙값 64) crop 색상(H, OpenCV 0~179) 중앙값은 완전히 갈렸다: 회색 박스 125~144(높이 90px 이상
     무작위 400장), 종이상자 18~22, 그 밖 오답 79~88 -> 110~160. 이 방 조명·이 카메라 색감에서 잰 값이다
     (door의 hue_gate와 같은 성격) -- 다른 장소에서는 다시 재야 한다.
  ⑤ 최소 높이 65px: 처음 35px(높이 분포가 24~27px 오답 7개 다음 45px로 끊김)로 잡았으나 ④ 뒤에도
     75px 미만 15장 중 13장이 책상 밑 검은 가방(어두워 H가 흔들려 ④를 통과), 2장이 왼쪽 끝 조각이었다.
     이 영상에서 가장 멀리 찍힌 실제 박스도 높이 ~78px이라 65px로 올렸다 -- 더 먼 거리(약 3m 이상)의
     박스는 이 데이터셋에 라벨이 없다는 한계가 생긴다.
- 음성(라벨 파일 비움)은 만들지 않는다(NEG_MAX=0): 처음엔 "통과 후보 없음 + 최고점<0.3"을 박스 없는
  장면으로 보려 했으나 육안 확인에서 그런 장면(2240·2250 등)도 박스가 화면 끝에 걸친 경우가 섞여
  있었다. 통과 후보가 없으면 판단 보류로 버린다. 배경은 라벨 없는 영역에서 학습된다.
- 다른 장소 음성(2026-10-27 추가): 1차 학습 모델이 다른 장소 프레임에서 박스를 지어냈다(흰 벽·캐비닛·
  다리·나무벽, 점수 0.3~0.78). 학습 장면이 전부 이 방이라 "이 방이 아닌 것"을 본 적이 없어서다. 그래서
  datasets/260915의 robot/rot_*.jpg(회색 박스 없는 리허설 방)를 세션 단위로 반씩 나눠 짝수 번째 세션만
  학습 음성으로 넣고, 홀수 번째 세션은 eval_model.py의 시험용으로만 남긴다(같은 프레임으로 시험하지 않음).
  이 방에서 박스가 화면 밖인 2527~2555번(판단 보류 중 육안으로 박스 없음 확인)도 음성으로 넣는다.
- 학습/검증 분리: 바로 옆 프레임은 거의 같은 그림이라 무작위로 나누면 검증이 부풀려진다.
  시간 순서로 10구간으로 나누고 VAL_BLOCKS 구간을 통째로 검증에 쓴다.
"""
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "20261026_211320" / "frames"
CROP = (114, 80, 351, 321)  # class_finder_service.BORDER_CROP_BOX
W, H = CROP[2] - CROP[0], CROP[3] - CROP[1]
BOX_W_CM, BOX_D_CM, BOX_H_CM = 59.3, 21.0, 39.0
ASPECT_MIN = BOX_D_CM / BOX_H_CM * 0.9                         # 0.48
ASPECT_MAX = math.hypot(BOX_W_CM, BOX_D_CM) / BOX_H_CM * 1.1   # 1.77
FLOOR_Y2_MIN = 0.6 * H
TOP_Y1_MIN = 80.0
HUE_RANGE = (110.0, 160.0)
MIN_H_PX = 65.0
EDGE_PX = 2.0
NEG_MAX = 0.0
N_BLOCKS, VAL_BLOCKS = 10, {3, 8}
OTHER_SCENE_DIR = HERE.parent / "datasets" / "260915"
IN_ROOM_ABSENT_N = (2527, 2555)


def other_scene_sessions():
    """robot/rot_*.jpg가 있는 세션을 이름순으로 -- (학습 음성용 짝수 번째, 시험용 홀수 번째)."""
    sessions = sorted(d for d in OTHER_SCENE_DIR.iterdir() if d.is_dir() and list(d.rglob("robot/rot_*.jpg")))
    return sessions[0::2], sessions[1::2]


def median_hue(crop_img, b):
    x1, y1, x2, y2 = [int(round(max(0.0, v))) for v in b]
    c = crop_img[y1:y2, x1:x2]
    return float(np.median(cv2.cvtColor(c, cv2.COLOR_BGR2HSV)[..., 0])) if c.size else -1.0


def passes_geometry(b):
    x1, y1, x2, y2 = b
    w, h = x2 - x1, y2 - y1
    if w <= 0 or h < MIN_H_PX:
        return False
    a = w / h
    cut_lr = x1 <= EDGE_PX or x2 >= W - EDGE_PX
    cut_bottom = y2 >= H - EDGE_PX
    if a < ASPECT_MIN and not cut_lr:
        return False
    if a > ASPECT_MAX and not cut_bottom:
        return False
    return y2 >= FLOOR_Y2_MIN and y1 >= TOP_Y1_MIN


def select(r, crop_img):
    """('pos', box, score) / ('neg', None, best) / ('drop', None, best)"""
    best = max(d["score"] for d in r["gdino"]) if r["gdino"] else 0.0
    ok = [d for d in r["gdino"] if passes_geometry(d["box_xyxy"])
          and HUE_RANGE[0] <= median_hue(crop_img, d["box_xyxy"]) <= HUE_RANGE[1]]
    if ok:
        d = max(ok, key=lambda d: d["score"])
        return "pos", d["box_xyxy"], d["score"]
    return ("neg" if best < NEG_MAX else "drop"), None, best


def main():
    recs = [json.loads(l) for l in open(HERE / "labels.jsonl", encoding="utf-8")]
    n_max = max(r["n"] for r in recs)
    out = HERE / "dataset"
    counts = {s: {"pos": 0, "neg": 0} for s in ("train", "val")}
    dropped, changed = [], []
    selection = []
    cl, ct, cr, cb = CROP
    for r in recs:
        crop_img = cv2.imread(str(SRC / r["frame"]))[ct:cb, cl:cr]
        kind, box, score = select(r, crop_img)
        selection.append({"n": r["n"], "frame": r["frame"], "kind": kind, "box_xyxy": box, "score": score,
                          "changed_from_top": kind == "pos" and box != r.get("box_xyxy")})
        if kind == "drop" and IN_ROOM_ABSENT_N[0] <= r["n"] <= IN_ROOM_ABSENT_N[1]:
            kind = "neg"  # 육안 확인: 박스가 화면 밖
        if kind == "drop":
            dropped.append(r["n"])
            continue
        if kind == "pos" and box != r.get("box_xyxy"):
            changed.append(r["n"])
        split = "val" if (r["n"] - 1) * N_BLOCKS // n_max in VAL_BLOCKS else "train"
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
        stem = Path(r["frame"]).stem
        cv2.imwrite(str(out / "images" / split / f"{stem}.jpg"), crop_img)
        line = ""
        if kind == "pos":
            x1, y1, x2, y2 = [max(0.0, v) for v in box]
            x2, y2 = min(x2, W), min(y2, H)
            line = f"0 {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}\n"
        counts[split][kind] += 1
        (out / "labels" / split / f"{stem}.txt").write_text(line)
    train_sessions, test_sessions = other_scene_sessions()
    other_neg = 0
    for sess in train_sessions:
        for p in sorted(sess.rglob("robot/rot_*.jpg")):
            im = cv2.imread(str(p))
            if im.shape[1] == 464 and im.shape[0] == 400:
                im = im[CROP[1]:CROP[3], CROP[0]:CROP[2]]
            stem = f"other_{sess.name[:6]}_{p.stem}"
            cv2.imwrite(str(out / "images" / "train" / f"{stem}.jpg"), im)
            (out / "labels" / "train" / f"{stem}.txt").write_text("")
            other_neg += 1
    (out / "data.yaml").write_text(
        f"path: {out.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n  0: gray box\n")
    (HERE / "selection.jsonl").write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in selection),
                                          encoding="utf-8")
    stats = {"neg_max": NEG_MAX, "aspect_range": [round(ASPECT_MIN, 3), round(ASPECT_MAX, 3)],
             "floor_y2_min_px": FLOOR_Y2_MIN, "top_y1_min_px": TOP_Y1_MIN, "hue_range": HUE_RANGE,
             "min_h_px": MIN_H_PX, "val_blocks": sorted(VAL_BLOCKS), "n_blocks": N_BLOCKS,
             "dropped_undecided": len(dropped),
             "other_scene_negatives_train": other_neg,
             "other_scene_train_sessions": [s.name for s in train_sessions],
             "other_scene_test_sessions": [s.name for s in test_sessions], "label_changed_from_gdino_top": len(changed), **counts}
    (out / "dataset_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(stats)


if __name__ == "__main__":
    main()
