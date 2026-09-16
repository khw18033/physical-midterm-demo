"""2026-09-14 사용자 지시: "try1/incoming frame_000005/6/7 3프레임에 문이 존재하지만 미검출. 어떤 게이트 조건이 원인인지
탐색 후 출력. 바로 수정하지 않음"

19:10 새 판(복도 장면) 스냅샷(diag_567/frames)을 두 설정으로 본다:
  OLD = 실시간 수신기(17:03 시작)가 메모리에 들고 있던 반영 전 설정(backup_260914/class_features.json)
  NEW = 18:34 반영한 현재 운영 설정(demo/test/class_features.json)
코드는 하위 호환(새 키가 없으면 예전 규칙)이라 현재 코드 + 백업 JSON = 반영 전 동작이다.

출력
  1) 대상 물체(육안 박스)마다: 겹치는 RPN 후보 전부의 게이트 측정값과 OLD/NEW 통과 여부(걸린 게이트 표시)
  2) 그 물체의 GroundingDINO/YOLO-World 박스(점수·라벨)와 OLD/NEW 증거 규칙 통과 여부
  3) 실제 ClassFinderService.on_frame으로 돌린 최종 확정 결과(OLD/NEW) -- 출력은 diag_567/run_<cfg>/ (try1 무관)
운영 파일은 읽기만 한다.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
sys.path.insert(0, str(REPO_ROOT / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402

import cv2  # noqa: E402
import numpy as np  # noqa: E402

FRAMES = [("frame_000005.jpg", 225.0), ("frame_000006.jpg", 270.0), ("frame_000007.jpg", 315.0)]
CONFIGS = {
    "OLD": HERE.parent / "backup_260914" / "class_features.json",
    "NEW": REPO_ROOT / "demo" / "test" / "class_features.json",
}
# 육안 확인 박스(테두리 자르기 후 237x241 좌표) -- 격자 확대 이미지 기준
OBJECTS = {
    "frame_000005.jpg": {"목재 문/장(가운데 오른쪽)": [150, 74, 190, 145],
                         "복도 끝 먼 문(작음)": [112, 108, 122, 138]},
    "frame_000006.jpg": {"파란 문": [150, 50, 190, 146],
                         "목재 문/장(왼쪽)": [65, 82, 98, 143]},
    "frame_000007.jpg": {"파란 문": [27, 55, 62, 147],
                         "엘리베이터 문": [100, 76, 126, 140],
                         "파란 테 유리문": [176, 98, 191, 137],
                         "목재 문/장(오른쪽 끝)": [200, 100, 228, 140]},
}


def rel(cand, obj):
    iou, cont = cfs._iou_and_containment(cand, obj)
    ax1, ay1, ax2, ay2 = cand
    bx1, by1, bx2, by2 = obj
    inter = max(0, min(ax2, bx2) - max(ax1, bx1)) * max(0, min(ay2, by2) - max(ay1, by1))
    cover = inter / ((bx2 - bx1) * (by2 - by1))          # 물체 중 후보가 덮는 비율
    inside = inter / max((ax2 - ax1) * (ay2 - ay1), 1e-6)  # 후보 중 물체 안에 든 비율
    return iou, cover, inside


def gate_measures(cfg, embeds, boxes, crops):
    sim = embeds @ cfg["text_embeds"].T
    out = [{"target_sim": float(sim[i].max()), "best_feature": cfg["anchored_features"][int(sim[i].argmax())]}
           for i in range(len(boxes))]
    if cfg["color_feature_k"]:
        own = cfg["llm_features"][cfg["color_feature_k"][0]].rsplit(" color", 1)[0]
        prompts = [f"a door's {own} color"] + [f"a door's {c} color" for c in cfs.COLOR_COMPETITOR_WORDS]
        cs = embeds @ cfg["engine"].embed_texts(prompts).T
        for i, m in enumerate(out):
            m["color_gap"] = float(cs[i, 0] - np.delete(cs[i], 0).max())
            m["color_winner"] = prompts[int(cs[i].argmax())].split("'s ")[1]
    if cfg["shape_cfg"]:
        n_pos = len(cfg["shape_cfg"]["positive_prompts"])
        ss = embeds @ cfg["shape_embeds"].T
        for i, m in enumerate(out):
            m["shape_gap"] = float(ss[i, :n_pos].max() - ss[i, n_pos:].max())
    for i, m in enumerate(out):
        x1, y1, x2, y2 = boxes[i]
        m["aspect"] = (y2 - y1) / (x2 - x1)
        m["sat"] = cfs._median_saturation(crops[i])
        if cfg["ref_image_embed"] is not None:
            m["ref_sim"] = float((embeds[i:i + 1] @ cfg["ref_image_embed"].T)[0, 0])
    return out


def failed_gates(m, cfg):
    f = []
    if m["target_sim"] < cfg["target_sim_threshold"]:
        f.append(f"target_sim {m['target_sim']:.4f}<{cfg['target_sim_threshold']}")
    if cfg["min_aspect"] is not None and m["aspect"] < cfg["min_aspect"]:
        f.append(f"종횡비 {m['aspect']:.2f}<{cfg['min_aspect']}")
    if cfg["color_feature_k"] and m["color_gap"] < -cfg["color_tol"]:
        f.append(f"색 차이 {m['color_gap']:+.4f}<-{cfg['color_tol']}(1등 {m['color_winner']})")
    if cfg["shape_cfg"] and m["shape_gap"] < -cfg["shape_tol"]:
        f.append(f"모양 {m['shape_gap']:+.4f}<-{cfg['shape_tol']}")
    if cfg["ref_sim_min"] is not None and m["ref_sim"] < cfg["ref_sim_min"]:
        f.append(f"참조이미지 {m['ref_sim']:.3f}<{cfg['ref_sim_min']}")
    sat = cfg["saturation_cfg"] or {}
    if "min_saturation" in sat and m["sat"] < sat["min_saturation"]:
        f.append(f"채도 {m['sat']:.0f}<{sat['min_saturation']}")
    return f


def main():
    report = {"gate_analysis": {}, "final": {}}
    finders = {}
    for cname, path in CONFIGS.items():
        cfs.CLASS_FEATURES_PATH = path
        f = cfs.ClassFinderService()
        if finders:  # 모델은 공유하고 사전(JSON)만 새로 읽힌다
            other = next(iter(finders.values()))
            f.grounding_dino, f.yolo_world, f.fastsam = other.grounding_dino, other.yolo_world, other.fastsam
            f.dictionary.proposer, f.dictionary.engine = other.dictionary.proposer, other.dictionary.engine
        f.on_class_discovery_command("door")
        finders[cname] = f

    base = finders["NEW"]
    for fname, rot in FRAMES:
        bgr_full = cv2.imread(str(HERE / "frames" / fname))
        cl, ct, cr, cb = cfs.BORDER_CROP_BOX
        bgr = bgr_full[ct:cb, cl:cr]
        h, w = bgr.shape[:2]
        # ── RPN 후보: DictionaryProvider.detect()와 같은 절차 ──
        dp = base.dictionary
        all_boxes, all_scores = dp.proposer.propose(bgr)
        filt = []
        for (x1, y1, x2, y2), sc in zip(all_boxes[:cfs.YOLO_TOPN], all_scores[:cfs.YOLO_TOPN]):
            x1, y1, x2, y2 = max(0.0, x1), max(0.0, y1), min(float(w), x2), min(float(h), y2)
            if (x2 - x1) >= cfs.MIN_CROP_SIDE_PX and (y2 - y1) >= cfs.MIN_CROP_SIDE_PX:
                filt.append(((x1, y1, x2, y2), sc))
        keep = cfs._nms_dedup([b for b, _ in filt], [s for _, s in filt], cfs.NMS_IOU_THR)
        boxes = [filt[i][0] for i in keep]
        crops = [bgr[int(y1):int(y2), int(x1):int(x2)] for (x1, y1, x2, y2) in boxes]
        embeds = dp.engine.embed_images(crops)
        measures = {c: gate_measures(finders[c].dictionary.class_configs["door"], embeds, boxes, crops) for c in CONFIGS}
        gd = base.grounding_dino.detect(bgr, ["door", "pedestal"])
        yw = base.yolo_world.detect(bgr, ["door", "pedestal"], conf=0.001)

        print(f"\n################ {fname} ({rot}°) RPN 후보 {len(boxes)}개")
        report["gate_analysis"][fname] = {}
        for oname, obox in OBJECTS[fname].items():
            print(f"\n  ▶ {oname} {obox}  (크기 {obox[2] - obox[0]}x{obox[3] - obox[1]}px)")
            rows = []
            for i, b in enumerate(boxes):
                iou, cover, inside = rel(b, obox)
                if not (iou >= 0.3 or (inside >= 0.7 and cover >= 0.3)):
                    continue
                row = {"box": [round(v) for v in b], "iou": round(iou, 2), "cover": round(cover, 2)}
                for c in CONFIGS:
                    fails = failed_gates(measures[c][i], finders[c].dictionary.class_configs["door"])
                    row[c] = fails
                m = measures["OLD"][i]
                row["measures"] = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()}
                rows.append(row)
            rows.sort(key=lambda r: -r["iou"])
            if not rows:
                print("     RPN 후보 없음(물체와 IoU>=0.3 또는 물체 안에 든 후보가 없음)")
            for r in rows:
                m = r["measures"]
                print(f"     RPN {r['box']} IoU={r['iou']} 덮음={r['cover']} | sim={m['target_sim']:.4f}({m['best_feature'].split(chr(39) + 's ')[1]}) "
                      f"색차={m.get('color_gap', 0):+.4f}(1등 {m.get('color_winner')}) 모양={m.get('shape_gap', 0):+.4f} "
                      f"참조={m.get('ref_sim', 0):.3f} 채도={m['sat']:.0f} 종횡비={m['aspect']:.2f}")
                for c in CONFIGS:
                    print(f"         {c}: {'통과' if not r[c] else '탈락 <- ' + ' / '.join(r[c])}")
            gd_rows = []
            for d in gd:
                iou, cover, inside = rel(d["box_xyxy"], obox)
                if iou >= 0.3:
                    old_ok = "door" in d["label"] and d["score"] >= 0.15
                    new_ok = d["label"].strip() == "door" and d["score"] >= 0.25
                    gd_rows.append({**d, "iou": round(iou, 2), "OLD": old_ok, "NEW": new_ok})
                    print(f"     GDINO {d['box_xyxy']} score={d['score']} label='{d['label']}' IoU={iou:.2f} "
                          f"| OLD 증거={'O' if old_ok else 'X'} NEW 증거={'O' if new_ok else 'X'}")
            if not gd_rows:
                print("     GDINO: 이 물체와 IoU>=0.3인 박스 없음(box/text 0.15)")
            for d in yw:
                iou, _, _ = rel(d["box_xyxy"], obox)
                if iou >= 0.3:
                    print(f"     YOLO-World {d['box_xyxy']} score={d['score']} label={d['label']} (door 증거 기준 0.05)")
            report["gate_analysis"][fname][oname] = {"box": obox, "rpn": rows, "gdino": gd_rows}

    # ── 실제 on_frame 최종 결과 ──
    for c, f in finders.items():
        cfs.CLASS_FEATURES_PATH = CONFIGS[c]
        cfs.RUN_DIR = HERE / f"run_{c}"
        f.on_class_discovery_command("door")
        for i, (fname, rot) in enumerate(FRAMES):
            f.on_frame(HERE / "frames" / fname, rot, i + 5)
        dets = f.get_detections("door")
        report["final"][c] = {fn: [inst["box_xyxy"] for inst in dets[rot]["instances"]] for fn, rot in FRAMES}
    print("\n################ 실제 on_frame 최종 확정(door)")
    for c in CONFIGS:
        print(f"  {c}: {report['final'][c]}")
    (HERE / "diag_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
