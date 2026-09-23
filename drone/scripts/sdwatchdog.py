"""
systemd 워치독 — **죽지 않고 멈추는(hang)** 상태를 잡는다.

`Restart=always` 는 프로세스가 *종료* 할 때만 동작한다. 데드락·무한 대기·굶주림으로
프로세스가 살아는 있지만 아무 일도 못 하는 경우는 systemd 가 알 수 없고, 그러면
사람이 SSH 로 들어가 재시작해야 한다.

해결은 반대로 증명하게 하는 것이다. 유닛에 `WatchdogSec=` 를 주면 systemd 가
`WATCHDOG_USEC` 환경변수를 넣어 주고, 프로세스는 그 주기 안에 `WATCHDOG=1` 을
계속 보내야 한다. 끊기면 systemd 가 죽이고 `Restart=` 대로 다시 띄운다.

**환경변수가 없으면 이 클래스는 아무 일도 하지 않는다.** 즉 `WatchdogSec=` 를 주지
않은 유닛은 동작이 한 줄도 바뀌지 않는다. 켜고 끄는 건 유닛 파일 쪽 결정이다.

⚠ 이 파일은 `~/hw/pi/common/watchdog.py` 와 같은 내용이다. 두 트리(`~/drone`,
`~/hw`)가 따로 배포되고 서로를 import 하지 않으므로 의도적으로 복제해 두었다.
한쪽을 고치면 다른 쪽도 같이 고쳐라.

의존성이 없다 — `NOTIFY_SOCKET` 에 유닉스 데이터그램을 직접 쏜다.
(`python3-systemd` 를 설치하지 않아도 된다)
"""
import os
import socket
import time


class Watchdog:
    def __init__(self):
        self.sock = None
        self.interval = None
        self._last = 0.0

        addr = os.environ.get("NOTIFY_SOCKET")
        usec = os.environ.get("WATCHDOG_USEC")
        # WATCHDOG_PID 가 있으면 그 pid 만 보내야 한다 (자식이 가로채지 않게).
        wd_pid = os.environ.get("WATCHDOG_PID")
        if not addr or not usec:
            return
        if wd_pid is not None and wd_pid != str(os.getpid()):
            return
        try:
            timeout_s = int(usec) / 1_000_000.0
        except ValueError:
            return
        if timeout_s <= 0:
            return
        # systemd 권고: 마감의 절반 주기로 보낸다. 한 번 빠뜨려도 여유가 있다.
        self.interval = timeout_s / 2.0

        # "@..." 는 추상 네임스페이스 — 앞에 NUL 을 붙인다.
        path = "\0" + addr[1:] if addr.startswith("@") else addr
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
            s.connect(path)
        except OSError:
            self.interval = None
            return
        self.sock = s

    @property
    def enabled(self):
        return self.sock is not None and self.interval is not None

    def _send(self, msg):
        if self.sock is None:
            return
        try:
            self.sock.send(msg.encode())
        except OSError:
            pass          # 워치독 전송 실패가 노드를 죽여서는 안 된다

    def ping(self, now=None):
        """루프에서 매 회전 불러도 된다. 실제 전송은 interval 마다 한 번이다."""
        if not self.enabled:
            return
        if now is None:
            now = time.time()
        if now - self._last >= self.interval:
            self._send("WATCHDOG=1")
            self._last = now

    def describe(self):
        if not self.enabled:
            return "systemd 워치독 없음 (유닛에 WatchdogSec= 미설정)"
        return (f"systemd 워치독 활성 — {self.interval * 2:.0f}초 마감, "
                f"{self.interval:.0f}초마다 보고")
