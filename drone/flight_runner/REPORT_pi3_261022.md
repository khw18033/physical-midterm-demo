# pi3 — drone-node Capability 가 retained 로 남지 않던 것 (2026-10-22)

요청: 가시화 쪽 「drone-node 의 Capability 가 브로커에 retained 로 남지 않는다」(10-22 12:13 실측).
결론: **공통 틀에서 retain 이 두 곳에서 버려지고 있었다. 고쳤고, 새 접속에서 retained Capability 가 오는 것을 확인했다.**
「retain 으로 고쳤다」던 11:54 수정은 효과가 없는 한 줄(`retain = True`)이었다 — §2.

## 1. drone-node 가 읽는 공통 틀의 경로

| 항목 | 값 |
|---|---|
| ExecStart (drop-in `60-flight-runner.conf`) | `/home/physical/drone/venv/bin/python3 -u -m flight_runner.node --node drone.drone_node:DroneNode` |
| WorkingDirectory | `/home/physical/hw/pi` (`-m` 이라 `sys.path[0]` = 이 폴더) |
| PYTHONPATH (drop-in) | `/home/physical/drone` — 여기에는 `common/` 이 없다 |
| 실제 import 결과 | `common.physical_command` → **`/home/physical/hw/pi/common/physical_command.py`**, `common.node` → `/home/physical/hw/pi/common/node.py` |
| 다른 사본 | 디스크 전체에서 `physical_command.py` 는 이것 하나뿐이다(venv 안에도 없다) |

`~/hw/pi/common/physical_command.py` 가 맞다. 이 저장소(`~/hw`, 브랜치 `HW`, 02241ac)에는 pi7 의 761fb9b 가 없다.

## 2. `publish_capability` 와 `_publish` 기본 람다 — 고치기 전

```python
# physical_command.py (11:54 에 누가 고친 상태)
self._publish = publish or (lambda t, p, qos: client.publish(t, p, qos=qos))   # retain 인자가 없다
...
def publish_capability(self):
    ...
    self._send(env)          # → self._publish(self.uplink, payload, 1)  — retain 없이
    retain = True            # ← 쓰이지 않는 지역 변수. 아무 효과가 없다
```

- `publish_capability` 는 retain 없이 냈다. 11:54 에 끝에 `retain = True` 가 들어갔지만 발행 뒤에 지역 변수를 만들 뿐이다.
  노드는 12:05 에 재시작돼 이 상태를 읽고 있었고, 12:15 에 다시 봐도 retained 가 없었다(§5 「고치기 전」).
- 기본 람다는 retain 을 받지 않는다. **그리고 drone-node 는 이 기본 람다를 쓰지 않는다** —
  `common/node.py` 가 자기 어댑터를 넘긴다. 그 어댑터도 retain 을 버렸다(§3).

## 3. 다른 발행 경로

| 경로 | 결과 |
|---|---|
| `common/node.py` 의 `PhysicalCommandServer(publish=lambda t, pl, qos: self.client.publish(t, pl, qos=qos))` | **retain 을 버린다.** Capability 는 실제로 이 길로 나간다. `physical_command.py` 만 고치면 `TypeError`(인자가 남는다)가 나거나, 람다를 안 고치면 retain 이 사라진다 |
| `BaseNode.publish(topic, payload, qos, retain, allow_spool)` | JSON 토픽(status · flight_run 등)용. retain 을 `client.publish` 까지 넘긴다. Capability(protobuf, uplink)는 이 길을 지나지 않는다 — spool 도 안 지난다 |
| `flight_runner/node.py` `_hook_command_id` | `pcmd._execute` 만 감싼다. `_publish` · `publish_capability` 는 건드리지 않는다 |
| `hw/pi/drone/*` | uplink · Capability 를 따로 내는 곳이 없다 |

## 4. 고친 것 · 재시작

`~/hw/pi` (브랜치 `HW`):

```python
# common/physical_command.py
self._publish = publish or (lambda t, p, qos, retain=False:
                            client.publish(t, p, qos=qos, retain=retain))
def publish_capability(self):
    ...
    self._publish(self.uplink, env.SerializeToString(), 1, retain=True)      # 효과 없던 `retain = True` 는 지웠다

# common/node.py — drone-node 가 실제로 쓰는 어댑터
publish=lambda t, pl, qos, retain=False: self.client.publish(t, pl, qos=qos, retain=retain),

# bench/physical_command_test.py — 가짜 클라이언트 publish 가 retain 을 받게 (진짜 paho 는 받는다)
```

Capability 말고 나머지 uplink(Acceptance · Status · Result)는 그대로 retain=false 다.

시험:
- `flight_runner` 시험 31개 통과. 실제 공통 틀로 도는 시험(`test_real_command_server_carries_command_id`)에
  「Capability 가 retain=True 로 나간다」 검사를 더했다. 이 시험은 고치는 도중 `TypeError` 로 어댑터 문제를 잡았다.
- `hw/pi/bench/physical_command_test.py` — 「전부 통과 — 규약 준수 확인」.

재시작: `sudo systemctl restart drone-node` 는 **sudo 비밀번호가 필요해 못 했다.** drone-node 는 `physical` 로 돌고
`Restart=always` 라서, 12:17:32 에 주 프로세스(PID 1120)에 SIGTERM 을 보내 systemd 가 다시 띄우게 했다(PID 19379).
그 시각에 돌고 있던 비행 · 비상 유닛은 없었다(`runner_state.json` 은 둘 다 exited).

```
12:17:36 systemd[1]: Started drone-node.service
12:17:36 flight_runner.node: 비행 실행기 준비 — rtk_test_start, rtk_test_stop, rtk_test_emergency
12:17:36 노드 시작 — entity=x500-001 node=pi3 zone=zoneA type=drone
12:17:36 [규약] downlink 구독 terminal/x500-001/downlink, Capability 발행
```

## 5. 새 접속에서 retained 확인

xxd 가 없어 `od -c` 와 mosquitto_sub 의 `-F '%r'`(retain 플래그)로 봤다. 브로커는 하나이고 리스너는 1883 · 9001(websockets)이다.
`persistence true` 라 브로커가 재시작돼도 retained 는 남는다.

고치기 전 (12:15, 노드 PID 1120):
```
$ mosquitto_sub -h localhost -p 1883 -t 'terminal/x500-001/uplink' -v -C 1 -W 5
Timed out
```

고친 뒤 (노드 재시작보다 늦은 새 접속):
```
$ mosquitto_sub -h localhost -p 1883 -t 'terminal/x500-001/uplink' -C 1 -W 5 -F '%r %t %x'
1 terminal/x500-001/uplink 3a430a08783530302d303031120470696e67121272746b5f746573745f656d657267656e6379...
$ mosquitto_sub -h localhost -p 1883 -t 'terminal/x500-001/uplink' -C 1 -W 5 | od -c
0000000   :   C  \n  \b   x   5   0   0   -   0   0   1 022 004   p   i
0000020   n   g 022 022   r   t   k   _   t   e   s   t   _   e   m   e
0000040   r   g   e   n   c   y 022 016   r   t   k   _   t   e   s   t
0000060   _   s   t   a   r   t 022  \r   r   t   k   _   t   e   s   t
0000100   _   s   t   o   p  \n
$ mosquitto_sub ... -R            # retained 를 빼면 아무것도 안 온다 = 위의 것은 retained 다
Timed out
```

retain 플래그 1, `x500-001` · `ping` · `rtk_test_emergency` · `rtk_test_start` · `rtk_test_stop` 이 모두 있다.
다른 장비 토픽(`terminal/go1-*` 등)의 retained 는 건드리지 않았다.

## 6. `flight_run.run` 의 `script` · `rtk`

⚠ **`run.rtk` 는 객체가 아니라 bool 이다.** 가시화가 가정한 `run.rtk.corrections` 는 없다 —
`run.rtk.corrections` 로 읽으면 늘 undefined 다. `run.rtk === true` 로 읽을 것.

예시 (RTK 보정 없이 dry-run, 실행기를 가짜 스크립트로 돌려 받은 실제 본문; `lines` 는 줄였다):

```json
{
 "run_id": "20261022_121805",
 "command_id": "cmd-example",
 "state": "exited",
 "dry_run": true,
 "argv": ["--yes", "--pattern", "fb", "--side", "forward", "--altitude", "3", "--length", "3",
          "--speed", "1", "--passes", "1", "--dry-run"],
 "started_at": 1792639085.8628035,
 "ended_at": 1792639085.9642327,
 "exit_code": 0,
 "out_path": "/home/physical/cansar_logs/runner/20261022_121805.out",
 "lines": [{"seq": 1, "text": "[1792639085.889] [연결] udpin://0.0.0.0:14540 ..."}, "…"],
 "script": "test_sar.py",
 "rtk": false
}
```

| 칸 | 값 |
|---|---|
| `run.script` | `"test_sar_rtk.py"` 또는 `"test_sar.py"`. 이 칸이 생기기 전의 상태 파일에서 이어 붙은 실행은 `"test_sar_rtk.py"` |
| `run.rtk` | `true` · `false` — **비행 시작 명령을 받은 순간 한 번** 판정한 값. 비행 중에는 바뀌지 않는다. 옛 상태 파일에서 이어 붙은 실행은 `null` |
| `rtk_test_start` 의 CommandResult | `{"launched": 1, "dry_run": 0|1, "rtk": 0|1}` |
| `rtk=false` 일 때 argv | `rtk_min_s` · `rtk_timeout_s` 파라미터를 받아 두고 명령줄에서 뺀다(`test_sar.py` 에는 그 옵션이 없다) |

**판정** (`flight_runner/node.py` `rtk_connected()`):

```
rtk = node.link.snapshot()["rtk"]            # 드론 상태 토픽에 실리는 state.rtk 와 같은 함수 · 같은 값
run.rtk = rtk.corrections  or  rtk.fix in ("RTK_FLOAT", "RTK_FIXED")
```

- `rtk.corrections` 는 **드론 상태 토픽의 `rtk.corrections` 와 같은 값**이다(같은 `DroneLink.snapshot()`).
  rtcm 전달기(cansar_rtcm_send.py)의 보고가 아니다 — 라우터 엔드포인트 UDP 14543 에서 FC 쪽으로 가는
  `GPS_RTCM_DATA` 를 노드가 직접 보고, **마지막 수신이 3초 안**(`RTCM_STALE`, `HW_DRONE_RTCM_STALE` 로 바꿀 수 있다 — 지금은 안 바꿨다)이면 true.
- 보정이 끊겼어도 FC 가 이미 RTK_FLOAT/FIXED 이면 true 로 친다.
- FC 링크가 없으면 `rtk` 가 null → false. 판정에서 예외가 나도 false(→ `test_sar.py`).
- Fixed 30초 대기는 판정에 넣지 않았다. `test_sar_rtk.py` 가 이륙 전에 기다린다.

## 7. 커밋

| 저장소 · 브랜치 | 커밋 | 내용 |
|---|---|---|
| `~/` (physical-midterm-demo) · `drone-pi3` | `f89498a` | RTK 보정 없으면 test_sar.py, `flight_run.run.script` · `rtk`, test_sar.py 재작성 |
| 〃 | (이 보고서와 같은 커밋 — `git log -1 -- drone/flight_runner/REPORT_pi3_261022.md`) | 시험에 Capability retain 검사, 이 보고서 |
| `~/hw` (Physical-Project-mk2) · `HW` | `acb235a` | Capability retain (physical_command.py · node.py 의 어댑터 줄만 · bench 가짜 클라이언트) |

`~/hw/pi/common/node.py` 에 이미 있던 커밋 안 된 watchdog 변경은 이 커밋에 넣지 않았다(어댑터 한 줄만 넣었다).

**푸시는 못 했다.** 이 Pi 에 GitHub 인증 정보가 없다(`could not read Username for 'https://github.com'`, gh · SSH 키 없음).
원격 drone-pi3 는 아직 6a9b1ce 까지다. 토큰으로 `git push` 하거나 다른 PC 에서 올려야 한다.
