"""research/door_gate_relax/cache_raw.py

2026-09-14 사용자 지시: "필수 게이트 완화, 나머지 provider 임계값 조절 실험 진행 --
datasets/20260910-134818_rot8에서 frame_000113/132에서만 문이 제대로 검출되는지 확인.
현재 게이트가 너무 강력해 다른 환경에서 문을 잘 탐지하지 못하는 문제."

게이트/임계값 조합을 수백 개 훑으려면 매번 모델을 돌릴 수 없으므로, 4개 provider를
프레임마다 한 번만 돌려 **임계값을 적용하기 전의 원시값**을 캐시한다:
  - 사전(CLIP): RPN 후보 박스 전부 + crop 이미지 임베딩 + 채도 중앙값 + 참조이미지 임베딩
  - GroundingDINO: box threshold 0.05로 낮춰 받고, text threshold는 라벨 조립에 쓰이므로
    격자마다 따로 후처리해 저장
  - YOLO-World: conf 0.001로 낮춰 받음
  - FastSAM: 서비스와 동일 호출(클래스 무관 마스크)
실측 처리시간도 함께 저장한다(증거 완료시각 = 도착 순서가 융합 결과에 영향).

서비스 코드(demo/test/class_finder_service.py)의 provider 클래스를 그대로 import해 쓰며,
try1/ 산출물은 건드리지 않는다(on_frame을 호출하지 않음).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(REPO_ROOT / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402  (ctypes 우회가 torch import보다 먼저 돌아야 함)

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

from aug import AUGS  # noqa: E402

CACHE_DIR = HERE / "cache"
CLASSES = ["door", "pedestal"]  # target_class=door일 때 active_classes와 같다
GDINO_BOX_FLOOR = 0.05
GDINO_TEXT_GRID = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30]
YW_CONF_FLOOR = 0.001

SETS = {
    "rot8": (REPO_ROOT / "datasets" / "20260910-134818_rot8",
             [("frame_000001.jpg", 0.0), ("frame_000020.jpg", 45.0), ("frame_000039.jpg", 90.0),
              ("frame_000057.jpg", 135.0), ("frame_000076.jpg", 180.0), ("frame_000095.jpg", 225.0),
              ("frame_000113.jpg", 270.0), ("frame_000132.jpg", 315.0)]),
    # 보조 세트: 2026-09-14 리허설에서 로봇(Go1) 카메라로 실제 수신한 8장(try1/incoming, 읽기만 함).
    # 같은 방이지만 카메라·노출이 달라 "게이트가 환경 변화에 얼마나 버티나"를 보는 용도다.
    "robot": (REPO_ROOT / "demo" / "test" / "try1" / "incoming",
              [(f"frame_{i:06d}.jpg", 45.0 * i) for i in range(8)]),
}


def _crop_border(bgr):
    h, w = bgr.shape[:2]
    if (w, h) == cfs.BORDER_CROP_SOURCE_SIZE:
        cl, ct, cr, cb = cfs.BORDER_CROP_BOX
        return bgr[ct:cb, cl:cr]
    return bgr


def main() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dictionary = cfs.DictionaryProvider()
    dictionary._ensure_loaded()
    gdino = cfs.GroundingDinoProvider()
    yw = cfs.YoloWorldProvider()
    fs = cfs.FastSamProvider()

    ref_bgr = cv2.imread(str(REPO_ROOT / "datasets" / "25301.jpg"))
    np.save(CACHE_DIR / "door_ref_embed.npy", dictionary.engine.embed_images([ref_bgr]))

    # 인자: 세트 이름("rot8") 또는 세트@변형("rot8@dim", aug.py의 AUGS). "all-augs"는 두 세트 x 모든 변형.
    wanted = sys.argv[1:] or list(SETS)
    if wanted == ["all-augs"]:
        wanted = [f"{s}@{a}" for s in SETS for a in AUGS]
    for set_name in wanted:
        base, _, aug_name = set_name.partition("@")
        frame_dir, frames = SETS[base]
        for fname, rot in frames:
            bgr = _crop_border(cv2.imread(str(frame_dir / fname)))
            if aug_name:
                bgr = np.ascontiguousarray(AUGS[aug_name](bgr))
            h, w = bgr.shape[:2]
            stem = f"{set_name}__{Path(fname).stem}"

            # ── 사전(CLIP): DictionaryProvider.detect()의 후보 생성 부분을 그대로 재현 ──
            t0 = time.perf_counter()
            all_boxes, all_scores = dictionary.proposer.propose(bgr)
            filtered = []
            for (x1, y1, x2, y2), sc in zip(all_boxes[:cfs.YOLO_TOPN], all_scores[:cfs.YOLO_TOPN]):
                x1, y1 = max(0.0, x1), max(0.0, y1)
                x2, y2 = min(float(w), x2), min(float(h), y2)
                if (x2 - x1) >= cfs.MIN_CROP_SIDE_PX and (y2 - y1) >= cfs.MIN_CROP_SIDE_PX:
                    filtered.append(((x1, y1, x2, y2), sc))
            keep = cfs._nms_dedup([b for b, _ in filtered], [s for _, s in filtered], cfs.NMS_IOU_THR)
            candidates = [filtered[i][0] for i in keep]
            crops = [bgr[int(y1):int(y2), int(x1):int(x2)] for (x1, y1, x2, y2) in candidates]
            embeds = dictionary.engine.embed_images(crops)
            sats = [cfs._median_saturation(c) for c in crops]
            t_dict = (time.perf_counter() - t0) * 1000.0
            np.save(CACHE_DIR / f"{stem}__clip_embeds.npy", embeds)

            # ── GroundingDINO: 모델 1회 + text threshold 격자별 후처리 ──
            t0 = time.perf_counter()
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            text = ". ".join(CLASSES) + "."
            inputs = gdino.processor(images=rgb, text=text, return_tensors="pt").to(gdino.device)
            with torch.no_grad():
                outputs = gdino.model(**inputs)
            torch.cuda.synchronize()
            t_gdino = (time.perf_counter() - t0) * 1000.0
            gd_by_text = {}
            for tt in GDINO_TEXT_GRID:
                r = gdino.processor.post_process_grounded_object_detection(
                    outputs, input_ids=inputs["input_ids"], threshold=GDINO_BOX_FLOOR, text_threshold=tt,
                    target_sizes=[(h, w)])[0]
                labels = r.get("text_labels", r.get("labels"))
                gd_by_text[str(tt)] = [{"box_xyxy": [round(float(v), 2) for v in b.tolist()],
                                        "score": round(float(s), 4), "label": lab}
                                       for b, s, lab in zip(r["boxes"], r["scores"], labels)]

            # ── YOLO-World / FastSAM ──
            t0 = time.perf_counter()
            yw_dets = yw.detect(bgr, CLASSES, conf=YW_CONF_FLOOR)
            t_yw = (time.perf_counter() - t0) * 1000.0
            t0 = time.perf_counter()
            fs_dets = fs.detect(bgr)
            t_fs = (time.perf_counter() - t0) * 1000.0

            record = {
                "set": set_name, "frame": fname, "rotation_deg": rot, "crop_wh": [w, h],
                "timings_ms": {"dictionary": round(t_dict, 1), "grounding_dino": round(t_gdino, 1),
                               "yolo_world": round(t_yw, 1), "fastsam": round(t_fs, 1)},
                "rpn_candidates": [[round(v, 2) for v in b] for b in candidates],
                "median_saturation": [round(s, 1) for s in sats],
                "grounding_dino_by_text_thr": gd_by_text,
                "yolo_world": yw_dets,
                "fastsam": fs_dets,
            }
            with open(CACHE_DIR / f"{stem}.json", "w", encoding="utf-8") as f:
                json.dump(record, f, ensure_ascii=False)
            print(f"[cache] {stem}: RPN={len(candidates)} GDINO(0.05/0.15)={len(gd_by_text['0.15'])} "
                  f"YW(0.001)={len(yw_dets)} FS={len(fs_dets)} timings={record['timings_ms']}")


if __name__ == "__main__":
    main()
