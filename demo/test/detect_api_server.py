"""demo/test/detect_api_server.py

implements: `탐지_연동스키마_260912.md` §1 -- 관제 웹(브라우저)이 **폴링으로 가져가는**
HTTP 창구 8개. 문서의 핵심 전제 두 가지를 그대로 따른다.

1. **밀어 주지 않는다.** 관제 웹은 브라우저 페이지라 수신을 못 하므로 이쪽은 열어만
   둔다(GET only). 임무 시작/종료 명령도, `command_id`도 받지 않는다.
2. **필드 이름을 바꾸지 않는다.** 화면이 읽는 모양(`src/detect/parse.ts`)은 저쪽이
   맞추기로 했으므로, 이 서버는 문서 §1 예시에 적힌 모양으로만 내보낸다.

**이 파일은 try1/을 읽기만 한다.** 파이프라인(class_finder/navigate) 산출물을 그대로
읽어 HTTP로 옮기는 얇은 어댑터라서 torch/cv2 없이 표준 라이브러리만 쓴다 -- ML 환경이
없는 PC에서도(또는 파이프라인이 죽어도) 창구는 뜬다.

**`target=box`만은 try_box/를 읽는다(2026-11-02).** 박스 편(「박스 앞까지 이동해」)은
4-provider 파이프라인이 아니라 `mqtt_box_receiver.py`(학습한 gray box YOLO + 높이로 거리)가
돌고, 그 산출물은 try_box/에 따로 쌓인다. 2026-11-01 실연동 판에서 수신기가 90도에서 박스를
찾았는데도 이 창구가 try1/만 봐서 `"frames": []`를 줬다 -- 관제 웹 화면이 빈 채로 각도마다
15초씩 기다렸다. 그래서 box만 같은 응답 모양으로 try_box/에서 만들어 준다(아래 「박스 편」 절).
door/pedestal 쪽 동작은 그대로다.

**점진적으로 는다.** 관제 웹은 한 각도가 끝날 때마다 배열이 하나씩 느는 것을 기대하고
(문서 §1①), class_finder_service가 프레임을 끝낼 때마다 try1/<frame>/<class>/evidence.json을
쓰므로, 매 요청 때 디스크를 다시 훑는 것만으로 그 모양이 된다. 캐시하지 않는 이유다.

**아직 없는 것은 404다.** 문서가 "그 전에는 404로 주면 된다"(③ 경로), "못 찾은 각도에는
이 파일이 없는 것이 정상"(② 근거)이라고 정한 대로다. 파이프라인이 `ok:false`로 정직하게
실패를 보고한 경우에도 404를 주되, **그 이유를 본문에 실어** 개발자 도구에서 보이게 한다
(화면은 「아직 안 왔다」로 처리하고 멈추지 않는다).

실행:
    python3 detect_api_server.py                 # 0.0.0.0:8000
    python3 detect_api_server.py --port 8000 --bind 0.0.0.0
    python3 detect_api_server.py --bind $(tailscale ip -4)   # 테일넷에서만 보이게

관제 웹에 넣어 줄 주소(이 PC의 MagicDNS 이름):
    http://<hostname>.<tailnet>.ts.net:8000
"""

from __future__ import annotations

import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

OUT_ROOT = Path(__file__).resolve().parent
RUN_DIR = OUT_ROOT / "try1"  # class_finder_service.RUN_DIR / navigate_to_target_service.RUN_DIR과 동일

# 문서 ⑦은 시료 기준으로 `unidepth_localization/`이라고 부르지만 현재 파이프라인은
# `localization/`에 쓴다 -- 어느 이름이든 읽는다(시료로 맞춰 본 저쪽 환경 호환).
LOCALIZATION_DIR_NAMES = ["localization", "unidepth_localization"]
NAV_DIR_NAME = "navigation"

# 문서 ⑤ `kind` 네 가지 -> 실제 파일 위치. 원본/RPN은 프레임 폴더 바로 밑,
# 클래스 전용 산출물은 그 안의 클래스 폴더 밑이다(class_finder_service.on_frame 참고).
FRAME_IMAGE_KINDS = {
    "original": ("frame", "original.jpg"),
    "rpn_overlay": ("frame", "rpn_overlay.jpg"),
    "confirmed_overlay": ("frame", "confirmed_overlay.jpg"),  # 문서에 없지만 있으면 쓸 수 있게
    "target_overlay": ("class", "target_overlay.jpg"),
    "target_crop": ("class", "target_crop.jpg"),
}

# evidence.json의 게이트 이름(내부) -> 문서 ② `mandatory_gates`의 이름.
GATE_NAME_MAP = {
    "color": "color_gate",
    "shape": "shape_gate",
    "reference_image": "reference_image_gate",
    "saturation": "saturation_gate",
    "aspect_ratio": "aspect_ratio_gate",
    "hue": "hue_gate",  # 2026-09-15 door 강화(crop 픽셀 색상 중앙값)
}

# ── 박스 편(2026-11-02) ──────────────────────────────────────────────
# mqtt_box_receiver.RUN_DIR와 같은 폴더. 한쪽만 바꾸면 화면이 다시 빈다.
BOX_TARGET = "box"
BOX_RUN_DIR = OUT_ROOT / "try_box"
BOX_SUMMARY_NAME = "scan_summary.json"
# 문서 ⑤ `kind` -> try_box/<stem>/ 아래 파일 후보. 크롭은 2026-11-02부터 수신기가 found 각도에만
# 쓴다 -- 없으면(못 찾은 각도·지난 판) 지어내지 않고 404다. rpn_overlay 등은 박스 편에 없다(404).
BOX_FRAME_IMAGE_KINDS = {
    "original": ("original.jpg",),
    "target_overlay": ("overlay.jpg",),
    "target_crop": ("crop.jpg", "target_crop.jpg"),
}
# navigate_to_target_service.STANDOFF_CM_BY_CLASS["box"] / ROBOT_FORWARD_M_MIN·MAX와 같은 값.
# 이 서버는 torch 없이 떠야 해서 그 파일을 import하지 않고 값만 옮겨 둔다 -- 바꿀 때 양쪽 다.
BOX_STANDOFF_CM = 20.0
ROBOT_FORWARD_M_MIN = 0.05
ROBOT_FORWARD_M_MAX = 10.0

# 클래스명으로 경로를 조립하므로 경로 탈출(../)과 이상한 문자를 먼저 막는다.
SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]+$")


# ────────────────────────────── 읽기 헬퍼 ──────────────────────────────

def _read_json(path: Path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _localization_dir() -> Path | None:
    for name in LOCALIZATION_DIR_NAMES:
        d = RUN_DIR / name
        if d.is_dir():
            return d
    return None


def _frame_stem(frame: str) -> str:
    """관제 웹은 `frame_000113.jpg`로 물어보고, 폴더 이름은 `frame_000113`이다."""
    return Path(frame).stem


def _clip_detail_of(instance: dict) -> dict | None:
    """인스턴스의 증거 이력에서 사전(CLIP) 상세 근거를 찾는다 -- 게이트 판정과
    특징별 유사도가 여기에만 있다(다른 provider의 증거에는 없다)."""
    for record in reversed(instance.get("evidence_trail") or []):
        if record.get("clip_detail"):
            return record["clip_detail"]
    return None


def _feature_best_score(instance: dict):
    """문서 ②가 `final_score`를 **「특징 최고값」**이라고 화면에 적는다고 했으므로,
    비교한 특징 유사도 중 최고값을 내보낸다. 파이프라인 내부의 `final_score`는
    지지 provider들의 신뢰도 **합**이라 의미가 다르다 -- 그 값은 이름을 달리해
    (`fusion_confidence_sum`) 같이 실어 둔다(저쪽이 안 읽어도 무해하다)."""
    detail = _clip_detail_of(instance)
    compared = (detail or {}).get("compared_features") or {}
    if compared:
        return max(compared.values())
    return instance.get("final_score")


# ────────────────────── 문서 §1 모양으로 바꾸는 어댑터 ──────────────────────

def build_results(target: str) -> dict:
    """① `GET /detect/results?target=door` -- `target_summary.json`과 같은 모양.

    각도별 결과는 프레임이 끝나는 즉시 필요하고(1.5초 폴링), 거리/절대방위각은
    8프레임이 다 끝난 뒤 자기 위치 추정이 되어야 나온다. 그래서 뼈대는 프레임별
    evidence.json에서 만들고, target_summary.json이 생기면 그 값을 덧입힌다.

    문서가 기대하는 모양은 프레임 한 칸에 값이 **평평하게** 있는 형태라, 여러
    인스턴스 중 대표(instances[0] = 지지 provider가 가장 많은 것)를 끌어올린다.
    나머지 인스턴스도 `instances`로 같이 실어 둔다(문서에 없는 추가 필드)."""
    frames = []

    summary_by_frame = {}
    summary = _read_json(RUN_DIR / NAV_DIR_NAME / "target_summary.json")
    if summary and summary.get("target_class") == target:
        summary_by_frame = {f["frame"]: f for f in summary.get("frames", [])}

    if RUN_DIR.is_dir():
        for frame_dir in sorted(RUN_DIR.iterdir()):
            evidence = _read_json(frame_dir / target / "evidence.json")
            if evidence is None:
                continue  # 프레임 폴더가 아니거나(localization/ 등) 이 클래스를 안 찾은 폴더
            instances = evidence.get("instances") or []
            entry = {
                "frame": evidence["frame"],
                "rotation_deg": evidence["rotation_deg"],
                "found": bool(instances),
            }
            if instances:
                entry["final_score"] = _feature_best_score(instances[0])
                entry["instance_count"] = len(instances)

            measured = summary_by_frame.get(evidence["frame"]) or {}
            measured_instances = measured.get("instances") or []
            if measured_instances:
                best = measured_instances[0]
                for key in ("absolute_bearing_deg", "rel_depth", "distance_cm",
                            "in_valid_calibration_range"):
                    if key in best:
                        entry[key] = best[key]
                entry["instances"] = measured_instances
            frames.append(entry)

    frames.sort(key=lambda f: f["rotation_deg"])
    return {"target_class": target, "frames": frames}


def build_evidence(target: str, frame: str):
    """② `GET /detect/evidence?target=door&frame=frame_000113.jpg`.

    내부 evidence.json은 인스턴스 목록 + 증거 이력(progressive 재해석 과정)까지
    담고 있는데, 화면이 읽는 것은 대표 인스턴스 하나의 박스/특징유사도/게이트다.
    그 부분만 문서 ② 모양으로 평평하게 편다. 못 찾은 각도면 None(=404)."""
    evidence = _read_json(RUN_DIR / _frame_stem(frame) / target / "evidence.json")
    if evidence is None:
        return None
    instances = evidence.get("instances") or []
    if not instances:
        return None  # "못 찾은 각도에는 이 파일이 없는 것이 정상이다"
    best = instances[0]
    detail = _clip_detail_of(best) or {}

    mandatory_gates = {}
    for name, gate in (detail.get("gates") or {}).items():
        mapped = dict(gate)
        # 문서 예시가 `required` 를 먼저 보여 준다. 이 파이프라인의 게이트는 전부
        # AND 필수조건이라(_dictionary_gate_and_score) 항상 true다.
        mandatory_gates[GATE_NAME_MAP.get(name, f"{name}_gate")] = {
            "required": True,
            "passed": mapped.pop("passed", None),
            **mapped,
        }

    return {
        "frame": evidence["frame"],
        "rotation_deg": evidence["rotation_deg"],
        "box_xyxy": best.get("box_xyxy"),
        "feature_similarities": detail.get("compared_features", {}),
        "final_score": _feature_best_score(best),
        "mandatory_gates": mandatory_gates,
        # ── 아래는 문서에 없는 추가 필드(안 읽어도 무해, 근거 추적용) ──
        "fusion_confidence_sum": best.get("final_score"),
        "supporting_sources": best.get("supporting_sources"),
        "lifecycle": best.get("lifecycle"),
        # 2026-09-15: 확정 조건 '사전 박스 ↔ OVD 박스 짝 IoU'(door만). 확정 시점 기록의 값이다.
        "dictionary_ovd_iou": ((best.get("evidence_trail") or [{}])[-1]).get("dictionary_ovd_iou"),
        "provider_timings_ms": evidence.get("provider_timings_ms"),
        "instance_count": len(instances),
    }


def build_path(target: str):
    """③ `GET /detect/path?target=door` -- navigation/evidence.json 그대로.

    `path_calculation`의 식과 대입값 문자열이 화면에 그대로 네 줄로 그려진다고
    했으므로 가공하지 않는다. 아직 없거나 실패면 (None, 이유)."""
    nav = _read_json(RUN_DIR / NAV_DIR_NAME / "evidence.json")
    if nav is None:
        return None, "경로 산출 전 -- 8프레임 스캔과 자기 위치 추정이 끝나야 나온다"
    if nav.get("target_class") != target:
        return None, f"현재 실행의 타겟 클래스는 '{nav.get('target_class')}'다"
    if not nav.get("ok"):
        # 2026-09-14: **실패는 「아직 없음」이 아니다.** 404 로 주면 관제 웹이 계속 기다리고,
        # 대체 경로(A 단상 -> B 문만 위치 -> C 문 관측만)가 어디서 왜 끊겼는지도 버려진다.
        # 산출물을 ok:false 그대로 200 으로 내준다 -- reason 과 fallback_chain 이 실려 있다.
        nav.setdefault("reason", (nav.get("target_resolution") or {}).get("detail") or "경로 산출 실패")
    return nav, None


def build_localization():
    """⑦ `GET /detect/localization` -- 스캔보다 **먼저** 와야 하는 자세 역산.

    현재 파이프라인은 8프레임을 다 본 뒤에야 자기 위치를 추정하므로 실제로는
    스캔 뒤에 생긴다. 문서는 그 경우 "각도 결과가 올 때까지 대기로 남는다 --
    화면이 멈추지는 않는다"고 정해 뒀으니, 없는 동안 404를 주면 된다."""
    d = _localization_dir()
    if d is None:
        return None, "자기 위치 추정 전"
    loc = _read_json(d / "localization_evidence.json")
    if loc is None:
        return None, "자기 위치 추정 전"
    if not loc.get("ok"):
        return None, loc.get("reason") or "자기 위치 추정 실패"
    return loc, None


def resolve_image(kind: str, target: str, frame: str) -> Path | None:
    """⑤ 그림. 로컬 절대경로를 JSON에 넣어 주는 것은 소용이 없다고 했으므로
    (브라우저가 못 연다) 여기서 바이트로 내보낸다."""
    where, filename = FRAME_IMAGE_KINDS[kind]
    frame_dir = RUN_DIR / _frame_stem(frame)
    path = frame_dir / filename if where == "frame" else frame_dir / target / filename
    return path if path.is_file() else None


# ────────────── 박스 편: try_box/(mqtt_box_receiver 산출물) -> 문서 §1 모양 ──────────────
#
# 수신기 산출 형식은 그대로 두고 여기서 맞춘다(2026-11-02):
#   try_box/<frame_stem>/evidence.json   {frame, rotation_deg, found, detections[{box_xyxy, score,
#                                         distance_cm, h_px, reason, bearing{bearing_deg,...}, gates{...}}],
#                                         rejected_candidates[...], rejected_by_gates[...], ...}
#                                         (gates·rejected_candidates는 2026-11-02~, ground_gate·rejected_by_gates는 같은 날 오후~)
#   try_box/<frame_stem>/original.jpg · overlay.jpg · crop.jpg(found일 때, 2026-11-02~)
#   try_box/scan_summary.json            판이 끝나야 생긴다 {accepted, problems, best_overall, ...}
#   try_box/navigation/evidence.json     판 끝의 경로 근거(box_path_from_summary 결과, 2026-11-02~)
# 새 스캔이 시작되면 수신기(_clear_previous_run)가 이 폴더를 비운다 -- 관제 웹은 「각도 수가
# 줄어드는 순간」을 새 판의 시작으로 보므로, 여기서 지난 판을 따로 거르거나 캐시하지 않는다.

def _box_detections(evidence: dict) -> list[dict]:
    """대표 = YOLO score가 가장 높은 것. 수신기가 이미 그 순서로 쓰지만 순서에 기대지 않는다."""
    return sorted(evidence.get("detections") or [], key=lambda d: -(d.get("score") or 0.0))


def build_box_results() -> dict:
    """① `GET /detect/results?target=box` -- 프레임 evidence.json이 생기는 즉시 한 칸.

    scan_summary.json은 판이 끝나야 생기므로 기다리지 않는다. 문 편과 달리 거리·방위가
    프레임 처리와 동시에 나오므로(박스 높이·박스 중심 오프셋) 덧입힐 요약이 없다.
    `in_valid_calibration_range`는 거리가 있을 때만 true -- 박스가 화면 끝에 닿아
    거리가 null이면 false로 둬서 관제 웹이 그 칸을 거리로 그리지 않게 한다."""
    frames = []
    if BOX_RUN_DIR.is_dir():
        for frame_dir in sorted(BOX_RUN_DIR.iterdir()):
            if not frame_dir.is_dir() or frame_dir.name == NAV_DIR_NAME:
                continue  # navigation/에도 evidence.json(경로 근거)이 있다 -- 프레임이 아니다
            evidence = _read_json(frame_dir / "evidence.json")
            if evidence is None or "frame" not in evidence:
                continue  # incoming/ 등
            detections = _box_detections(evidence)
            entry = {
                "frame": evidence["frame"],
                "rotation_deg": evidence["rotation_deg"],
                "found": bool(detections),
            }
            if detections:
                best = detections[0]
                distance_cm = best.get("distance_cm")
                entry["final_score"] = best.get("score")
                entry["instance_count"] = len(detections)
                entry["absolute_bearing_deg"] = (best.get("bearing") or {}).get("bearing_deg")
                entry["distance_cm"] = distance_cm
                entry["in_valid_calibration_range"] = distance_cm is not None
                if distance_cm is None and best.get("reason"):
                    entry["distance_reason"] = best["reason"]  # 문서에 없는 추가 필드
                entry["instances"] = detections
            elif "rejected_candidates" in evidence:
                # 못 찾은 칸의 이유: conf 아래로 버린 후보 중 최고 score. null = CANDIDATE_CONF 이상 후보조차 없었다.
                # 키 자체가 없는 지난 형식의 판에는 넣지 않는다(없던 값을 지어내지 않는다).
                rejected = evidence["rejected_candidates"]
                entry["best_rejected_score"] = rejected[0]["score"] if rejected else None
                entry["decision_threshold"] = (evidence.get("detector") or {}).get("conf")
            if not detections and evidence.get("rejected_by_gates"):
                # 2026-11-02~: score는 넘었지만 required 관문(ground_gate)에 떨어져 버린 검출 -- 못 찾은 이유가 점수가 아니다.
                gate_rejected = evidence["rejected_by_gates"]
                entry["gate_rejected"] = [{"score": d.get("score"), "failed_gates": d.get("failed_gates"),
                                           "words": d.get("words")} for d in gate_rejected]
            frames.append(entry)
    frames.sort(key=lambda f: f["rotation_deg"])
    return {"target_class": BOX_TARGET, "frames": frames}


def build_box_evidence(frame: str):
    """② 박스 편 근거. 박스엔 특징 비교가 없어 `feature_similarities`는 항상 빈 객체다(YOLO 점수를
    특징처럼 넣지 않는다). `mandatory_gates`는 수신기가 남긴 대표 검출의 `gates`를 이름 그대로 싣는다
    (score_gate · ground_gate · height_gate · calibration_range, 각 `required`/`passed`/값/식/`words`). 수신기가 gates를
    안 남긴 지난 형식의 판이면 빈 객체 -- 관제 웹이 「관문 근거 미수신」으로 적는다. 키는 어느 쪽이든 둔다."""
    evidence = _read_json(BOX_RUN_DIR / _frame_stem(frame) / "evidence.json")
    if evidence is None or "frame" not in evidence:
        return None  # frame=navigation.jpg 처럼 프레임이 아닌 폴더
    detections = _box_detections(evidence)
    if not detections:
        return None  # 문 편과 같이 「못 찾은 각도」는 404
    best = detections[0]
    return {
        "frame": evidence["frame"],
        "rotation_deg": evidence["rotation_deg"],
        "box_xyxy": best.get("box_xyxy"),  # 테두리 crop(237×241) 좌표 그대로 -- 웹이 변환한다
        "final_score": best.get("score"),
        "feature_similarities": {},
        "mandatory_gates": best.get("gates") or {},
        # ── 아래는 문서에 없는 추가 필드(근거 추적용) ──
        "rejected_candidates": evidence.get("rejected_candidates"),  # 지난 형식의 판이면 null
        "rejected_by_gates": evidence.get("rejected_by_gates"),  # 2026-11-02~, 지난 형식의 판이면 null
        "detector": evidence.get("detector"),
        "distance_cm": best.get("distance_cm"),
        "distance_fit": evidence.get("distance_fit"),
        "distance_calculation": ({"formula": best["formula"], "substituted": best["substituted"]}
                                 if best.get("formula") else None),
        "h_px": best.get("h_px"),
        "reason": best.get("reason"),
        "bearing": best.get("bearing"),
        "inference_ms": evidence.get("inference_ms"),
        "instance_count": len(detections),
    }


def build_box_features() -> dict:
    """④ 박스 편은 비교하는 특징이 없다. features_sent.json이 없어도 404로 두지 않는다 --
    관제 웹이 「올 때까지」 묻는 창구라 404면 영영 기다린다."""
    features = _read_json(BOX_RUN_DIR / "features_sent.json")
    if features and BOX_TARGET in features:
        return {BOX_TARGET: features[BOX_TARGET], "_all_searched_classes": list(features)}
    return {BOX_TARGET: {"target_class": BOX_TARGET, "requested_by_command": True,
                         "is_localization_landmark": False, "features_compared": []},
            "_all_searched_classes": [BOX_TARGET]}


def build_box_path():
    """③ 박스 편 경로. 판이 끝나기 전(scan_summary 없음)은 (None, 이유) = 404.

    2026-11-02부터 수신기가 판 끝에 `try_box/navigation/evidence.json`을 남긴다(같은 함수
    box_path_from_summary로 계산). 그 파일이 이 판(mission_id 같음)의 것이면 그대로 내고, 없으면 -- 그 전
    형식으로 남은 지난 판 -- 여기서 계산해 낸다. 어느 쪽이든 값은 같다."""
    summary = _read_json(BOX_RUN_DIR / BOX_SUMMARY_NAME)
    if summary is None:
        return None, "경로 산출 전 -- 여덟 각도 스캔이 끝나 scan_summary.json이 생겨야 나온다"
    saved = _read_json(BOX_RUN_DIR / NAV_DIR_NAME / "evidence.json")
    if saved is not None and saved.get("mission_id") == summary.get("mission_id"):
        return saved, None
    computed = box_path_from_summary(summary)
    computed["path_evidence_saved"] = False  # 근거 파일 없이 이 창구가 계산한 것(지난 형식의 판)
    return computed, None


def box_path_from_summary(summary: dict) -> dict:
    """박스 편 경로 계산 -- **도면 없이 박스 관측만으로**(navigate_to_target_service._door_relative_path와
    같은 식·같은 모양). 관제 웹은 `path_mode: "map"`을 거부하므로 `door_relative`로 낸다.
    mqtt_box_receiver가 판 끝에 이 함수로 navigation/evidence.json을 쓴다(표준 라이브러리만 쓰는 이유).

      회전   turn_amount_signed = ((bearing + 180) mod 360) − 180   (스캔 시작 방향 기준, 오른쪽 +)
      직진   forward_distance_cm = distance_cm − standoff_cm(box)

    대표 각도는 수신기가 정한 scan_summary.best_overall(가장 높은 score)을 따른다.
    경로를 못 내면 ok:false + reason(창구는 404가 아니라 200) -- 「못 구하면 정직하게 실패」 원칙이고,
    404면 웹이 계속 기다린다."""

    def fail(reason: str) -> dict:
        return {"target_class": BOX_TARGET, "ok": False, "path_mode": None, "reason": reason,
                "mission_id": summary.get("mission_id"), "scan_accepted": summary.get("accepted"),
                "scan_problems": summary.get("problems") or [],
                "best_overall": summary.get("best_overall"),
                "path_overlay_available": False, "path_overlay_kind": None}

    if not summary.get("accepted"):
        problems = " / ".join(summary.get("problems") or []) or "사유 미기록"
        return fail(f"판이 온전하지 않아 경로를 내지 않는다 -- {problems}")
    top = summary.get("best_overall")
    if not top or not top.get("best"):
        return fail(summary.get("reason") or "어느 각도에서도 박스를 찾지 못했다 -- 갈 방향이 없다")
    best = top["best"]
    distance = best.get("distance_cm")
    if distance is None:
        return fail(f"회전 {top['rotation_deg']:g}도에서 박스를 찾았지만 거리를 못 구했다 -- "
                    f"{best.get('reason') or '사유 미기록'}. 방향은 알지만 얼마나 갈지 모른다")
    bearing_ev = best.get("bearing") or {}
    bearing = bearing_ev.get("bearing_deg")
    if bearing is None:
        return fail(f"회전 {top['rotation_deg']:g}도 박스의 방위가 기록돼 있지 않다")

    turn_amount_signed = (bearing + 180.0) % 360.0 - 180.0
    turn_direction = "왼쪽(반시계)" if turn_amount_signed < 0 else "오른쪽(시계)"
    turn_amount_deg = abs(turn_amount_signed)
    standoff_cm = BOX_STANDOFF_CM
    forward_distance_cm = distance - standoff_cm
    forward_distance_m = forward_distance_cm / 100.0
    distance_in_range = ROBOT_FORWARD_M_MIN <= forward_distance_m <= ROBOT_FORWARD_M_MAX
    robot_command = {
        "turn": {"deg": round(turn_amount_signed, 1)},
        "move_forward": {"distance_m": round(forward_distance_m, 3)},
        "distance_m_in_range": distance_in_range,
        "accepted_range_m": [ROBOT_FORWARD_M_MIN, ROBOT_FORWARD_M_MAX],
        "note": "turn.deg는 오른쪽이 +(왼쪽이 음수), 스캔 시작 방향 기준. "
                "move_forward.distance_m에는 standoff가 이미 반영돼 있다 -- 또 빼지 말 것.",
    }
    if not distance_in_range:
        robot_command["warning"] = (f"전진 거리 {forward_distance_m:.3f}m가 로봇이 받는 범위"
                                    f"({ROBOT_FORWARD_M_MIN}~{ROBOT_FORWARD_M_MAX}m)를 벗어난다 -- 그대로 보내면 안 된다")

    path_calculation = {
        "step1_box_bearing": {
            "formula": bearing_ev.get("formula", "bearing = rotation_deg + atan((cx − W/2) / f)"),
            "substituted": bearing_ev.get("substituted", f"bearing = {bearing:.1f}"),
        },
        "step2_turn_amount": {
            "formula": "turn_amount_signed = ((box_bearing_deg + 180) mod 360) - 180",
            "substituted": f"(({bearing:.1f} + 180) mod 360) - 180 = {turn_amount_signed:.1f} ({turn_direction})",
        },
        "step3_box_distance": {
            "formula": best.get("formula", "distance_cm = k / h_px − c"),
            "substituted": best.get("substituted", f"{distance:.1f}"),
        },
        "step4_forward_distance": {
            "formula": "forward_distance_cm = box_distance_cm - standoff_cm(box)",
            "substituted": f"{distance:.1f} - {standoff_cm:.1f} = {forward_distance_cm:.1f}",
        },
    }
    return {
        "target_class": BOX_TARGET,
        "ok": True,
        "path_mode": "door_relative",
        "path_mode_words": "도면 없이 박스 관측(방위·겉보기 높이)만으로 산출",
        "localization_method": None,
        "mission_id": summary.get("mission_id"),
        "path_overlay_available": False,
        "path_overlay_kind": None,
        "target_resolution": {"target_class": BOX_TARGET, "position_cm": None, "source": "box_relative",
                              "detail": f"회전 {top['rotation_deg']:g}도 프레임({top['frame']})의 박스 관측 "
                                        f"(score {best.get('score')}) -- 도면 좌표 없이 로봇 기준 방위·거리로만 산출"},
        "robot_position_cm": None,
        "current_heading_map_deg": None,
        "target_position_cm": [],
        "turn_instruction": f"{turn_direction}으로 {turn_amount_deg:.1f}도 회전",
        "turn_deg": round(turn_amount_signed, 1),
        "distance_to_target_cm": round(distance, 1),
        "standoff_cm": standoff_cm,
        "forward_distance_cm": round(forward_distance_cm, 1),
        "forward_distance_m": round(forward_distance_m, 3),
        "robot_command": robot_command,
        "goal_cm": None,
        "path_calculation": path_calculation,
        "bearing_note": bearing_ev.get("note"),
        "distance_fit": summary.get("distance_fit"),
    }


def resolve_box_image(kind: str, frame: str) -> Path | None:
    """⑤ 박스 편 그림. 못 찾은 각도라도 original.jpg는 반드시 있다(수신기가 항상 쓴다) --
    관제 웹은 각도마다 그 그림이 뜬 것을 보고서야 로봇에게 다음 회전을 허락한다."""
    frame_dir = BOX_RUN_DIR / _frame_stem(frame)
    for filename in BOX_FRAME_IMAGE_KINDS.get(kind, ()):
        if (frame_dir / filename).is_file():
            return frame_dir / filename
    return None


# ────────────────────────────── HTTP 핸들러 ──────────────────────────────

class DetectAPIHandler(BaseHTTPRequestHandler):
    server_version = "PhysicalDemoDetectAPI/1.0"
    # 관제 웹이 1.5초마다 여러 창구를 두드리므로 연결을 유지한다(모든 응답에
    # Content-Length를 붙이고 있어서 keep-alive가 안전하다).
    protocol_version = "HTTP/1.1"

    # ── 응답 헬퍼: CORS 헤더는 **그림 포함 모든 응답**에 붙인다(문서 §2) ──
    def _send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")  # 폴링이라 캐시되면 화면이 안 는다
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, payload, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _send_not_yet(self, reason: str):
        """아직 없는 것 = 404. 화면은 「아직 안 왔다」로 처리하고 멈추지 않는다.
        이유를 본문에 실어 개발자 도구에서 원인이 보이게 한다."""
        self._send_json({"error": "not_available", "reason": reason}, status=404)

    def _send_file(self, path: Path, content_type: str):
        try:
            body = path.read_bytes()
        except OSError as exc:
            self._send_not_yet(f"파일을 읽을 수 없음: {exc}")
            return
        self._send(200, body, content_type)

    def do_OPTIONS(self):  # 브라우저 프리플라이트
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        route = parsed.path.rstrip("/") or "/"

        def param(name: str, default: str | None = None):
            values = query.get(name)
            return values[0] if values else default

        # 경로 조립에 쓰는 값은 먼저 검증한다(../ 같은 경로 탈출 차단).
        for name in ("target", "frame", "kind"):
            value = param(name)
            if value is not None and not SAFE_NAME.match(value):
                self._send_json({"error": "bad_request",
                                 "reason": f"'{name}' 값에 쓸 수 없는 문자가 있다"}, status=400)
                return

        if route == "/health":                                     # ⑥
            self._send_json({"ok": True, "run_dir": str(RUN_DIR), "run_dir_exists": RUN_DIR.is_dir(),
                             "box_run_dir": str(BOX_RUN_DIR), "box_run_dir_exists": BOX_RUN_DIR.is_dir()})
            return

        if route == "/detect/localization":                        # ⑦ (target 없음)
            loc, reason = build_localization()
            self._send_json(loc) if loc else self._send_not_yet(reason)
            return

        if route == "/detect/map":                                 # ⑧
            d = _localization_dir()
            path = (d / "map_original.jpg") if d else None
            if path and path.is_file():
                self._send_file(path, "image/jpeg")
            else:
                self._send_not_yet("도면 원본이 아직 없다 -- 자기 위치 추정 단계에서 저장된다")
            return

        target = param("target")
        if route in ("/detect/results", "/detect/evidence", "/detect/path",
                     "/detect/features", "/detect/frame", "/detect/path_overlay"):
            if not target:
                self._send_json({"error": "bad_request", "reason": "target 파라미터가 필요하다"},
                                status=400)
                return

        if target == BOX_TARGET and route.startswith("/detect/"):
            self._handle_box(route, param)
            return

        if route == "/detect/results":                             # ①
            self._send_json(build_results(target))
            return

        if route == "/detect/evidence":                            # ②
            frame = param("frame")
            if not frame:
                self._send_json({"error": "bad_request", "reason": "frame 파라미터가 필요하다"},
                                status=400)
                return
            evidence = build_evidence(target, frame)
            if evidence is None:
                self._send_not_yet(f"{frame}에서 '{target}'을(를) 찾지 못했거나 아직 처리 전")
            else:
                self._send_json(evidence)
            return

        if route == "/detect/path":                                # ③
            nav, reason = build_path(target)
            self._send_json(nav) if nav else self._send_not_yet(reason)
            return

        if route == "/detect/features":                            # ④
            features = _read_json(RUN_DIR / "features_sent.json")
            if features is None:
                self._send_not_yet("탐색 명령 처리 전 -- features_sent.json이 아직 없다")
            elif target in features:
                # 문서 ④는 target 하나의 것을 물어보지만, 어느 클래스를 함께
                # 찾았는지(랜드마크 door/pedestal)도 같이 보이는 편이 근거로 낫다.
                self._send_json({target: features[target], "_all_searched_classes": list(features)})
            else:
                self._send_not_yet(f"'{target}'은 이번 실행에서 탐색한 클래스가 아니다"
                                   f"(탐색: {list(features)})")
            return

        if route == "/detect/frame":                               # ⑤ 프레임 그림
            frame, kind = param("frame"), param("kind", "original")
            if not frame:
                self._send_json({"error": "bad_request", "reason": "frame 파라미터가 필요하다"},
                                status=400)
                return
            if kind not in FRAME_IMAGE_KINDS:
                self._send_json({"error": "bad_request",
                                 "reason": f"kind는 {list(FRAME_IMAGE_KINDS)} 중 하나여야 한다"},
                                status=400)
                return
            path = resolve_image(kind, target, frame)
            if path is None:
                self._send_not_yet(f"{frame}의 '{kind}' 그림이 없다"
                                   f"(못 찾은 각도의 target_overlay/target_crop은 없는 것이 정상)")
            else:
                self._send_file(path, "image/jpeg")
            return

        if route == "/detect/path_overlay":                        # ⑤ 경로 그림
            path = RUN_DIR / NAV_DIR_NAME / "path_overlay.jpg"
            if path.is_file():
                self._send_file(path, "image/jpeg")
            else:
                self._send_not_yet("경로 그림은 스캔이 끝나고 경로가 산출돼야 나온다")
            return

        self._send_json({"error": "not_found", "reason": f"알 수 없는 경로: {parsed.path}",
                         "routes": ["/health", "/detect/localization", "/detect/map",
                                    "/detect/results", "/detect/evidence", "/detect/path",
                                    "/detect/features", "/detect/frame", "/detect/path_overlay"]},
                        status=404)

    def _handle_box(self, route: str, param) -> None:
        """`target=box` 창구 -- try_box/를 읽는다(위 「박스 편」 절). 도면·위치 추정·경로 그림은
        박스 편에 없으므로 path_overlay는 404다(localization/map은 target이 없어 여기 안 온다)."""
        if route in ("/detect/evidence", "/detect/frame") and not param("frame"):
            self._send_json({"error": "bad_request", "reason": "frame 파라미터가 필요하다"}, status=400)
            return

        if route == "/detect/results":                             # ①
            self._send_json(build_box_results())
        elif route == "/detect/evidence":                          # ②
            frame = param("frame")
            evidence = build_box_evidence(frame)
            if evidence is None:
                self._send_not_yet(f"{frame}에서 'box'를 찾지 못했거나 아직 처리 전")
            else:
                self._send_json(evidence)
        elif route == "/detect/path":                              # ③
            nav, reason = build_box_path()
            self._send_json(nav) if nav else self._send_not_yet(reason)
        elif route == "/detect/features":                          # ④
            self._send_json(build_box_features())
        elif route == "/detect/frame":                             # ⑤
            frame, kind = param("frame"), param("kind", "original")
            if kind not in FRAME_IMAGE_KINDS:
                self._send_json({"error": "bad_request",
                                 "reason": f"kind는 {list(FRAME_IMAGE_KINDS)} 중 하나여야 한다"},
                                status=400)
                return
            path = resolve_box_image(kind, frame)
            if path is None:
                self._send_not_yet(f"{frame}의 '{kind}' 그림이 없다(박스 편은 original·target_overlay만 "
                                   f"만든다 -- target_crop은 크롭이 저장돼 있을 때만, rpn_overlay는 없음)")
            else:
                self._send_file(path, "image/jpeg")
        elif route == "/detect/path_overlay":
            self._send_not_yet("박스 편은 도면을 쓰지 않아 경로 그림이 없다")
        else:
            self._send_json({"error": "not_found", "reason": f"알 수 없는 경로: {route}"}, status=404)

    def log_message(self, fmt, *args):  # 기본 로그는 stderr 한 줄 형식이라 그대로 쓰되 접두사만
        print(f"[detect_api] {self.address_string()} {fmt % args}")


def main() -> None:
    global RUN_DIR, BOX_RUN_DIR
    parser = argparse.ArgumentParser(description="관제 웹용 탐지 결과 HTTP 창구(읽기 전용)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="0.0.0.0",
                        help="기본은 모든 인터페이스. 테일넷에서만 열려면 `tailscale ip -4` 값을 준다")
    parser.add_argument("--run-dir", default=None,
                        help=f"파이프라인 산출 폴더(기본: {RUN_DIR})")
    parser.add_argument("--box-run-dir", default=None,
                        help=f"박스 수신기(mqtt_box_receiver) 산출 폴더 -- target=box가 읽는다(기본: {BOX_RUN_DIR})")
    args = parser.parse_args()
    if args.run_dir:
        RUN_DIR = Path(args.run_dir).resolve()
    if args.box_run_dir:
        BOX_RUN_DIR = Path(args.box_run_dir).resolve()

    server = ThreadingHTTPServer((args.bind, args.port), DetectAPIHandler)
    print(f"[detect_api] listening on http://{args.bind}:{args.port}  (run_dir={RUN_DIR})")
    print(f"[detect_api] target=box -> box_run_dir={BOX_RUN_DIR} (존재={BOX_RUN_DIR.is_dir()})")
    print(f"[detect_api] run_dir 존재={RUN_DIR.is_dir()} -- 관제 웹에는 이 PC의 "
          f"MagicDNS 이름 + :{args.port} 를 준다")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[detect_api] 종료")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
