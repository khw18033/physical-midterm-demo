"""Phase 0 검증 스크립트: contracts/*.schema.json 예시 인스턴스가 스키마를 통과하는지 확인.

규약:
  contracts/<name>.schema.json  <-  contracts/examples/<name>/*.json
  파일명이 "valid-"로 시작하면 통과해야 하고, "invalid-"로 시작하면 거부되어야 한다.

사용법: python contracts/validate_examples.py
"""
import json
import sys
from pathlib import Path

import jsonschema

CONTRACTS_DIR = Path(__file__).parent
EXAMPLES_DIR = CONTRACTS_DIR / "examples"
SCHEMA_SUFFIX = ".schema.json"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def expectation_for(example_path: Path) -> bool:
    name = example_path.name
    if name.startswith("valid-"):
        return True
    if name.startswith("invalid-"):
        return False
    raise ValueError(
        f"{example_path}: 예시 파일명은 'valid-' 또는 'invalid-'로 시작해야 합니다."
    )


def main() -> int:
    schema_paths = sorted(CONTRACTS_DIR.glob(f"*{SCHEMA_SUFFIX}"))
    if not schema_paths:
        print(f"검증할 스키마가 없습니다: {CONTRACTS_DIR}")
        return 1

    checked = 0
    failures = 0

    for schema_path in schema_paths:
        schema_name = schema_path.name[: -len(SCHEMA_SUFFIX)]
        schema = load_json(schema_path)
        validator = jsonschema.Draft202012Validator(schema)

        example_dir = EXAMPLES_DIR / schema_name
        example_paths = sorted(example_dir.glob("*.json")) if example_dir.is_dir() else []

        print(f"\n== {schema_path.name} ({len(example_paths)} example(s)) ==")
        if not example_paths:
            print(f"  [WARN] 예시가 없습니다: {example_dir}")
            failures += 1
            continue

        for example_path in example_paths:
            expect_valid = expectation_for(example_path)
            errors = sorted(validator.iter_errors(load_json(example_path)), key=str)
            is_valid = not errors
            passed = is_valid == expect_valid
            checked += 1

            print(f"  [{'OK' if passed else 'FAIL'}] {example_path.name} "
                  f"(expected_valid={expect_valid}, actual_valid={is_valid})")
            if not passed:
                failures += 1
                for error in errors:
                    location = "/".join(str(p) for p in error.absolute_path) or "<root>"
                    print(f"      - {location}: {error.message}")

    print(f"\n{checked} example(s) checked, {failures} failure(s).")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
