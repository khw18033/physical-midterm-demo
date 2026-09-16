# 증강 기능 컨테이너 (HW-C-03)
# ==============================
# 말단은 aarch64 다. 빌드는 반드시 arm64 로 한다 — amd64 이미지를 밀어 넣으면
# 파드가 ImagePullBackOff 대신 exec format error 로 죽어 원인을 찾기 어렵다.
#
#   docker buildx build --platform linux/arm64 -t <registry>/hw-augment:<태그> \
#          -f pi/augment/Dockerfile pi
#
# 이미지는 태그가 아니라 **digest 로 고정**해 배포한다. 태그는 같은 이름으로 내용이
# 바뀔 수 있어서, 이벤트 시점에 예상과 다른 것이 뜰 수 있다(SDD §7.3).
FROM python:3.13-slim-bookworm

# 말단에 서버형 미들웨어를 두지 않는다(AI-B-10). 전송 클라이언트만 넣는다.
RUN pip install --no-cache-dir paho-mqtt==2.1.0

WORKDIR /app
# 공통 코어를 그대로 쓴다 — 증강 워크로드도 같은 메시지 봉투를 쓴다(P3).
COPY common/ /app/common/
COPY augment/ /app/augment/

# 비루트로 돌린다. 증강 기능이 말단의 다른 것을 건드릴 이유가 없다.
RUN useradd -r -u 10001 augment
USER augment

ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python3", "-m", "augment.analyzer"]
