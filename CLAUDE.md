# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

이 저장소의 README, 코드 주석, 산출 JSON은 모두 한국어로 작성돼 있다. 새 코드/주석도 같은 언어와 서술 방식(“무엇을 왜 이렇게 했는지 + 실측 근거 날짜”)을 유지한다.

## 명령

```bash
# 설치 (README 참고 -- UniDepth는 PyPI에 없어 별도 설치 필요)
python3 -m venv venv && source venv/bin/activate
pip install -r requirements-freeze.txt
pip install -e "git+https://github.com/lpiccinelli-eth/UniDepth.git@8d8cfe4c7ee15297099983607febf0d4f32eb3d6#egg=unidepth"

# 전체 파이프라인 실행 -- 진입점 두 개 중 하나를 고른다
cd demo/test
python3 mock_stream_receiver.py            # 오프라인: datasets/의 8프레임 재생
python3 mqtt_stream_receiver.py --sniff    # 실연동 전 확인: 로봇 브로커 토픽 구경
python3 mqtt_stream_receiver.py            # 실연동: 로봇 MQTT(WebSocket) 수신
python3 detect_api_server.py --port 8000   # 관제 웹용 HTTP 창구(별도 터미널)
```

- **테스트/린트 설정이 없다.** 검증 수단은 파이프라인을 돌리고 `demo/test/try1/` 아래 산출물(프레임별 `evidence.json`, 오버레이 이미지, `localization/`, `navigation/`)을 직접 확인하는 것뿐이다. `try1`은 고정 이름이라 재실행하면 덮어쓴다 — 이전 결과를 비교하려면 실행 전에 따로 복사해 두거나 `RUN_DIR`을 바꾼다(두 서비스 파일 모두에서).
- **빠른 반복**: 8프레임 전체는 프레임당 수 초(사전 CLIP provider가 1.3~1.8초) + `FRAME_INTERVAL_SEC=1.5` 지연이 걸린다. 일부만 돌리려면 [mock_stream_receiver.py:34](demo/test/mock_stream_receiver.py#L34)의 `ROTATION_FRAMES`를 줄이고 `FRAME_INTERVAL_SEC`를 0으로 둔다. 단 프레임을 줄이면 위치 추정에 쓰이는 pedestal 관측이 사라져 `localize()`가 실패할 수 있다.
- `target_class`는 [mock_stream_receiver.py:101](demo/test/mock_stream_receiver.py#L101)에 하드코딩돼 있고, `class_features.json`에 등록된 클래스(door/pedestal/person)만 쓸 수 있다.

## 실행 전 확인해야 하는 것

- 모든 모델이 `device="cuda"` 하드코딩이다. **GPU 없이는 코드 수정 없이 동작하지 않는다** — 2026-09-14 작업 PC에 NVIDIA GPU가 없어 파이프라인 실물 구동을 못 했고, 지금까지 검증된 것은 입출력 계층(MQTT 수신기·HTTP 창구)뿐이다. 자세한 건 [이관메모_260914.md](이관메모_260914.md).
- `python3.14 -m venv`에 pip이 안 들어가는 환경이 있다(`ensurepip` 부재). 그때는 `curl -sS https://bootstrap.pypa.io/get-pip.py | venv/bin/python`으로 우회한다.
- MQTT 수신기는 `paho-mqtt>=2.0`이 따로 필요하다(`requirements-freeze.txt`에 없음).
- 첫 실행 시 `IDEA-Research/grounding-dino-tiny`, `lpiccinelli/unidepth-v2-vitb14`를 HF Hub에서 자동 다운로드한다(인터넷 필요).
- 두 서비스 파일 맨 위의 `ctypes.CDLL` 루프는 venv의 `nvidia/cu13`·`cudnn` `.so`를 전역 로드해 torch/onnxruntime-gpu 심볼 충돌을 피하는 우회다. **반드시 `import torch`/`onnxruntime`보다 먼저 실행돼야 하므로 import 순서를 정리하지 말 것.**
- 경로는 전부 `Path(__file__).resolve().parents[2]`(=저장소 루트) 기준 상대경로다. 디렉터리 구조를 옮기면 깨진다.

## 아키텍처

코드는 `demo/test/`에 있고, 역할 경계가 “실제 하드웨어/가시화 파트와 통합할 때 갈아끼울 지점”에 맞춰져 있다. 파이프라인 본체 2개(`class_finder_service`/`navigate_to_target_service`)는 **입력원과 출력창구가 바뀌어도 건드리지 않는다** — 그래서 진입점이 둘(mock/mqtt), 창구가 하나(api server) 붙어 있다.

### 1. `mock_stream_receiver.py` / `mqtt_stream_receiver.py` — 교체 가능한 입력 경계
둘은 **입력원만 다르고 오케스트레이션이 같다**(명령/스캔 → 8프레임 → 위치추정 → 관측요약 → 경로). mock은 `datasets/`를 재생하고, mqtt는 로봇(`ws://pi7.tailcb6bfb.ts.net:9001/mqtt`)에서 받는다. 메시지 타입(`ClassDiscoveryCommand`/`FrameMessage`/`GoToClassCommand`)과 서비스 함수 시그니처를 미리 맞춰 둔 덕분에 서비스 쪽은 그대로다. 8프레임의 회전각(0/45/…/315)은 mock의 `ROTATION_FRAMES` 한 곳에만 두고 다른 모듈은 메시지로 받아 쓴다 — 각도를 다른 곳에 다시 적지 말 것.

mqtt 쪽만의 전제 셋 — 규약의 authoritative 출처는 로봇 쪽에서 받은 `detection-protocol_0914.md`다:
- **관제 웹은 명령을 보내지 않는다**(연동 스키마 §1: GET only). 그래서 go-to-class 명령을 기다리지 않고 판이 정상 종료되면 경로 산출까지 자동으로 끝낸다.
- **판(scan round) 단위로 돈다.** `zoneA/robot/go1-001/scan`의 `scan_start`/`scan_end`와 `mission_id`가 경계고, `zoneA/robot/go1-001/frame`이 방향마다 1건씩 온다(QoS 1, JSON + base64 `image` + `rotation_deg`). 새 판이 시작되면 `ScanSession.start()`가 이전 판 산출물을 지우고 탐지 누적·depth 캐시를 초기화한다 — 안 지우면 버린 판의 결과가 관제 웹 화면에 남는다. scan 이벤트가 유실돼도 프레임 수를 채우면 끝낸다.
- **중복 그림이 섞인 판은 통째로 버린다.** Go1 카메라는 얼어붙어도 계속 내보내서 그림만 멈춘다. 로봇이 `duplicate_of_prev`를 붙여 주고, 우리도 판 안의 sha1을 따로 모아 건너뛴 중복까지 잡는다(로봇은 직전 한 장하고만 견준다). 같은 사진 8장을 8방향으로 오해하면 문 방향이 통째로 틀어지므로 **이 검사를 완화하면 안 된다.**

`yaw_deg`는 판마다 기준점이 옮겨져서 방향 계산에 쓸 수 없다 — 그래서 `ROTATION_KEYS`에서 일부러 뺐다. 각도는 언제나 `rotation_deg`다.

흐름: 명령 수신 → 프레임 8장 → **마지막 프레임 직후 명령 종류와 무관하게 항상 `navigator.localize()` 먼저 실행** → 그 다음에야 go-to-class 처리. “로봇은 어떤 명령이든 먼저 한 바퀴 돌아 자기 위치를 추정한다”는 설계가 여기 분기 구조로 표현돼 있다.

### 2. `class_finder_service.py` — 4-provider 증거 융합
같은 프레임을 4개 독립 provider가 분석하고, 그 결과를 사용자의 논문(*Progressive Digital Twin Object Record Construction…*) Eq 1–13으로 통합한다. 파일 안의 섹션 구분선이 곧 이 구조다.

- provider: `DictionaryProvider`(YOLOv8n RPN 후보 → CLIP + 클래스별 게이트), `GroundingDinoProvider`, `YoloWorldProvider`(둘 다 OVD), `FastSamProvider`(마스크 전용, 의미 투표 불참). 프레임당 각 1회 호출하며 **실측 처리시간을 증거의 완료시각으로 쓴다**(가정치 아님).
- `EvidenceEvent`(Eq 1) → `MultiObjectProgressiveResolver`(Eq 2, IoU 0.30 **OR** containment 0.7로 연계 — 스케일 차 큰 같은 물체를 묶기 위한 확장) → `_resolve_geometry`(Eq 5-6) / `_resolve_semantic`(Eq 7-8) / `_resolve_lifecycle`(Eq 9) → `ProgressiveResolver`(Eq 10-13, “보이는 상태”가 바뀔 때만 레코드 갱신).
- 확정 기준은 점수 임계값이 아니라 **서로 다른 provider 2개 이상의 동의**(`CONFIRM_MIN_DISTINCT_GROUPS`). 단 door/pedestal처럼 위치 추정에 쓰이는 랜드마크는 **`dictionary`(CLIP) 게이트의 동의가 필수**다(`required_source`) — OVD 둘이 같은 오탐을 공유해 위치 추정이 깨진 실측 사례 때문에 추가된 규칙이라 완화하면 그 회귀가 되살아난다.
- `consolidate()`는 증거 도착 순서 때문에 갈라진 클러스터를 관측 종료 시 최종 기하로 다시 병합한다.
- 클래스별 게이트(색/모양/참조이미지/채도/종횡비)는 `class_features.json`에 데이터로만 존재하고 `_dictionary_gate_and_score`가 해석한다. **새 클래스 추가나 오탐 튜닝은 코드가 아니라 이 JSON에서 한다** — 각 항목의 `rationale`에 실측 튜닝 이력이 남아 있다.
- 2026-09-14 door 완화(조명·각도 대응, `research/door_gate_relax/RESULT.md`): 참조이미지 게이트 제외, 색·모양은 "1등"이 아니라 `color_gate_tolerance` / `shape_gate.tolerance` 차이 이내면 통과, 채도 75·target_sim 0.25. **`grounding_dino_evidence`(door만: 라벨 정확히 door + 점수≥0.25)는 이 완화의 전제다** — 빼면 "door pedestal" 섞인 라벨·저점수 박스가 문 증거로 들어와 rot8 오탐이 되살아난다. 전역 GDINO 임계값을 올리면 단상(0.17~0.24)이 사라지므로 클래스별로만 건다. 원본은 `research/door_gate_relax/backup_260914/`.
- 2026-09-15 door 강화(단상·사람 다리 오탐 대응, `research/door_gate_harden/RESULT.md`): 두 규칙을 더했다. ① `confirm_pair_iou_min`(0.42) — CONFIRMED가 되려면 사전(CLIP) 박스와 OVD 박스 중 가장 잘 맞는 한 쌍의 IoU가 기준 이상이어야 한다(`_dictionary_ovd_pair_iou` → `_resolve_lifecycle`, 값은 `evidence_trail`의 `dictionary_ovd_iou`). 오탐은 전부 작은 CLIP 조각(창문·짙은 옷)이 GDINO의 큰 단상·사람 박스 안에 containment로만 묶여 "2개 동의"가 된 경우였다. **containment 연계 자체는 끄지 말 것**(같은 물체 부위 증거를 못 묶어 오탐이 오히려 남는다). ② `hue_gate`(crop 색상 H 중앙값 85~112) — 짝 IoU로 못 막는 "CLIP·GDINO가 같은 다리를 함께 잡은" 경우용. 둘 다 door에만 걸려 있고 pedestal은 그대로다. 원본은 `research/door_gate_harden/backup_260915/`.

### 3. `navigate_to_target_service.py` — 위치 추정 + 경로
3단계로 나뉜다: `localize()`(항상 먼저) → `resolve_target_position()` → `on_go_to_class_command()`. depth는 UniDepthV2, cm 환산은 사용자가 로봇으로 직접 재서 만든 3차 보정식(`calibrate_depth_to_cm`)이다.

모듈 docstring의 **“정직한 한계”** 절이 이 파일의 핵심 계약이다: 위치 추정은 일반 삼변측량이 아니라 이번 시연 환경 특유의 기하 가정이고, 문 위치는 검출값이 아니라 GT 고정값(`DOOR_PX`)이며, 구할 수 없는 값은 임의 추정하지 않고 `position_cm=None` + `reason`으로 보고한다. **이 “못 구하면 정직하게 실패” 원칙을 추정값으로 메우는 방향으로 바꾸지 말 것.**

회전각은 `rotation_deg`(45도 8단계)만으로 계산하면 지시각이 항상 45의 배수로 나오는 구조적 결함이 있어서, 랜드마크는 `_bearing_offset_deg`(박스 중심의 화면 중앙 대비 픽셀 오프셋을 UniDepth 추정 `fx`,`cx`로 각도 환산)로 얻은 연속값을 우선 쓴다(`bearing_refinement`).

### 4. `detect_api_server.py` — 관제 웹이 가져가는 출력 창구
`try1/`을 **읽기만** 하는 얇은 어댑터다. 표준 라이브러리만 쓰므로 ML 환경 없이도(파이프라인이 죽어도) 뜬다. 밀어 주지 않고 열어만 두며(브라우저는 수신을 못 한다), 매 요청마다 디스크를 다시 훑어서 각도가 끝날 때마다 배열이 하나씩 느는 모양이 된다 — **캐시하지 말 것.**

**응답 모양의 authoritative 출처는 `탐지_연동스키마_260912.md` §1이다.** 내부 `evidence.json`과 모양이 다른 곳이 있으니(아래) 이 문서를 먼저 보고 맞춘다.

## 파일 간 지켜야 하는 계약

- **detections 딕셔너리**: `finder.get_detections()` → `{class: {rotation_deg: {frame, found, instances: [...]}}}`. `instances`는 지지 provider 수 내림차순 정렬이고 navigate 쪽 `_best_instance()`가 `instances[0]`을 대표값으로 쓰며 `box_xyxy`/`final_score` 키에 의존한다.
- **좌표계가 4겹이다.** frame 원본 px → `BORDER_CROP_BOX`로 잘라낸 px(검출 결과가 이 좌표계) → `INFER_SIZE`(320×240) depth px → 도면 px → 방 cm(`px_to_cm`/`cm_to_map_px`). `_measure_depth_cm`/`_bearing_offset_deg`가 이 환산을 담당하므로 박스를 넘길 때 어느 좌표계인지 항상 확인한다.
- **두 서비스에 중복 정의된 상수**: `RUN_DIR`(`demo/test/try1`), `BORDER_CROP_BOX`, 랜드마크 목록(`LOCALIZATION_CLASSES` ↔ `LANDMARK_MAP_POSITIONS_CM`). 한쪽만 고치면 조용히 어긋난다.
- **출력 디렉터리 레이아웃**도 계약이다. `class_finder_service.on_frame()`이 만드는 `try1/<frame_stem>/`(원본·RPN·확정 오버레이) + `try1/<frame_stem>/<class>/`(크롭·클래스 오버레이·evidence) 구조를 navigate 쪽 `_frame_image_paths()`가 문자열로 다시 조립해 JSON에 넣는다.
- `_send_to_device()`는 양쪽 파일에 있는 **의도된 빈 스텁**이다(MAC 주소 대상 전송은 프로토콜 미정). 호출 지점은 이미 다 박아 뒀으니 지우지 말고, 전송을 구현할 때 이 함수 본문만 채운다.
- `evidence.json`에는 최종값뿐 아니라 **수식(`formula`)과 대입 결과(`substituted`), 증거 도착 시각(ms), CLIP 게이트별 실측값**을 남기는 것이 요구사항이다. 새 계산을 추가하면 같은 형식으로 근거도 함께 남긴다. 관제 웹이 `path_calculation`의 문자열을 **그대로 화면에 네 줄로 그리므로** 형식을 바꾸면 저쪽 화면이 깨진다.
- **프레임 원본 출처는 명시로 정한다.** `navigate_to_target_service.FRAME_SOURCE_DIR`이 None이면 데이터셋 폴더, 실시간 수신이면 수신기가 `try1/incoming`으로 설정한다. 자동 추측을 넣지 말 것 — 로봇 프레임 이름이 `frame_000001.jpg`처럼 데이터셋 파일명과 겹쳐서 엉뚱한 이미지의 depth를 재게 된다. `try1/<stem>/original.jpg`는 JPEG 재인코딩본이라 마지막 대비책으로만 쓴다(픽셀이 미세하게 달라 depth가 흔들린다).
- **로봇 명령 어휘**(`detection-protocol_0914.md` §4): `navigation/evidence.json`의 `robot_command`가 `turn { deg }` + `move_forward { distance_m }` 그대로다. **`turn_deg`는 오른쪽이 +**(우리 `turn_amount_signed`와 부호 규약이 같다), `distance_m`에는 `standoff_cm`이 이미 빠져 있어 로봇이 또 빼면 안 되며, 허용 범위는 0.05~10m라 벗어나면 `distance_m_in_range: false` + `warning`으로 드러낸다. 로봇 명령 경로가 protobuf(`terminal/go1-001/downlink`)라 **우리는 발행하지 않는다** — `--publish-topic`을 줄 때만 JSON을 쏜다.
- **로봇 카메라는 464×400이다.** `status.media`의 `1280x720`은 아직 안 쓰는 별도 송출기 값이라 무시할 것. 실제 프레임이 데이터셋과 화소가 같아서 테두리 자르기(237×241)와 거리 보정식(`image_w=464`)이 그대로 적용된다.
- **API 응답과 내부 JSON이 이름이 다른 두 곳**(`detect_api_server.py`의 어댑터가 흡수한다): `final_score`는 화면에서 「특징 최고값」으로 쓰이므로 **CLIP 특징 유사도의 최댓값**을 내보낸다(내부 `final_score`는 지지 provider 신뢰도의 **합**이라 의미가 다르며 `fusion_confidence_sum`으로 따로 실린다). `mandatory_gates`는 내부 `clip_detail.gates`를 `color`→`color_gate` 식으로 이름만 바꾼 것이다.

## 성능상 알아둘 점

`_run_unidepth()`는 경로 단위 캐시(`self._depth_cache`)가 붙어 있다(2026-09-14, 관제 웹이 1.5초 주기로 폴링하는 실시간 연동 때문에 추가). 같은 프레임을 여러 단계에서 다시 재도 추론은 한 번이다 — 프레임 내용이 바뀌는데 경로가 같은 상황(같은 이름으로 덮어쓰기)에서는 캐시를 비워야 한다.

`sys.path.insert(REPO_ROOT / "research" / "oln_training")`([class_finder_service.py:83](demo/test/class_finder_service.py#L83))은 원본 저장소에서 넘어온 잔재다 — 현재 그 디렉터리에는 `yolo_weights/`만 있고 import되는 모듈은 없다.
