"""YOLOv8n을 gray box 한 클래스로 미세조정 (2026-10-27).

시작 가중치는 저장소의 RPN과 같은 research/oln_training/yolo_weights/yolov8n.pt(COCO 사전학습).
imgsz 256: 입력 crop이 237x241이라 그보다 크게 키울 이유가 없다(32의 배수 중 가장 가까운 값).
workers=0: Windows에서 dataloader 다중 프로세스가 느리거나 멈추는 경우가 있어 끈다.
"""
import sys
from pathlib import Path

from ultralytics import YOLO

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
EPOCHS = int(sys.argv[1]) if len(sys.argv) > 1 else 60
NAME = sys.argv[2] if len(sys.argv) > 2 else "yolov8n_graybox"
# 2026-11-01 v3: box_meter 실측 사진에서 200cm(박스 높이 ~27px)를 못 잡았다. 학습 라벨이 높이 65px 이상뿐이라
# (build_dataset.py ⑤) 작은 박스를 본 적이 없어서다 -- 크기 변형 범위를 기본 0.5(0.5~1.5배)에서 넓혀
# 같은 라벨로 작은 박스를 만들어 학습한다. box_meter 사진은 시험용으로만 남기고 학습에 넣지 않는다.
SCALE = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5

model = YOLO(str(REPO / "research" / "oln_training" / "yolo_weights" / "yolov8n.pt"))
model.train(data=str(HERE / "dataset" / "data.yaml"), imgsz=256, epochs=EPOCHS, batch=32, device=0,
            workers=0, project=str(HERE / "runs"), name=NAME, exist_ok=True, seed=0,
            deterministic=True, plots=True, verbose=False, scale=SCALE)
