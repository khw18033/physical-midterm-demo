"""실연동 판으로 고정한 시험 세트(live_test/)로 학습 결과를 비교한다 (2026-11-02).

학습·증강에 한 번도 쓰지 않은 로봇 실연동 프레임 27장(복도 2판 16장, 사무실 A판 3장, 사무실 B판 8장)의
테두리 crop(237x241)이다. 처음엔 demo/test/try_box*를 직접 읽었는데, 관제 웹에서 새 판을 돌리자 try_box가
덮어써져 정답 표시가 엉뚱한 사진에 붙었다(2026-11-02) -- 그래서 crop을 live_test/에 PNG로 복사해 고정했다.
정답(live_test/gt.json)은 육안: 박스가 crop 안에 보이는 8장의 대략 중심, 애매한 1장은 집계 제외.
"검출 있음"만으로 맞았다고 하지 않는다 -- 사무실 A rot90에서 v3가 박스 대신 책상 상판을 잡았다.
박스 중심(BOX_HINT) 30px 안에 중심이 온 검출만 맞음으로 센다.
사용: python eval_live_scans.py <run> [<run> ...]
결과: live_scans_eval.json, live_scans_sheet.jpg (행 = run, 열 = 프레임)
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
TEST = HERE / "live_test"
CONF, IMGSZ = 0.25, 256
GT = json.loads((TEST / "gt.json").read_text(encoding="utf-8"))
BOX_HINT = {k: tuple(v) for k, v in GT["box_center"].items()}
UNSURE = set(GT["unsure"])
HIT_PX = 30


def frames():
    for p in sorted(TEST.glob("*.png")):
        yield p.stem, p


def main():
    runs = sys.argv[1:] or ["yolov8n_graybox_v3"]
    items = list(frames())
    out, rows = {"conf": CONF, "imgsz": IMGSZ, "frames": len(items), "present": len(BOX_HINT),
                 "unsure_excluded": sorted(UNSURE), "runs": {}}, []
    for run in runs:
        model = YOLO(str(HERE / "runs" / run / "weights" / "best.pt"))
        res, tiles = [], []
        for name, p in items:
            im = cv2.imread(str(p))
            r = model.predict(im, conf=CONF, imgsz=IMGSZ, verbose=False)[0]
            dets = [{"box_xyxy": [round(v, 1) for v in b.xyxy[0].tolist()], "score": round(float(b.conf[0]), 3)}
                    for b in r.boxes]
            hint = BOX_HINT.get(name)
            hits = [d for d in dets if hint and np.hypot((d["box_xyxy"][0] + d["box_xyxy"][2]) / 2 - hint[0],
                                                          (d["box_xyxy"][1] + d["box_xyxy"][3]) / 2 - hint[1]) <= HIT_PX]
            res.append({"frame": name, "present": hint is not None, "unsure": name in UNSURE,
                        "detections": dets, "hit": bool(hits), "wrong": len(dets) - len(hits)})
            t = im.copy()
            for d in dets:
                x1, y1, x2, y2 = [int(v) for v in d["box_xyxy"]]
                c = (0, 220, 0) if d in hits else (0, 0, 255)
                cv2.rectangle(t, (x1, y1), (x2, y2), c, 2)
                cv2.putText(t, f"{d['score']:.2f}", (x1 + 2, max(12, y1 - 2)), 0, 0.45, c, 1)
            if hint:
                cv2.circle(t, hint, 3, (255, 255, 0), -1)
            cv2.putText(t, f"{run[-2:]} {name.split('_')[0]} {name[-6:]}", (3, 236), 0, 0.4, (255, 255, 255), 1)
            tiles.append(t)
        valid = [r for r in res if not r["unsure"]]
        out["runs"][run] = {
            "present_hit": sum(r["hit"] for r in valid if r["present"]),
            "absent_frames_with_detection": sum(bool(r["detections"]) for r in valid if not r["present"]),
            "wrong_boxes_total": sum(r["wrong"] for r in valid),
            "per_frame": res}
        rows.append(np.hstack(tiles))
    cv2.imwrite(str(HERE / "live_scans_sheet.jpg"), np.vstack(rows))
    (HERE / "live_scans_eval.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk != "per_frame"} for k, v in out["runs"].items()},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
