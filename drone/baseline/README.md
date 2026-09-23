# 기준 스냅샷 — pi3 (드론 전용 Raspberry Pi 5)

0단계에서 **아무것도 바꾸지 않은 상태**로 채집했다.
이후 단계에서 "드론 작업 외에 바뀐 게 없는가"를 확인하는 기준이다.

`pi7`(Go1) 시절 스냅샷은 이 장비와 무관하며 `../archive/pi7/baseline/`에 보관만 한다. 비교에 쓰지 않는다.

| 파일 | 내용 |
|---|---|
| `TIMESTAMP` | 스냅샷 시각 |
| `system-info.txt` | 모델/리비전/호스트명/커널/OS/Python/사용자 그룹 |
| `enabled-units.txt` | enabled 시스템 유닛 36개 |
| `enabled-units-user.txt` | enabled 사용자 세션 유닛 8개 |
| `ss-tulnp.txt` | 열린 포트 전체 |
| `ip-4-addr.txt` | IPv4 주소 + 라우팅 |
| `nmcli-connections.txt` | NetworkManager 연결 프로파일 |
| `tailscale-status.txt` | tailnet 피어 목록 |
| `config.txt.snapshot` | `/boot/firmware/config.txt` 원본 |
| `cmdline.txt.snapshot` | `/boot/firmware/cmdline.txt` 원본 |
| `proc-cmdline.txt` | `/proc/cmdline` (펌웨어 치환 후 실제 커널 인자) |
| `boot-config-sha256.txt` | 부트 설정 2개 해시 |
| `serial-devices.txt` | 시리얼 장치 노드 + `pinctrl get 14,15` + DT status + serial-getty |
| `firewall.txt` | iptables 규칙(tailscale 체인만) / nftables / ufw |

## 대조 방법

```sh
cd ~/drone/baseline

# 부트 설정 — 1단계에서 2개 파일이 의도적으로 바뀐다
sha256sum -c boot-config-sha256.txt

# 그 외에는 차이가 0이어야 한다
diff <(systemctl list-unit-files --state=enabled --no-pager) enabled-units.txt
diff <(ss -tulnp) ss-tulnp.txt          # 드론 포트 14540/14550/5760만 늘어나야 함
diff <(nmcli -t -f NAME,DEVICE,TYPE,STATE connection show) nmcli-connections.txt
```

`serial-devices.txt`는 1단계 후 의도적으로 달라진다(`/dev/ttyAMA0` 생성, GPIO14/15 기능 변경).
