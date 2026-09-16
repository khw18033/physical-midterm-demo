"""정답(육안 확인, border-crop 237x241 좌표).

rot8: 2026-09-14 사용자 지정 -- frame_000113/132에만 문. 박스는 격자 오버레이로 확인한 파란 문
      영역(GroundingDINO 최고점 박스와 일치).
robot: try1/incoming(리허설 로봇 카메라, 다른 방: 초록 칠판/목재 유리책장/흰 벽). 파란 문이
      225도(frame_000005)와 270도(frame_000006)에 보인다. 90/135도의 유리 칸막이 구조물은 문인지
      애매해 오탐 집계에서 빼고(ambiguous) 따로 표시한다.
"""

def gt_for(set_name: str) -> dict:
    """"rot8@squash"처럼 변형이 붙은 세트는 기하 변형에 맞춰 정답 박스를 옮겨 돌려준다."""
    from aug import transform_box
    base, _, aug = set_name.partition("@")
    g = GT_BY_SET[base]
    return {k: {f: transform_box(aug, b) for f, b in g[k].items()} for k in ("doors", "ambiguous")}


GT_BY_SET = {
    "rot8": {
        "doors": {"frame_000113.jpg": [139.6, 87.8, 161.4, 144.0],
                  "frame_000132.jpg": [31.9, 87.4, 52.5, 142.3]},
        "ambiguous": {},
    },
    "robot": {
        "doors": {"frame_000005.jpg": [188.5, 82.0, 215.5, 146.7],
                  "frame_000006.jpg": [93.0, 88.5, 114.0, 144.1]},
        "ambiguous": {"frame_000002.jpg": [147.1, 11.1, 204.2, 165.4],
                      "frame_000003.jpg": [48.6, 22.2, 87.3, 158.0]},
    },
}
