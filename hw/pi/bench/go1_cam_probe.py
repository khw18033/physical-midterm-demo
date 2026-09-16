"""
피지컬팀 mk2 — Go1 카메라 정지 판정 (HW-R-07)
================================================
**프레임이 흐르는 것과 그림이 변하는 것은 다른 문제다.**

Go1 카메라 파이프라인이 물리면 인코더가 마지막 버퍼를 계속 압축한다. 30 fps 가 그대로
나오고 비트레이트도 정상이라 프레임 수만 세면 정상으로 보인다. 실제로 정면 카메라가
이 상태로 몇 시간 방치됐다 — "예전 화면에서 멈춰 있다"는 지적으로야 발견했다.

그래서 프레임 수가 아니라 **그림의 변화량**을 잰다. 32x32 그레이로 줄여 프레임 간
평균 절대차와 처음↔끝 차이를 본다. 조명 노이즈만 있어도 0 은 나오지 않으므로,
0.00 이면 진짜로 같은 그림이다.

사용:
    cd ~/hw/pi && python3 -m bench.go1_cam_probe [초]

정지로 판정되면 그 카메라를 담당하는 나노를 재부팅해야 한다(자세한 배경은
`robot/go1_camera.py` 의 경고 참조).
"""
import subprocess
import sys
import tempfile
import time

from robot.go1_camera import CAMS, Go1CameraSource

CELL = 32 * 32
# 정지 판정 — 결정 신호는 **잡음의 유무** 하나다. 살아 있는 카메라는 장면이 완전히
# 정적이어도 센서 잡음이 프레임간 평균차 0.08~0.25 를 만들고, 진짜 정지(인코더가
# 같은 버퍼를 재압축)는 0.02 로 잡음조차 없다. 실측 분포가 3배 이상 벌어져 있다.
#
# 처음엔 "변화량"(처음↔끝 span)으로 판정하려다 두 번 실패했다: 임계 1.0 은 바닥만
# 보는 카메라를 정지로 오판했고, 0.10 은 얼어붙은 정면 카메라의 span 0.12(디코드
# 잡음)를 정상으로 통과시켰다. 변화량은 장면에 좌우되지만 잡음은 센서의 물리다.
STILL_MEAN = 0.05


def capture(cam_id, seconds, path):
    n = 0
    with open(path, "wb") as f:
        t0 = time.time()
        for chunk in Go1CameraSource(cam_id):
            f.write(chunk)
            n += 1
            if time.time() - t0 > seconds:
                break
    return n


def gray_frames(path):
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "h264", "-i", path,
         "-vf", f"scale=32x32,format=gray", "-f", "rawvideo", "pipe:1"],
        stdout=subprocess.PIPE).stdout
    return [raw[i * CELL:(i + 1) * CELL] for i in range(len(raw) // CELL)]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 8.0
    print(f"카메라별 {seconds:.0f}초 수집 — 프레임 수가 아니라 '그림이 변하는가'를 본다\n")
    bad = []
    for cid in CAMS:
        with tempfile.NamedTemporaryFile(suffix=".h264", delete=False) as tf:
            path = tf.name
        try:
            capture(cid, seconds, path)
            fr = gray_frames(path)
            if len(fr) < 2:
                print(f"  {cid} {CAMS[cid][2]:10s} 프레임 부족 ({len(fr)})")
                bad.append(cid)
                continue
            diffs = [sum(abs(a - b) for a, b in zip(fr[i - 1], fr[i])) / CELL
                     for i in range(1, len(fr))]
            span = sum(abs(a - b) for a, b in zip(fr[0], fr[-1])) / CELL
            bright = sum(fr[-1]) / CELL
            still = sum(diffs) / len(diffs) < STILL_MEAN
            if still:
                bad.append(cid)
            print(f"  {cid} {CAMS[cid][2]:10s} {len(fr):3d}프레임  "
                  f"평균차 {sum(diffs)/len(diffs):4.2f}  최대 {max(diffs):4.2f}  "
                  f"처음↔끝 {span:4.2f}  밝기 {bright:3.0f}  "
                  f"→ {'⛔ 정지' if still else '정상'}")
        finally:
            subprocess.run(["rm", "-f", path])
    if bad:
        print(f"\n정지 판정: {', '.join(f'{c}({CAMS[c][2]})' for c in bad)}")
        print("해당 카메라를 담당하는 나노를 재부팅할 것 "
              "— 링크나 프로세스 재기동으로는 복구되지 않는다.")
        print("  1,2 → 192.168.123.13 · 3,4 → .14 · 5 → .15")
    else:
        print("\n전부 정상")


if __name__ == "__main__":
    main()
