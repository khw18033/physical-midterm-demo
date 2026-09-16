"""실제 ClassFinderService로 끝까지 돌려 캐시 재현(relax_lib) 결과가 진짜 파이프라인과 같은지 확인한다.

운영 파일은 건드리지 않는다:
  - 출력: cfs.RUN_DIR을 research/door_gate_relax/e2e/<mode>/<set>/ 로 돌린다(try1/ 무관).
  - 설정(mode=R2일 때만): 런타임 패치
      * class_features.json → 완화본 복사(relaxed_class_features.json)를 읽게 CLASS_FEATURES_PATH 교체
        (door: target_sim_threshold 0.22, shape_gate/reference_image_similarity_min 삭제, 종횡비 1.5·채도 85 유지)
      * 색상 게이트: 서비스가 reference feature 문구의 "color"로 자동으로 켜므로 load_classes 뒤에 door의
        color_feature_k를 비워 끈다(특징 문구 자체는 그대로 둬서 유사도 점수는 바뀌지 않게)
      * GroundingDINO: box 0.25 / text 0.25, 라벨이 클래스명과 정확히 같은 것만 남김
        (서비스의 `class_name not in label` 부분일치가 "door pedestal"을 door로 세는 것을 막음)
"""

from __future__ import annotations

import copy
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(REPO_ROOT / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402

import relax_lib as rl  # noqa: E402
from cache_raw import SETS  # noqa: E402
from gt import GT_BY_SET  # noqa: E402

RELAXED_JSON = HERE / "relaxed_class_features.json"


def write_relaxed_json():
    data = json.loads(cfs.CLASS_FEATURES_PATH.read_text(encoding="utf-8"))
    door = copy.deepcopy(data["door"])
    door["target_sim_threshold"] = 0.22
    door.pop("shape_gate", None)
    door.pop("reference_image_similarity_min", None)
    data["door"] = door
    RELAXED_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def patch_r2():
    write_relaxed_json()
    cfs.CLASS_FEATURES_PATH = RELAXED_JSON

    orig_load = cfs.DictionaryProvider.load_classes

    def load_classes(self, class_names):
        out = orig_load(self, class_names)
        if "door" in self.class_configs:
            self.class_configs["door"]["color_feature_k"] = []
        return out

    cfs.DictionaryProvider.load_classes = load_classes

    orig_detect = cfs.GroundingDinoProvider.detect

    def detect(self, bgr, class_names, box_threshold=0.25, text_threshold=0.25):
        dets = orig_detect(self, bgr, class_names, box_threshold=box_threshold, text_threshold=text_threshold)
        names = {c.lower() for c in class_names}
        return [dict(d, label=d["label"].strip()) for d in dets if d["label"].strip() in names]

    cfs.GroundingDinoProvider.detect = detect


def patch_r2b():
    """R2b: 게이트는 R2와 같고, GroundingDINO 호출은 현재값(0.15/0.15) 그대로 둔 채 **door 증거로
    받는 것만** '라벨이 정확히 door + 점수 >= 0.25'로 거른다 -- R2 검증에서 전역 box 0.25가 rot8 135도
    단상(GDINO 0.17~0.24)을 없애 위치 추정 랜드마크를 잃는 부작용이 확인돼서(2026-09-14).
    서비스의 부분일치 규칙을 건드리지 않고 같은 효과를 내려고 라벨을 고쳐 쓴다:
    "door pedestal" -> "pedestal"(단상 쪽 부분일치는 그대로), 점수 미달 "door" -> ""(door에서만 빠짐)."""
    write_relaxed_json()
    cfs.CLASS_FEATURES_PATH = RELAXED_JSON

    orig_load = cfs.DictionaryProvider.load_classes

    def load_classes(self, class_names):
        out = orig_load(self, class_names)
        if "door" in self.class_configs:
            self.class_configs["door"]["color_feature_k"] = []
        return out

    cfs.DictionaryProvider.load_classes = load_classes

    orig_detect = cfs.GroundingDinoProvider.detect

    def detect(self, bgr, class_names, **kw):
        out = []
        for d in orig_detect(self, bgr, class_names, **kw):
            tokens = d["label"].split()
            if "door" in tokens and (tokens != ["door"] or d["score"] < 0.25):
                d = dict(d, label=" ".join(t for t in tokens if t != "door"))
            out.append(d)
        return out

    cfs.GroundingDinoProvider.detect = detect


def _patch_door_only_gdino(min_score=0.25):
    orig_detect = cfs.GroundingDinoProvider.detect

    def detect(self, bgr, class_names, **kw):
        out = []
        for d in orig_detect(self, bgr, class_names, **kw):
            tokens = d["label"].split()
            if "door" in tokens and (tokens != ["door"] or d["score"] < min_score):
                d = dict(d, label=" ".join(t for t in tokens if t != "door"))
            out.append(d)
        return out

    cfs.GroundingDinoProvider.detect = detect


def patch_k2a(color_tol=0.012, shape_tol=0.005, target_sim=0.24, min_saturation=75):
    """K2a(2026-09-14 사용자 방향 "게이트는 유지, 통과 기준만 완화, 참조이미지는 필수 제외"):
      class_features.json(door): reference_image_similarity_min 삭제, target_sim_threshold 0.24,
                                 saturation_gate.min_saturation 75, 종횡비 1.5 유지, shape_gate 유지
      색 게이트: light blue 1등 -> 1등과 차이 color_tol 이내
      모양 게이트: positive 1등 -> 최고 negative보다 shape_tol 이내
      GroundingDINO: door 증거만 '라벨 정확히 door + 점수>=0.25'(R2b와 동일, 단상 판정 불변)
    색/모양 기준은 서비스 함수 원문에서 판정 두 줄만 바꿔 다시 정의한다(나머지 로직은 운영 코드 그대로)."""
    import inspect
    import textwrap

    data = json.loads(cfs.CLASS_FEATURES_PATH.read_text(encoding="utf-8"))
    door = copy.deepcopy(data["door"])
    door.pop("reference_image_similarity_min", None)
    door["target_sim_threshold"] = target_sim
    door["saturation_gate"] = dict(door["saturation_gate"], min_saturation=min_saturation)
    data["door"] = door
    path = HERE / "keep_relaxed_class_features.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    cfs.CLASS_FEATURES_PATH = path

    src = textwrap.dedent(inspect.getsource(cfs._dictionary_gate_and_score))
    old_color = "color_check_passed = all_color_sim.argmax(axis=1) == 0"
    new_color = ("color_check_passed = (all_color_sim[:, 0] - np.delete(all_color_sim, 0, axis=1).max(axis=1)) "
                 f">= -({color_tol} if class_name == 'door' else 0.0)")
    old_shape = "shape_check_passed = shape_sim.argmax(axis=1) < n_positive"
    new_shape = ("shape_check_passed = (shape_sim[:, :n_positive].max(axis=1) - shape_sim[:, n_positive:].max(axis=1)) "
                 f">= -({shape_tol} if class_name == 'door' else 0.0)")
    assert old_color in src and old_shape in src, "서비스 게이트 코드가 바뀌어 패치 지점을 못 찾음"
    exec(src.replace(old_color, new_color).replace(old_shape, new_shape), cfs.__dict__)
    _patch_door_only_gdino()


def main(mode: str):
    if mode == "R2":
        patch_r2()
    elif mode == "R2b":
        patch_r2b()
    elif mode == "K2a":
        patch_k2a()
    elif mode == "K4":  # 추천안: 조명·각도 변형 22세트 평가로 sim 0.24 -> 0.25(오탐 7 -> 2)
        patch_k2a(target_sim=0.25)
    finder = cfs.ClassFinderService()
    summary = {}
    for set_name in ("rot8", "robot"):
        frame_dir, frames = SETS[set_name]
        cfs.RUN_DIR = HERE / "e2e" / mode / set_name
        finder.on_class_discovery_command("door")
        for i, (fname, rot) in enumerate(frames):
            finder.on_frame(frame_dir / fname, rot, i)
        dets = finder.get_detections("door")
        gts = GT_BY_SET[set_name]
        rows = []
        for fname, rot in frames:
            d = dets[rot]
            gt = gts["doors"].get(fname)
            insts = [{"box": inst["box_xyxy"], "iou_gt": round(rl.iou(inst["box_xyxy"], gt), 3) if gt else None,
                      "sources": sorted(inst["supporting_sources"])} for inst in d["instances"]]
            rows.append({"frame": fname, "rotation_deg": rot, "gt": gt, "instances": insts})
        summary[set_name] = rows
    out = HERE / "e2e" / f"summary_{mode}.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    for set_name, rows in summary.items():
        print(f"\n[{mode} / {set_name}]")
        for r in rows:
            mark = "문" if r["gt"] else ("애매" if r["frame"] in GT_BY_SET[set_name]["ambiguous"] else "  ")
            print(f"   {r['frame']} {r['rotation_deg']:>5} {mark} -> {r['instances']}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "R2")
