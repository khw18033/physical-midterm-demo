#!/usr/bin/env bash
# 말단 환경을 Pi에 배포한다. 재실행 안전(멱등).
#
# **이것이 비행 정본이다** — Dockerfile은 재현·CI용이다(Dockerfile 첫머리 참고).
#
# 기기를 바꿔도 되도록 대상은 전부 인자·환경변수로 받는다. 저장소에 특정 기기의
# 주소를 박아 두지 않는다 — 엣지를 GitHub로 옮길 때 고칠 곳이 생기면 안 된다.
#
#   ./deploy.sh --host <pi-호스트> --user <계정>
#   DRONE_HOST=<주소> DRONE_USER=<계정> ./deploy.sh
#   ./deploy.sh --no-venv          # 코드만 갱신(의존성 설치 건너뜀)
#   ./deploy.sh --password         # 키 대신 비밀번호(sshpass 필요)
set -euo pipefail

# 기본값을 두지 않는다 — 특정 기기를 저장소에 박아 두면 다른 기기에서
# 쓸 때 조용히 엉뚱한 곳으로 간다. 없으면 말하고 멈춘다.
HOST="${DRONE_HOST:-}"
USER="${DRONE_USER:-}"
KEY="${DRONE_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${DRONE_DIR:-drone_rpi}"
DO_VENV=1
USE_PW=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2;;
    --user) USER="$2"; shift 2;;
    --key)  KEY="$2"; shift 2;;
    --dir)  REMOTE_DIR="$2"; shift 2;;
    --no-venv) DO_VENV=0; shift;;
    --password) USE_PW=1; shift;;
    *) echo "모르는 인자: $1" >&2; exit 2;;
  esac
done

if [[ -z "$HOST" || -z "$USER" ]]; then
  echo "대상을 지정한다:  ./deploy.sh --host <주소> --user <계정>" >&2
  echo "또는            DRONE_HOST=<주소> DRONE_USER=<계정> ./deploy.sh" >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$USER@$HOST"

if [[ "$USE_PW" == "1" ]]; then
  command -v sshpass >/dev/null || { echo "sshpass가 필요하다" >&2; exit 1; }
  read -rsp "$TARGET 비밀번호: " PW; echo
  SSH=(sshpass -p "$PW" ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
  RSH="sshpass -p $PW ssh -o StrictHostKeyChecking=accept-new"
else
  SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10)
  RSH="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes"
fi

echo "== 대상: $TARGET:~/$REMOTE_DIR"
"${SSH[@]}" "$TARGET" "mkdir -p ~/$REMOTE_DIR"

# 코드·설정만 보낸다. 산출물(spool/, *.jsonl, 스냅샷)은 뺀다 — 말단에서 생긴
# 결과를 개발 기기 것으로 덮어쓰면 안 된다. 모델도 뺀다(아래에서 따로).
rsync -az --delete-after \
  --exclude 'venv/' --exclude '__pycache__/' \
  --exclude 'spool/' --exclude '*.jsonl' --exclude '*.log' \
  --exclude 'records_snapshot.json' --exclude 'Dockerfile' \
  --exclude '.dockerignore' \
  -e "$RSH" "$HERE/" "$TARGET:$REMOTE_DIR/"

# **모델을 보내지 않는다.** 말단에는 이제 신경망이 없다 — 캡처와 KLT 플로우
# 정렬뿐이고 검출·거리는 전부 엣지 몫이다(AI-B-10). 예전에는 20MB RPN ONNX를
# 따로 보냈고, rsync --delete-after가 그걸 지우는 사고도 한 번 있었다.

if [[ "$DO_VENV" == "1" ]]; then
  echo "== venv 구성(이미 있으면 갱신만)"
  "${SSH[@]}" "$TARGET" "
    set -e
    cd ~/$REMOTE_DIR
    [ -d venv ] || python3 -m venv venv
    ./venv/bin/pip install -q --upgrade pip
    ./venv/bin/pip install -q -r requirements.txt
    ./venv/bin/python -c 'import numpy,onnxruntime,cv2; print(\"deps OK\")'
  "
fi

echo "== 배포 완료"
"${SSH[@]}" "$TARGET" "cd ~/$REMOTE_DIR && ls"
echo
echo "실행:  ssh $TARGET 'cd ~/$REMOTE_DIR && ./venv/bin/python agent.py'"
echo "확인:  curl http://$HOST:8890/api/health"
