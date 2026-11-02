"""gray box 증강 2차 -- 시연 장소를 못 찍는 대신 「다른 장소」를 넓힌다 -> dataset_aug2/ (2026-11-02).

왜: 시연 장소에 지금 갈 수 없어 그곳 영상을 받을 수 없다(사용자). 학습 장면은 사무실(연구실) 한 곳과 복도 한 곳이고, 먼 박스(15~30px)는
복도에만 있다. augment_dataset.py(1차)의 장소 붙여 넣기는 배경이 85장뿐이었다. 그래서 두 가지를 더 만든다.
  place2 : 박스를 다른 배경에 바닥 관계(y2 = 0.803·h + 135.7)대로 붙인다. 배경 = 박스 없는 학습 음성 전부
           (datasets/260915 짝수 세션, 이 방 2527~2555번, dataset_neg·dataset_lab의 학습 음성 -- 약 1,600장).
           가까운 박스(h 40~150)는 원래 영상에서 GrabCut으로, 먼 박스(h 14~32)는 dataset_far 학습 양성에서 4배로 키워 GrabCut한 뒤
           줄여서 오린다(작은 박스에 GrabCut을 바로 걸면 마스크가 깨진다). 절반은 1차의 조명 증강을 함께 건다.
  venue  : 실제 양성(원래 영상·먼 거리·연구실 박스 배치 학습 분) 전체의 색감을 크게 바꾼다 -- 색조 회전 ±10(OpenCV 0~179),
           채도 0.6~1.4배, 채널별 화이트밸런스 0.75~1.25, 밝기·대비. 조명 색이 다른 장소에서 박스·바닥 색이 함께 바뀌는 것을 흉내 낸다.
           1차 light는 그늘·노이즈 위주였고 색 이동은 ±20%까지만이었다.
누설 방지: 원본·배경 모두 각 데이터셋의 학습(train) 분만 쓴다. 검증, eval_model.py의 시험 세션(260915 홀수 세션·rot8),
box_meter, live_test, 먼 거리 검증 구간은 손대지 않는다.
한계: 시연 장소에서의 효과는 잴 수 없다. 기존 시험에서 나빠지지 않는지만 본다. 연구실 배경은 live_test 사무실 판과 같은 방이다
(그림은 겹치지 않지만 장소가 같다).
사용: python augment_dataset2.py [place2 장수=1500] [venue 장수=1000]
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import augment_dataset as a1  # noqa: E402  (light_ops·cut_box·box_visible·yolo_line 재사용)

OUT = HERE / "dataset_aug2"
N_PLACE = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
N_VENUE = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
FAR_SHARE = 0.4
W, H = a1.W, a1.H
rng = np.random.default_rng(1)


def labeled(ds):
    """(이미지, 박스 xyxy 또는 None) -- 학습 분만."""
    out = []
    for lp in sorted((HERE / ds / "labels" / "train").glob("*.txt")):
        out.append((HERE / ds / "images" / "train" / f"{lp.stem}.jpg", a1.read_label(lp)))
    return out


def cut_small(src, b):
    """먼 박스: 4배로 키운 patch에 GrabCut -> 마스크를 원래 크기로. 실패하면 None."""
    im = cv2.imread(str(src))
    x1, y1, x2, y2 = [int(round(v)) for v in b]
    m = 3
    X1, Y1, X2, Y2 = max(0, x1 - m), max(0, y1 - m), min(W, x2 + m), min(H, y2 + m)
    if x1 <= 2 or x2 >= W - 2 or y2 >= H - 2 or (y2 - y1) < 10:
        return None
    patch = im[Y1:Y2, X1:X2]
    big = cv2.resize(patch, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    mask = np.zeros(big.shape[:2], np.uint8)
    rect = ((x1 - X1) * 4, (y1 - Y1) * 4, (x2 - x1) * 4, (y2 - y1) * 4)
    try:
        cv2.grabCut(big, mask, rect, np.zeros((1, 65)), np.zeros((1, 65)), 3, cv2.GC_INIT_WITH_RECT)
    except cv2.error:
        return None
    fg = np.isin(mask, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.uint8)
    fg = cv2.resize(fg, (X2 - X1, Y2 - Y1), interpolation=cv2.INTER_AREA)[(y1 - Y1):(y2 - Y1), (x1 - X1):(x2 - X1)]
    if not 0.55 <= fg.mean() <= 0.99:
        return None
    return im[y1:y2, x1:x2], fg


def paste(patch, fg, h_new, bg):
    ph, pw = patch.shape[:2]
    s = h_new / ph
    nw, nh = max(4, int(round(pw * s))), max(4, int(round(ph * s)))
    patch = cv2.resize(patch, (nw, nh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    alpha = cv2.GaussianBlur(cv2.resize(fg.astype(np.float32), (nw, nh)), (3, 3), 0)[..., None]
    y2 = int(round(a1.GROUND_A * nh + a1.GROUND_B + rng.uniform(*a1.GROUND_RES)))
    y1 = y2 - nh
    x1 = int(rng.integers(-nw // 4, W - 3 * nw // 4))
    out = bg.astype(np.float32)
    ax1, ay1, ax2, ay2 = max(0, x1), max(0, y1), min(W, x1 + nw), min(H, y2)
    if ax2 <= ax1 or ay2 <= ay1:
        return None
    px1, py1 = ax1 - x1, ay1 - y1
    pa = alpha[py1:py1 + ay2 - ay1, px1:px1 + ax2 - ax1]
    pp = patch[py1:py1 + ay2 - ay1, px1:px1 + ax2 - ax1].astype(np.float32)
    region = out[ay1:ay2, ax1:ax2]
    ratio = float(np.clip((region.mean() + 1) / (pp.mean() + 1), 0.6, 1.6)) ** 0.5
    pp = np.clip(pp * ratio, 0, 255)
    sh = np.zeros((H, W), np.float32)
    cv2.ellipse(sh, (int(x1 + nw / 2), int(y2)), (int(nw * 0.55), max(1, int(nh * 0.08))), 0, 0, 360, 1.0, -1)
    out = out * (1 - 0.45 * cv2.GaussianBlur(sh, (9, 9), 0)[..., None])
    out[ay1:ay2, ax1:ax2] = out[ay1:ay2, ax1:ax2] * (1 - pa) + pp * pa
    ys, xs = np.nonzero(pa[..., 0] > 0.5)
    if len(xs) < 20:
        return None
    return out.clip(0, 255).astype(np.uint8), [float(ax1 + xs.min()), float(ay1 + ys.min()),
                                              float(ax1 + xs.max() + 1), float(ay1 + ys.max() + 1)]


def venue_shift(im):
    hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV).astype(np.float32)
    dh = float(rng.uniform(-10, 10))
    ss = float(rng.uniform(0.6, 1.4))
    hsv[..., 0] = (hsv[..., 0] + dh) % 180
    hsv[..., 1] = np.clip(hsv[..., 1] * ss, 0, 255)
    out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)
    gains = rng.uniform(0.75, 1.25, 3)
    bright, con = float(rng.uniform(0.7, 1.3)), float(rng.uniform(0.75, 1.25))
    out = ((out * gains * bright) - 128) * con + 128
    return out.clip(0, 255).astype(np.uint8), f"dh{dh:+.0f}/s{ss:.2f}/wb" + "/".join(f"{g:.2f}" for g in gains) + \
        f"/b{bright:.2f}/c{con:.2f}"


def main():
    for k in ("images", "labels"):
        d = OUT / k / "train"
        d.mkdir(parents=True, exist_ok=True)
        for p in d.iterdir():
            p.unlink()
    near = [x for x in labeled("dataset") if x[1]]
    far = [x for x in labeled("dataset_far") if x[1]]
    lab_pos = [x for x in labeled("dataset_lab") if x[1]]
    bgs = [p for p, b in labeled("dataset") + labeled("dataset_neg") + labeled("dataset_lab") if b is None]
    log, stats = [], {"backgrounds": len(bgs), "sources": {"near": len(near), "far": len(far), "lab_pos": len(lab_pos)},
                      "made": {}, "fail": {}}
    samples = {"place2": [], "venue": []}

    made = fail = 0
    while made < N_PLACE and fail < N_PLACE * 10:
        is_far = rng.random() < FAR_SHARE
        src, b = (far if is_far else near)[rng.integers(len(far if is_far else near))]
        cut = cut_small(src, b) if is_far else a1.cut_box(src, b)
        if cut is None:
            fail += 1
            continue
        bgp = bgs[rng.integers(len(bgs))]
        bg = cv2.imread(str(bgp))
        bg = cv2.resize(bg, (W, H)) if bg.shape[:2] != (H, W) else bg
        if rng.random() < 0.5:
            bg = bg[:, ::-1].copy()
        h_new = float(rng.uniform(14, 32) if is_far else rng.uniform(40, 150))
        r = paste(*cut, h_new, bg)
        if r is None:
            fail += 1
            continue
        im, nb = r
        meta = {"kind": "place2", "far": is_far, "source": src.stem, "bg": bgp.stem, "h_px": round(nb[3] - nb[1], 1)}
        if rng.random() < 0.5:
            im, ops = a1.light_ops(im)
            meta["light"] = ops
        if not a1.box_visible(im, nb):
            fail += 1
            continue
        stem = f"aug2_place_{made:04d}"
        cv2.imwrite(str(OUT / "images" / "train" / f"{stem}.jpg"), im)
        (OUT / "labels" / "train" / f"{stem}.txt").write_text(a1.yolo_line(nb))
        log.append({"file": stem, **meta, "box_xyxy": [round(v, 1) for v in nb]})
        if len(samples["place2"]) < 48:
            samples["place2"].append((f"{'far' if is_far else 'near'} h{nb[3] - nb[1]:.0f}", im, nb))
        made += 1
    stats["made"]["place2"], stats["fail"]["place2"] = made, fail

    pool = near + far + lab_pos
    for i in range(N_VENUE):
        src, b = pool[rng.integers(len(pool))]
        im, desc = venue_shift(cv2.imread(str(src)))
        stem = f"aug2_venue_{i:04d}"
        cv2.imwrite(str(OUT / "images" / "train" / f"{stem}.jpg"), im)
        (OUT / "labels" / "train" / f"{stem}.txt").write_text(a1.yolo_line(b))
        log.append({"file": stem, "kind": "venue", "source": src.stem, "shift": desc})
        if len(samples["venue"]) < 48:
            samples["venue"].append((desc[:14], im, b))
    stats["made"]["venue"] = N_VENUE
    for k, v in samples.items():
        a1.audit_sheet(v, OUT / f"audit_{k}.jpg")
    (OUT / "data.yaml").write_text(
        f"path: {HERE.as_posix()}\ntrain:\n  - dataset/images/train\n  - dataset_aug/images/train\n"
        f"  - dataset_far/images/train\n  - dataset_neg/images/train\n  - dataset_lab/images/train\n"
        f"  - dataset_aug2/images/train\n"
        f"val:\n  - dataset/images/val\n  - dataset_far/images/val\n  - dataset_neg/images/val\n  - dataset_lab/images/val\n"
        f"names:\n  0: gray box\n")
    (OUT / "augment2_log.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in log),
                                            encoding="utf-8")
    (OUT / "augment2_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(stats)


if __name__ == "__main__":
    main()
