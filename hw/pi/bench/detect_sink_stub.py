# -*- coding: utf-8 -*-
"""
피지컬팀 mk2 — 탐지 수신측 스텁 (연동 확인용)
================================================
`robot/detect_bridge.py` 가 보내는 것을 그대로 받아 찍어 본다. 탐지 담당 쪽이
받는 코드를 짜기 전에 경로를 확인하거나, 우리 쪽 전송을 시험할 때 쓴다.

    python3 -m bench.detect_sink_stub                 # 0.0.0.0:8000
    python3 -m bench.detect_sink_stub 8799 --save /tmp/shots

받는 것 (전부 단방향 — 본문은 돌려주지 않는다):

    POST /mission/start   application/json
    POST /frame           multipart/form-data  (meta=JSON, image=JPEG)
    POST /mission/end     application/json

탐지 담당 쪽이 실제로 구현할 때 참고할 최소 형태이기도 하다.
"""
import argparse
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def kind_of(img):
    """JPEG 인지 눈으로 확인 — SOI 마커."""
    return "JPEG" if img[:2] == b"\xff\xd8" else "?"


SAVE_DIR = None
COUNT = {"start": 0, "frame": 0, "end": 0}


def split_multipart(body, boundary):
    """meta / image 파트를 꺼낸다. 라이브러리 없이 — 파트가 둘뿐이라 짧다."""
    sep = b"--" + boundary.encode()
    parts = {}
    for chunk in body.split(sep):
        if b"\r\n\r\n" not in chunk:
            continue
        head, _, payload = chunk.partition(b"\r\n\r\n")
        m = re.search(rb'name="([^"]+)"', head)
        if m:
            parts[m.group(1).decode()] = payload.rstrip(b"\r\n")
    return parts


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass                                   # 기본 접근로그는 끈다 — 우리가 찍는다

    def _ok(self):
        self.send_response(204)                # 본문 없음 — 단방향이다
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        ctype = self.headers.get("Content-Type", "")
        ts = time.strftime("%H:%M:%S")

        if self.path == "/frame":
            m = re.search(r"boundary=([^;]+)", ctype)
            parts = split_multipart(body, m.group(1)) if m else {}
            meta = json.loads(parts.get("meta", b"{}").decode("utf-8"))
            img = parts.get("image", b"")
            COUNT["frame"] += 1
            print(f"[{ts}] FRAME  seq={meta.get('seq')} "
                  f"step={meta.get('step')}/{meta.get('steps')} "
                  f"bearing={meta.get('bearing_deg')}deg "
                  f"yaw={meta.get('yaw_deg')} "
                  f"{len(img)}B {kind_of(img)}", flush=True)
            if SAVE_DIR and img:
                os.makedirs(SAVE_DIR, exist_ok=True)
                name = f"{meta.get('mission_id','m')}_{meta.get('seq',0):02d}.jpg"
                with open(os.path.join(SAVE_DIR, name), "wb") as f:
                    f.write(img)
        else:
            meta = json.loads(body.decode("utf-8") or "{}")
            kind = meta.get("kind", self.path)
            COUNT["start" if "start" in self.path else "end"] += 1
            print(f"[{ts}] {kind.upper()}  {json.dumps(meta, ensure_ascii=False)[:300]}",
                  flush=True)
        self._ok()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8000)
    ap.add_argument("--save", help="받은 이미지를 이 디렉터리에 저장한다")
    a = ap.parse_args()
    global SAVE_DIR
    SAVE_DIR = a.save
    srv = ThreadingHTTPServer(("0.0.0.0", a.port), Handler)
    print(f"[수신] 0.0.0.0:{a.port} 대기 — /mission/start /frame /mission/end", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print(f"\n[수신] 종료. {COUNT}", flush=True)


if __name__ == "__main__":
    main()
