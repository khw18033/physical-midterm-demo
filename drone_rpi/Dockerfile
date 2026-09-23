# 말단 컨테이너 — **재현·CI용이지 비행 정본이 아니다.**
#
# 비행 정본은 venv다(deploy.sh). 이유는 카메라다: rpicam-vid는 호스트 libcamera
# 스택에 묶여 있어서 컨테이너에서 쓰려면 /dev/video*, /dev/dma_heap, /run/udev를
# 넘기고 **호스트와 컨테이너의 libcamera 버전이 맞아야** 한다. 어긋나면 카메라만
# 조용히 실패한다 — 비행 중에 그 실패를 만나고 싶지 않다.
#
# 그래서 이 이미지의 용도는 둘이다:
#   1) source="images"로 도는 재현 실행(카메라 불필요)
#   2) 다른 기기에서 코드가 도는지 확인하는 CI
#
# 카메라까지 컨테이너로 돌리려면 호스트에 rpicam-apps를 맞춘 뒤:
#   docker run --rm -it --device /dev/video0 --device /dev/dma_heap \
#     -v /run/udev:/run/udev:ro -p 8890:8890 drone-rpi
FROM python:3.13-slim-bookworm

# opencv-python-headless가 libGL을 안 쓰지만 libglib는 필요하다.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py config.json ./
# 모델은 이미지에 굽지 않는다 — 20MB 바이너리를 레이어에 넣으면 코드 한 줄
# 고칠 때마다 같이 옮겨진다. 실행 시 마운트한다: -v $PWD/models:/app/models
VOLUME ["/app/models", "/app/spool"]

EXPOSE 8890
CMD ["python", "agent.py"]
