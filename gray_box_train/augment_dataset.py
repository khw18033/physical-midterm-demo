"""gray box 학습 데이터 오프라인 증강 -> dataset_aug/ (2026-11-02).

왜: 2026-11-01~02 실연동 판 3개(demo/test/try_box*)를 육안으로 보니 놓친 장면이 ① 의자 다리에 가려진 박스,
② 문 옆 그늘의 어두운 박스였고, 학습은 20261026_211320 한 방·한 조명뿐이다. 먼 거리(박스 높이 ~30px)는
사용자가 새로 찍기로 했으므로 여기서는 다루지 않는다(크기 변형으로 흉내 낸 v3가 효과 없었음, RESULT.md 4절).
그래서 이미 있는 학습 이미지로 세 가지를 만든다.
  occl  : 가려짐 -- 의자·책상 다리 같은 세로 막대, 옆에서 박스 일부를 가리는 다른 장면 조각,
          바닥의 낮은 물체(가방 등). 라벨은 원래 박스 전체 그대로 둔다(거리 계산이 박스 전체 높이를 쓴다).
          보이는 면적이 50% 미만이 되면 다시 뽑는다.
  light : 조명 -- 전체 감마·대비, 부분 그늘(경계 흐린 다각형/띠), 색온도(채널별 이득), 바닥 반사광,
          노이즈·흐림·JPEG 압축 중 2~4개를 겹친다.
  place : 장소 -- 박스를 GrabCut으로 오려 다른 장소 배경에 붙인다. 위치는 학습 라벨에서 맞춘 바닥 관계
          y2 = 0.803*h + 135.7(잔차 5~95% -3.5~4.5px, 2026-11-02 실측)을 따라 정해서 공중에 뜬 박스를
          만들지 않는다. 밝기를 배경 쪽으로 반쯤 맞추고 아래에 접지 그림자를 깐다. 절반은 light도 함께 건다.

누설 방지: 원본은 학습(train) 양성만, 배경은 이미 학습 음성으로 쓰던 장면만(datasets/260915 짝수 세션 +
이 방에서 박스가 화면 밖인 2527~2555번) 쓴다. 검증(val), eval_model.py의 시험 세션(홀수 세션, rot8),
box_meter, 실연동 판(try_box*)은 손대지 않는다 -- 증강 효과를 이 시험들로만 잰다.
기존 dataset/은 바꾸지 않고, dataset_aug/data.yaml이 dataset/images/train + dataset_aug/images/train을
함께 학습 목록으로 쓴다.
사용: python augment_dataset.py [종류별 장수=900]
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
BASE = HERE / "dataset"
OUT = HERE / "dataset_aug"
N_PER_KIND = int(sys.argv[1]) if len(sys.argv) > 1 else 900
SEED = 0
W, H = 237, 241
GROUND_A, GROUND_B, GROUND_RES = 0.803, 135.7, (-3.5, 4.5)  # y2 = A*h + B (학습 라벨 2915개에서 맞춤)
MIN_VISIBLE = 0.5
rng = np.random.default_rng(SEED)


def read_label(p):
    t = p.read_text().split()
    if not t:
        return None
    cx, cy, w, h = map(float, t[1:5])
    return [(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H]


def yolo_line(b):
    x1, y1, x2, y2 = max(0.0, b[0]), max(0.0, b[1]), min(float(W), b[2]), min(float(H), b[3])
    return f"0 {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}\n"


def load_sources():
    pos, neg = [], []
    for lp in sorted((BASE / "labels" / "train").glob("*.txt")):
        ip = BASE / "images" / "train" / f"{lp.stem}.jpg"
        b = read_label(lp)
        (pos if b else neg).append((ip, b))
    return pos, [p for p, _ in neg]


# ---------------------------------------------------------------- 가려짐
DARK_COLORS = [(25, 25, 28), (45, 45, 50), (70, 70, 75), (40, 60, 90), (30, 45, 70), (140, 140, 145), (170, 170, 175)]


def occ_legs(im, b, mask):
    """의자·책상 다리: 박스를 세로로 지나는 막대 1~3개(기울기 ±15도, 박스 위쪽에서 시작해 박스 아래까지)."""
    x1, y1, x2, y2 = b
    bw, bh = x2 - x1, y2 - y1
    for _ in range(rng.integers(1, 4)):
        w = max(3, int(bw * rng.uniform(0.06, 0.18)))
        xc = rng.uniform(x1 + 0.1 * bw, x2 - 0.1 * bw)
        top = rng.uniform(0, y1 + 0.3 * bh)
        bot = rng.uniform(y2 - 0.1 * bh, min(H, y2 + 0.3 * bh))
        dx = np.tan(np.radians(rng.uniform(-15, 15))) * (bot - top)
        pts = np.array([[xc - w / 2, top], [xc + w / 2, top], [xc + w / 2 + dx, bot], [xc - w / 2 + dx, bot]], np.int32)
        c = np.array(DARK_COLORS[rng.integers(len(DARK_COLORS))], np.float32) * rng.uniform(0.8, 1.2)
        cv2.fillPoly(im, [pts], c.clip(0, 255).tolist())
        cv2.fillPoly(mask, [pts], 0)
        if rng.random() < 0.4:  # 의자 바퀴 받침: 아래쪽 가로 막대
            yb = int(min(H - 3, bot))
            hx = int(bw * rng.uniform(0.2, 0.5))
            cv2.rectangle(im, (int(xc + dx - hx), yb - 3), (int(xc + dx + hx), yb + 2), c.clip(0, 255).tolist(), -1)


def occ_side(im, b, mask, bgs):
    """옆에서 가리는 물체: 다른 학습 음성 장면의 조각을 박스 좌/우 15~45%에 덮는다(캐비닛·다른 상자 흉내)."""
    x1, y1, x2, y2 = [int(v) for v in b]
    bw = x2 - x1
    cw = max(4, int(bw * rng.uniform(0.15, 0.45)))
    ct = int(max(0, y1 - rng.uniform(0, 0.8) * (y2 - y1)))
    cb = int(min(H, y2 + rng.uniform(0, 10)))
    left = rng.random() < 0.5
    px1 = x1 - int(rng.uniform(0, 0.5) * cw) if left else x2 - cw + int(rng.uniform(0, 0.5) * cw)
    px1 = int(np.clip(px1, 0, W - cw))
    bg = cv2.imread(str(bgs[rng.integers(len(bgs))]))
    bg = cv2.resize(bg, (W, H)) if bg.shape[:2] != (H, W) else bg
    sx = int(rng.integers(0, W - cw + 1))
    im[ct:cb, px1:px1 + cw] = bg[ct:cb, sx:sx + cw]
    mask[ct:cb, px1:px1 + cw] = 0


def occ_low(im, b, mask, bgs):
    """바닥의 낮은 물체(가방 등): 박스 아래쪽 15~35%를 어두운 덩어리로 가린다."""
    x1, y1, x2, y2 = b
    bw, bh = x2 - x1, y2 - y1
    ow, oh = bw * rng.uniform(0.3, 0.7), bh * rng.uniform(0.15, 0.35)
    cx = rng.uniform(x1, x2)
    center = (int(cx), int(y2 + oh * rng.uniform(-0.1, 0.3)))
    axes = (int(ow / 2), int(oh))
    c = np.array(DARK_COLORS[rng.integers(5)], np.float32) * rng.uniform(0.7, 1.2)
    cv2.ellipse(im, center, axes, 0, 180, 360, c.clip(0, 255).tolist(), -1)
    cv2.ellipse(mask, center, axes, 0, 180, 360, 0, -1)


def make_occl(src, b, bgs):
    im0 = cv2.imread(str(src))
    x1, y1, x2, y2 = [int(round(v)) for v in b]
    area = max(1, (x2 - x1) * (y2 - y1))
    for _ in range(10):
        im, mask = im0.copy(), np.zeros((H, W), np.uint8)
        mask[max(0, y1):y2, max(0, x1):x2] = 1
        kinds = []
        for k, p in (("legs", 0.6), ("side", 0.45), ("low", 0.3)):
            if rng.random() < p:
                kinds.append(k)
        kinds = kinds or ["legs"]
        for k in kinds:
            (occ_legs(im, b, mask) if k == "legs" else occ_side(im, b, mask, bgs) if k == "side"
             else occ_low(im, b, mask, bgs))
        vis = mask.sum() / area
        if MIN_VISIBLE <= vis < 0.97:
            return im, b, {"ops": kinds, "visible": round(float(vis), 3)}
    return None


# ---------------------------------------------------------------- 조명
def soft_mask(shape):
    m = np.zeros(shape, np.float32)
    if rng.random() < 0.5:  # 다각형 그늘
        n = rng.integers(3, 7)
        c = rng.uniform([0, 0], [W, H])
        r = rng.uniform(40, 160)
        ang = np.sort(rng.uniform(0, 2 * np.pi, n))
        pts = (c + np.stack([np.cos(ang), np.sin(ang)], 1) * r * rng.uniform(0.5, 1.0, (n, 1))).astype(np.int32)
        cv2.fillPoly(m, [pts], 1.0)
    else:  # 띠 모양(문틀·기둥 그림자)
        ang = rng.uniform(-60, 60)
        w = rng.uniform(30, 120)
        c = rng.uniform(0, W)
        yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
        d = (xx - c) * np.cos(np.radians(ang)) + (yy - H / 2) * np.sin(np.radians(ang))
        m[np.abs(d) < w / 2] = 1.0
    k = int(rng.integers(7, 31)) | 1
    return cv2.GaussianBlur(m, (k, k), 0)


def light_ops(im):
    f = im.astype(np.float32) / 255.0
    ops = []
    choices = ["gamma", "shadow", "wb", "glare", "noise", "blur", "jpeg"]
    probs = np.array([0.7, 0.6, 0.5, 0.25, 0.35, 0.3, 0.35])
    pick = [c for c, p in zip(choices, probs) if rng.random() < p]
    while len(pick) < 2:
        c = choices[rng.integers(len(choices))]
        if c not in pick:
            pick.append(c)
    pick = pick[:4]
    if "gamma" in pick:
        g = float(rng.choice([rng.uniform(1.3, 1.9), rng.uniform(0.6, 0.85)], p=[0.65, 0.35]))  # 어두운 쪽 위주
        con = float(rng.uniform(0.7, 1.2))
        f = np.clip(((f ** g) - 0.5) * con + 0.5, 0, 1)
        ops.append(f"gamma{g:.2f}/con{con:.2f}")
    if "shadow" in pick:
        s = float(rng.uniform(0.45, 0.75))
        m = soft_mask((H, W))[..., None]
        f = f * (1 - m * (1 - s))
        ops.append(f"shadow{s:.2f}")
    if "wb" in pick:
        gains = rng.uniform(0.8, 1.2, 3).astype(np.float32)
        f = np.clip(f * gains, 0, 1)
        ops.append("wb" + "/".join(f"{v:.2f}" for v in gains))
    if "glare" in pick:  # 복도 바닥 반사광
        m = np.zeros((H, W), np.float32)
        for _ in range(rng.integers(1, 4)):
            cv2.ellipse(m, (int(rng.uniform(0, W)), int(rng.uniform(H * 0.55, H))),
                        (int(rng.uniform(5, 25)), int(rng.uniform(3, 12))), 0, 0, 360, 1.0, -1)
        m = cv2.GaussianBlur(m, (15, 15), 0)[..., None]
        f = np.clip(f + m * rng.uniform(0.3, 0.7), 0, 1)
        ops.append("glare")
    out = (f * 255).astype(np.uint8)
    if "blur" in pick:
        k = int(rng.integers(3, 8))
        if rng.random() < 0.5:
            out = cv2.GaussianBlur(out, (k | 1, k | 1), 0)
        else:  # 걸으면서 생기는 가로 흔들림
            kern = np.zeros((k, k), np.float32)
            kern[k // 2, :] = 1.0 / k
            out = cv2.filter2D(out, -1, kern)
        ops.append(f"blur{k}")
    if "noise" in pick:
        s = float(rng.uniform(3, 10))
        out = np.clip(out.astype(np.float32) + rng.normal(0, s, out.shape), 0, 255).astype(np.uint8)
        ops.append(f"noise{s:.0f}")
    if "jpeg" in pick:
        q = int(rng.integers(25, 70))
        out = cv2.imdecode(cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, q])[1], 1)
        ops.append(f"jpeg{q}")
    return out, ops


MIN_BOX_MEAN, MIN_BOX_STD = 20.0, 4.0


def box_visible(im, b):
    """박스 영역 밝기 평균·표준편차가 너무 낮으면(새까맣게 뭉개짐) 라벨을 달 수 없는 그림으로 본다.
    2026-11-02 첫 감사(audit_light.jpg)에서 감마 2.2 + 그늘 0.35가 겹친 장은 박스가 육안으로 안 보였다."""
    x1, y1, x2, y2 = [int(round(v)) for v in b]
    g = cv2.cvtColor(im[max(0, y1):y2, max(0, x1):x2], cv2.COLOR_BGR2GRAY)
    return g.size > 0 and g.mean() >= MIN_BOX_MEAN and g.std() >= MIN_BOX_STD


def make_light(src, b):
    im, ops = light_ops(cv2.imread(str(src)))
    if not box_visible(im, b):
        return None
    return im, b, {"ops": ops}


# ---------------------------------------------------------------- 장소
def cut_box(src, b):
    """GrabCut으로 박스만 오린다. 마스크가 라벨 사각형의 55~99%를 못 채우면 실패로 본다."""
    im = cv2.imread(str(src))
    x1, y1, x2, y2 = [int(round(v)) for v in b]
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(W, x2), min(H, y2)
    if x2 - x1 < 20 or y2 - y1 < 20 or x1 <= 2 or x2 >= W - 2 or y2 >= H - 2:
        return None  # 화면 끝에 잘린 박스는 오려 붙이면 잘린 면이 그대로 드러난다
    m = np.zeros((H, W), np.uint8)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(im, m, (x1, y1, x2 - x1, y2 - y1), bgd, fgd, 3, cv2.GC_INIT_WITH_RECT)
    except cv2.error:
        return None
    fg = np.isin(m, (cv2.GC_FGD, cv2.GC_PR_FGD)).astype(np.uint8)[y1:y2, x1:x2]
    if not 0.55 <= fg.mean() <= 0.99:
        return None
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return im[y1:y2, x1:x2], fg


def make_place(src, b, bgs):
    cut = cut_box(src, b)
    if cut is None:
        return None
    patch, fg = cut
    ph, pw = patch.shape[:2]
    h_new = float(rng.uniform(40, 150))
    s = h_new / ph
    nw, nh = max(8, int(round(pw * s))), max(8, int(round(ph * s)))
    patch = cv2.resize(patch, (nw, nh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    alpha = cv2.resize(fg.astype(np.float32), (nw, nh))
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)[..., None]
    y2 = int(round(GROUND_A * nh + GROUND_B + rng.uniform(*GROUND_RES)))
    y1 = y2 - nh
    x1 = int(rng.integers(-nw // 4, W - 3 * nw // 4))
    bgp = bgs[rng.integers(len(bgs))]
    bg = cv2.imread(str(bgp))
    bg = cv2.resize(bg, (W, H)) if bg.shape[:2] != (H, W) else bg
    if rng.random() < 0.5:
        bg = bg[:, ::-1].copy()
    out = bg.astype(np.float32)
    # 대상 영역(화면 밖은 잘라냄)
    ax1, ay1, ax2, ay2 = max(0, x1), max(0, y1), min(W, x1 + nw), min(H, y2)
    px1, py1 = ax1 - x1, ay1 - y1
    pa = alpha[py1:py1 + ay2 - ay1, px1:px1 + ax2 - ax1]
    pp = patch[py1:py1 + ay2 - ay1, px1:px1 + ax2 - ax1].astype(np.float32)
    # 밝기를 배경 쪽으로 반쯤 맞춘다(조명 차이로 붙인 티가 나는 것을 줄임)
    region = out[ay1:ay2, ax1:ax2]
    ratio = float(np.clip((region.mean() + 1) / (pp.mean() + 1), 0.6, 1.6)) ** 0.5
    pp = np.clip(pp * ratio, 0, 255)
    # 접지 그림자
    sh = np.zeros((H, W), np.float32)
    cv2.ellipse(sh, (int(x1 + nw / 2), int(y2)), (int(nw * 0.55), max(2, int(nh * 0.08))), 0, 0, 360, 1.0, -1)
    sh = cv2.GaussianBlur(sh, (9, 9), 0)[..., None]
    out = out * (1 - 0.45 * sh)
    out[ay1:ay2, ax1:ax2] = out[ay1:ay2, ax1:ax2] * (1 - pa) + pp * pa
    im = out.clip(0, 255).astype(np.uint8)
    ys, xs = np.nonzero(pa[..., 0] > 0.5)
    if len(xs) < 50:
        return None
    nb = [ax1 + xs.min(), ay1 + ys.min(), ax1 + xs.max() + 1, ay1 + ys.max() + 1]
    meta = {"bg": bgp.stem, "h_px": round(nh, 1), "scale": round(s, 3)}
    if rng.random() < 0.5:
        im, ops = light_ops(im)
        meta["light"] = ops
    if not box_visible(im, nb):
        return None
    return im, [float(v) for v in nb], meta


# ----------------------------------------------------------------
def audit_sheet(items, path, cols=8, n=48):
    tiles = []
    for name, im, b in items[:n]:
        im = im.copy()
        cv2.rectangle(im, (int(b[0]), int(b[1])), (int(b[2]), int(b[3])), (0, 220, 255), 1)
        cv2.putText(im, name, (3, 236), 0, 0.35, (255, 255, 255), 1)
        tiles.append(im)
    tiles += [np.zeros_like(tiles[0])] * (-len(tiles) % cols)
    cv2.imwrite(str(path), np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]))


def main():
    pos, bgs = load_sources()
    (OUT / "images" / "train").mkdir(parents=True, exist_ok=True)
    (OUT / "labels" / "train").mkdir(parents=True, exist_ok=True)
    for p in (OUT / "images" / "train").glob("*.jpg"):
        p.unlink()
    for p in (OUT / "labels" / "train").glob("*.txt"):
        p.unlink()
    log, stats = [], {"seed": SEED, "n_per_kind": N_PER_KIND, "source_positives": len(pos),
                      "backgrounds": len(bgs), "made": {}, "retries": {}}
    for kind in ("occl", "light", "place"):
        made, tries, samples = 0, 0, []
        while made < N_PER_KIND and tries < N_PER_KIND * 5:
            tries += 1
            src, b = pos[rng.integers(len(pos))]
            r = (make_occl(src, b, bgs) if kind == "occl" else make_light(src, b) if kind == "light"
                 else make_place(src, b, bgs))
            if r is None:
                continue
            im, nb, meta = r
            stem = f"aug_{kind}_{made:04d}"
            cv2.imwrite(str(OUT / "images" / "train" / f"{stem}.jpg"), im)
            (OUT / "labels" / "train" / f"{stem}.txt").write_text(yolo_line(nb))
            log.append({"file": stem, "kind": kind, "source": src.stem, "box_xyxy": [round(v, 1) for v in nb], **meta})
            if len(samples) < 48:
                samples.append((stem[4:], im, nb))
            made += 1
        stats["made"][kind] = made
        stats["retries"][kind] = tries - made
        audit_sheet(samples, OUT / f"audit_{kind}.jpg")
    (OUT / "data.yaml").write_text(
        f"path: {HERE.as_posix()}\ntrain:\n  - dataset/images/train\n  - dataset_aug/images/train\n"
        f"val: dataset/images/val\nnames:\n  0: gray box\n")
    (OUT / "augment_log.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in log),
                                           encoding="utf-8")
    (OUT / "augment_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    print(stats)


if __name__ == "__main__":
    main()
