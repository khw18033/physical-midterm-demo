"""학습된 gray box YOLOv8n을 학습 라벨과 무관한 기준으로 확인한다 (2026-10-27).

검증 mAP(0.995)는 GDINO pseudo-label을 같은 방·비슷한 장면에서 다시 맞춘 값이라 일반화 근거가 못 된다.
1) 다른 장소 프레임(datasets/260915 기록 + rot8, 회색 박스 없음): 박스를 지어내는지 -> other_scene_sheet.jpg
2) 학습에서 판단 보류로 뺀 63장(박스가 화면 밖이거나 끝에 걸침): 어떻게 반응하는지 -> dropped_sheet.jpg
3) 이 영상 고유 프레임 전체의 검출률, GDINO 정제 라벨과의 IoU
입력은 class_finder_service와 같이 464x400이면 테두리를 자른다.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
CROP = (114, 80, 351, 321)  # class_finder_service.BORDER_CROP_BOX
RUN = sys.argv[1] if len(sys.argv) > 1 else "yolov8n_graybox"
CONF = float(sys.argv[2]) if len(sys.argv) > 2 else 0.25
# 2026-11-01: box_meter 실측에서 입력 256은 150cm(박스 높이 ~35px)를 0.17점으로 놓치고 512는 0.93점으로 잡았다.
IMGSZ = int(sys.argv[3]) if len(sys.argv) > 3 else 256
model = YOLO(str(HERE / "runs" / RUN / "weights" / "best.pt"))
sys.path.insert(0, str(HERE))
from build_dataset import other_scene_sessions  # noqa: E402


def prep(path):
    im = cv2.imread(str(path))
    if im.shape[1] == 464 and im.shape[0] == 400:
        im = im[CROP[1]:CROP[3], CROP[0]:CROP[2]]
    return im


def detect(im):
    r = model.predict(im, conf=CONF, imgsz=IMGSZ, verbose=False)[0]
    return [{"box_xyxy": [round(v, 1) for v in b.xyxy[0].tolist()], "score": round(float(b.conf[0]), 3)}
            for b in r.boxes]


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


def sheet(items, path, cols=8, limit=48):
    tiles = []
    for name, im, dets in items[:limit]:
        im = cv2.resize(im, (237, 241)).copy() if im.shape[:2] != (241, 237) else im.copy()
        for d in dets:
            x1, y1, x2, y2 = [int(v) for v in d["box_xyxy"]]
            cv2.rectangle(im, (x1, y1), (x2, y2), (0, 220, 255), 2)
            cv2.putText(im, f"{d['score']:.2f}", (x1 + 2, y1 + 14), 0, 0.45, (0, 220, 255), 1)
        cv2.putText(im, name, (3, 236), 0, 0.4, (255, 255, 255), 1)
        tiles.append(im)
    if not tiles:
        return
    tiles += [np.zeros_like(tiles[0])] * (-len(tiles) % cols)
    cv2.imwrite(str(path), np.vstack([np.hstack(tiles[i:i + cols]) for i in range(0, len(tiles), cols)]))


def main():
    out = {"run": RUN, "conf": CONF, "imgsz": IMGSZ}

    # 1) 다른 장소 -- 원본 프레임(robot/rot_*.jpg)만 쓴다. 처음엔 rglob("*.jpg")로 도면(map.jpg)·검출 박스가
    # 그려진 오버레이·crop까지 섞여 들어갔다. 학습 음성으로 쓴 세션은 빼고 시험용 세션 + rot8만 본다.
    _train_sessions, test_sessions = other_scene_sessions()
    other = [p for s in test_sessions for p in sorted(s.rglob("robot/rot_*.jpg"))] + sorted(
        (REPO / "datasets" / "20260910-134818_rot8").glob("*.jpg"))
    hits = []
    for p in other:
        im = prep(p)
        dets = detect(im)
        if dets:
            hits.append((p.parts[-4][:6] + "/" + p.stem, im, dets))
    out["other_scene_heldout"] = {"sessions": [s.name for s in test_sessions], "frames": len(other),
                                  "frames_with_detection": len(hits)}
    sheet(hits, HERE / f"other_scene_sheet_{RUN}_{IMGSZ}.jpg")

    # 2) 판단 보류 63장
    sel = [json.loads(l) for l in open(HERE / "selection.jsonl", encoding="utf-8")]
    src = REPO / "20261026_211320" / "frames"
    dropped = [s for s in sel if s["kind"] == "drop"]
    items = [(str(s["n"]), prep(src / s["frame"]), None) for s in dropped]
    items = [(n, im, detect(im)) for n, im, _ in items]
    out["dropped"] = {"frames": len(items), "frames_with_detection": sum(1 for *_, d in items if d)}
    sheet(items, HERE / f"dropped_sheet_{RUN}_{IMGSZ}.jpg", limit=64)

    # 3) 이 영상 고유 프레임 전체 -- 정제 라벨이 있는 프레임은 IoU도 본다
    found, ious, multi = 0, [], 0
    for s in sel:
        dets = detect(prep(src / s["frame"]))
        found += bool(dets)
        multi += len(dets) > 1
        if s["kind"] == "pos" and dets:
            ious.append(max(iou(d["box_xyxy"], s["box_xyxy"]) for d in dets))
    out["this_video_unique_frames"] = {
        "frames": len(sel), "frames_with_detection": found, "frames_with_multiple_detections": multi,
        "iou_vs_refined_label": {"median": round(float(np.median(ious)), 3),
                                 "p5": round(float(np.percentile(ious, 5)), 3),
                                 "rate_ge_0.5": round(float(np.mean(np.array(ious) >= 0.5)), 3)}}
    (HERE / f"model_eval_{RUN}_{IMGSZ}.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
