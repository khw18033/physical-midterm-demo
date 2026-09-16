# Physical AI Door-Detection & Navigation Demo (PoC)

로봇이 8방향(45도 간격) 회전 스캔으로 촬영한 프레임에서 지정 클래스(예: door)를
CLIP + OVD(GroundingDINO/YOLO-World) + FastSAM 4개 provider의 증거를 점진적으로
융합해 탐지하고, door/pedestal 두 랜드마크의 위치로 로봇 자기 위치를 추정한 뒤
목표 지점까지의 회전각/거리를 계산하는 PoC 파이프라인입니다.

원본 저장소(`Physical-Project-mk2-jny-backup`)에서 이 데모가 실제로 참조하는
코드/데이터만 뽑아 별도 레포로 만들었습니다.

## 디렉터리 구조

```
demo/test/
  mock_stream_receiver.py       -- 진입점(오프라인). 데이터셋 8장으로 스트림을 흉내 냄
  mqtt_stream_receiver.py       -- 진입점(실연동). 로봇 MQTT over WebSocket 프레임 수신
  detect_api_server.py          -- 관제 웹이 폴링해 가는 HTTP 창구(try1/ 읽기 전용)
  class_finder_service.py       -- 프레임별 클래스 탐지(증거 융합 파이프라인)
  navigate_to_target_service.py -- 자기 위치 추정 + 목표까지 회전각/거리 계산
  class_features.json           -- 클래스별 CLIP 특징/게이트 설정(door/pedestal/person)
  try1/                         -- 실행 결과물이 저장되는 디렉터리(최초 실행 시 생성됨, git에는 없음)

datasets/
  20260910-134818_rot8/         -- 8방향(0/45/.../315도) 회전 스캔 프레임 8장
  25300.png, 25300_gt.png       -- 도면 이미지(및 GT 검증용)
  25301.jpg                     -- door class_features.json의 참조 이미지 원본
  pedestal_reference.jpg        -- pedestal 참조 이미지
  person_reference.jpg          -- person 참조 이미지

research/oln_training/yolo_weights/
  yolov8n.pt                    -- RPN(후보 제안)용
  yolov8s-worldv2.pt            -- YOLO-World(OVD) provider용
  FastSAM-s.pt                  -- FastSAM(segmentation) provider용

models/openvocab/clip-vit-base-patch32/onnx/
  vision_model_quantized.onnx
  text_model_quantized.onnx     -- CLIP(quantized ONNX) dictionary provider용

requirements-freeze.txt         -- 원본 개발 환경의 전체 pip freeze(Python 3.14.4 기준)
```

이 구조를 그대로 유지해야 합니다 -- 코드가 `Path(__file__).resolve().parents[2]`로
레포 루트를 찾아 위 경로들을 상대경로로 참조합니다.

## 요구 사항

- **NVIDIA GPU + CUDA 드라이버 필수** -- 모든 모델이 `device="cuda"`로 하드코딩돼
  있습니다(CPU 전용 환경에서는 코드 수정 없이 동작하지 않습니다).
- Python 3.14 (원본 개발 환경 기준. 다른 3.x에서도 대부분 동작하겠지만 검증되지 않음)
- 최초 실행 시 인터넷 연결 필요(아래 "최초 실행 시 자동 다운로드" 참고)

## 설치

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements-freeze.txt

# UniDepth는 PyPI에 없는 별도 오픈소스 저장소(editable install)이므로 따로 설치합니다.
# (CC BY-NC 4.0 라이선스 -- 비상업적 용도로만 사용 가능, 라이선스 원문 확인 필요)
pip install -e "git+https://github.com/lpiccinelli-eth/UniDepth.git@8d8cfe4c7ee15297099983607febf0d4f32eb3d6#egg=unidepth"
```

`requirements-freeze.txt`는 이 데모뿐 아니라 원본 연구용 venv 전체의 스냅샷이라
이 데모에 불필요한 패키지도 일부 섞여 있습니다(원본 환경 그대로 재현하는 쪽이
버전 충돌 없이 안전하다고 판단해 그대로 포함했습니다). 이 데모가 직접 import하는
핵심 패키지만 추리면: `opencv-python`, `numpy`, `onnxruntime-gpu`, `torch`,
`tokenizers`, `transformers`, `ultralytics`, `unidepth`(위 별도 설치) 입니다.

`torch==2.14.0`과 `nvidia-*-cu13` 패키지들이 기본 PyPI 인덱스에서 안 잡히면
https://pytorch.org 에서 사용 중인 CUDA 버전에 맞는 설치 명령을 확인하세요.

### 최초 실행 시 자동 다운로드(HuggingFace Hub)

아래 두 모델은 로컬에 없으면 최초 실행 시 자동으로 다운로드되어 캐시됩니다
(레포에는 포함돼 있지 않음, 인터넷 필요):

- `IDEA-Research/grounding-dino-tiny` (OVD provider)
- `lpiccinelli/unidepth-v2-vitb14` (자기 위치 추정용 depth)

## 실행

```bash
cd demo/test
python3 mock_stream_receiver.py
```

`target_class`는 `mock_stream_receiver.py` 안에 `"door"`로 하드코딩돼 있습니다
(바꾸려면 `class_features.json`에 해당 클래스 설정이 있어야 합니다 -- 지금은
door/pedestal/person 3개만 등록돼 있습니다).

실행 결과는 `demo/test/try1/` 아래에 프레임별 원본/오버레이 이미지, 클래스별
증거(evidence.json), 자기위치추정(`localization/`), 최종 이동 지시
(`navigation/`)가 저장됩니다.

## 로봇·관제 웹 연동 (시연 경로)

```
로봇 라즈베리파이(pi7)                     이 PC                          관제 웹(브라우저)
  MQTT broker :9001  ──프레임+회전각──▶  mqtt_stream_receiver.py
                                              │ try1/ 산출
                                              ▼
                                        detect_api_server.py  ◀──GET 폴링──  화면
```

둘 다 **테일스케일 테일넷 위**에서 통신합니다. 이 PC가 로봇과 같은 테일넷에
있어야 `pi7.tailcb6bfb.ts.net` 이름이 풀립니다.

```bash
# 0) 로봇과 같은 테일넷에 로그인 (브라우저에서 계정 인증)
sudo tailscale logout          # 다른 테일넷에 붙어 있다면
sudo tailscale up              # 출력된 URL을 브라우저로 열어 로그인
tailscale status | grep pi7    # 로봇이 보이는지 확인

# 1) 브로커에 무엇이 흐르는지 확인(선택)
cd demo/test && python3 mqtt_stream_receiver.py --sniff

# 2) 프레임 수신 + 파이프라인 -- 로봇이 스캔을 돌리면 자동으로 경로까지 산출
python3 mqtt_stream_receiver.py --target door

# 3) 관제 웹용 HTTP 창구(별도 터미널). torch 없이도 뜹니다
python3 detect_api_server.py --port 8000
```

추가 패키지: `pip install "paho-mqtt>=2.0"` (수신기 전용. 창구 서버는 표준
라이브러리만 씁니다.)

로봇 쪽 전송 규약은 [`detection-protocol_0914.md`](detection-protocol_0914.md)가
기준입니다 — `zoneA/robot/go1-001/frame`(방향마다 1건, JSON+base64) 과
`zoneA/robot/go1-001/scan`(판의 시작·끝)을 구독합니다. 카메라가 얼어 같은 그림이
섞인 판은 **통째로 버리고** 다시 스캔하도록 안내합니다(문 방향이 통째로 틀어지기
때문). 산출된 이동 지시는 `try1/navigation/evidence.json`의 `robot_command`에
로봇 명령 어휘(`turn { deg }`, `move_forward { distance_m }`) 그대로 들어 있습니다.

관제 웹에 알려 줄 주소는 이 PC의 MagicDNS 이름입니다 —
`http://$(hostname).<테일넷>.ts.net:8000`. 창구 목록과 응답 모양은
[`탐지_연동스키마_260912.md`](탐지_연동스키마_260912.md) §1을 그대로 따릅니다
(`/health`, `/detect/localization`, `/detect/results`, `/detect/evidence`,
`/detect/path`, `/detect/features`, `/detect/frame`, `/detect/path_overlay`,
`/detect/map`). 아직 산출되지 않은 것은 이유를 본문에 담은 404로 응답합니다.

## 라이선스 참고

- YOLO 계열 가중치(`yolov8n.pt`, `yolov8s-worldv2.pt`, `FastSAM-s.pt`)는
  Ultralytics(AGPL-3.0) 배포 가중치입니다.
- UniDepth는 CC BY-NC 4.0(비상업적 용도)이며 이 레포에는 소스를 포함하지 않고
  설치 방법만 안내합니다.
- 이 레포 자체의 코드(demo/test/*.py)와 CLIP 특징 설정(class_features.json)은
  원본 프로젝트 저장소에서 이 PoC만 추출한 것입니다.
