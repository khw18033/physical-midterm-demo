# -*- coding: utf-8 -*-
"""JSON 인스턴스 하나를 스키마 하나로 검증한다.

`validate_examples.py`가 예시 디렉터리 전체를 도는 것과 달리, 이쪽은 **생성된 인스턴스
하나**를 검사한다. 편집기 초안을 직렬화한 계약 JSON이 실제로 계약을 통과하는지
회귀 스크립트에서 확인하기 위한 것이다 (REQ-1002).

검증기는 `validate_examples.py`와 같다 — jsonschema Draft202012Validator에
`contracts/*.schema.json`을 그대로 먹인다. 여기서 다른 검증기를 쓰면 "계약을 통과했다"는
말의 뜻이 두 갈래가 된다.

사용법:
    python contracts/validate_instance.py <schema-name> <instance.json>
    예) python contracts/validate_instance.py pipeline out.json

종료 코드 0 = 통과, 1 = 거부(사유를 표준출력에 적는다), 2 = 사용법/입력 오류.
"""
import json
import sys
from pathlib import Path

import jsonschema

CONTRACTS_DIR = Path(__file__).parent


def main(argv) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2

    schema_path = CONTRACTS_DIR / (argv[1] + ".schema.json")
    instance_path = Path(argv[2])
    if not schema_path.is_file():
        print("스키마가 없습니다: %s" % schema_path)
        return 2
    if not instance_path.is_file():
        print("인스턴스가 없습니다: %s" % instance_path)
        return 2

    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    instance = json.loads(instance_path.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(instance), key=str)

    if not errors:
        print("OK %s (%s)" % (instance_path.name, schema_path.name))
        return 0

    print("REJECTED %s (%s) — %d건" % (instance_path.name, schema_path.name, len(errors)))
    for error in errors:
        location = "/".join(str(p) for p in error.absolute_path) or "<root>"
        print("  - %s: %s" % (location, error.message))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
