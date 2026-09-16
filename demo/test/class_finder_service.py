"""demo/test/class_finder_service.py

implements: 사용자 지시 누적 반영 -- (1) "지정 클래스 발견 코드. 명령을 받고
프레임마다 디렉터리 만들고 original.jpg 먼저 저장, 근거 json은 검출된 타겟의
feature 유사도와 최종 점수만, 다른 기기 mac 전송은 미리 구현 후 주석 처리."
(2) "door와 pedestal는 로봇이 본인 위치 추정하기 위해 자동으로 먼저 계산."
(3) "찾으려는 클래스는 프레임마다 하나가 아니라 여러개 존재할 수도 있어."
(4) "grounding dino도 증거로 추가... 추가 증거들도 전부 다운로드 받고 실험
진행하며 가장 성능이 좋고 안정적인 증거 조합을 찾아내자. 증거마다 처리 시간이
다르니 전부 기다리지 않고 정해진 수식으로 더하도록 하자 -- progressive-object-
record 아이디어처럼." (5) "association 기준을 확장." (6) "demo/test에 지금
방식으로 코드 3개로만 정리. 원본+오버레이 이미지는 동일하게, 증거 json은
명확하고 간결하게 -- 어떤 증거와 연산을 거쳐 후보가 선택됐는지, 몇 ms일 때
결과인지."

**아키텍처**: 4개의 독립된 provider(사전 CLIP, GroundingDINO, YOLO-World,
FastSAM)가 비동기로(실측 처리시간이 서로 다름) 같은 프레임을 분석하고, 그
결과를 사용자가 작성한 논문("Progressive Digital Twin Object Record
Construction Method Using Heterogeneous Models in an On-Device Environment")의
수식(Eq 1-13)으로 통합한다 -- 가장 느린 provider를 기다리지 않고, 증거가
도착하는 순서대로 점진적으로 물체 상태를 재해석한다.

- Evidence event(Eq 1): source, 완료시각(ms, 실측), 종류(box/mask), 신뢰도,
  payload(박스/라벨) -- `EvidenceEvent`
- 관측 내 물리 객체 연계(Eq 2, association threshold=0.30 논문 값 + containment
  확장): `MultiObjectProgressiveResolver` -- "찾으려는 클래스는 여러 개일 수도
  있다"는 지시를 여기서 만족한다. 순수 IoU만으로는 머리/전신처럼 스케일이 크게
  다른 같은 물체의 증거를 못 묶는 문제를 실측 확인해서(2026-09-11)
  containment 기준을 OR로 추가했고, 그래도 남는 시간차 분리 문제는 관측 종료
  시 최종 기하로 한 번 더 병합하는 `consolidate()`로 해결했다.
- 기하 해석(Eq 5-6): 마스크(FastSAM)가 박스 증거와 spatial consistency>=0.45면
  마스크 채택, 아니면 confidence-weighted 박스 평균.
- 의미 해석(Eq 7-8): provider(=source_group)별 최고신뢰 대표값 -> 그룹 수
  다수결 -> 신뢰도 합 동률 처리.
- lifecycle(Eq 9): PROVISIONAL(단일 소스) -> CONFIRMED(독립 소스 2개 이상 동의)
  -- "증거 기반 score가 임계값 이상으로 충분하다 판단되면 확정"의 실제 기준.
- 점진적 구성(Eq 10-13): 완료시각 순으로 증거를 하나씩 반영, "보이는 상태"가
  바뀔 때만 레코드 갱신 노출(confidence만 바뀌는 건 갱신 아님).

door/pedestal은 로봇이 8프레임 환경 탐색 결과로 항상 자기 위치를 먼저
추정하기 위한 랜드마크 클래스라 실제 명령의 target_class와 무관하게 매
프레임마다 항상 함께 탐색한다(LOCALIZATION_CLASSES).

**실측 결론(2026-09-11, demo/test/progressive_evidence_resolver.py 실험)**:
사전(CLIP) 파이프라인은 RPN 후보를 전부 CLIP에 통과시키는 구조라 프레임당
1.3~1.8초로 GroundingDINO(~0.2초)/YOLO-World(~0.1초)/FastSAM(~0.02초)보다
15~20배 느리다. 그래도 이 4개를 group-count 합의 규칙으로 통합하면 게이트
튜닝(채도/참조이미지/종횡비 등, class_features.json에 기록된 door/pedestal
튜닝 이력 참고) 없이도 person/door 둘 다 8프레임 전체에서 실제 정답과 100%
일치하는 결과가 나왔다 -- 이게 이 파일이 최종적으로 채택한 방식이다.

전송(다른 기기로 MAC 주소를 통해 보내기)은 아직 구현하지 않고 호출 지점만
주석 처리해뒀다(`_send_to_device` 참고).
"""

from __future__ import annotations

import ctypes
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

_VENV_SITE = Path(sys.prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
for _lib_dir in [_VENV_SITE / "nvidia" / "cu13" / "lib", _VENV_SITE / "nvidia" / "cudnn" / "lib"]:
    if _lib_dir.is_dir():
        for _so in sorted(_lib_dir.glob("*.so*")):
            try:
                ctypes.CDLL(str(_so), mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass

import cv2
import numpy as np
import onnxruntime as ort
import torch
from tokenizers import Tokenizer
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
from ultralytics import YOLO, FastSAM

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "research" / "oln_training"))

OUT_ROOT = Path(__file__).resolve().parent
CLASS_FEATURES_PATH = OUT_ROOT / "class_features.json"
YOLO_WEIGHTS_DIR = REPO_ROOT / "research" / "oln_training" / "yolo_weights"

# 2026-09-11 사용자 지시: 클래스별 최상위 폴더(demo/test/<class>/) 대신 실행
# 단위 폴더(try1) 밑에 프레임 폴더, 그 밑에 클래스 폴더를 두는 구조로 재구성.
# navigate_to_target_service.py도 이 RUN_DIR을 그대로 공유해 localization/,
# navigation/ 폴더를 같은 위치에 만든다.
RUN_DIR = OUT_ROOT / "try1"

# ── 사전(CLIP) provider 설정 -- 이 세션에서 실측 확정한 값 그대로 ──
YOLO_WEIGHTS_PATH = YOLO_WEIGHTS_DIR / "yolov8n.pt"
YOLO_DEVICE = "cuda"
# door가 COCO 80개 클래스에 없어서 confidence가 door-ness와 무관하다(실측: 진짜
# 문 박스의 confidence가 0.0001~0.001 수준까지 낮을 수 있음) -- confidence로
# 미리 거르지 않는다. topN을 3000까지 올려도(사실상 무제한) 이제는 다른
# provider들과의 합의 규칙이 오탐을 걸러내므로 부담이 없다(아래 클래스
# docstring의 실측 결론 참고).
YOLO_CONF = 1e-4
YOLO_IOU_NEARDUP = 0.999
YOLO_MAX_DET = 3000
YOLO_TOPN = 1000
NMS_IOU_THR = 0.5
MIN_CROP_SIDE_PX = 16
TARGET_SIM_THRESHOLD = 0.26

BORDER_CROP_SOURCE_SIZE = (464, 400)
BORDER_CROP_BOX = (114, 80, 351, 321)

CLIP_DIR = REPO_ROOT / "models" / "openvocab" / "clip-vit-base-patch32"
IMAGE_SIZE = 224
CLIP_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
CLIP_STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)
CONTEXT_LENGTH = 77
COLOR_COMPETITOR_WORDS = ["white", "gray", "black", "brown", "red", "yellow", "green"]

# ── 다른 3개 provider 설정 ──
GROUNDING_DINO_MODEL_ID = "IDEA-Research/grounding-dino-tiny"
GROUNDING_DINO_BOX_THRESHOLD = 0.15
GROUNDING_DINO_TEXT_THRESHOLD = 0.15
YOLO_WORLD_WEIGHTS = YOLO_WEIGHTS_DIR / "yolov8s-worldv2.pt"
YOLO_WORLD_CONF = 0.05
FASTSAM_WEIGHTS = YOLO_WEIGHTS_DIR / "FastSAM-s.pt"

# ── 논문 Eq 2/6/9 파라미터 ──
ASSOCIATION_IOU_THR = 0.30            # 논문 본문 값
ASSOCIATION_CONTAINMENT_THR = 0.7     # 2026-09-11 확장(스케일 차이 큰 같은 물체 병합)
MASK_SPATIAL_CONSISTENCY_THR = 0.45   # τ_m (Eq 6)
CONFIRM_MIN_DISTINCT_GROUPS = 2       # lifecycle PROVISIONAL->CONFIRMED (Eq 9)
MASK_ONLY_SOURCES = {"fastsam"}       # 의미 투표에 참여하지 않는 소스

# 2026-09-11 사용자 지시: "각 증거들의 모델명도 좋지만 분류도 추가되면 좋을 것
# 같아... 문장형으로 작성하지 않음" -- evidence.json에 모델명(source)과 별개로
# 방법론 분류만 짧게 남긴다(설명 문장 아님, source 필드에 이미 모델명이 있음).
SOURCE_CATEGORIES = {
    "dictionary": "CLIP",
    "grounding_dino": "OVD",
    "yolo_world": "OVD",
    "fastsam": "segmentation",
}

# door/pedestal은 로봇이 8프레임 환경 탐색 결과로 항상 자기 위치를 먼저
# 추정하기 위한 랜드마크 클래스다 -- 실제 명령의 target_class와 무관하게 매
# 프레임마다 항상 이 둘도 함께 탐색한다.
LOCALIZATION_CLASSES = ["door", "pedestal"]

# 프레임 단위 "확정된 클래스 전부 오버레이" 이미지에서 클래스를 색으로 구분한다.
CLASS_COLORS = {"door": (0, 0, 255), "pedestal": (255, 0, 0), "person": (0, 200, 0)}
DEFAULT_CLASS_COLOR = (0, 200, 200)


def _send_to_device(payload: dict, tag: str, target_mac: str | None = None) -> None:
    """다른 기기로 결과를 보내는 지점 -- 지금은 저장만 하고 실제 전송은 주석
    처리해뒀다. target_mac만 채우면 활성화할 수 있게 인터페이스를 미리 맞춤."""
    # TODO(추후 통합): 아래처럼 실제 전송 코드를 넣는다. 구체 전송 기술(예: 어떤
    # 프로토콜로 MAC 주소를 대상으로 보낼지)은 아직 정해지지 않았으므로 자리만
    # 남겨둔다.
    # import some_transport_provider
    # some_transport_provider.send(target_mac=target_mac, tag=tag, payload=payload)
    pass


# ══════════════════════════════ 공용 기하 헬퍼 ══════════════════════════════

def _iou_xyxy(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / ua if ua > 0 else 0.0


def _iou_and_containment(a, b):
    """IoU와 (한쪽이 다른 쪽에 포함된 비율의 최댓값)을 함께 반환한다. 몸의
    일부만 담은 박스(머리/전신처럼 스케일이 크게 다른 같은 물체)는 순수 IoU로
    못 묶이므로 containment도 같이 봐야 한다(2026-09-11 실측 확인)."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    iou = inter / union if union > 0 else 0.0
    contain_a = inter / area_a if area_a > 0 else 0.0
    contain_b = inter / area_b if area_b > 0 else 0.0
    return iou, max(contain_a, contain_b)


def _union_box(boxes):
    x1 = min(b[0] for b in boxes)
    y1 = min(b[1] for b in boxes)
    x2 = max(b[2] for b in boxes)
    y2 = max(b[3] for b in boxes)
    return (x1, y1, x2, y2)


OVERLAY_UPSCALE = 2  # 프레임이 237x241 정도로 작아 원본 해상도에 그대로 글자를
                     # 쓰면 깨져 보인다(2026-09-11 사용자 지적) -- 확대한 캔버스에
                     # 그린 뒤 그대로 저장해서 글자를 선명하게 만든다.


def _draw_labeled_boxes(bgr, items, upscale: int = OVERLAY_UPSCALE):
    """items: [(box_xyxy, (b,g,r) color, label_str), ...]. 얇은 테두리(1px,
    확대 좌표계 기준) + 안티에일리어싱 텍스트로 작은 프레임에서도 깨지지 않게
    그린다."""
    h, w = bgr.shape[:2]
    canvas = cv2.resize(bgr, (w * upscale, h * upscale), interpolation=cv2.INTER_LINEAR)
    for box, color, label in items:
        x1, y1, x2, y2 = [int(round(v * upscale)) for v in box]
        cv2.rectangle(canvas, (x1, y1), (x2, y2), color, 1, lineType=cv2.LINE_AA)
        if label:
            cv2.putText(canvas, label, (x1, max(14, y1 - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1,
                        lineType=cv2.LINE_AA)
    return canvas


def _nms_dedup(boxes, scores, iou_thr):
    keep = []
    suppressed = [False] * len(boxes)
    for i in range(len(boxes)):
        if suppressed[i]:
            continue
        keep.append(i)
        for j in range(i + 1, len(boxes)):
            if not suppressed[j] and _iou_xyxy(boxes[i], boxes[j]) >= iou_thr:
                suppressed[j] = True
    return keep


# ══════════════════════════ 사전(CLIP) provider ══════════════════════════

class _DeploymentYoloProposer:
    """RPN class-agnostic 후보 제안(YOLOv8n) -- 사전 provider 전용."""

    def __init__(self, weights_path, device, conf, iou):
        self.model = YOLO(str(weights_path))
        self.model.to(device)
        self.device = device
        self.conf = conf
        self.iou = iou

    def propose(self, bgr):
        r = self.model.predict(bgr, conf=self.conf, iou=self.iou, agnostic_nms=True,
                                max_det=YOLO_MAX_DET, verbose=False, device=self.device)
        res = r[0]
        if len(res.boxes) == 0:
            return [], []
        boxes_np = res.boxes.xyxy.detach().cpu().numpy()
        scores_np = res.boxes.conf.detach().cpu().numpy()
        order = np.argsort(-scores_np)
        boxes = [tuple(float(v) for v in boxes_np[i]) for i in order]
        scores = [float(scores_np[i]) for i in order]
        return boxes, scores


def _clip_preprocess(bgr: np.ndarray) -> np.ndarray:
    rgb = bgr[:, :, ::-1]
    h, w = rgb.shape[:2]
    s = IMAGE_SIZE / min(h, w)
    r = cv2.resize(np.ascontiguousarray(rgb), (max(IMAGE_SIZE, int(round(w * s))), max(IMAGE_SIZE, int(round(h * s)))),
                   interpolation=cv2.INTER_CUBIC)
    y = (r.shape[0] - IMAGE_SIZE) // 2
    x = (r.shape[1] - IMAGE_SIZE) // 2
    c = r[y:y + IMAGE_SIZE, x:x + IMAGE_SIZE].astype(np.float32) / 255.0
    return ((c - CLIP_MEAN) / CLIP_STD).transpose(2, 0, 1)


class BatchClipEngine:
    """quantized CLIP 유지(fp32 시도 결과 정확도가 깨져서 되돌린 실측 결론)."""

    def __init__(self) -> None:
        so = ort.SessionOptions()
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        self.vision = ort.InferenceSession(str(CLIP_DIR / "onnx" / "vision_model_quantized.onnx"),
                                            sess_options=so, providers=providers)
        self.text = ort.InferenceSession(str(CLIP_DIR / "onnx" / "text_model_quantized.onnx"),
                                          sess_options=so, providers=providers)
        tok = Tokenizer.from_file(str(CLIP_DIR / "tokenizer.json"))
        eot = tok.token_to_id("<|endoftext|>")
        tok.enable_padding(pad_id=eot if eot is not None else 0, length=CONTEXT_LENGTH)
        tok.enable_truncation(CONTEXT_LENGTH)
        self.tok = tok

    def embed_images(self, crops_bgr: list[np.ndarray]) -> np.ndarray:
        batch = np.stack([_clip_preprocess(c) for c in crops_bgr], axis=0)
        e = self.vision.run(None, {"pixel_values": batch})[0]
        return e / np.linalg.norm(e, axis=-1, keepdims=True)

    def embed_texts(self, prompts: list[str]) -> np.ndarray:
        ids = np.array([e.ids for e in self.tok.encode_batch(prompts)], np.int64)
        e = self.text.run(None, {"input_ids": ids})[0]
        return e / np.linalg.norm(e, axis=-1, keepdims=True)


def _median_saturation(crop_bgr) -> float:
    """crop 픽셀의 HSV 채도(S) 직접 측정 -- CLIP 텍스트 색상 게이트로 못 가르던
    door 오탐(하얀 하늘색 vs 진한 하늘색)을 실측으로 분리한 게이트."""
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    return float(np.median(hsv[..., 1]))


def _median_hue(crop_bgr) -> float:
    """crop 픽셀의 HSV 색상(H, OpenCV 0~179) 중앙값 -- 2026-09-15 door 강화: 짙은 바지 다리(H 105~125)가
    CLIP 색 게이트(light blue와 차이 0.012 이내)를 통과하던 것을 픽셀 색상으로 한 번 더 거른다."""
    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    return float(np.median(hsv[..., 0]))


def _dictionary_gate_and_score(class_name, cfg, image_embeds, candidates, crops):
    """RPN 후보들을 하나의 클래스 설정(cfg)과 비교해 필수 게이트(색/모양/
    참조이미지/채도)를 통과한 후보 목록을 반환한다. class_features.json에
    기록된 door/pedestal 튜닝 이력이 이 게이트들의 실측 근거다.

    2026-09-11 사용자 지시: "clip은 어떤 특징 증거를 비교하고 gate 적용했는지와
    그 결과 정보가 있어야지" -- 통과한 각 후보에 실제 비교한 텍스트 특징들의
    유사도 전부와, 게이트별 실측값·통과여부를 함께 담아 반환한다."""
    sim_matrix = image_embeds @ cfg["text_embeds"].T
    best_feature_idx = sim_matrix.argmax(axis=1)
    target_sim = sim_matrix.max(axis=1)
    n = len(candidates)

    # 2026-09-14 사용자 지시: "조명, 촬영 각도 등이 달라지는 상황을 고려해 색, 채도, 종횡비 등의 게이트는
    # 유지한 채 통과 기준만을 완화" -- 색/모양 게이트의 '1등이어야 통과'를 '1등과 tolerance 이내면 통과'로
    # 바꾼다(tolerance=0이면 예전 규칙과 같음). 순위(상위 k등)가 아니라 차이로 푸는 이유: 8색 유사도가
    # 0.01 안에 몰려 있어 어두운 조명에서 실제 문의 light blue가 6등까지 떨어지지만 1등과의 차이는
    # -0.0074에 그쳤다(research/door_gate_relax/RESULT.md).
    color_check_passed = np.ones(n, dtype=bool)
    all_color_prompts, all_color_sim, color_gap = None, None, None
    if cfg["color_feature_k"]:
        own_color_feature_text = cfg["llm_features"][cfg["color_feature_k"][0]]
        own_color_word = own_color_feature_text.rsplit(" color", 1)[0]
        unanchored = own_color_feature_text not in [
            f for f in cfg["llm_features"] if f"a {class_name}'s {f}" in cfg["anchored_features"]]
        if unanchored:
            all_color_prompts = [f"{own_color_word} color"] + [f"{c} color" for c in COLOR_COMPETITOR_WORDS]
        else:
            all_color_prompts = [f"a {class_name}'s {own_color_word} color"] + [
                f"a {class_name}'s {c} color" for c in COLOR_COMPETITOR_WORDS]
        all_color_sim = image_embeds @ cfg["engine"].embed_texts(all_color_prompts).T
        color_gap = all_color_sim[:, 0] - np.delete(all_color_sim, 0, axis=1).max(axis=1)
        color_check_passed = color_gap >= -cfg["color_tol"]

    shape_check_passed = np.ones(n, dtype=bool)
    shape_prompts, shape_sim, shape_gap = None, None, None
    if cfg["shape_cfg"] and cfg["shape_embeds"] is not None:
        shape_prompts = cfg["shape_cfg"]["positive_prompts"] + cfg["shape_cfg"]["negative_prompts"]
        n_positive = len(cfg["shape_cfg"]["positive_prompts"])
        shape_sim = image_embeds @ cfg["shape_embeds"].T
        shape_gap = shape_sim[:, :n_positive].max(axis=1) - shape_sim[:, n_positive:].max(axis=1)
        shape_check_passed = shape_gap >= -cfg["shape_tol"]

    ref_image_check_passed = np.ones(n, dtype=bool)
    ref_image_sim = None
    if cfg["ref_sim_min"] is not None and cfg["ref_image_embed"] is not None:
        ref_image_sim = image_embeds @ cfg["ref_image_embed"].T
        ref_image_check_passed = ref_image_sim[:, 0] >= cfg["ref_sim_min"]

    saturation_values = None
    saturation_check_passed = np.ones(n, dtype=bool)
    if cfg["saturation_cfg"] is not None:
        saturation_values = np.array([_median_saturation(c) for c in crops])
        sat_cfg = cfg["saturation_cfg"]
        if "min_saturation" in sat_cfg:
            saturation_check_passed &= saturation_values >= sat_cfg["min_saturation"]
        if "max_saturation" in sat_cfg:
            saturation_check_passed &= saturation_values <= sat_cfg["max_saturation"]

    hue_values = None
    hue_check_passed = np.ones(n, dtype=bool)
    if cfg["hue_cfg"] is not None:
        hue_values = np.array([_median_hue(c) for c in crops])
        hue_check_passed = ((hue_values >= cfg["hue_cfg"]["min_median_hue"])
                            & (hue_values <= cfg["hue_cfg"]["max_median_hue"]))

    def _passes_aspect(i):
        if cfg["min_aspect"] is None:
            return True
        x1, y1, x2, y2 = candidates[i]
        bw, bh = x2 - x1, y2 - y1
        return bw > 0 and (bh / bw) >= cfg["min_aspect"]

    def _gate_detail(i):
        """이 후보가 실제로 비교한 텍스트 특징 전부의 유사도 + 게이트별
        실측값·통과여부. evidence.json의 detail 필드로 그대로 저장된다."""
        detail = {
            "compared_features": {cfg["anchored_features"][k]: round(float(sim_matrix[i, k]), 4)
                                   for k in range(len(cfg["anchored_features"]))},
            "gates": {},
        }
        if all_color_sim is not None:
            winner = all_color_prompts[int(all_color_sim[i].argmax())]
            # winning_color는 1등 색 그대로다 -- tolerance로 통과하면 1등이 다른 색일 수 있으므로 판정 근거는
            # target_color_gap(목표색 - 나머지 최고)과 tolerance를 함께 본다.
            detail["gates"]["color"] = {"passed": bool(color_check_passed[i]), "winning_color": winner,
                                         "target_color_gap": round(float(color_gap[i]), 4),
                                         "tolerance": cfg["color_tol"],
                                         "candidates": {p: round(float(all_color_sim[i, k]), 4)
                                                        for k, p in enumerate(all_color_prompts)}}
        if shape_sim is not None:
            winner = shape_prompts[int(shape_sim[i].argmax())]
            detail["gates"]["shape"] = {"passed": bool(shape_check_passed[i]), "winning_shape": winner,
                                         "positive_minus_negative": round(float(shape_gap[i]), 4),
                                         "tolerance": cfg["shape_tol"],
                                         "candidates": {p: round(float(shape_sim[i, k]), 4)
                                                        for k, p in enumerate(shape_prompts)}}
        if ref_image_sim is not None:
            detail["gates"]["reference_image"] = {"passed": bool(ref_image_check_passed[i]),
                                                    "similarity": round(float(ref_image_sim[i, 0]), 4),
                                                    "threshold_min": cfg["ref_sim_min"]}
        if saturation_values is not None:
            detail["gates"]["saturation"] = {"passed": bool(saturation_check_passed[i]),
                                              "median_saturation": round(float(saturation_values[i]), 1),
                                              **{k: v for k, v in cfg["saturation_cfg"].items()
                                                 if k in ("min_saturation", "max_saturation")}}
        if hue_values is not None:
            detail["gates"]["hue"] = {"passed": bool(hue_check_passed[i]),
                                       "median_hue": round(float(hue_values[i]), 1),
                                       "min_median_hue": cfg["hue_cfg"]["min_median_hue"],
                                       "max_median_hue": cfg["hue_cfg"]["max_median_hue"]}
        if cfg["min_aspect"] is not None:
            x1, y1, x2, y2 = candidates[i]
            bw, bh = x2 - x1, y2 - y1
            detail["gates"]["aspect_ratio"] = {"passed": _passes_aspect(i),
                                                "h_over_w": round(bh / bw, 3) if bw > 0 else None,
                                                "min_required": cfg["min_aspect"]}
        return detail

    passed = []
    for i in range(n):
        if (target_sim[i] >= cfg["target_sim_threshold"] and _passes_aspect(i)
                and color_check_passed[i] and shape_check_passed[i] and ref_image_check_passed[i]
                and saturation_check_passed[i] and hue_check_passed[i]):
            passed.append({"box": candidates[i], "score": float(target_sim[i]),
                            "label": cfg["anchored_features"][int(best_feature_idx[i])],
                            "detail": _gate_detail(i)})
    return passed


def _cluster_same_source_boxes(boxes_with_scores, iou_thr=NMS_IOU_THR, containment_thr=ASSOCIATION_CONTAINMENT_THR):
    """같은 provider가 낸 여러 후보를(예: 사전 게이트를 통과한 여러 crop) 물리
    객체 단위로 미리 합쳐 합집합 박스로 만든다 -- 부위별로 갈라진 후보를 provider
    한 개가 이미 정리해서 내놓게 하기 위함(효율 + 이후 다중 provider 합의 단계의
    노이즈 감소)."""
    order = sorted(range(len(boxes_with_scores)), key=lambda i: -boxes_with_scores[i]["score"])
    assigned = set()
    clusters = []
    for i in order:
        if i in assigned:
            continue
        cluster = [i]
        assigned.add(i)
        changed = True
        while changed:
            changed = False
            cur_union = _union_box([boxes_with_scores[k]["box"] for k in cluster])
            for j in order:
                if j in assigned:
                    continue
                iou, containment = _iou_and_containment(cur_union, boxes_with_scores[j]["box"])
                if iou >= iou_thr or containment >= containment_thr:
                    cluster.append(j)
                    assigned.add(j)
                    changed = True
        clusters.append(cluster)
    merged = []
    for cluster in clusters:
        boxes = [boxes_with_scores[k]["box"] for k in cluster]
        best_k = max(cluster, key=lambda k: boxes_with_scores[k]["score"])
        merged.append({"box_xyxy": [round(v, 2) for v in _union_box(boxes)],
                        "score": round(boxes_with_scores[best_k]["score"], 4),
                        "label": boxes_with_scores[best_k]["label"],
                        "detail": boxes_with_scores[best_k].get("detail")})
    return merged


class DictionaryProvider:
    """사전(class_features.json) 기반 RPN+CLIP provider. 클래스별 게이트(색/
    모양/참조이미지/채도)는 이 provider 내부에서만 적용되고, 그 결과(통과한
    후보들을 합친 박스+점수)가 다른 provider들과 동일한 형식의 증거로 나간다."""

    def __init__(self) -> None:
        self.proposer: _DeploymentYoloProposer | None = None
        self.engine: BatchClipEngine | None = None
        self.class_dict: dict | None = None
        self.class_configs: dict[str, dict] = {}
        self.last_rpn_candidates: list = []

    def _ensure_loaded(self):
        if self.proposer is None:
            self.proposer = _DeploymentYoloProposer(YOLO_WEIGHTS_PATH, YOLO_DEVICE, YOLO_CONF, YOLO_IOU_NEARDUP)
        if self.engine is None:
            self.engine = BatchClipEngine()
        if self.class_dict is None:
            self.class_dict = json.loads(CLASS_FEATURES_PATH.read_text(encoding="utf-8"))

    def load_classes(self, class_names: list[str]) -> dict[str, list[str]]:
        """class_names 각각의 CLIP 텍스트 임베딩 등을 준비한다. 반환값은
        {class_name: 비교에 실제 쓰인 문구 리스트}(features_sent.json 저장용)."""
        self._ensure_loaded()
        sent_features = {}
        for class_name in class_names:
            if class_name in self.class_configs:
                sent_features[class_name] = self.class_configs[class_name]["anchored_features"]
                continue
            cls = self.class_dict[class_name]
            llm_features = list(cls["features"])
            ref_block = cls.get("reference_image_features", {})
            ref_features = ref_block.get("features", [])
            llm_features = llm_features + ref_features
            unanchored = set(ref_block.get("unanchored_features", []))
            anchored_features = [f if f in unanchored else f"a {class_name}'s {f}" for f in llm_features]
            color_feature_k = [k for k, f in enumerate(llm_features) if f in ref_features and "color" in f.lower()]
            text_embeds = self.engine.embed_texts(anchored_features)
            shape_cfg = cls.get("shape_gate")
            shape_embeds = None
            if shape_cfg:
                shape_embeds = self.engine.embed_texts(shape_cfg["positive_prompts"] + shape_cfg["negative_prompts"])
            ref_image_embed = None
            ref_image_path_str = ref_block.get("source_image")
            if ref_image_path_str:
                ref_bgr = cv2.imread(str(REPO_ROOT / ref_image_path_str))
                if ref_bgr is not None:
                    ref_image_embed = self.engine.embed_images([ref_bgr])
            self.class_configs[class_name] = {
                "class_name": class_name, "engine": self.engine, "llm_features": llm_features,
                "anchored_features": anchored_features, "color_feature_k": color_feature_k,
                "min_aspect": cls.get("min_aspect_ratio_h_over_w"), "shape_cfg": shape_cfg,
                "shape_embeds": shape_embeds, "ref_sim_min": cls.get("reference_image_similarity_min"),
                "ref_image_embed": ref_image_embed, "text_embeds": text_embeds,
                "target_sim_threshold": cls.get("target_sim_threshold", TARGET_SIM_THRESHOLD),
                "saturation_cfg": cls.get("saturation_gate"),
                "color_tol": float(cls.get("color_gate_tolerance", 0.0)),
                "shape_tol": float((shape_cfg or {}).get("tolerance", 0.0)),
                "gdino_evidence": cls.get("grounding_dino_evidence"),
                "hue_cfg": cls.get("hue_gate"),
                "pair_iou_min": cls.get("confirm_pair_iou_min"),
            }
            sent_features[class_name] = anchored_features
        return sent_features

    def detect(self, bgr, class_names: list[str]) -> dict[str, list[dict]]:
        """RPN은 클래스 무관이라 1회만 돌리고, 클래스별로 게이트 비교만
        각자 수행한다. 반환: {class_name: [{box_xyxy, score, label}, ...]}.
        RPN 후보 자체는 self.last_rpn_candidates에 남겨(시각화용, "이미지는
        전처럼 rpn오버레이 추가" 지시) 호출부가 다시 계산하지 않게 한다."""
        h, w = bgr.shape[:2]
        all_boxes, all_scores = self.proposer.propose(bgr)
        filtered, filtered_scores = [], []
        for (x1, y1, x2, y2), sc in zip(all_boxes[:YOLO_TOPN], all_scores[:YOLO_TOPN]):
            x1, y1 = max(0.0, x1), max(0.0, y1)
            x2, y2 = min(float(w), x2), min(float(h), y2)
            if (x2 - x1) >= MIN_CROP_SIDE_PX and (y2 - y1) >= MIN_CROP_SIDE_PX:
                filtered.append((x1, y1, x2, y2))
                filtered_scores.append(sc)
        keep = _nms_dedup(filtered, filtered_scores, NMS_IOU_THR)
        candidates = [filtered[i] for i in keep]
        self.last_rpn_candidates = candidates
        crops = [bgr[int(y1):int(y2), int(x1):int(x2)] for (x1, y1, x2, y2) in candidates]
        image_embeds = self.engine.embed_images(crops) if crops else None

        out = {}
        for class_name in class_names:
            if not crops:
                out[class_name] = []
                continue
            cfg = self.class_configs[class_name]
            passed = _dictionary_gate_and_score(class_name, cfg, image_embeds, candidates, crops)
            out[class_name] = _cluster_same_source_boxes(passed) if passed else []
        return out


# ══════════════════════════ 개방어휘 provider 3종 ══════════════════════════

class GroundingDinoProvider:
    def __init__(self, model_id=GROUNDING_DINO_MODEL_ID, device="cuda"):
        self.processor = AutoProcessor.from_pretrained(model_id)
        self.model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(device).eval()
        self.device = device

    def detect(self, bgr, class_names, box_threshold=GROUNDING_DINO_BOX_THRESHOLD,
               text_threshold=GROUNDING_DINO_TEXT_THRESHOLD):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        text = ". ".join(c.lower() for c in class_names) + "."
        inputs = self.processor(images=rgb, text=text, return_tensors="pt").to(self.device)
        with torch.no_grad():
            outputs = self.model(**inputs)
        h, w = bgr.shape[:2]
        result = self.processor.post_process_grounded_object_detection(
            outputs, input_ids=inputs["input_ids"], threshold=box_threshold, text_threshold=text_threshold,
            target_sizes=[(h, w)])[0]
        labels = result.get("text_labels", result.get("labels"))
        out = []
        for box, score, label in zip(result["boxes"], result["scores"], labels):
            out.append({"box_xyxy": [round(float(v), 2) for v in box.tolist()],
                        "score": round(float(score), 4), "label": label})
        return out


class YoloWorldProvider:
    def __init__(self, weights=YOLO_WORLD_WEIGHTS, device="cuda"):
        self.model = YOLO(str(weights))
        self.model.to(device)

    def detect(self, bgr, class_names, conf=YOLO_WORLD_CONF):
        self.model.set_classes(class_names)
        r = self.model.predict(bgr, conf=conf, verbose=False)
        res = r[0]
        out = []
        for b in res.boxes:
            out.append({"box_xyxy": [round(v, 2) for v in b.xyxy[0].tolist()],
                        "score": round(float(b.conf[0]), 4), "label": res.names[int(b.cls[0])]})
        return out


class FastSamProvider:
    """마스크 전용(의미 없음) -- 의미 투표에 참여하지 않고 기하만 보강한다."""

    def __init__(self, weights=FASTSAM_WEIGHTS, device="cuda"):
        self.model = FastSAM(str(weights))
        self.device = device

    def detect(self, bgr):
        h, w = bgr.shape[:2]
        r = self.model.predict(bgr, device=self.device, verbose=False)
        res = r[0]
        out = []
        if res.boxes is not None:
            infer_h, infer_w = res.orig_shape if hasattr(res, "orig_shape") else (h, w)
            sx, sy = w / infer_w, h / infer_h
            for b in res.boxes:
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                out.append({"box_xyxy": [round(x1 * sx, 2), round(y1 * sy, 2), round(x2 * sx, 2), round(y2 * sy, 2)],
                            "score": round(float(b.conf[0]), 4)})
        return out


# ══════════════ 논문 Eq 1-13: progressive 증거 통합 ══════════════

@dataclass
class EvidenceEvent:
    """Eq 1: e_i = (id_i, o_i, s_i, t_i, k_i, c_i, p_i)."""
    id: str
    observation: str
    source: str
    completion_time_ms: float
    evidence_type: str          # "box" | "mask"
    confidence: float | None
    box_xyxy: list | None
    class_label: str | None = None
    detail: dict | None = None  # 사전(CLIP) 소스 전용: 비교한 특징 유사도 + 게이트별 실측값


@dataclass
class ObjectState:
    """Eq 4: S_j(t) = (G_j(t), C_j(t), L_j(t), T_j(t))."""
    geometry: list | None = None
    geometry_source: str | None = None
    semantic_class: str = "unknown"
    supporting_groups: list = field(default_factory=list)
    lifecycle: str = "PROVISIONAL"
    observation_time: str = ""

    def visible(self):
        """Eq 12-13: 레코드 갱신을 촉발하는 '보이는 상태'만(confidence만
        바뀌는 건 갱신 아님)."""
        geo = tuple(round(v / 2) * 2 for v in self.geometry) if self.geometry is not None else None
        return (self.semantic_class, self.lifecycle, self.geometry_source, geo)


def _resolve_geometry(box_evidence: list[EvidenceEvent], mask_evidence: list[dict]):
    """Eq 5-6: 마스크가 박스 증거와 spatial consistency>=τ_m이면 마스크 채택,
    아니면 confidence-weighted 박스 평균."""
    if not box_evidence and not mask_evidence:
        return None, None
    boxes = [(e.box_xyxy, e.confidence or 1e-6) for e in box_evidence]
    admissible_masks = []
    for m in mask_evidence:
        if not boxes:
            continue
        gamma = max(_iou_xyxy(m["box_xyxy"], b) for b, _ in boxes)
        if gamma >= MASK_SPATIAL_CONSISTENCY_THR:
            admissible_masks.append((m, gamma))
    if admissible_masks:
        best_mask, _ = max(admissible_masks, key=lambda t: t[1])
        return best_mask["box_xyxy"], "mask"
    if boxes:
        total_c = sum(c for _, c in boxes)
        avg = [sum(b[k] * c for b, c in boxes) / total_c for k in range(4)]
        return avg, "box_weighted_avg"
    return None, None


def _resolve_semantic(box_evidence: list[EvidenceEvent]):
    """Eq 7-8: source_group별 최고신뢰 대표 가설 -> 그룹 수 다수결 -> 신뢰도 합
    동률 처리 -> 결정론적 순서."""
    by_group: dict[str, EvidenceEvent] = {}
    for e in box_evidence:
        if e.source in MASK_ONLY_SOURCES or e.class_label is None:
            continue
        cur = by_group.get(e.source)
        if cur is None or (e.confidence or 0) > (cur.confidence or 0):
            by_group[e.source] = e
    if not by_group:
        return "unknown", []
    support: dict[str, list[str]] = {}
    for group, e in by_group.items():
        support.setdefault(e.class_label, []).append(group)
    best_count = max(len(v) for v in support.values())
    tied = [c for c, v in support.items() if len(v) == best_count]
    if len(tied) == 1:
        cls = tied[0]
    else:
        conf_sum = {c: sum(by_group[g].confidence or 0 for g in support[c]) for c in tied}
        max_conf = max(conf_sum.values())
        cls = sorted(c for c in tied if conf_sum[c] == max_conf)[0]
    return cls, support[cls]


PAIR_OVD_SOURCES = ("grounding_dino", "yolo_world")


def _dictionary_ovd_pair_iou(box_evidence: list[EvidenceEvent]) -> float:
    """사전(CLIP) 박스와 OVD 박스 중 가장 잘 맞는 한 쌍의 IoU. 둘 중 하나라도 없으면 0.

    2026-09-15 실측(datasets/260915): door 오탐은 전부 작은 CLIP 조각이 GDINO의 큰 단상·사람 박스 안에
    containment로만 묶인 경우였다(짝 IoU 0.03~0.22 vs 실제 문 0.76~0.91) -- 같은 클러스터에 있어도
    서로 다른 범위를 가리키면 '동의'로 치지 않으려고 잰다."""
    dict_boxes = [e.box_xyxy for e in box_evidence if e.source == "dictionary"]
    ovd_boxes = [e.box_xyxy for e in box_evidence if e.source in PAIR_OVD_SOURCES]
    return max((_iou_xyxy(a, b) for a in dict_boxes for b in ovd_boxes), default=0.0)


def _resolve_lifecycle(supporting_groups: list[str], current_class: str, required_source: str | None = None,
                       pair_iou: float | None = None, pair_iou_min: float | None = None) -> str:
    """Eq 9(단순화): 이 데모는 한 관측(프레임) 안의 progressive 해석만 다루므로
    PROVISIONAL/CONFIRMED만 구현한다(STALE/EXPIRED는 여러 관측에 걸친 추적
    개념이라 범위 밖).

    2026-09-11 사용자 지적("path_overlay.jpg가 왜 0도로 나왔냐")으로 실측
    발견한 문제: frame_113의 "pedestal"이 GroundingDINO+YOLO-World 두 OVD만
    동의해서(둘 다 같은 벽 스피커를 착각) 확정됐는데, 이게 실제 단상(frame_039)
    관측과 평균돼 회전각 계산이 깨졌다(180도라는 물리적으로 말이 안 되는
    평균 방위각 발생). OVD 두 개는 서로 다른 모델이지만 방법론이 같아서
    같은 착각을 공유할 수 있다는 것을 실측으로 확인했다 -- door/pedestal처럼
    로봇 위치 추정에 직접 쓰이는 랜드마크 클래스는 이 개체 전용으로 튜닝된
    사전(CLIP) 게이트의 동의가 반드시 있어야 확정하도록 강화한다.

    2026-09-15 추가(class_features.json의 confirm_pair_iou_min, 현재 door만): 사전 박스와 OVD 박스가
    같은 범위를 가리켜야(짝 IoU >= 기준) 확정한다 -- 창문 조각 CLIP 증거가 GDINO의 단상 박스 안에
    포함 관계로 묶여 단상이 문으로 확정되던 오탐 때문이다."""
    if current_class == "unknown":
        return "PROVISIONAL"
    if required_source is not None and required_source not in supporting_groups:
        return "PROVISIONAL"
    if pair_iou_min is not None and (pair_iou is None or pair_iou < pair_iou_min):
        return "PROVISIONAL"
    if len(set(supporting_groups)) >= CONFIRM_MIN_DISTINCT_GROUPS:
        return "CONFIRMED"
    return "PROVISIONAL"


class ProgressiveResolver:
    """Eq 10-13: 완료 시각 순으로 증거를 하나씩 반영하며 재해석하고, '보이는
    상태'가 바뀔 때만 레코드 갱신을 노출한다."""

    def __init__(self, observation: str, required_source: str | None = None, pair_iou_min: float | None = None):
        self.observation = observation
        self.required_source = required_source
        self.pair_iou_min = pair_iou_min
        self.evidence: list[EvidenceEvent] = []
        self.record_updates: list[dict] = []
        self._last_visible = None
        self._update_counter = 0

    def feed(self, event: EvidenceEvent) -> ObjectState:
        self.evidence.append(event)
        box_evidence = [e for e in self.evidence if e.evidence_type == "box"]
        mask_evidence = [{"box_xyxy": e.box_xyxy, "confidence": e.confidence}
                          for e in self.evidence if e.evidence_type == "mask"]
        geometry, geometry_source = _resolve_geometry(box_evidence, mask_evidence)
        semantic_class, supporting_groups = _resolve_semantic(box_evidence)
        pair_iou = _dictionary_ovd_pair_iou(box_evidence) if self.pair_iou_min is not None else None
        lifecycle = _resolve_lifecycle(supporting_groups, semantic_class, self.required_source,
                                       pair_iou, self.pair_iou_min)
        state = ObjectState(geometry=geometry, geometry_source=geometry_source, semantic_class=semantic_class,
                             supporting_groups=supporting_groups, lifecycle=lifecycle, observation_time=self.observation)
        visible = state.visible()
        if visible != self._last_visible:
            self._update_counter += 1
            self._last_visible = visible
            record = {
                "source": event.source, "source_category": SOURCE_CATEGORIES.get(event.source, event.source),
                "arrived_at_ms": round(event.completion_time_ms, 1),
                "semantic_class": state.semantic_class, "supporting_groups": sorted(set(supporting_groups)),
                "lifecycle": state.lifecycle,
                "box_xyxy": [round(v, 1) for v in geometry] if geometry else None,
                "geometry_source": geometry_source,
            }
            if pair_iou is not None:
                record["dictionary_ovd_iou"] = {"value": round(pair_iou, 3), "min_required": self.pair_iou_min}
            if event.detail is not None:
                # "clip은 어떤 특징 증거를 비교하고 gate 적용했는지와 그 결과
                # 정보가 있어야지" -- 사전(CLIP) 소스일 때만 있는 상세 근거.
                record["clip_detail"] = event.detail
            self.record_updates.append(record)
        return state


class MultiObjectProgressiveResolver:
    """Eq 2 확장: 관측(프레임) 안에서 증거를 물리 객체 단위로 연계해 클러스터마다
    독립된 ProgressiveResolver를 돌린다 -- "찾으려는 클래스는 프레임마다 하나가
    아니라 여러개 존재할 수도 있다"는 요구를 여기서 만족한다. 클러스터 배정은
    증거 도착 순서 그대로 진행한다(새 물리 객체도 증거가 오면서 그때그때
    생겨날 수 있다). 마스크 증거(FastSAM)는 겹치는 클러스터가 없으면 새 객체를
    만들지 않고 버려진다(논문: "세그멘터는 새 객체를 만들지 않는다")."""

    def __init__(self, observation: str, association_iou_thr: float = ASSOCIATION_IOU_THR,
                 association_containment_thr: float = ASSOCIATION_CONTAINMENT_THR,
                 required_source: str | None = None, pair_iou_min: float | None = None):
        self.observation = observation
        self.association_iou_thr = association_iou_thr
        self.association_containment_thr = association_containment_thr
        self.required_source = required_source
        self.pair_iou_min = pair_iou_min
        self.resolvers: list[ProgressiveResolver] = []
        self.cluster_geometry: list[list | None] = []

    def _best_match(self, box_xyxy):
        best_idx, best_iou = None, -1.0
        for i, g in enumerate(self.cluster_geometry):
            if g is None:
                continue
            iou, containment = _iou_and_containment(g, box_xyxy)
            if (iou >= self.association_iou_thr or containment >= self.association_containment_thr) and iou > best_iou:
                best_iou, best_idx = iou, i
        return (best_idx, best_iou) if best_idx is not None else (None, 0.0)

    def feed(self, event: EvidenceEvent):
        idx, _ = self._best_match(event.box_xyxy)
        if idx is None:
            if event.evidence_type == "mask":
                return None
            resolver = ProgressiveResolver(self.observation, self.required_source, self.pair_iou_min)
            self.resolvers.append(resolver)
            self.cluster_geometry.append(None)
            idx = len(self.resolvers) - 1
        state = self.resolvers[idx].feed(event)
        self.cluster_geometry[idx] = state.geometry
        return idx, state

    def consolidate(self):
        """스트리밍 도중에는 그 시점까지 누적된 증거만으로 클러스터를 배정하므로,
        같은 물체의 서로 다른 부위 증거가 도착 순서에 따라 별도 클러스터로
        갈라질 수 있다(실측 확인: 상체 증거가 먼저 쌓여 클러스터 geometry가
        좁아진 상태에서 나중에 하체 증거가 도착하면 새 클러스터로 분리됨).
        관측이 끝난 뒤 클러스터들의 '최종' 기하로 한 번 더 병합을 시도한다
        (실 배포에서는 매 이벤트가 아니라 주기적 체크포인트에서 돌리면 된다)."""
        changed = True
        while changed and len(self.resolvers) > 1:
            changed = False
            for i in range(len(self.resolvers)):
                gi = self.cluster_geometry[i]
                if gi is None:
                    continue
                for j in range(i + 1, len(self.resolvers)):
                    gj = self.cluster_geometry[j]
                    if gj is None:
                        continue
                    iou, containment = _iou_and_containment(gi, gj)
                    if iou >= self.association_iou_thr or containment >= self.association_containment_thr:
                        merged_events = sorted(self.resolvers[i].evidence + self.resolvers[j].evidence,
                                                key=lambda e: e.completion_time_ms)
                        merged_resolver = ProgressiveResolver(self.observation, self.required_source, self.pair_iou_min)
                        state = None
                        for e in merged_events:
                            state = merged_resolver.feed(e)
                        self.resolvers[i] = merged_resolver
                        self.cluster_geometry[i] = state.geometry if state else None
                        del self.resolvers[j]
                        del self.cluster_geometry[j]
                        changed = True
                        break
                if changed:
                    break

    def confirmed_objects(self):
        """CONFIRMED 상태에 도달한 클러스터만 최종 검출로 인정한다("증거 기반
        score가 임계값 이상으로 충분하다 판단되면 확정"의 실제 기준)."""
        out = []
        for i, resolver in enumerate(self.resolvers):
            if resolver.record_updates and resolver.record_updates[-1]["lifecycle"] == "CONFIRMED":
                out.append({"cluster_index": i, "final": resolver.record_updates[-1],
                            "evidence_trail": resolver.record_updates})
        return out


# ══════════════════════════════ 서비스 본체 ══════════════════════════════

class ClassFinderService:
    """다중 provider 발견 서비스. ClassDiscoveryCommand -> on_frame() x N ->
    get_detections(class_name)로 결과를 navigate_to_target_service에 넘겨준다."""

    def __init__(self) -> None:
        self.dictionary = DictionaryProvider()
        self.grounding_dino: GroundingDinoProvider | None = None
        self.yolo_world: YoloWorldProvider | None = None
        self.fastsam: FastSamProvider | None = None
        self.active_classes: list[str] = []
        self._detections: dict[str, dict[float, dict]] = {}

    def on_class_discovery_command(self, target_class: str) -> None:
        t0 = time.perf_counter()
        if self.grounding_dino is None:
            self.grounding_dino = GroundingDinoProvider()
        if self.yolo_world is None:
            self.yolo_world = YoloWorldProvider()
        if self.fastsam is None:
            self.fastsam = FastSamProvider()

        self.active_classes = list(dict.fromkeys(LOCALIZATION_CLASSES + [target_class]))
        sent_features = self.dictionary.load_classes(self.active_classes)
        self._detections = {c: {} for c in self.active_classes}

        # "지금 비교하는 특징만 보냄" -- 사전 provider가 실제 비교에 쓰는 쿼리
        # 문자열만 담아 저장(나중엔 이 시점에 전송). 클래스별 폴더 대신 실행
        # 폴더(RUN_DIR) 밑에 하나로 모아 저장한다.
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        features_payload = {
            class_name: {"requested_by_command": class_name == target_class,
                         "is_localization_landmark": class_name in LOCALIZATION_CLASSES,
                         "features_compared": sent_features[class_name]}
            for class_name in self.active_classes
        }
        with open(RUN_DIR / "features_sent.json", "w", encoding="utf-8") as f:
            json.dump(features_payload, f, ensure_ascii=False, indent=2)
        _send_to_device(features_payload, tag="features")  # 주석 처리된 실제 전송, 지금은 저장만

        print(f"[class_finder] class_discovery({target_class}) 처리 완료, "
              f"이번 명령의 탐색 클래스={self.active_classes} "
              f"({(time.perf_counter()-t0)*1000:.1f}ms, 모델 로드 포함 가능)")

    def on_frame(self, frame_path: Path, rotation_deg: float, frame_index: int) -> None:
        assert self.active_classes, "class_discovery 명령을 먼저 받아야 함"

        # 2026-09-11 사용자 지시: demo/test/<class>/<frame>/ 대신
        # try1/<frame>/[<class>/] 구조로 재구성 -- 프레임 공용 산출물(원본,
        # RPN 오버레이, 확정 전체 오버레이)은 프레임 폴더 바로 밑에, 클래스별
        # 산출물(크롭, 클래스 전용 오버레이, 상세 근거)은 그 안의 클래스
        # 폴더에 둔다.
        frame_dir = RUN_DIR / frame_path.stem
        frame_dir.mkdir(parents=True, exist_ok=True)

        bgr_full = cv2.imread(str(frame_path))
        if bgr_full is None:
            raise FileNotFoundError(frame_path)
        src_h, src_w = bgr_full.shape[:2]
        if (src_w, src_h) == BORDER_CROP_SOURCE_SIZE:
            cl, ct, cr, cb = BORDER_CROP_BOX
            bgr = bgr_full[ct:cb, cl:cr]
        else:
            bgr = bgr_full
        cv2.imwrite(str(frame_dir / "original.jpg"), bgr_full)

        # ── 4개 provider를 프레임당 한 번씩만 호출(모든 active_classes 동시 질의)
        # -- 각 provider의 실제 처리시간을 측정해 완료시각으로 쓴다(가정치 아님) ──
        t0 = time.perf_counter()
        dict_dets = self.dictionary.detect(bgr, self.active_classes)
        t_dict = (time.perf_counter() - t0) * 1000.0

        rpn_overlay = _draw_labeled_boxes(bgr, [(box, (160, 160, 160), None)
                                                 for box in self.dictionary.last_rpn_candidates])
        cv2.imwrite(str(frame_dir / "rpn_overlay.jpg"), rpn_overlay)

        t0 = time.perf_counter()
        gd_dets = self.grounding_dino.detect(bgr, self.active_classes)
        t_gdino = (time.perf_counter() - t0) * 1000.0

        t0 = time.perf_counter()
        yw_dets = self.yolo_world.detect(bgr, self.active_classes)
        t_yw = (time.perf_counter() - t0) * 1000.0

        t0 = time.perf_counter()
        fs_dets = self.fastsam.detect(bgr)  # 클래스 무관(마스크 전용)
        t_fs = (time.perf_counter() - t0) * 1000.0

        provider_timings_ms = {"dictionary": round(t_dict, 1), "grounding_dino": round(t_gdino, 1),
                                "yolo_world": round(t_yw, 1), "fastsam": round(t_fs, 1)}
        print(f"[class_finder] frame#{frame_index}({frame_path.name}, {rotation_deg}도): "
              f"RPN 후보={len(self.dictionary.last_rpn_candidates)}개 provider 처리시간(ms)={provider_timings_ms}")

        found_summary = {}
        confirmed_overlay_items = []  # 프레임 전체 확정 오버레이용 (box, color, label)
        class_summaries = []          # 프레임 evidence.json에 남길 클래스별 요약
        for class_name in self.active_classes:
            class_dir = frame_dir / class_name
            class_dir.mkdir(parents=True, exist_ok=True)

            events: list[EvidenceEvent] = []
            eid = 0
            for d in dict_dets.get(class_name, []):
                eid += 1
                events.append(EvidenceEvent(f"e{eid}", frame_path.name, "dictionary", t_dict, "box",
                                             d["score"], d["box_xyxy"], class_name, d.get("detail")))
            # 2026-09-14: 클래스별 grounding_dino_evidence(class_features.json)가 있으면 그 규칙으로만 받는다.
            # door는 "라벨이 정확히 door + 점수>=0.25" -- 부분일치("door pedestal"도 door)와 0.15 점수로 받던
            # GDINO 오탐(흰 단상/화이트보드/창문)을 막아야 색·채도 게이트의 통과 기준을 풀어도 rot8 오탐이
            # 생기지 않았다. 호출 임계값(0.15/0.15)은 그대로 둬서 단상(GDINO 0.17~0.24) 판정은 바뀌지 않는다.
            gd_rule = self.dictionary.class_configs[class_name].get("gdino_evidence") or {}
            for d in gd_dets:
                if gd_rule.get("exact_label"):
                    if d["label"].strip() != class_name:
                        continue
                elif class_name not in d["label"]:
                    continue
                if d["score"] < gd_rule.get("min_score", 0.0):
                    continue
                eid += 1
                events.append(EvidenceEvent(f"e{eid}", frame_path.name, "grounding_dino", t_gdino, "box",
                                             d["score"], d["box_xyxy"], class_name))
            for d in yw_dets:
                if d["label"] != class_name:
                    continue
                eid += 1
                events.append(EvidenceEvent(f"e{eid}", frame_path.name, "yolo_world", t_yw, "box",
                                             d["score"], d["box_xyxy"], class_name))
            for d in fs_dets:  # 마스크는 클래스 무관 -- 어느 클래스 클러스터든 겹치면 배정됨
                eid += 1
                events.append(EvidenceEvent(f"e{eid}", frame_path.name, "fastsam", t_fs, "mask",
                                             d["score"], d["box_xyxy"], None))

            # ── Eq 10 + Eq 2 확장: 완료 시각 순으로 점진적 반영 + 물리 객체
            # 단위 클러스터링(다중 인스턴스) + 관측 종료 시 최종 통합 ──
            events.sort(key=lambda e: e.completion_time_ms)
            # 랜드마크 클래스(door/pedestal)는 로봇 위치 추정에 직접 쓰이므로
            # OVD 두 개만 동의해도 확정되지 않도록, 이 개체 전용으로 튜닝된
            # 사전(CLIP) 게이트의 동의를 반드시 요구한다(실측 발견: OVD 둘이
            # 같은 벽 스피커를 pedestal로 착각해 위치 추정이 깨진 사례 참고).
            required_source = "dictionary" if class_name in LOCALIZATION_CLASSES else None
            # 2026-09-15: 클래스별 confirm_pair_iou_min(현재 door만) -- 사전 박스와 OVD 박스가 같은 범위를
            # 가리켜야 확정(단상/다리 오탐 대응, class_features.json 근거 참고).
            multi = MultiObjectProgressiveResolver(
                frame_path.name, required_source=required_source,
                pair_iou_min=self.dictionary.class_configs[class_name].get("pair_iou_min"))
            for e in events:
                multi.feed(e)
            multi.consolidate()
            confirmed = multi.confirmed_objects()
            # navigate_to_target_service가 instances[0]을 "가장 강한 근거"로
            # 취급하므로(_best_instance), 지지 provider 수가 많은 순으로 정렬한다.
            confirmed.sort(key=lambda o: -len(set(o["final"]["supporting_groups"])))

            saved_instances = []
            class_overlay_items = []  # 이 클래스 전용 오버레이용
            color = CLASS_COLORS.get(class_name, DEFAULT_CLASS_COLOR)
            for obj in confirmed:
                box = obj["final"]["box_xyxy"]
                if box is None:
                    continue
                # "door[CONFIRMED]가 아닌 그냥 확정된 클래스 door과 같이 클래스만
                # 표시" -- 확정된 것만 그리므로 lifecycle 태그 없이 클래스명만.
                class_overlay_items.append((box, color, class_name))
                confirmed_overlay_items.append((box, color, class_name))
                confidence_sum = sum(
                    e.confidence or 0 for e in
                    (multi.resolvers[obj["cluster_index"]].evidence if obj["cluster_index"] < len(multi.resolvers) else [])
                    if e.source in obj["final"]["supporting_groups"]
                )
                saved_instances.append({
                    "index": obj["cluster_index"],
                    "box_xyxy": [round(v, 1) for v in box],
                    "semantic_class": obj["final"]["semantic_class"],
                    "lifecycle": obj["final"]["lifecycle"],
                    "final_score": round(confidence_sum, 4),
                    "supporting_sources": {s: SOURCE_CATEGORIES.get(s, s) for s in obj["final"]["supporting_groups"]},
                    "evidence_trail": obj["evidence_trail"],
                })

            # "타겟 crop도 추가" -- 확정된 인스턴스마다 크롭 이미지 저장(대표
            # 인스턴스는 target_crop.jpg, 나머지는 번호를 붙인다).
            for i, inst in enumerate(saved_instances):
                x1, y1, x2, y2 = [int(round(v)) for v in inst["box_xyxy"]]
                x1, y1 = max(0, x1), max(0, y1)
                x2, y2 = min(bgr.shape[1], x2), min(bgr.shape[0], y2)
                if x2 > x1 and y2 > y1:
                    crop_name = "target_crop.jpg" if i == 0 else f"target_crop_{i}.jpg"
                    cv2.imwrite(str(class_dir / crop_name), bgr[y1:y2, x1:x2])
            if class_overlay_items:
                cv2.imwrite(str(class_dir / "target_overlay.jpg"), _draw_labeled_boxes(bgr, class_overlay_items))

            evidence = {
                "target_class": class_name, "frame": frame_path.name, "rotation_deg": rotation_deg,
                "provider_timings_ms": provider_timings_ms,
                "instance_count": len(saved_instances), "instances": saved_instances,
            }
            with open(class_dir / "evidence.json", "w", encoding="utf-8") as f:
                json.dump(evidence, f, ensure_ascii=False, indent=2)
            if saved_instances:
                _send_to_device(evidence, tag=f"{class_name}:detection:{frame_path.stem}")  # 주석 처리된 실제 전송

            self._detections[class_name][rotation_deg] = {
                "frame": frame_path.name, "found": len(saved_instances) > 0, "instances": saved_instances,
            }
            found_summary[class_name] = len(saved_instances)
            class_summaries.append({
                "class": class_name, "instance_count": len(saved_instances),
                "boxes": [inst["box_xyxy"] for inst in saved_instances],
            })

        # "탐색한 클래스들 확정만 모두 오버레이한 이미지"
        cv2.imwrite(str(frame_dir / "confirmed_overlay.jpg"), _draw_labeled_boxes(bgr, confirmed_overlay_items))

        frame_evidence = {
            "frame": frame_path.name, "rotation_deg": rotation_deg,
            "provider_timings_ms": provider_timings_ms,
            "rpn_candidate_count": len(self.dictionary.last_rpn_candidates),
            "searched_classes": self.active_classes,
            "confirmed_classes": class_summaries,
        }
        with open(frame_dir / "evidence.json", "w", encoding="utf-8") as f:
            json.dump(frame_evidence, f, ensure_ascii=False, indent=2)

        print(f"[class_finder] frame#{frame_index}({frame_path.name}, {rotation_deg}도): 검출개수={found_summary}")

    def get_detections(self, class_name: str | None = None):
        """class_name을 주면 그 클래스의 {rotation_deg: 결과} 딕셔너리, 생략하면
        {class_name: {rotation_deg: 결과}} 전체를 반환한다. 각 결과는
        {frame, found, instances: [{box_xyxy, final_score, ...}, ...]} 형태로,
        한 프레임에 같은 클래스 인스턴스가 여럿이면 instances가 여러 개다."""
        if class_name is not None:
            return dict(self._detections.get(class_name, {}))
        return {c: dict(d) for c, d in self._detections.items()}
