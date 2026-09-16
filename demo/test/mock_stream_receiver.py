"""demo/test/mock_stream_receiver.py

implements: 사용자 지시 -- "프레임과 명령 수신 시뮬레이션 코드. 하드웨어 파트에서
프레임과 각도(오른쪽 방향 회전으로 45도씩 360도 회전으로 총 8장만 순차적으로 올
예정). 클래스를 찾으라는 명령과 그 클래스 앞까지 가라는 명령은 가시화 파트에서
받을 예정. 이후에 바로 통합 가능하도록 수신 모방 코드를 작성"

이 파일은 실제 하드웨어 파트(프레임+회전각 스트림)와 가시화 파트(명령 스트림)를
아직 연결할 수 없는 지금 시점에, 그 두 입력을 흉내 내는 모의(mock) 수신기다.
나중에 실제 연결로 바꿀 때는 이 파일만 실제 수신 코드(예: MQTT 구독, 소켓 등)로
교체하면 되고, class_finder_service/navigate_to_target_service는 손댈 필요가
없도록 메시지 타입(ClassDiscoveryCommand/FrameMessage/GoToClassCommand)과 처리
함수 시그니처를 실제 통합 시점의 인터페이스로 미리 맞춰뒀다.

수신 순서(사용자 지시 그대로): 클래스 발견 명령 -> 프레임 8장(순차, 지연 있음)
-> 그 클래스 앞까지 가라는 명령.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATASET_DIR = REPO_ROOT / "datasets" / "20260910-134818_rot8"

# 8프레임 실제 파일명 + 회전각. 2026-09-10 사용자 지적으로 수정: 이전에는
# "150프레임=360도 등속 회전"이라는 가정으로 프레임 인덱스(1,20,39,...)를
# 역산해 45.6/91.2/134.4도 같은 값을 썼는데, 실제 촬영은 정확히 45도씩
# 회전하며 찍은 것이므로 0/45/90/135/180/225/270/315의 정확한 배수를 쓴다 --
# 두 서비스가 같은 값을 공유해야 하므로 숫자를 여기 한 곳에만 두고 다른
# 모듈은 이 값을 그대로 참조한다.
ROTATION_FRAMES = [
    ("frame_000001.jpg", 0.0),
    ("frame_000020.jpg", 45.0),
    ("frame_000039.jpg", 90.0),
    ("frame_000057.jpg", 135.0),
    ("frame_000076.jpg", 180.0),
    ("frame_000095.jpg", 225.0),
    ("frame_000113.jpg", 270.0),
    ("frame_000132.jpg", 315.0),
]

# 실제처럼 넣는 지연(가정치, 실측 아님 -- 로봇이 45도 회전하고 프레임을 캡처+전송
# 하는 데 걸리는 시간을 대략 잡은 값). 명령(가시화 파트)은 물리적 이동이 없는
# 가벼운 메시지라 프레임보다 훨씬 짧은 지연을 가정했다.
FRAME_INTERVAL_SEC = 1.5
COMMAND_LATENCY_SEC = 0.2


@dataclass
class ClassDiscoveryCommand:
    """가시화 파트 -> AI: "이 클래스를 찾아라" 명령."""
    target_class: str


@dataclass
class FrameMessage:
    """하드웨어 파트 -> AI: 프레임 1장 + 그 프레임을 찍은 시점의 회전각."""
    frame_index: int  # 0~7 (8장 중 몇 번째)
    frame_path: Path
    rotation_deg: float


@dataclass
class GoToClassCommand:
    """가시화 파트 -> AI: "그 클래스 앞까지 가라" 명령."""
    target_class: str


def simulate_incoming_messages(target_class: str):
    """실제 수신을 흉내 낸 제너레이터 -- 호출부는 이 함수만 실제 수신 루프로
    바꾸면 나머지(class_finder_service/navigate_to_target_service)는 그대로 쓸 수
    있다. yield마다 실제처럼 지연을 넣는다."""
    time.sleep(COMMAND_LATENCY_SEC)
    yield ClassDiscoveryCommand(target_class=target_class)

    for i, (fname, angle) in enumerate(ROTATION_FRAMES):
        time.sleep(FRAME_INTERVAL_SEC)
        yield FrameMessage(frame_index=i, frame_path=DATASET_DIR / fname, rotation_deg=angle)

    time.sleep(COMMAND_LATENCY_SEC)
    yield GoToClassCommand(target_class=target_class)


def main() -> None:
    """전체 흐름 오케스트레이션: 이 모의 스트림이 실제 스트림으로 바뀌어도
    이 main()의 구조(메시지 타입별로 분기해서 서비스에 넘김)는 그대로 유지된다.

    2026-09-10 재구성(사용자 지시): "어떤 명령이 오든 로봇은 환경 탐색을 위해
    한바퀴 돌며 8프레임을 찍도록 할거고... door와 pedestal는 로봇이 본인 위치
    추정하기 위해 자동으로 먼저 계산하도록 하고 위치가 나오면 이제 명령을
    수행하는거지." -- 그래서 8번째(마지막) FrameMessage 처리 직후, 원래
    명령이 class-discovery였든 go-to-class였든 상관없이 항상 먼저
    navigator.localize()를 실행한다. class_finder_service도 이제 매 프레임
    LOCALIZATION_CLASSES(door, pedestal) + 실제 요청 클래스를 함께 찾는다."""
    import class_finder_service
    import navigate_to_target_service

    target_class = "door"
    finder = class_finder_service.ClassFinderService()
    navigator = navigate_to_target_service.NavigateToTargetService()
    localization_result = None

    print(f"[mock_stream] 시뮬레이션 시작: target_class={target_class}")
    for msg in simulate_incoming_messages(target_class):
        if isinstance(msg, ClassDiscoveryCommand):
            print(f"[mock_stream] 수신: ClassDiscoveryCommand({msg.target_class})")
            finder.on_class_discovery_command(msg.target_class)
        elif isinstance(msg, FrameMessage):
            print(f"[mock_stream] 수신: FrameMessage(#{msg.frame_index}, "
                  f"{msg.frame_path.name}, {msg.rotation_deg}도)")
            finder.on_frame(msg.frame_path, msg.rotation_deg, msg.frame_index)
            if msg.frame_index == len(ROTATION_FRAMES) - 1:
                # 8프레임 완료 -- 명령 종류와 무관하게 자기 위치 추정을 먼저 실행.
                print("[mock_stream] 8프레임 완료 -- 자기 위치 추정(door+pedestal 랜드마크) 먼저 실행")
                localization_result = navigator.localize(finder.get_detections(), target_class=target_class)
                # "지정 클래스 탐색" 명령 자체의 결과 보고 -- go-to-class가 뒤따르지
                # 않아도 이 시점에 target_class의 8프레임 관측 요약은 항상 남긴다.
                navigator.save_target_observation_summary(target_class, finder.get_detections(), localization_result)
        elif isinstance(msg, GoToClassCommand):
            print(f"[mock_stream] 수신: GoToClassCommand({msg.target_class})")
            navigator.on_go_to_class_command(msg.target_class, finder.get_detections(), localization_result)
    print("[mock_stream] 시뮬레이션 종료")


if __name__ == "__main__":
    main()
