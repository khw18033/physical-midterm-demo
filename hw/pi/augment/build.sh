#!/usr/bin/env bash
# 증강 기능 이미지 빌드·배포 (HW-C-03)
# ======================================
# 사용:  ./build.sh <레지스트리>/<이미지>:<태그>
#
# 레지스트리가 없는 현장에서는 빌드 결과를 tar 로 내려 각 말단의 containerd 에
# 직접 밀어 넣는다(--import). 이벤트 시점의 pull 을 피하려면 어차피 사전 배치가
# 필요하므로, 레지스트리가 없다고 막히지는 않는다.
set -euo pipefail
IMAGE=${1:?사용: ./build.sh <registry>/<image>:<tag>}
MODE=${2:-push}                      # push | import
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # pi/

echo "[빌드] arm64 — $IMAGE"
docker buildx build --platform linux/arm64 -t "$IMAGE" -f "$HERE/augment/Dockerfile" "$HERE" \
  $( [ "$MODE" = "push" ] && echo --push || echo --output=type=docker,dest=/tmp/hw-augment.tar )

if [ "$MODE" = "push" ]; then
  DIGEST=$(docker buildx imagetools inspect "$IMAGE" --format '{{.Manifest.Digest}}')
  echo "[digest] ${IMAGE%%:*}@${DIGEST}"
  echo "  → 매니페스트의 image 를 이 digest 로 고정할 것 (SDD 7.3)"
else
  echo "[내보냄] /tmp/hw-augment.tar"
  echo "  각 말단에서:  sudo k3s ctr images import /tmp/hw-augment.tar"
fi
