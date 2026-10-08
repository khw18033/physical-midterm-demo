"""MAVSDK 제어 스크립트 공용 안전장치 — sar_test·test_sar 계열이 같이 쓴다.

2026-10-08 13:17 사고(drone/REPORT_mavsdk_stale_server_261008.md)에서 드러난 세 구멍을 막는다.

1. **남의 mavsdk_server 에 붙기** — MAVSDK-Python 은 자기가 띄운 서버가 bind 에 실패해 죽어도
   localhost:50051 에 아무 서버나 떠 있으면 그대로 붙는다. 그 서버가 언제 죽을지는 이 스크립트가 모른다.
   → connect() 전에 UDP 제어 포트·gRPC 포트가 비었는지 보고, connect() 뒤 내 서버가 살아 있는지 본다.
2. **[종료] 뒤에 안 끝나는 프로세스** — 서버 stdout 을 읽는 _LoggingThread 가 non-daemon 이고 서버는
   atexit 에서만 죽는다. 파이썬은 non-daemon 스레드를 join 한 **뒤에** atexit 를 돌리므로 서로 기다린다.
   그동안 서버는 기체와 연결된 채 14540·50051 을 쥐고 있다.
   → 끝날 때 stop() 으로 서버를 직접 죽인다.
3. **명령 통로가 죽으면 rtl 도 못 보냄** — abort 가 같은 gRPC 로 나가므로 서버가 죽으면 같이 실패한다.
   → 새 mavsdk_server 를 다른 gRPC 포트로 띄워 다시 연결한 뒤 보낸다.
"""

import asyncio
import socket
import subprocess
from urllib.parse import urlparse

from mavsdk import System

GRPC_PORT = 50051


def _udp_port(address):
    u = urlparse(address)
    return u.port if u.scheme == "udpin" else None


def _holders(proto, port):
    """해당 포트를 잡은 프로세스 설명(ss 출력). 못 얻으면 빈 문자열."""
    flag = "-ulpnH" if proto == "udp" else "-tlpnH"
    try:
        out = subprocess.run(["ss", flag, f"sport = :{port}"], capture_output=True,
                             text=True, timeout=3).stdout.strip()
    except Exception:
        return ""
    return out


def _bindable(proto, host, port):
    kind = socket.SOCK_DGRAM if proto == "udp" else socket.SOCK_STREAM
    s = socket.socket(socket.AF_INET, kind)
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def busy_ports(address, grpc_port=GRPC_PORT):
    """쓰이고 있는 포트 목록 [(설명, ss 출력)]. 비었으면 안전."""
    busy = []
    udp = _udp_port(address)
    if udp and not _bindable("udp", "0.0.0.0", udp):
        busy.append((f"UDP {udp} (MAVLink 제어)", _holders("udp", udp)))
    # gRPC 서버는 SO_REUSEPORT 로 열리지만 이 소켓은 그 옵션 없이 bind 하므로 누가 있으면 실패한다.
    if not _bindable("tcp", "127.0.0.1", grpc_port):
        busy.append((f"TCP {grpc_port} (mavsdk_server gRPC)", _holders("tcp", grpc_port)))
    return busy


def _free_tcp_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class StaleServer(RuntimeError):
    pass


async def connect(address, log, grpc_port=GRPC_PORT):
    """포트가 비었는지 확인하고 연결한다. 남의 서버가 있거나 내 서버가 죽으면 StaleServer."""
    busy = busy_ports(address, grpc_port)
    if busy:
        for what, who in busy:
            log(f"[오류] {what} 를 이미 다른 프로세스가 쓰고 있다:")
            for line in (who or "(ss 로 프로세스를 확인하지 못했다)").splitlines():
                log(f"         {line}")
        log("[오류] 이전 MAVSDK 스크립트가 [종료] 뒤 안 끝났거나, SSH 가 끊긴 창에서 아직 돌고 있다.")
        log("       다른 창에서 비행 중인 스크립트가 없는지 확인한 뒤: pkill -f mavsdk_server")
        raise StaleServer("제어 포트 사용 중")
    drone = System(port=grpc_port)
    await drone.connect(system_address=address)
    # bind 실패 시 mavsdk_server 는 곧바로 끝난다. 잠깐 기다렸다가 살아 있는지 본다.
    await asyncio.sleep(0.5)
    if not alive(drone):
        stop(drone)
        raise StaleServer("내가 띄운 mavsdk_server 가 바로 죽었다 (포트 충돌?)")
    return drone


def alive(drone):
    p = getattr(drone, "_server_process", None)
    return p is not None and p.poll() is None


def stop(drone):
    """mavsdk_server 를 죽인다. 서버 stdout 이 닫혀 로그 스레드도 끝나고 프로세스가 정상 종료된다."""
    p = getattr(drone, "_server_process", None)
    if p is None:
        return
    try:
        p.kill()
        p.wait(timeout=3)
    except Exception:
        pass


async def _send(drone, how):
    if how == "rtl":
        await drone.action.return_to_launch()
    elif how == "land":
        await drone.action.land()
    else:
        await drone.action.hold()


async def abort(drone, how, address, log):
    """how(rtl/land/hold)를 보낸다. 실패하면 서버를 새로 띄워 한 번 더 보낸다. 성공하면 True."""
    log(f"[중단] {how} 명령을 보낸다 — ★ 필요하면 즉시 조종기로 개입할 것 ★")
    try:
        async with asyncio.timeout(5):
            await _send(drone, how)
        return True
    except Exception as e:
        log(f"[오류] {how} 실패: {e}")
    # 명령 통로(mavsdk_server/gRPC)가 죽었을 수 있다. 내 서버를 확실히 내리고 새로 연결한다.
    log("[복구] mavsdk_server 를 새로 띄워 다시 연결한다...")
    stop(drone)
    await asyncio.sleep(1.0)
    fresh = None
    try:
        fresh = System(port=_free_tcp_port())
        await fresh.connect(system_address=address)
        async with asyncio.timeout(10):
            async for s in fresh.core.connection_state():
                if s.is_connected:
                    break
            await _send(fresh, how)
        log(f"[복구] {how} 전송 ✔ (새 연결)")
        return True
    except Exception as e:
        log(f"[오류] 새 연결로도 {how} 실패: {e!r} — ★ 즉시 조종기로 개입할 것 ★")
        return False
    finally:
        if fresh is not None:
            stop(fresh)
