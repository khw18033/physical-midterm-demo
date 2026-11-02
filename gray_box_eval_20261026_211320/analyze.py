"""records.jsonl을 집계해 summary.json과 contact_sheet_*.jpg를 만든다.

정답 박스(GT)가 없으므로 "맞게 잡았는지"는 contact sheet를 사람이 보고 판정해야 한다.
여기서 내는 수치는 provider별 반응률과, 확정이 진짜 동의인지(사전 박스와 OVD 박스의
짝 IoU, door의 confirm_pair_iou_min=0.42 기준) 가리는 지표다.
"""
import json
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / "20261026_211320" / "frames"
CROP = (114, 80, 351, 321)  # class_finder_service.BORDER_CROP_BOX
CROP_AREA = (CROP[2] - CROP[0]) * (CROP[3] - CROP[1])
PAIR_IOU_MIN = 0.42          # door의 confirm_pair_iou_min과 같은 기준
WHOLE_FRAME_FRAC = 0.8       # 이보다 큰 사전 후보는 "사진 전체" 후보로 본다


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def area_frac(b):
    return (b[2] - b[0]) * (b[3] - b[1]) / CROP_AREA


def main():
    recs = [json.loads(l) for l in open(HERE / "records.jsonl", encoding="utf-8")]
    rows = []
    for r in recs:
        raw = r["raw"]
        ovd = raw["grounding_dino"] + raw["yolo_world"]
        pair = max((iou(d["box_xyxy"], o["box_xyxy"]) for d in raw["dictionary"] for o in ovd), default=0.0)
        gd_best = max(raw["grounding_dino"], key=lambda d: d["score"], default=None)
        rows.append({
            "n": r["n"], "found": r["found"],
            "gdino": gd_best is not None, "gdino_score": gd_best["score"] if gd_best else None,
            "yolo_world": bool(raw["yolo_world"]),
            "dictionary": bool(raw["dictionary"]),
            "dictionary_tight": any(area_frac(d["box_xyxy"]) < WHOLE_FRAME_FRAC for d in raw["dictionary"]),
            "pair_iou": round(pair, 3),
            "real_agreement": r["found"] and pair >= PAIR_IOU_MIN,
            "confirmed_vs_gdino_iou": (round(iou(r["instances"][0]["box_xyxy"], gd_best["box_xyxy"]), 3)
                                       if r["found"] and gd_best else None),
        })
    n = len(rows)

    def rate(key):
        k = sum(1 for x in rows if x[key])
        return {"count": k, "rate": round(k / n, 3)}

    gd_scores = [x["gdino_score"] for x in rows if x["gdino_score"] is not None]
    summary = {
        "frames_evaluated": n,
        "note": "GT 없음 -- 각 수치는 '반응했는가'이지 '맞게 잡았는가'가 아니다. 위치 정확성은 contact sheet로 확인.",
        "confirmed": rate("found"),
        "confirmed_with_pair_iou_ge_0.42": rate("real_agreement"),
        "provider_response": {"dictionary_any": rate("dictionary"),
                              "dictionary_tight(<80%_of_frame)": rate("dictionary_tight"),
                              "grounding_dino": rate("gdino"), "yolo_world": rate("yolo_world")},
        "grounding_dino_score": ({"min": min(gd_scores), "median": float(np.median(gd_scores)),
                                  "max": max(gd_scores)} if gd_scores else None),
        "per_frame": rows,
    }
    (HERE / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "per_frame"}, ensure_ascii=False, indent=1))

    # contact sheet: 노랑=확정, 초록=GDINO 최고점, 분홍=YOLO-World 최고점, 회색=사전 통과 후보
    by_n = {r["n"]: r for r in recs}
    pick = [rows[i]["n"] for i in np.linspace(0, n - 1, min(n, 48)).astype(int)]
    tiles = []
    cl, ct, cr, cb = CROP
    for k in pick:
        r = by_n[k]
        img = cv2.imread(str(SRC / r["frame"]))[ct:cb, cl:cr].copy()

        def box(b, c, t=1):
            x1, y1, x2, y2 = [int(round(v)) for v in b]
            cv2.rectangle(img, (x1, y1), (x2, y2), c, t)
        for d in r["raw"]["dictionary"]:
            box(d["box_xyxy"], (170, 170, 170))
        if r["raw"]["grounding_dino"]:
            box(max(r["raw"]["grounding_dino"], key=lambda d: d["score"])["box_xyxy"], (0, 200, 0))
        if r["raw"]["yolo_world"]:
            box(max(r["raw"]["yolo_world"], key=lambda d: d["score"])["box_xyxy"], (200, 0, 200))
        for inst in r["instances"]:
            box(inst["box_xyxy"], (0, 220, 255), 2)
        cv2.putText(img, f"{k}{'' if r['found'] else ' X'}", (3, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45,
                    (0, 255, 255) if r["found"] else (0, 0, 255), 1)
        tiles.append(img)
    for s in range(0, len(tiles), 24):
        chunk = tiles[s:s + 24]
        chunk += [np.zeros_like(tiles[0])] * (-len(chunk) % 6)
        sheet = np.vstack([np.hstack(chunk[i:i + 6]) for i in range(0, len(chunk), 6)])
        cv2.imwrite(str(HERE / f"contact_sheet_{s // 24 + 1}.jpg"), sheet)


if __name__ == "__main__":
    main()
