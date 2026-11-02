"""gray box 학습용 라벨 생성 (2026-10-27).

20261026_211320의 sha1 고유 프레임마다:
- 탐지 라벨: GroundingDINO에 "gray box."만 질의(door/pedestal을 같이 넣으면 "pedestal gray box"처럼
  라벨이 섞인다)해 최고점 박스를 pseudo-label로 쓴다. 정답(GT)이 아니라 GDINO의 판단이다 --
  2026-10-27 평가(gray_box_eval_20261026_211320)에서 이 최고점 박스가 contact sheet 육안으로 거의
  모든 장면에서 박스에 맞았다는 것이 근거.
- 거리 참조값: 같은 박스로 navigate_to_target_service의 UniDepth + 사용자 실측 3차 보정식 거리(cm).
  이것도 실측 거리가 아니라 기존 시스템의 추정값이다(이 영상에는 거리 실측이 없다).
좌표는 class_finder_service와 같은 테두리 자른(237x241) 좌표계. 결과: labels.jsonl
"""
import json
import sys
import time
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SRC = REPO / "20261026_211320"
TAG = "gray box"
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else None
sys.path.insert(0, str(REPO / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402  (ctypes 우회가 torch보다 먼저 돌아야 함)
import navigate_to_target_service as nav  # noqa: E402

nav.FRAME_SOURCE_DIR = SRC / "frames"


def main():
    meta = [json.loads(l) for l in open(SRC / "frames.jsonl", encoding="utf-8")]
    gd = cfs.GroundingDinoProvider()
    navigator = nav.NavigateToTargetService()
    cl, ct, cr, cb = cfs.BORDER_CROP_BOX

    seen = set()
    out_path = HERE / ("labels_test.jsonl" if LIMIT else "labels.jsonl")
    if LIMIT:
        out_path.unlink(missing_ok=True)
    elif out_path.exists():
        # 2026-10-27 이어받기: 중간에 PC 전원이 꺼져 3061장에서 끊겼다. 이미 기록된 sha1은 건너뛰고,
        # 쓰다 만 마지막 줄(JSON 파싱 실패)은 버린다.
        kept = []
        for line in out_path.read_text(encoding="utf-8").splitlines():
            try:
                kept.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        out_path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept), encoding="utf-8")
        seen = {r["sha1"] for r in kept}
        print(f"[make_labels] 이어받기: 기존 {len(kept)}장 건너뜀", flush=True)
    t0 = time.perf_counter()
    done = 0
    for m in meta:
        sha = m["sender"].get("X-Sha1")
        if sha in seen:
            continue
        seen.add(sha)
        name = Path(m["frame_file"]).name
        bgr = cv2.imread(str(SRC / "frames" / name))[ct:cb, cl:cr]
        dets = [d for d in gd.detect(bgr, [TAG]) if TAG in d["label"]]
        rec = {"n": m["n"], "frame": name, "sha1": sha, "gdino": dets}
        if dets:
            best = max(dets, key=lambda d: d["score"])
            rel, dist_cm, in_range = navigator._measure_depth_cm(name, best["box_xyxy"])
            _d, _wh, (fx, cx) = navigator._run_unidepth(nav._resolve_frame_path(name))
            rec.update({"box_xyxy": best["box_xyxy"], "score": best["score"],
                        "unidepth_rel_depth": rel, "unidepth_distance_cm": dist_cm,
                        "unidepth_in_calibration_range": in_range, "unidepth_fx_infer": fx})
        navigator._depth_cache.clear()  # 프레임마다 다르므로 쌓아 둘 필요가 없다(3500장이면 1GB)
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        done += 1
        if done % 50 == 0 or (LIMIT and done >= LIMIT):
            print(f"[make_labels] {done}장 {time.perf_counter() - t0:.0f}s", flush=True)
        if LIMIT and done >= LIMIT:
            break


if __name__ == "__main__":
    main()
