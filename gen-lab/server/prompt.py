"""프롬프트를 만드는 **유일한 자리** (`VZ-G-01` 베이스라인 · 지시서 §4).

## 왜 서비스가 만드는가

부르는 쪽이 프롬프트 문자열을 통째로 넘기게 하면, 같은 정답셋을 재는 두 사람이 서로 다른
프롬프트로 재고도 그 사실을 모른다. **측정의 조건이 코드에 있어야** 숫자가 비교된다.
부르는 쪽이 고르는 것은 **재료**다 — 장소 위상과 few-shot 예시. 그 둘을 어떻게 문장으로
펴는지는 여기 한 곳에 있다.

규칙을 켜고 끄는 것도 마찬가지로 여기 한 곳이다(`rules_for()`). 판이 하나 늘 때마다
프롬프트가 어디서 갈라지는지를 코드에서 한 번에 볼 수 있어야, 「B 와 D 는 한 가지만
다르다」가 주장이 아니라 확인이 된다.

## 부르는 쪽이 고르는 것 — few-shot 누출을 막는 자리

**채점 대상인 편은 예시에서 뺀다**(지시서 §4-3). 그 선택은 부르는 쪽이 한다 —
서비스는 어느 편이 채점 대상인지 모르기 때문이다. 뺐는지 검사하는 것이
`verify:no-leak` 이고, 이 파일은 **받은 예시를 그대로 싣기만 한다.**

## 기하를 읽지 않는다

좌표를 든 층(§1 에서 갈라 둔 기하 파일)을 여는 경로가 이 파일에도, gen-lab 어디에도
없다. 좌표를 보면 모델이 503호 전용이 된다.

`verify:places` 4번 검사가 `gen-lab/server/` 와 `src/generate/` 를 훑어 **그 파일 이름이
나오는지**를 본다 — 주석이라도 잡는다. 문자열은 언젠가 코드가 되기 때문이고, 그래서
여기서도 파일 이름을 적지 않고 「기하 파일」이라고만 쓴다. (3단계에 `verify:no-stt` 가
같은 이유로 `LlmClient` 의 주석을 잡았다.)
"""

from __future__ import annotations

import json
from typing import Any, Optional

#: 마일스톤이 지켜야 하는 것. **화면에도 보고서에도 이 문장 그대로 쓴다** —
#: 규칙을 두 벌로 적으면 모델이 지킨 규칙과 사람이 채점한 규칙이 갈라진다.
RULES = [
    "출력은 JSON 객체 하나다. 설명·주석·코드펜스를 붙이지 않는다.",
    # 첫 실측에서 4B 가 20건 전부 마일스톤 하나로 답했다 — 발화를 그대로 옮겨 적은 것이다.
    # 개수를 알려주지 않고 **할 일이 무엇인지**만 적는다. 개수를 주면 그것은 정답 누출이다.
    "마일스톤은 여러 개다. 임무를 **사람이 중간에 확인할 수 있는 단위**로 나눈다 — 발화 한 줄을 마일스톤 하나로 옮겨 적는 것은 분리가 아니다.",
    "마일스톤은 **무엇을 이루는가**를 적는다. 어떻게 이루는지는 적지 않는다.",
    "로봇 기종·모델명(예: 사족보행 로봇의 제품명)을 쓰지 않는다. 어떤 장비가 하는지는 assigned_targets 로만 적는다.",
    "좌표를 쓰지 않는다. (x, y, z) 나 절대 위치를 적으면 그 마일스톤은 이 건물 전용이 된다.",
    "속도·가속도·모터 파라미터를 쓰지 않는다. 그것은 실행이 정하는 값이다.",
    "임무 자체의 조건(시간·수위·거리 임계처럼 발화가 요구한 것)은 적어도 된다. 금지되는 것은 구현 파라미터다.",
    "장소는 아래 [장소] 목록에 있는 이름만 쓴다. 목록에 없는 방 번호·층·시설을 만들면 실패다.",
    "tasks 는 빈 배열 [] 로 둔다. 태스크 분해는 다음 단계가 한다.",
    "status 는 모두 \"pending\", order 는 0 부터 1 씩 는다.",
    "mission_id 와 utterance 는 아래 [요청] 에 준 값을 그대로 옮긴다.",
]

#: 장비 목록을 **줬을 때만** 붙는 규칙 (7단계). 장소 규칙 바로 뒤에 들어간다 — 그라운딩
#: 규칙 둘이 붙어 있어야 사람이 읽을 때 대칭이 보인다.
#:
#: **RULES 에 상수로 박지 않은 이유가 측정에 있다.** 목록을 안 주는 판(A)에서도 이 문장이
#: 붙어 있으면, 모델은 있지도 않은 [장비] 목록을 찾다가 없는 것을 확인하게 된다. 그때
#: 나온 숫자는 「목록이 없어서」가 아니라 「없는 목록을 가리켰기 때문」일 수 있고, 두 가지를
#: 가를 방법이 없다. 안 주는 판은 **규칙도 목록도 없이** 6단계와 같은 프롬프트로 돈다.
EQUIPMENT_RULE = "assigned_targets 에는 아래 [장비] 목록에 있는 id 만 쓴다. 목록에 없는 장비 id 를 만들면 실패다."

#: 단계의 **종류** 목록 (8단계 D 판). 개수가 아니다.
#:
#: 7단계 B 판의 실제 출력을 보면 이동 단계만 내고 감지·판정·보고를 빼먹는다 —
#: 「503호 출발 → 문으로 이동 → 복도로 이동 → 엘리베이터 도달」 넷을 내고 정답의
#: 「문 열림 확인」·「3 m 정지 판정」·「도착 보고」·「임무 종료」가 없다. 개수차 −1.40 이
#: 대부분 그 자리다. 지금 프롬프트는 「여러 개로 나눠라」만 말하고 **어떤 종류의 단계가
#: 있는지는 안 알려준다** — 장소 목록·장비 목록이 들었듯 단계 종류 목록도 들 수 있다.
NODE_KINDS = ["감지", "판단", "실행", "검증", "보고"]

#: 노드 문법을 **줬을 때만** 붙는 규칙. 분할 규칙(「마일스톤은 여러 개다」) 바로 뒤에
#: 들어간다 — 「어떻게 나누는가」를 말하는 두 문장이 붙어 있어야 사람이 읽을 때 이어진다.
#:
#: **개수를 주지 않는다.** 「다섯 개로 나눠라」는 정답 누출이고, 그렇게 읽히면 모델이
#: 의미 없는 단계를 만들어 개수만 맞춘다. 그때 개수 일치율은 오르는데 제목 유사도가
#: 떨어지므로 표에서 갈린다(8단계 §「읽는 법」 둘째 줄). 마지막 문장이 그 오독을 막는
#: 자리다 — 종류 목록이지 채워야 할 칸이 아니다.
#:
#: **RULES 에 상수로 박지 않은 이유는 EQUIPMENT_RULE 과 같다** — 켜고 끄는 것이
#: `rules_for()` 한 곳에서 정해져야 B 판과 D 판이 한 가지만 다르다.
#:
#: ## 실측 판정 — **채택하지 않았다. 기본은 꺼짐이다** (8단계 · 260907)
#:
#: 켜지 마라. 좋아 보이지만 재 봤고, 나빴다. 15건 실측에서 개수차는 −1.40 → −1.07 로
#: 0 에 가까워졌는데 **순서는 0.14 → 0.13 으로 내려갔고** 개수 일치는 33% 로 그대로였다.
#: 개수차 개선의 실체는 한 편(`MSN-260831-03`)의 빈 단계 채우기다 — 그 편의 제목 유사도는
#: 0.00(짝지어진 정답이 하나도 없다)인데 개수만 정답에 붙었고, 실제 출력은
#: 「수문 작동 상태 확인」이 세 번 반복된 다섯 줄이었다.
#:
#: 부작용 셋이 더 났다: 제목 중복 5% → 13% · 개수 흔들림 σ 0.40 → 0.62 ·
#: 장비 오선택 2 → 7(**7건 전부 부풀린 그 편**, 지어낸 감지 단계에 센서를 붙이느라).
#: 그리고 규칙 문구가 제목에 샜다 — 「503호 문으로 이동 (확인)」 5건. 출력 형식을
#: 요구하지 않았는데도 규칙 문장만으로 그렇게 됐다.
#:
#: **지우지 않고 꺼 둔다.** 대조군은 남아 있어야 다시 물을 수 있다
#: (`--no-grammar`·`--no-equipment`·`--no-examples` 와 같은 성질).
#: 자세한 것은 `reports/2026-09-07_마일스톤분리_8단계.md`.
NODE_KIND_RULE = (
    "임무는 보통 "
    + " · ".join(NODE_KINDS)
    + " 다섯 종류의 단계로 이뤄진다. 이동 단계만 늘어놓지 말고, "
    "확인하고 판정하고 보고하는 단계가 필요한지 살펴라. "
    "다섯 종류를 다 쓰라는 뜻이 아니다 — 그 임무에 실제로 필요한 것만 쓴다."
)


#: 태스크를 내게 하는 판 (10단계 E). **규칙 하나를 더하는 것이 아니라 갈아 끼운다** —
#: 기본 규칙 「tasks 는 빈 배열 [] 로 둔다」와 정면으로 부딪히기 때문이다. 둘을 같이 두면
#: 모델은 서로 반대되는 지시를 받고, 그때 나온 숫자는 어느 쪽을 따른 결과인지 못 가른다.
#:
#: ## 계약의 태스크는 **실행 모양**이라 규칙이 여럿 필요하다
#:
#: `task.schema.json` 의 required 는 실행이 채우는 자리를 여럿 들고 있다 —
#: `status`·`attempt`·`derived_from`·`action_items`·`evaluation`. 문법이 그것을 전부
#: 요구하므로, 못을 박아 두지 않으면 모델이 **실행이 정할 값을 지어낸다.** 마일스톤에
#: 이미 같은 규칙이 있다(「status 는 모두 pending, order 는 0 부터」) — 그 규칙을 태스크
#: 층으로 한 번 더 내리는 것이다.
#:
#: ## `deps` 는 모델이 만들지 않는다 (지시서 §5)
#:
#: **여기가 이 판에서 가장 중요한 줄이다.** 실행 전에는 worldTimeline 이 없어 병렬의
#: 근거가 없고, 근거 없이 `deps` 를 내게 하면 순환·고아 노드·엉뚱한 합류가 나온다.
#: 계약상 required 라 문법에서 뺄 수는 없으므로 **빈 배열로 내게 하고 규칙이 매단다**
#: (`src/generate/solveDeps.ts`). `utterance` 를 부르는 쪽 값으로 덮어쓰는 것과 같은
#: 모양이고, 덮어쓴 사실도 같은 자리에 남는다.
#:
#: ## 다섯 종류를 여기서는 적는다 — 8단계와 모순이 아니다
#:
#: 8단계 D 판은 「임무를 이 다섯 종류로 **나눠라**」였고, 그것이 빈 단계를 만들었다.
#: 여기는 나누라는 말이 아니라 **이미 낸 태스크에 라벨을 붙이라**는 말이다. 값도 계약의
#: enum 이라 문법이 다섯 중 하나로 강제한다 — 지어낼 수 없다. 그래도 D 판이 제목을
#: 오염시킨 전례가 있으므로 마지막 문장으로 한 번 못을 박는다.
TASK_RULES = [
    "각 마일스톤의 tasks 에 그 마일스톤을 이루는 태스크를 낸다. 태스크는 **한 번에 하나씩 실행되는 단위**다.",
    "task_id 는 임무 안에서 겹치지 않게 짓는다 (예: T-1, T-2 …).",
    "node_kind 는 반드시 적는다 — sense(관측·값을 받아 온다) · decide(판정·조건이 참인가) · act(구동·명령을 낸다) · verify(검증·구동 결과가 의도대로인가) · report(보고·기록하고 알린다) 중 하나다.",
    "target 은 그 태스크를 수행하는 [장비] 목록의 id 하나다. 장비가 필요 없는 태스크(임무 종료 처리 등)는 null 로 둔다 — 아무 장비나 적지 않는다.",
    "deps 는 **빈 배열 [] 로 둔다.** 태스크 사이의 순서는 다음 단계가 규칙으로 계산한다. 여기서 적으면 버려진다.",
    "status 는 \"pending\", attempt 는 1, derived_from 은 null, action_items 는 [], evaluation 은 null 로 둔다. 그 자리는 실행이 채운다.",
    "node_kind 는 그 자리에만 적는다. 제목에 「(감지)」·「(확인)」처럼 종류를 덧붙이지 않는다.",
]

#: 태스크를 안 낼 때의 규칙. `RULES` 안에 있고, 태스크 판에서는 위 목록으로 **갈린다.**
NO_TASK_RULE_PREFIX = "tasks 는 빈 배열"


#: 분기와 되풀이를 적게 하는 판 (분기와루프 3단계 G). **태스크 규칙 뒤에 붙는다** —
#: 마일스톤 층의 이야기지만 태스크를 낸 뒤에 읽어야 「무엇이 판정인가」가 이미 나와 있다.
#:
#: ## 마지막 줄이 이 규칙의 절반이다
#:
#: 8단계 D 판이 보인 것 — **새 자리를 열면 모델은 그 자리를 채운다.** 종류 목록을 주자
#: 그 종류의 이름을 붙인 빈 단계를 만들었다. 분기와 되풀이도 같은 위험이 있고, 그쪽이
#: 더 나쁘다: 빈 단계는 사람이 보면 알지만 **없어야 할 갈래는 그럴듯해 보인다.**
#:
#: 그래서 「없는 것이 정상이다」를 규칙으로 못박고, 채점이 **지어내기를 따로 센다.**
#: 정답셋 발화 15개에는 분기·되풀이 표지가 하나도 없으므로 거기서 나온 것은 전부 지어낸
#: 것이고, 그 숫자가 이 판의 채택 여부를 가르는 축이 된다.
BRANCH_RULES = [
    "발화가 **둘 중 하나를 고르라**고 할 때만 마일스톤을 갈래로 나눈다. 갈래인 마일스톤에는 branch 를 적는다 — from 은 판정한 마일스톤의 id, when 은 그 판정이 pass 일 때인지 fail 일 때인지다.",
    "같은 판정에서 갈라진 마일스톤들은 **둘 중 하나만** 실행된다. 둘 다 하는 것은 갈래가 아니므로 branch 를 적지 않는다.",
    "발화가 **되풀이**를 요구할 때만(「~할 때까지」·「반복」 같은 말) 그 마일스톤에 repeat_of 를 적는다 — to 는 돌아갈 마일스톤의 id, when 은 되돌아가는 조건이다.",
    "**발화가 요구하지 않았으면 branch 도 repeat_of 도 적지 않는다. 없는 것이 정상이다** — 지어내면 실패다.",
]

#: `RULES` 안에서 태스크 규칙 묶음의 마지막 줄. 그 뒤에 분기 규칙이 들어간다.
BRANCH_ANCHOR_PREFIX = "node_kind 는 그 자리에만 적는다"


def _insert_after(rules: list[str], prefix: str, rule: str) -> list[str]:
    """`prefix` 로 시작하는 규칙 **바로 뒤**에 한 줄을 끼운다.

    번호로 세지 않는다. 규칙이 하나 늘 때마다 다른 규칙의 자리가 밀리고, 그러면
    「장소 규칙 뒤」라고 적어 둔 주석이 조용히 거짓말을 한다.
    """
    at = next(index for index, existing in enumerate(rules) if existing.startswith(prefix)) + 1
    return [*rules[:at], rule, *rules[at:]]


def _replace_rule(rules: list[str], prefix: str, replacements: list[str]) -> list[str]:
    """`prefix` 로 시작하는 규칙 **하나를 여러 줄로 갈아 끼운다.**

    `_insert_after` 와 갈라 둔 이유가 있다. 더하는 것과 갈아 끼우는 것은 다른 일이고,
    갈아 끼워야 하는 자리를 더하기로 처리하면 **서로 반대되는 지시 둘**이 프롬프트에
    남는다. 그때 나온 숫자는 어느 쪽을 따른 결과인지 못 가른다.
    """
    at = next(index for index, existing in enumerate(rules) if existing.startswith(prefix))
    return [*rules[:at], *replacements, *rules[at + 1:]]


def rules_for(
    equipment: Any = None,
    node_kinds: bool = False,
    tasks: bool = False,
    branch: bool = False,
) -> list[str]:
    """이 요청에 실제로 적용되는 규칙. **화면에도 보고서에도 이 목록 그대로 쓴다.**

    규칙을 두 벌로 적으면 모델이 지킨 규칙과 사람이 채점한 규칙이 갈라진다 — 그래서
    「어느 판에 어느 규칙이 붙었는가」도 여기 한 곳에서만 정해진다. 화면(§6)이 생성
    근거에 싣는 규칙 목록도 이 함수가 준 그대로다.
    """
    rules = list(RULES)
    if node_kinds:
        rules = _insert_after(rules, "마일스톤은 여러 개다", NODE_KIND_RULE)
    if tasks:
        rules = _replace_rule(rules, NO_TASK_RULE_PREFIX, TASK_RULES)
    if branch:
        # 태스크 판에서는 태스크 규칙 뒤, 아니면 분할 규칙 뒤. **어느 쪽이든 한 곳에서
        # 정해진다** — 자리를 부르는 쪽이 정하면 판마다 프롬프트가 달라진다.
        anchor = BRANCH_ANCHOR_PREFIX if tasks else "마일스톤은 여러 개다"
        for rule in reversed(BRANCH_RULES):
            rules = _insert_after(rules, anchor, rule)
    if equipment:
        rules = _insert_after(rules, "장소는", EQUIPMENT_RULE)
    return rules


def render_places(places: Any) -> str:
    """`places.json` → 프롬프트에 실을 장소 위상.

    **좌표는 애초에 `places.json` 에 없다.** 층을 나눈 것이 여기서 값을 한다 —
    실수로 좌표를 실을 방법 자체가 없다.
    """
    if not places:
        return "(장소 목록이 주어지지 않았습니다 — 그라운딩 없이 돕니다.)"
    entries = places.get("places", []) if isinstance(places, dict) else list(places)
    by_id = {entry["place_id"]: entry for entry in entries}
    lines = []
    for entry in entries:
        neighbours = [by_id[pid]["label"] for pid in entry.get("adjacent", []) if pid in by_id]
        floor = entry.get("floor")
        head = f"{entry['label']} ({entry['kind']}, {floor}층)" if floor is not None else f"{entry['label']} ({entry['kind']})"
        alias = [a for a in entry.get("aliases", []) if a != entry["label"]]
        if alias:
            head += f" [별칭: {', '.join(alias)}]"
        lines.append(f"- {head}" + (f" ↔ {' · '.join(neighbours)}" if neighbours else " ↔ (연결 예정)"))
    return "\n".join(lines)


def render_equipment(equipment: Any) -> str:
    """`equipment.json` → 프롬프트에 실을 장비 어휘 (7단계).

    ## 왜 이 함수가 생겼나

    260906 실측에서 **장소 위반은 0건이고 장비 위반은 22~48%** 였다. 같은 모델·같은
    프롬프트·같은 디코딩·같은 응답 안에서 갈린 것이 하나뿐이다 — 장소는 목록을 줬고
    장비는 안 줬다. 그래서 장비에도 같은 처방을 준다.

    ## 원천을 여기서 고르지 않는다

    무엇을 실을지는 `scripts/extract-equipment.mjs` 가 정한다. 이 함수는 **받은 것을
    문장으로 펴기만 한다** — 예시와 같은 규칙이다(부르는 쪽이 재료를 고른다).

    ## `label` 이 없으면 식별자만 적는다

    추출기가 이름을 모르면 `null` 을 넣는다(레지스트리에 없는 식별자). 여기서 「로봇
    go1-02」 같은 이름을 지어내면 그 이름이 프롬프트를 통해 세상에 생긴다.

    ## 싣지 않는 항목이 있다

    `equipment_id` · `label` · `kind` · `aliases` 넷만 편다. 추출기가 파일에 남기는
    출처·집계는 **모델이 볼 것이 아니다** — 어느 장비가 정답셋에서 왔는지가 새면 그것이
    곧 정답 누출이다. 그래서 통째로 돌리지 않고 항목을 하나씩 집는다.
    """
    if not equipment:
        return "(장비 목록이 주어지지 않았습니다 — 그라운딩 없이 돕니다.)"
    entries = equipment.get("equipment", []) if isinstance(equipment, dict) else list(equipment)
    lines = []
    for entry in entries:
        label = entry.get("label")
        kind = entry.get("kind")
        head = entry["equipment_id"]
        if label and kind:
            head += f" — {label} ({kind})"
        elif label:
            head += f" — {label}"
        elif kind:
            head += f" ({kind})"
        alias = [a for a in entry.get("aliases", []) if a and a != label]
        if alias:
            head += f" [별칭: {', '.join(alias)}]"
        lines.append(f"- {head}")
    return "\n".join(lines)


def render_example(example: Any) -> str:
    """few-shot 한 편. **정답 JSON 을 그대로 보인다.**

    말로 설명한 예시는 형식을 가르치지 못한다 — 형식 안정성이 이 프롬프트의 첫 목표이고,
    그것은 모양을 보여야 옮는다.
    """
    utterance = example.get("utterance", {})
    shown = {
        "mission_id": example.get("mission_id"),
        "utterance": utterance,
        "milestones": example.get("milestones", []),
    }
    return (
        f"발화: {utterance.get('text', '')}\n"
        f"출력:\n{json.dumps(shown, ensure_ascii=False, indent=2)}"
    )


SYSTEM = (
    "너는 사람의 한국어 발화를 **마일스톤 목록**으로 나누는 임무 계획기다.\n"
    "마일스톤은 임무를 사람이 확인할 수 있는 단계로 자른 것이고, 각 단계는 추상적이어야 한다.\n"
    "출력은 계약(JSON 스키마)을 만족하는 JSON 객체 하나뿐이다."
)


def build(
    utterance: str,
    mission_id: str,
    places: Any = None,
    examples: Optional[list[Any]] = None,
    utterance_meta: Optional[dict[str, Any]] = None,
    equipment: Any = None,
    node_kinds: bool = False,
    tasks: bool = False,
    branch: bool = False,
) -> dict[str, str]:
    """(system, user) 두 문자열. **엔진의 대화 틀은 엔진이 씌운다** (`engines/`).

    `equipment` 를 안 주면 규칙도 목록도 붙지 않는다 — 6단계와 **같은 프롬프트**가 된다.
    그것이 7단계 A 판의 정의이고, 그 판이 있어야 B 판의 차이를 장비 목록에 돌릴 수 있다.

    `node_kinds` 는 8단계 D 판의 유일한 축이다. **목록을 프롬프트에 따로 싣지 않는다** —
    장소·장비와 달리 이것은 부르는 쪽이 고르는 재료가 아니라 규칙 자체이고, 다섯 종류가
    규칙 문장 안에 들어 있다. `[장비]` 처럼 절을 만들면 「목록에서 골라 채워라」로 읽히고,
    그것이 개수만 부풀리는 실패다(8단계 §「읽는 법」 둘째 줄).

    `tasks` 는 10단계 E 판의 축이다. **규칙을 더하는 것이 아니라 갈아 끼운다** —
    「tasks 는 빈 배열로 둔다」와 정면으로 부딪히므로 둘을 같이 둘 수 없다.
    예시는 여전히 마일스톤까지만 보인다(`lib/fewshot.mjs`) — 태스크를 예시로 보이면
    이 판이 재는 것이 「낼 줄 아는가」가 아니라 「예시를 베끼는가」가 된다.
    """
    examples = examples or []
    parts = [
        "[규칙]",
        "\n".join(f"{i + 1}. {rule}" for i, rule in enumerate(rules_for(equipment, node_kinds, tasks, branch))),
        "",
        "[장소] 이 목록 밖의 장소를 만들면 실패다.",
        render_places(places),
    ]
    if equipment:
        parts += ["", "[장비] assigned_targets 에는 이 목록의 id 만 쓴다.", render_equipment(equipment)]
    if examples:
        parts += ["", f"[예시] {len(examples)}편. 같은 형식으로 낸다."]
        parts += [render_example(example) for example in examples]
    meta = utterance_meta or {"audio_ref": None, "text": utterance, "engine": "script", "confidence": 1}
    parts += [
        "",
        "[요청]",
        f"mission_id: {mission_id}",
        f"utterance: {json.dumps(meta, ensure_ascii=False)}",
        f"발화: {utterance}",
        "",
        "위 발화의 마일스톤을 JSON 으로 내라.",
    ]
    return {"system": SYSTEM, "user": "\n".join(parts)}
