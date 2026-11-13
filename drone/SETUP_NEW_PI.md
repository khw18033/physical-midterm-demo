# 새 드론의 라즈베리파이 세팅 (drone-all 브랜치)

이 브랜치만 받으면 pi3 와 같은 드론 제어 환경을 다른 기체의 Pi 5 에 깔 수 있다.
설치는 `drone/install_all.sh` 하나로 하고, 이 문서는 그 앞뒤에 사람이 할 일을 적는다.

## 0. 준비

- Raspberry Pi 5, Raspberry Pi OS (Debian 13 trixie, 64bit). 계정 이름은 **`physical`**.
  유닛과 스크립트에 `/home/physical` 이 박혀 있다.
- 배선: FC **TELEM2** ↔ Pi GPIO14(TX)/15(RX)/GND. 카메라는 CAM0 = Arducam AR0234(pivariety), CAM1 = imx708_wide.

## 1. 저장소 받기 (저장소 루트 = 홈 디렉터리)

```bash
cd ~
git init -b drone-all
git remote add origin https://github.com/khw18033/physical-midterm-demo.git
git fetch origin drone-all
git checkout -f -t origin/drone-all     # 홈의 기존 파일은 .gitignore 화이트리스트 밖이라 건드리지 않는다
```

## 2. 기체마다 바꿀 값 (설치 전에)

| 파일 | 키 | pi3 값 |
|---|---|---|
| `drone/config/device_id` | (한 줄) | `x500-001` |
| `drone/config/drone-node.env` | `DRONE_DEVICE_ID` | `x500-001` |
| `drone/config/hw-drone.env` | `HW_ENTITY_ID` | `x500-001` |
| `drone/config/drone-node.env` | `DRONE_TS_NAME` · `DRONE_TS_IP` | `pi3` · `100.85.243.54` |
| `drone/config/drone-node.env` · `mavlink-router.conf` | `FC_BAUD` · `Baud` | `230400` (그 FC 의 TELEM2 보율) |
| `drone_rpi/config.json` | `cameras[].index` | 0 = AR0234, 1 = imx708 |

기기 ID 세 곳은 같아야 하고, 같은 브로커·웹에 붙는 다른 기체와는 달라야 한다(MQTT 토픽·clientId).

## 3. 설치

```bash
./drone/install_all.sh                         # 확인만 — 무엇이 빠졌는지 본다
sudo ./drone/install_all.sh --install --boot   # 전부 설치 + 부트 설정 패치
sudo reboot
./drone/install_all.sh                         # 다시 확인 — 전부 ✓ 여야 한다
```

설치하는 것: apt 패키지, mavlink-router(커밋 `2362c620` 소스 빌드), venv 2개(`drone/config/requirements.lock.txt`,
`drone_rpi/requirements.txt`), `/etc/{drone-node.env, hw-node.env, hw-drone.env, device_id}`, mosquitto 설정,
systemd 유닛(`drone-detect`, `drone-node`, `drone-mavlink-router`, `drone-linkmon`, `drone.target`, `drone-agent`),
비행 실행기 덮어쓰기(`/etc/systemd/system/drone-node.service.d/60-flight-runner.conf`, `/etc/flight-runner.env`, linger).

부트 설정 정본은 `drone/config/boot/config.txt`(pi3 의 `/boot/firmware/config.txt` 그대로)다. 스크립트는 파일을 통째로
덮지 않고 필요한 줄(`dtparam=uart0=on`, `dtoverlay=imx708`, `dtoverlay=arducam-pivariety,cam0`,
`camera_auto_detect=0`)만 넣고, `cmdline.txt` 의 `console=serial0` 을 `console=ttyAMA10` 으로 바꾼다.
`cmdline.txt` 는 SD 카드마다 PARTUUID 가 달라 저장소에 두지 않는다.

## 4. 스크립트가 하지 않는 것

- **Tailscale**: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up` → 나온 IP 를 `DRONE_TS_IP` 에.
  QGC 접속은 `TCP <그 IP>:5760`.
- **FC(PX4) 파라미터**: TELEM2 를 MAVLink 로, 보율을 `FC_BAUD` 와 같게. QGC 로 사람이 한다
  (pi3 기체 값은 `docs/PX4_동작정리_260924.md`).

## 5. 확인

```bash
cat ~/drone/state/mode                  # drone = FC 링크 OK, none = 못 찾음
systemctl status drone-detect drone-node drone-agent --no-pager
journalctl -u drone-node -n 30          # 「비행 실행기 준비」
curl localhost:8890/api/health          # 영상 에이전트
rpicam-hello --list-cameras             # 카메라 번호
```

## 노드 코드 위치에 대해

MQTT 가시화 브리지 노드(`drone.drone_node`)와 공통 틀(`common/`)은 원래 별도 저장소
(`Physical-Project-mk2`, `HW` 브랜치)의 `~/hw/pi` 에 있었고, 그중 드론 부분은 그 저장소에 커밋된 적이 없었다.
이 브랜치는 그것을 `drone/hw_pi/` 로 복사해 두고 `drone-node.service` 의 `WorkingDirectory` 를 그쪽으로 바꿨다
(2026-11-13, pi3 의 `~/hw/pi` 와 내용 동일 확인). 공통 틀을 고칠 때는 이 사본을 고친다.
