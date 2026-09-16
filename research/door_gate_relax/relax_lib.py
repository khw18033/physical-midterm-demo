"""research/door_gate_relax/relax_lib.py

cache_raw.py가 남긴 원시값 위에서 **class_finder_service의 door 판정을 설정만 바꿔 재현**한다.
게이트 판정은 `_dictionary_gate_and_score`와 같은 식을 설정값으로 풀어 쓴 것이고, 같은 provider
내부 병합·다중 provider 융합·확정(Eq 2-13)은 서비스 코드의 함수/클래스를 그대로 호출한다
(여기서 다시 쓰면 실험 결과가 실제 파이프라인과 조용히 어긋날 수 있어서).

설정(Config) 기본값 = 현재 class_features.json + 서비스 상수(= baseline).
"""

from __future__ import annotations

import json
import statistics
import sys
from dataclasses import dataclass, replace
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(REPO_ROOT / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402

import numpy as np  # noqa: E402

CACHE_DIR = HERE / "cache"
CLASS = "door"

GENERIC_FEATURES = ["handle", "hinge", "lock", "threshold"]
INSTANCE_FEATURES = ["light blue color", "round metal knob", "closer device at the top", "glossy surface"]
COLOR_PROMPTS = ["a door's light blue color"] + [f"a door's {c} color" for c in cfs.COLOR_COMPETITOR_WORDS]
SHAPE_POS = ["a rectangular shape", "a square shape"]
SHAPE_NEG = ["a round shape", "an irregular shape"]


@dataclass(frozen=True)
class Config:
    # ── 사전(CLIP) 필수 게이트 ── None/False = 게이트 끔
    feature_set: str = "all8"          # "all8" | "generic4" (target_sim을 어떤 특징들의 최댓값으로 볼지)
    target_sim_min: float = 0.26
    aspect_min: float | None = 1.5
    color_gate: bool = True
    color_tol: float = 0.0             # light blue가 1등과 이 차이 안이면 통과(0 = 현재 규칙: 1등이어야 함)
    color_rank_k: int = 1              # light blue가 8색 중 상위 k등 안이면 통과(1 = 현재 규칙). tol과 OR
    shape_gate: bool = True
    shape_tol: float = 0.0             # 최고 positive가 최고 negative보다 이만큼 낮아도 통과(0 = 현재 규칙)
    ref_sim_min: float | None = 0.75
    sat_min: float | None = 85.0
    # ── 다른 provider ──
    gdino_box: float = 0.15
    gdino_text: float = 0.15
    yw_conf: float = 0.05
    gdino_label_exact: bool = False    # False = 현재 규칙("door" in label, "door pedestal"도 door 증거)
    use_fastsam: bool = True

    def short(self) -> str:
        g = [f"sim>={self.target_sim_min}({self.feature_set})",
             f"asp>={self.aspect_min}" if self.aspect_min is not None else "asp:off",
             ("color" + (f"±{self.color_tol}" if self.color_tol else "")
              + (f"/top{self.color_rank_k}" if self.color_rank_k > 1 else "")) if self.color_gate else "color:off",
             ("shape" + (f"±{self.shape_tol}" if self.shape_tol else "")) if self.shape_gate else "shape:off",
             f"ref>={self.ref_sim_min}" if self.ref_sim_min is not None else "ref:off",
             f"sat>={self.sat_min}" if self.sat_min is not None else "sat:off",
             f"gd={self.gdino_box}/{self.gdino_text}" + ("/exact" if self.gdino_label_exact else ""),
             f"yw={self.yw_conf}"]
        return " ".join(g)


BASELINE = Config()


class Cache:
    """프레임 원시값 + 텍스트 임베딩(CLIP 텍스트 인코더는 가벼워서 여기서 한 번 계산)."""

    def __init__(self, set_name: str = "rot8") -> None:
        engine = cfs.BatchClipEngine()
        self.feature_names = [f"a door's {f}" for f in GENERIC_FEATURES + INSTANCE_FEATURES]
        self.feat_embeds = engine.embed_texts(self.feature_names)
        self.color_embeds = engine.embed_texts(COLOR_PROMPTS)
        self.shape_embeds = engine.embed_texts(SHAPE_POS + SHAPE_NEG)
        self.ref_embed = np.load(CACHE_DIR / "door_ref_embed.npy")
        self.frames = []
        for p in sorted(CACHE_DIR.glob(f"{set_name}__frame_*.json")):
            rec = json.loads(p.read_text(encoding="utf-8"))
            emb = np.load(CACHE_DIR / f"{p.stem}__clip_embeds.npy")
            rec["_stem"] = p.stem
            rec["_feat_sim"] = emb @ self.feat_embeds.T
            rec["_color_sim"] = emb @ self.color_embeds.T
            rec["_shape_sim"] = emb @ self.shape_embeds.T
            rec["_ref_sim"] = (emb @ self.ref_embed.T)[:, 0]
            self.frames.append(rec)
        # 도착 순서는 프레임별 실측값 대신 provider별 중앙값으로 고정한다 -- 첫 프레임의 워밍업
        # (YOLO-World 2.6초)이 순서를 뒤집어 설정 비교에 잡음이 끼지 않게.
        self.timings = {k: statistics.median(f["timings_ms"][k] for f in self.frames)
                        for k in self.frames[0]["timings_ms"]}


def candidate_measures(fr: dict, i: int) -> dict:
    x1, y1, x2, y2 = fr["rpn_candidates"][i]
    bw, bh = x2 - x1, y2 - y1
    fs = fr["_feat_sim"][i]
    cs = fr["_color_sim"][i]
    ss = fr["_shape_sim"][i]
    return {
        "box": [x1, y1, x2, y2],
        "sim_all8": float(fs.max()), "sim_generic4": float(fs[:4].max()),
        "best_feature": int(fs.argmax()),
        "color_gap": float(cs[0] - np.delete(cs, 0).max()),   # >=0 이면 light blue가 1등
        "color_rank": int((cs > cs[0]).sum()),                # 0 = 1등
        "color_winner": COLOR_PROMPTS[int(cs.argmax())],
        "shape_ok": bool(ss.argmax() < len(SHAPE_POS)),
        "shape_gap": float(ss[:2].max() - ss[2:].max()),
        "ref_sim": float(fr["_ref_sim"][i]),
        "sat": float(fr["median_saturation"][i]),
        "aspect": bh / bw if bw > 0 else 0.0,
    }


def gate_pass(m: dict, cfg: Config) -> bool:
    sim = m["sim_all8"] if cfg.feature_set == "all8" else m["sim_generic4"]
    if sim < cfg.target_sim_min:
        return False
    if cfg.aspect_min is not None and m["aspect"] < cfg.aspect_min:
        return False
    if cfg.color_gate and not (m["color_gap"] >= -cfg.color_tol or m["color_rank"] < cfg.color_rank_k):
        return False
    if cfg.shape_gate and m["shape_gap"] < -cfg.shape_tol:
        return False
    if cfg.ref_sim_min is not None and m["ref_sim"] < cfg.ref_sim_min:
        return False
    if cfg.sat_min is not None and m["sat"] < cfg.sat_min:
        return False
    return True


def run_frame(cache: Cache, fr: dict, cfg: Config) -> dict:
    """한 프레임의 door 판정 = on_frame()의 클래스 루프(door 한 클래스)와 같은 순서."""
    if "_measures" not in fr:
        fr["_measures"] = [candidate_measures(fr, i) for i in range(len(fr["rpn_candidates"]))]
    idx = tuple(i for i, m in enumerate(fr["_measures"]) if gate_pass(m, cfg))
    memo = fr.setdefault("_cluster_memo", {})
    key = (cfg.feature_set, idx)
    if key not in memo:
        passed = []
        for i in idx:
            m = fr["_measures"][i]
            sim = m["sim_all8"] if cfg.feature_set == "all8" else m["sim_generic4"]
            label_idx = m["best_feature"] if cfg.feature_set == "all8" else int(fr["_feat_sim"][i][:4].argmax())
            passed.append({"box": tuple(m["box"]), "score": sim, "label": cache.feature_names[label_idx],
                           "detail": {"measures": m}})
        memo[key] = cfs._cluster_same_source_boxes(passed) if passed else []
    passed = idx
    dict_dets = memo[key]

    t = cache.timings
    events = []
    for d in dict_dets:
        events.append(cfs.EvidenceEvent(f"d{len(events)}", fr["frame"], "dictionary", t["dictionary"], "box",
                                        d["score"], d["box_xyxy"], CLASS, d.get("detail")))
    for d in fr["grounding_dino_by_text_thr"][str(cfg.gdino_text)]:
        label_ok = d["label"].strip() == CLASS if cfg.gdino_label_exact else CLASS in d["label"]
        if d["score"] >= cfg.gdino_box and label_ok:
            events.append(cfs.EvidenceEvent(f"g{len(events)}", fr["frame"], "grounding_dino", t["grounding_dino"],
                                            "box", d["score"], d["box_xyxy"], CLASS))
    for d in fr["yolo_world"]:
        if d["score"] >= cfg.yw_conf and d["label"] == CLASS:
            events.append(cfs.EvidenceEvent(f"y{len(events)}", fr["frame"], "yolo_world", t["yolo_world"], "box",
                                            d["score"], d["box_xyxy"], CLASS))
    if cfg.use_fastsam:
        for d in fr["fastsam"]:
            events.append(cfs.EvidenceEvent(f"f{len(events)}", fr["frame"], "fastsam", t["fastsam"], "mask",
                                            d["score"], d["box_xyxy"], None))
    events.sort(key=lambda e: e.completion_time_ms)
    multi = cfs.MultiObjectProgressiveResolver(fr["frame"], required_source="dictionary")
    for e in events:
        multi.feed(e)
    multi.consolidate()
    confirmed = multi.confirmed_objects()
    confirmed.sort(key=lambda o: -len(set(o["final"]["supporting_groups"])))
    instances = [{"box_xyxy": o["final"]["box_xyxy"], "supporting": sorted(set(o["final"]["supporting_groups"]))}
                 for o in confirmed if o["final"]["box_xyxy"] is not None]
    return {"frame": fr["frame"], "rotation_deg": fr["rotation_deg"], "clip_passed": len(passed),
            "clip_clusters": [d["box_xyxy"] for d in dict_dets], "instances": instances}


def iou(a, b) -> float:
    return cfs._iou_xyxy(a, b)
