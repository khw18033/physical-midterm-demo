# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 촬영 산출물 업로더 (HW-R-07 / 아키텍처 §3)
============================================================
`bench/go1_capture_teleop.py` 가 만든 촬영 세션을 **서버가 받을 수 있는 형태**로 묶는다.

    python3 -m robot.capture_upload ~/captures/20260910-134818            # 매니페스트만
    python3 -m robot.capture_upload ~/captures/* --stage /mnt/usb/upload  # 묶어서 적재
    python3 -m robot.capture_upload ~/captures/20260910-134818 --put https://…/  # 업로드

## 왜 매니페스트인가 — 픽셀은 DB 에 넣지 않는다

10fps 로 한 시간이면 36,000장이다. 프레임마다 DB 행을 만들면 메타가 데이터보다 커지고
백업이 불가능해진다. 그래서 **픽셀은 객체 저장소, DB 에는 참조(매니페스트)만** 둔다.
프레임 하나하나의 시각도 박지 않는다 — `t0 + n/interval` 로 복원한다.

## 없는 값은 null 이다

`pose_track` 처럼 아직 만들 수 없는 것은 **키를 지우지 않고 `null` 로 남긴다.** 트윈이
`a,b,c` 를 기대하는데 이 소스가 `c` 를 못 주면 서버가 blank 로 내려보내고, 나중에 다른
센서가 채우면 그때 값이 실린다(docs/ARCHITECTURE_ALIGNMENT.md §1). 0 이나 빈 문자열로
채우면 "쟀더니 0" 과 구별되지 않는다.

## 목적지는 아직 정해지지 않았다

백엔드 회신(BACKEND_AGENDA #15) 전까지는 **묶어서 로컬에 적재**만 한다. 목적지가 정해지면
`--put <base-url>` 로 HTTP PUT 하거나, sink 하나를 더 붙이면 된다 — 매니페스트 형식은
그대로다. 그래서 지금 찍은 데이터도 나중에 그대로 올릴 수 있다.
"""
import argparse
import json
import os
import sys
import tarfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from common import config, schema      # noqa: E402

MANIFEST_VERSION = "1.0"


def _jpeg_files(session_dir):
    return sorted(f for f in os.listdir(session_dir) if f.endswith(".jpg"))


def build_manifest(session_dir, identity=None):
    """세션 폴더 -> 매니페스트(dict). 폴더 안의 사실만 적는다 — 모르는 것은 null."""
    session_dir = os.path.abspath(session_dir)
    name = os.path.basename(session_dir.rstrip("/"))

    meta_path = os.path.join(session_dir, "session.json")
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)

    frames = _jpeg_files(session_dir)
    total = sum(os.path.getsize(os.path.join(session_dir, f)) for f in frames)
    fps = meta.get("fps")
    t0 = meta.get("started_at")

    motion_csv = os.path.join(session_dir, "teleop_log.csv")
    ident = identity or schema.Identity.resolve("robot")

    return {
        "schema_version": MANIFEST_VERSION,
        "kind": "capture_session",
        "session_id": f"{ident.entity_id}/{name}",
        "source_id": ident.entity_id,
        "node_id": ident.node_id,
        "zone_id": ident.zone_id,
        "started_at": meta.get("started_at_iso"),
        # 촬영 길이는 프레임 수와 fps 로 낸다. 둘 중 하나라도 모르면 null 이다.
        "duration_s": round(len(frames) / fps, 1) if (fps and frames) else None,
        "sensor": {
            "type": "camera",
            "position": {1: "front", 2: "chin", 3: "left", 4: "right",
                         5: "belly"}.get(meta.get("camera")),
            "camera_id": meta.get("camera"),
            "fps": fps,
            "format": "jpeg",
            "jpeg_quality": meta.get("jpeg_quality"),
        },
        "frames": {
            "count": len(frames),
            "bytes": total,
            "naming": "frame_%06d.jpg",
            "t0_unix": t0,
            # 프레임 n(1부터)의 시각 = t0_unix + (n-1)*interval_s
            "interval_s": round(1.0 / fps, 4) if fps else None,
            "uri": None,               # 업로드 후 채워진다
        },
        "motion": ({"file": "teleop_log.csv",
                    "columns": ["ts_unix", "vx", "vy", "wz", "estop"],
                    "rows": sum(1 for _ in open(motion_csv, encoding="utf-8")) - 1}
                   if os.path.exists(motion_csv) else None),
        # 아래는 아직 만들 수 없는 것들. 지우지 않고 null 로 남긴다 — 다른 소스가 채운다.
        "pose_track": None,            # 위치 궤적(SLAM/odom 붙으면)
        "frame_ref_base": None,        # 엣지가 디코드 시점에 발급(v8 §6-9)
        "labels": None,                # AI 파트 산출물
    }


def pack(session_dir, out_dir):
    """세션을 tar.gz 로 묶는다. JPEG 는 이미 압축돼 있어 이득이 크지 않지만,
    파일 3만 개를 그대로 옮기는 것보다 한 덩어리가 훨씬 빠르고 안전하다."""
    os.makedirs(out_dir, exist_ok=True)
    name = os.path.basename(os.path.abspath(session_dir).rstrip("/"))
    path = os.path.join(out_dir, f"{name}.tar.gz")
    with tarfile.open(path, "w:gz") as tf:
        tf.add(session_dir, arcname=name)
    return path


def http_put(path, base_url, timeout=120):
    """S3 호환 PUT. base_url 은 디렉터리로 보고 파일명을 뒤에 붙인다."""
    url = base_url.rstrip("/") + "/" + os.path.basename(path)
    with open(path, "rb") as f:
        req = urllib.request.Request(url, data=f.read(), method="PUT")
        req.add_header("Content-Type", "application/gzip")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return url, r.status


def main():
    ap = argparse.ArgumentParser(description="촬영 세션 -> 매니페스트/적재/업로드")
    ap.add_argument("sessions", nargs="+", help="세션 디렉터리 (여러 개 가능)")
    ap.add_argument("--stage", default=None,
                    help="tar.gz 로 묶어 이 디렉터리에 적재 (목적지 미정일 때)")
    ap.add_argument("--put", default=None,
                    help="이 base URL 로 HTTP PUT (S3 호환). --stage 와 같이 쓸 수 있다")
    ap.add_argument("--delete-after", action="store_true",
                    help="업로드가 확인된 세션만 원본 삭제")
    args = ap.parse_args()

    for sess in args.sessions:
        if not os.path.isdir(sess):
            print(f"[건너뜀] 디렉터리가 아니다: {sess}")
            continue

        # 이미 매니페스트가 있고 **다른 종류의 세션**이면(예: 8방향 스캔 촬영) 그 도구가
        # 만든 것을 그대로 존중한다. 여기서 덮어쓰면 사진과 방위의 대응이 사라진다.
        mpath = os.path.join(sess, "manifest.json")
        man = None
        if os.path.exists(mpath):
            try:
                with open(mpath, encoding="utf-8") as f:
                    man = json.load(f)
            except ValueError:
                man = None
        if man is None or man.get("kind") == "capture_session":
            man = build_manifest(sess)

        if man.get("kind") == "capture_session":
            n = man["frames"]["count"]
            size_bytes = man["frames"]["bytes"]
        else:
            shots = man.get("shots") or []
            n = len(shots)
            size_bytes = sum(sh.get("bytes") or 0 for sh in shots)
        if n == 0:
            print(f"[건너뜀] 사진 0장: {sess}")
            continue

        archive = None
        if args.stage:
            archive = pack(sess, args.stage)

        uploaded = False
        if args.put:
            if archive is None:
                archive = pack(sess, "/tmp")
            try:
                uri, status = http_put(archive, args.put)
                if man.get("kind") == "capture_session":
                    man["frames"]["uri"] = uri
                else:
                    man["uri"] = uri
                uploaded = 200 <= status < 300
                print(f"[업로드] {uri} ({status})")
            except Exception as e:
                print(f"[업로드 실패] {type(e).__name__}: {e}")

        # 매니페스트는 세션 옆에 남긴다. 목적지가 정해지면 이 파일만 보내면 된다.
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(man, f, ensure_ascii=False, indent=2)

        label = man.get("session_id") or man.get("session") or os.path.basename(sess)
        print(f"[{label}] 사진 {n}장 {size_bytes/1e6:.1f}MB "
              f"길이 {man.get('duration_s')}s -> {mpath}"
              + (f" / 적재 {archive}" if archive else ""))

        if args.delete_after and uploaded:
            import shutil
            shutil.rmtree(sess)
            print(f"[삭제] {sess} (업로드 확인됨)")
        elif args.delete_after:
            print(f"[보존] {sess} — 업로드가 확인되지 않아 지우지 않는다")


if __name__ == "__main__":
    main()
