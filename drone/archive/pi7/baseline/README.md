# 기준 스냅샷 — 2026-09-21 15:15 KST (0단계, 변경 전)

7단계 재부팅 검증에서 이 파일들과 대조해 "Go1을 건드리지 않았다"를 증명한다.

| 파일 | 내용 |
|---|---|
| `TIMESTAMP` | 스냅샷 시각 |
| `go1-services-status.txt` | Go1 관련 서비스 `systemctl status` 전문 |
| `enabled-units.txt` | `systemctl list-unit-files --state=enabled` (43개) |
| `enabled-units-user.txt` | 사용자 세션 enabled 유닛 |
| `ss-tulnp.txt` | 열린 포트 전체 |
| `ip-4-addr.txt` | IPv4 주소 + 라우팅 |
| `nmcli-connections.txt` | NetworkManager 연결 프로파일 |
| `tailscale-status.txt` | tailnet 피어 목록 |
| `go1-code-sha256.txt` | Go1 코드 391개 파일 해시 (`~/hw`, `~/go1sdk`, `~/unitree_legged_sdk`, `__pycache__` 제외) |
| `go1-config-sha256.txt` | 시스템 설정 23개 파일 해시 (유닛·env·mosquitto·부트설정) |
| `go1-venv-packages.txt` | Go1 venv(`~/venv`) 패키지 목록 |
| `system-info.txt` | 모델 / 커널 / `/proc/cmdline` |
| `config.txt.snapshot` | `/boot/firmware/config.txt` 원본 |
| `cmdline.txt.snapshot` | `/boot/firmware/cmdline.txt` 원본 |
| `serial-devices.txt` | 시리얼 장치 노드 |

## 대조 방법

```bash
cd ~/drone/baseline
sha256sum -c go1-code-sha256.txt   --quiet   # 달라진 파일 0개여야 한다
sha256sum -c go1-config-sha256.txt --quiet   # 부트설정 2건 외 변화 없어야 한다
diff <(systemctl list-unit-files --state=enabled --no-pager) enabled-units.txt  # drone-* 추가만
diff <(ss -tulnp) ss-tulnp.txt                # 드론 포트 추가만
```
