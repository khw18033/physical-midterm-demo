"""전체 파이프라인(탐지 -> 위치 추정 -> 관측 요약 -> 경로)을 mock_stream_receiver.main()과 같은 순서로
돌리되 출력만 research/door_gate_relax/pipeline/<tag>/<set>/ 로 돌린다(try1/ 무관, 지연 없음).

  python pipeline_run.py before   # 운영 반영 전
  python pipeline_run.py after    # 운영 반영 후
rot8은 데이터셋, robot은 리허설 수신 프레임(try1/incoming, 읽기만)을 FRAME_SOURCE_DIR로 지정한다
(mqtt_stream_receiver가 실시간 수신 때 하는 것과 같은 설정).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
sys.path.insert(0, str(REPO_ROOT / "demo" / "test"))

import class_finder_service as cfs  # noqa: E402
import navigate_to_target_service as nav  # noqa: E402

from cache_raw import SETS  # noqa: E402

NAV_KEYS = ["ok", "path_mode", "localization_method", "robot_position_cm", "current_heading_map_deg",
            "turn_deg", "distance_to_target_cm", "forward_distance_m", "reason"]


def run(tag: str) -> dict:
    finder = cfs.ClassFinderService()
    out = {}
    for set_name in ("rot8", "robot"):
        frame_dir, frames = SETS[set_name]
        run_dir = HERE / "pipeline" / tag / set_name
        cfs.RUN_DIR = nav.RUN_DIR = run_dir
        nav.OUT_DIR, nav.NAV_DIR = run_dir / "localization", run_dir / "navigation"
        nav.FRAME_SOURCE_DIR = None if set_name == "rot8" else frame_dir
        navigator = nav.NavigateToTargetService()
        finder.on_class_discovery_command("door")
        for i, (fname, rot) in enumerate(frames):
            finder.on_frame(frame_dir / fname, rot, i)
        loc = navigator.localize(finder.get_detections(), target_class="door")
        navigator.save_target_observation_summary("door", finder.get_detections(), loc)
        navigator.on_go_to_class_command("door", finder.get_detections(), loc)

        dets = finder.get_detections()
        ev = json.loads((run_dir / "navigation" / "evidence.json").read_text(encoding="utf-8"))
        out[set_name] = {
            "detections": {cls: {str(rot): [[round(v, 1) for v in inst["box_xyxy"]] for inst in d["instances"]]
                                 for rot, d in sorted(by_rot.items()) if d["instances"]}
                           for cls, by_rot in dets.items()},
            "navigation": {k: ev.get(k) for k in NAV_KEYS},
            "fallback_chain": [f"{c['step']}:{'ok' if c['ok'] else 'X'} {c['detail']}" for c in ev.get("fallback_chain", [])],
            "robot_command": ev.get("robot_command"),
        }
    (HERE / "pipeline" / f"summary_{tag}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


if __name__ == "__main__":
    res = run(sys.argv[1])
    print(json.dumps(res, ensure_ascii=False, indent=1))
