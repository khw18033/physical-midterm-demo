"""박스 실제 크기로 거리 계산식을 맞춘다 (2026-10-27).

박스 실측(사용자 제공): 가로 59.3cm, 세로(깊이) 21cm, 높이 39cm.
- 높이 39cm는 박스가 바닥에 똑바로 서 있는 한 보는 방향(yaw)과 무관하게 화면 세로로 보인다.
  가로폭은 앞면 59.3과 옆면 21이 각도에 따라 섞여 보여서(투영 폭 21~62.9cm) 거리 기준으로 못 쓴다.
- 계산식: distance_cm = k / h_px * (1 + a * r^2)
  h_px = 박스 화면 높이(px, 원본 464x400과 crop이 같은 배율), r = 박스 중심의 화면 중심 대비
  정규화 반경(calibrate_depth_to_cm과 같은 정의). a는 어안 왜곡 보정항. k = f_px * 39.
- 정답 거리가 없으므로 k, a는 같은 프레임의 기존 거리 추정값(UniDepth + 사용자 실측 3차 보정식)에
  맞춘다. 즉 이 식의 정확도는 그 보정식을 넘을 수 없다 -- 이 식이 주는 이점은 UniDepth 없이
  박스 하나로 바로 거리가 나온다는 것과, 두 독립 방법이 서로 맞는지 확인할 수 있다는 것.
- 높이를 잴 수 없는 프레임(박스가 crop 위/아래 끝에 닿음)은 쓰지 않는다(추정하지 않음).
- 라벨 확인: 높이를 39cm로 두고 박스 가로폭을 cm로 환산(39*w/h)했을 때 물리적으로 가능한
  21~62.9cm 안에 드는지 -- GDINO 박스가 박스 전체를 감쌌는지 보는 간접 검사.
"""
import json
import math
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares

HERE = Path(__file__).resolve().parent
BOX_W_CM, BOX_D_CM, BOX_H_CM = 59.3, 21.0, 39.0
CROP = (114, 80, 351, 321)  # class_finder_service.BORDER_CROP_BOX
IMG_W, IMG_H = 464, 400
INFER_W = 320                # navigate_to_target_service.INFER_SIZE[0]
EDGE_PX = 2.0
POS_MIN = 0.30
N_BLOCKS, VAL_BLOCKS = 10, {3, 8}  # build_dataset.py와 같은 분리

def main():
    recs = [json.loads(l) for l in open(HERE / "labels.jsonl", encoding="utf-8")]
    # build_dataset.py가 실측 치수·색상으로 고른 라벨(selection.jsonl)을 쓴다. UniDepth 거리는
    # make_labels.py가 GDINO 최고점 박스로 잰 값이라, 라벨이 다른 후보로 바뀐 프레임은 다른 물체의
    # 거리다 -- 그래서 "라벨 = 최고점 박스"인 프레임만 쓴다.
    sel = {s["n"]: s for s in map(json.loads, open(HERE / "selection.jsonl", encoding="utf-8"))}
    n_max = max(r["n"] for r in recs)
    H = CROP[3] - CROP[1]
    rows, skipped = [], {"not_clean_label": 0, "touches_top_or_bottom": 0, "unidepth_out_of_range": 0}
    for r in recs:
        s = sel[r["n"]]
        if s["kind"] != "pos" or s["changed_from_top"]:
            skipped["not_clean_label"] += 1
            continue
        x1, y1, x2, y2 = r["box_xyxy"]
        if y1 <= EDGE_PX or y2 >= H - EDGE_PX:
            skipped["touches_top_or_bottom"] += 1
            continue
        if not r.get("unidepth_in_calibration_range") or r.get("unidepth_distance_cm") is None:
            skipped["unidepth_out_of_range"] += 1
            continue
        cx, cy = (x1 + x2) / 2 + CROP[0], (y1 + y2) / 2 + CROP[1]
        rr = min(1.0, math.hypot((cx - IMG_W / 2) / (IMG_W / 2), (cy - IMG_H / 2) / (IMG_H / 2)))
        rows.append({"n": r["n"], "h": y2 - y1, "w": x2 - x1, "r": rr, "d_ref": r["unidepth_distance_cm"],
                     "fx_orig": r["unidepth_fx_infer"] * IMG_W / INFER_W,
                     "val": (r["n"] - 1) * N_BLOCKS // n_max in VAL_BLOCKS})
    tr = [x for x in rows if not x["val"]]
    va = [x for x in rows if x["val"]]

    def pred(p, xs):
        k, a = p
        return np.array([k / x["h"] * (1 + a * x["r"] ** 2) for x in xs])

    def resid(p, xs):  # 로그 오차 -- 거리 비율 오차를 같은 무게로 본다
        return np.log(pred(p, xs)) - np.log([x["d_ref"] for x in xs])

    fit_b = least_squares(resid, x0=[5000.0, 0.0], args=(tr,))
    fit_a = least_squares(lambda p, xs: resid([p[0], 0.0], xs), x0=[5000.0], args=(tr,))

    def metrics(p, xs):
        d = pred(p, xs)
        ref = np.array([x["d_ref"] for x in xs])
        ape = np.abs(d - ref) / ref
        return {"frames": len(xs), "median_abs_pct_err": round(float(np.median(ape)) * 100, 1),
                "p90_abs_pct_err": round(float(np.percentile(ape, 90)) * 100, 1)}

    # 라벨 박스 자체의 물리적 타당성: 높이를 39cm로 두면 가로폭 = 39 * w/h cm. 이것이 실제로 보일 수 있는
    # 투영 폭(옆면만 21cm ~ 대각선 62.9cm, 여유 10%) 안에 드는 비율. 거리 계수와 무관한 라벨 검사다.
    w_cm_all = np.array([BOX_H_CM * x["w"] / x["h"] for x in rows])
    width_ok = float(np.mean((w_cm_all >= BOX_D_CM * 0.9) & (w_cm_all <= math.hypot(BOX_W_CM, BOX_D_CM) * 1.1)))

    k_b, a_b = fit_b.x
    out = {
        "box_size_cm": {"width": BOX_W_CM, "depth": BOX_D_CM, "height": BOX_H_CM},
        "formula": "distance_cm = k / h_px * (1 + a * r^2)",
        "reference": "UniDepthV2 + calibrate_depth_to_cm (사용자 실측 3차 보정식) -- 실측 거리 아님",
        "skipped": skipped,
        "label_width_cm_physically_possible_rate": round(width_ok, 3),
        "label_width_cm_quantiles(p5,p50,p95)": [round(float(v), 1) for v in np.percentile(w_cm_all, [5, 50, 95])],
        "pinhole_only": {"k": round(float(fit_a.x[0]), 1), "a": 0.0,
                         "implied_focal_px": round(float(fit_a.x[0]) / BOX_H_CM, 1),
                         "train": metrics([fit_a.x[0], 0.0], tr), "val": metrics([fit_a.x[0], 0.0], va)},
        "with_radial_term": {"k": round(float(k_b), 1), "a": round(float(a_b), 4),
                             "implied_focal_px": round(float(k_b) / BOX_H_CM, 1),
                             "train": metrics(fit_b.x, tr), "val": metrics(fit_b.x, va)},
        "unidepth_fx_orig_px": {"median": round(float(np.median([x["fx_orig"] for x in rows])), 1),
                                "p10": round(float(np.percentile([x["fx_orig"] for x in rows], 10)), 1),
                                "p90": round(float(np.percentile([x["fx_orig"] for x in rows], 90)), 1)},
        "reference_distance_cm_range": [round(min(x["d_ref"] for x in rows), 1),
                                        round(max(x["d_ref"] for x in rows), 1)],
    }
    # 정답 거리 없이 할 수 있는 비교: 바로 옆 프레임(n 차이 <= 3, 20fps라 0.15초 이내)끼리는 실제 거리가
    # 거의 안 변하므로 인접 프레임 사이 거리 변화율을 그 방법의 잡음으로 본다. (처음엔 로봇이 서 있던
    # 3421~4371번 구간으로 보려 했으나 그 구간은 박스가 화면 아래 끝에 닿아 높이를 못 재서 전부 빠졌다.)
    geo_all = pred(fit_b.x, rows)
    jit_ref, jit_geo = [], []
    for i in range(1, len(rows)):
        if 0 < rows[i]["n"] - rows[i - 1]["n"] <= 3:
            jit_ref.append(abs(rows[i]["d_ref"] - rows[i - 1]["d_ref"]) / rows[i - 1]["d_ref"])
            jit_geo.append(abs(geo_all[i] - geo_all[i - 1]) / geo_all[i - 1])
    if jit_ref:
        out["adjacent_frame_jitter_pct"] = {
            "pairs": len(jit_ref),
            "unidepth": {"median": round(float(np.median(jit_ref)) * 100, 2),
                         "p90": round(float(np.percentile(jit_ref, 90)) * 100, 2)},
            "size_based": {"median": round(float(np.median(jit_geo)) * 100, 2),
                           "p90": round(float(np.percentile(jit_geo, 90)) * 100, 2)},
        }
    (HERE / "distance_fit.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=1))

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(1, 2, figsize=(11, 4.6))
    for xs, c, lab in ((tr, "#9aa5b1", "train"), (va, "#d9480f", "val")):
        ax[0].scatter([x["d_ref"] for x in xs], pred(fit_b.x, xs), s=6, c=c, label=lab, alpha=0.7)
        ax[1].scatter([x["r"] for x in xs], pred(fit_b.x, xs) / np.array([x["d_ref"] for x in xs]),
                      s=6, c=c, alpha=0.7)
    lim = [0, max(x["d_ref"] for x in rows) * 1.1]
    ax[0].plot(lim, lim, "k--", lw=1)
    ax[0].set(xlabel="UniDepth + calibration (cm)", ylabel="size-based (cm)", title="distance", xlim=lim, ylim=lim)
    ax[0].legend()
    ax[1].axhline(1, c="k", ls="--", lw=1)
    ax[1].set(xlabel="radius from image center (0~1)", ylabel="size-based / UniDepth", title="ratio vs position")
    fig.tight_layout()
    fig.savefig(HERE / "distance_fit.png", dpi=120)


if __name__ == "__main__":
    main()
