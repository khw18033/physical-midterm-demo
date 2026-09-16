# -*- coding: utf-8 -*-
"""pi7 에서 15110(go1_sdk_pc 의 경로 수신 포트)으로 오는 것을 찍어본다.

go1_sdk_pc 가 안 떠 있을 때만 쓴다(포트를 뺏으므로). Unity 에서 목적지를 찍으면
여기에 go1_path JSON 이 찍혀야 한다.
"""
import socket
import sys
import time

port = int(sys.argv[1]) if len(sys.argv) > 1 else 15110
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 3000

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", port))
s.settimeout(1.0)
print(f"[probe] :{port} 대기", flush=True)

end = time.time() + secs
n = 0
while time.time() < end:
    try:
        data, src = s.recvfrom(65535)
    except socket.timeout:
        continue
    n += 1
    text = data.decode("utf-8", "replace")
    head = text[:400].replace("\n", " ")
    print(f"[probe] #{n} {len(data)}B from {src[0]}  {head}", flush=True)
print(f"[probe] 종료. {n} 개 수신", flush=True)
