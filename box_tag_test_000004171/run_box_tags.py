"""000004171.jpg 중앙의 회색 박스를 여러 태그로 탐지해 보는 실험 (2026-10-27).

저장소의 class_features.json과 서비스 코드는 건드리지 않는다. 이 폴더에 사본
(class_features_box.json)을 만들어 태그별 클래스를 추가하고, class_finder_service의
CLASS_FEATURES_PATH/RUN_DIR만 바꿔 같은 파이프라인(4-provider 융합)을 그대로 쓴다.
태그는 하나씩 따로 돌린다 -- GroundingDINO는 질의어를 한 문장으로 이어 붙이므로
여러 태그를 같이 넣으면 서로 라벨을 빼앗아 태그별 성능을 볼 수 없다.
"""
import json
import sys
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402  (ctypes 우회가 torch보다 먼저 돌아야 함)

FRAME = REPO / "000004171.jpg"

# CLIP 특징 문구: 사람이 직접 작성한 1차안(실측 튜닝 없음). 색·모양 게이트는 일부러 걸지 않았다 --
# "color" 문구를 reference_image_features에 넣으면 색 게이트가 자동으로 켜지므로 features에만 둔다.
# target_sim_threshold 0.22는 잠정치: pedestal(0.20)처럼 짧은 텍스트와 약하게 맞는 무채색 물체일 수
# 있어 전역 0.26보다 낮게 잡았다.
BOX_FEATURES = ["flat top surface", "rectangular body", "straight edges", "gray color", "soft fabric surface"]
TAGS = {
    "box": BOX_FEATURES,
    "gray box": BOX_FEATURES,
    "storage box": BOX_FEATURES + ["lid on top"],
    "cardboard box": BOX_FEATURES + ["folded flaps"],
    "luggage": ["rectangular hard shell", "carrying handle", "zipper along the edge", "gray color"],
    "suitcase": ["rectangular hard shell", "carrying handle", "zipper along the edge", "small wheels", "gray color"],
}
TARGET_SIM_THRESHOLD = 0.22


def main():
    features = json.loads((REPO / "demo" / "test" / "class_features.json").read_text(encoding="utf-8"))
    for tag, feats in TAGS.items():
        features[tag] = {"features": feats, "target_sim_threshold": TARGET_SIM_THRESHOLD,
                         "note": "box_tag_test 실험용 임시 등록 -- 게이트 없음, 문구·임계값 모두 미검증 잠정치"}
    features_path = HERE / "class_features_box.json"
    features_path.write_text(json.dumps(features, ensure_ascii=False, indent=2), encoding="utf-8")
    cfs.CLASS_FEATURES_PATH = features_path

    finder = cfs.ClassFinderService()
    summary = {"frame": FRAME.name, "target_sim_threshold": TARGET_SIM_THRESHOLD, "tags": {}}
    for tag in TAGS:
        cfs.RUN_DIR = HERE / tag.replace(" ", "_")
        finder.on_class_discovery_command(tag)
        finder.on_frame(FRAME, 0.0, 0)

        # 확정 실패 원인을 보기 위해 provider별 원본 출력도 남긴다(on_frame과 같은 crop 입력).
        bgr_full = cv2.imread(str(FRAME))
        cl, ct, cr, cb = cfs.BORDER_CROP_BOX
        bgr = bgr_full[ct:cb, cl:cr]
        raw = {
            "dictionary": [{"box_xyxy": d["box_xyxy"], "score": d["score"], "label": d["label"]}
                           for d in finder.dictionary.detect(bgr, [tag])[tag]],
            "grounding_dino": finder.grounding_dino.detect(bgr, finder.active_classes),
            "yolo_world": [d for d in finder.yolo_world.detect(bgr, finder.active_classes) if d["label"] == tag],
        }
        det = finder.get_detections()[tag][0.0]
        summary["tags"][tag] = {
            "found": det["found"],
            "instances": [{"box_xyxy": i["box_xyxy"], "final_score": i["final_score"],
                           "supporting_sources": list(i["supporting_sources"])} for i in det["instances"]],
            "raw_provider_outputs": raw,
        }
        print(f"[box_tag_test] {tag}: found={det['found']} "
              f"instances={[i['box_xyxy'] for i in det['instances']]}")

    (HERE / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
