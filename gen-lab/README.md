# gen-lab — 생성 서비스

발화에서 임무 객체를 만드는 서비스다 (`VZ-G-01` 마일스톤 분리 · `VZ-G-02` 태스크 DAG).
`stt-lab`·`viz-debugger/stt` 와 **같은 패턴**이다 — 모델은 브라우저에 들어가지 않는다.

| | STT | 생성 |
|---|---|---|
| 프로세스 | `viz-debugger/stt` FastAPI · 8801 | **`gen-lab` FastAPI · 8802** |
| 경계 파일 | `viz-debugger/src/stt/SttClient.ts` | **`viz-debugger/src/generate/LlmClient.ts`** |
| 주소 | 연결 관리(`VZ-C-07`) + 환경변수 기본값 | 동일 — `CONNECTION_TARGETS` 의 `generate` |
| 꺼져 있으면 | 음성만 꺼짐 (`verify:no-stt`) | **생성만 꺼짐 (`verify:no-llm`)** |

## 엔진 — llama.cpp (`llama-server` 바이너리 + HTTP)

**모델은 브라우저에 들어가지 않는다.** 엔진이 붙어 있고 가중치가 있으면 그것으로 내고,
없으면 계약을 만족하는 최소 임무를 돌려주는 **스텁으로 내려간다** — 그 사실은
`/generate/health` 의 `engine` 과 응답의 `extra.stub` 이 그대로 적는다.
**목임을 감추지 않는다.**

왜 llama.cpp 인가: `viz-debugger/src/generate/gbnf.ts` 가 계약에서 GBNF 를 뽑는데
Ollama 는 GBNF 를 직접 받지 않는다. **문법 강제 디코딩이 이 작업의 핵심 도구**이므로
그것을 그대로 받는 쪽으로 간다.

왜 바이너리 + HTTP 인가: `llama-cpp-python` 은 Windows + CUDA 휠 설치가 까다롭고,
거기서 막히면 「모델이 나쁜 것」과 「설치가 안 된 것」이 섞인다. 바이너리는 설치가
압축 해제 하나다. 안정되면 그때 in-process 를 판단한다.

**엔진 프로세스는 gen-lab 이 관리한다.** 모델을 바꿔 달라고 하면 내리고 다시 띄운다 —
사람이 매번 손으로 껐다 켜면 그 절차가 측정의 일부가 되어 재현이 흔들린다.

## 받을 것 둘 — 저장소에 없다

`vendor/` 와 `models/` 는 `.gitignore` 에 있다. 합쳐 13 GB 이고, 하나는 남의 배포물이며
하나는 라이선스가 따로 있다.

### 1. llama.cpp (CUDA 빌드)

```powershell
# gen-lab/ 에서
mkdir vendor
curl -L -o vendor\llama.zip  https://github.com/ggml-org/llama.cpp/releases/download/b10825/llama-b10825-bin-win-cuda-12.4-x64.zip
curl -L -o vendor\cudart.zip https://github.com/ggml-org/llama.cpp/releases/download/b10825/cudart-llama-bin-win-cuda-12.4-x64.zip
Expand-Archive vendor\llama.zip  -DestinationPath vendor\llama.cpp -Force
Expand-Archive vendor\cudart.zip -DestinationPath vendor\llama.cpp -Force
.\vendor\llama.cpp\llama-server.exe --list-devices   # CUDA0 가 보여야 한다
```

CUDA **12.4** 빌드를 쓴다. 드라이버가 더 새 CUDA 를 지원해도 12.x 는 뒤로 호환되고,
13.x 빌드는 드라이버 요구가 더 까다롭다 — 여기서 막히는 것이 측정에 섞이면 안 된다.

### 2. 가중치 (Q4_K_M GGUF · RTX 3060 12 GB 기준)

| 모델 | 파일 | 크기 | 라이선스 |
|---|---|---|---|
| Qwen3 8B | `Qwen3-8B-Q4_K_M.gguf` | 5.03 GB | Apache-2.0 |
| EXAONE 3.5 7.8B Instruct | `EXAONE-3.5-7.8B-Instruct-Q4_K_M.gguf` | 4.77 GB | **EXAONE AI Model License 1.1 – NC** |
| Qwen3 4B | `Qwen3-4B-Q4_K_M.gguf` | 2.50 GB | Apache-2.0 |

```powershell
mkdir models
curl -L -o models\Qwen3-8B-Q4_K_M.gguf https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
curl -L -o models\Qwen3-4B-Q4_K_M.gguf https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
curl -L -o models\EXAONE-3.5-7.8B-Instruct-Q4_K_M.gguf https://huggingface.co/LGAI-EXAONE/EXAONE-3.5-7.8B-Instruct-GGUF/resolve/main/EXAONE-3.5-7.8B-Instruct-Q4_K_M.gguf
curl -L -o models\EXAONE-3.5-7.8B-Instruct.LICENSE.txt https://huggingface.co/LGAI-EXAONE/EXAONE-3.5-7.8B-Instruct-GGUF/resolve/main/LICENSE
```

**모델 목록은 코드에 없다.** `models/` 에 있는 `*.gguf` 를 그대로 읽는다 — 새 모델을 재는
일이 코드 수정이 되면 「무엇을 쟀는가」가 커밋 사이에 흩어진다.

### EXAONE 을 쓸 때 지켜야 하는 것

라이선스 전문은 받아 둔 `models/EXAONE-3.5-7.8B-Instruct.LICENSE.txt` 에 있다. 이 프로젝트에
걸리는 조항은 셋이다.

- **연구 목적 비상업(§2.1a · §3.1).** 이 저장소는 연구·평가용이라 허용 범위 안이다.
  제품이나 수익이 걸리는 배포에는 **별도 상업 라이선스가 필요하다.**
- **연구 결과 공개는 허용된다(§2.1b).** 논문·발표에 대조군으로 쓰고 숫자를 싣는 것은 된다.
- **출력을 다른 모델의 학습·개선에 쓸 수 없다(§3.1 마지막 문장).**
  5단계에서 학습으로 가더라도 **EXAONE 의 출력은 학습 자료가 될 수 없다.**
  Qwen3 둘은 Apache-2.0 이라 이 제약이 없다.

그래서 EXAONE 은 **한국어 대조군**으로만 쓴다. 주 후보는 Qwen3 8B 다.

## 실행

Python 3.10 이상. 저장소 루트에서:

```powershell
cd gen-lab
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m server.main
```

**`.venv` 가 있으면 `viz-debugger` 의 `npm run dev` 가 이 서비스를 같이 띄운다** (260914).
마지막 줄은 이것만 따로 띄울 때 쓴다(`npm run dev:generate` 도 같다). `npm run dev` 를 끄면
프로세스 트리째 내리므로 이 서비스가 띄운 `llama-server` 도 남지 않는다 — 부모만 죽이면 남는다는
것을 실측으로 확인했다(아래 「유령 `llama-server`」).

`http://127.0.0.1:8802/generate/health` 를 열면 무엇이 떠 있는지 나온다 —
붙은 엔진, 쓸 수 있는 가중치 목록, 지금 물고 있는 것, 그리고 **포트에서 실제로 답하는
파일**(`serving_model`)까지. 마지막 것이 중요하다: `loaded_model` 은 우리가 띄웠다고
믿는 것이고 `serving_model` 은 물어본 것이다. 둘이 다르면 그 측정은 못 쓴다.

베이스라인은 `viz-debugger/` 에서 돈다.

```powershell
npm run baseline:run -- --model Qwen3-8B-Q4_K_M      # 임무 3편 × 발화 5개 = 15건
npm run baseline:run -- --model Qwen3-8B-Q4_K_M --no-grammar   # 문법 없는 대조군
npm run baseline:run -- --model Qwen3-8B-Q4_K_M --no-equipment # 장비 목록 없는 대조판 (7단계 A)
npm run baseline:run -- --model Qwen3-8B-Q4_K_M --no-examples  # 예시 0편 (7단계 C)
npm run baseline:run -- --model Qwen3-8B-Q4_K_M --node-kinds   # 노드 문법 5종 규칙 (8단계 D)
npm run baseline:run -- --model Qwen3-8B-Q4_K_M --tasks        # 태스크까지 낸다 (10단계 E)
npm run baseline:run -- --rescore                    # 출력은 그대로, 채점만 다시
npm run baseline:report                              # 모델을 한 표에 놓는다
```

**스위치는 한 번에 하나만 움직인다.** 둘을 같이 움직이면 그 판의 숫자를 어느 원인에도
돌릴 수 없다. 앞 셋은 기본이 켜짐이라 **끄는** 스위치이고 `--node-kinds` 만 **켜는**
스위치다 — `--node-kinds` 는 8단계에서 재고 **채택하지 않았고**, `--tasks` 는 10단계에서
재고 **채택했다**(화면 기본 켜짐).

`--tasks` 는 예시도 함께 바꾼다 — 규칙만 바꾸고 예시를 그대로 두면 프롬프트가 서로
반대되는 지시 둘을 들고, 실측에서 **예시가 이겼다**(15건 중 10건이 규칙을 무시했다).
그리고 프롬프트가 4,400 → 7,600 토큰이 되므로 `ctx` 가 **16384** 여야 한다 — 8192 에서는
출력에 567 토큰밖에 안 남아 15건 전부 잘렸다.
포트를 바꾸려면 `$env:VIZ_GENERATE_PORT = "8803"` 처럼 지정하고, 화면 쪽은
상단 바의 **「연결 관리」** 에서 주소를 바꾼다 (다시 빌드하지 않는다 · `VZ-C-07`).

**띄우지 않아도 된다.** 화면은 그대로 뜨고 생성 경로만 꺼진다 —
그것을 `verify:no-llm` 이 검사한다.

## 화면에서 쓰는 법 (260907 · 9단계)

발화 패널의 **뒤 세 칸**이 이 서비스로 채워진다.

```
의도 분석 · 마일스톤 분리   VZ-G-01   generateMission()  ← 모델
태스크 생성                VZ-G-02   노드는 모델 · deps 는 solveDeps() 규칙
```

결과는 **제안**이다. 사람이 승인해야 캔버스에 올라가고(`VZ-U-07`), 그 문은
`data/scenario.ts` 의 `acceptProposal()` 하나이며 `verify:proposal-gate` 가 지킨다.
**대본이 맞으면 대본이 이긴다** — 모델의 답은 나란히 뜨고 사람이 버튼으로 바꾼다.

태스크까지 낼지는 화면에서 끌 수 있다. **기본은 켜짐**이고, 끄면 마일스톤만 받는다
(6초 대 26초). `deps` 는 어느 쪽이든 규칙이 만든다 — 모델은 빈 배열을 낸다.

## 면 둘

```
GET  /generate/health    무엇이 떠 있는가 (엔진·가중치 목록·지금 답하는 파일·계약 목록)
POST /generate/mission   발화 하나 → 임무 객체 + 계약 검증 결과 + 생성 근거
POST /generate/unload    가중치를 내린다 (STT 와 12 GB 를 나눠 쓸 때)
```

### 응답이 근거를 함께 낸다 (260907 · 9단계)

`extra` 에 셋이 실린다 — **모델 이름 · 프롬프트 지문 · 적용된 규칙 목록**
(`rules_applied` 는 `prompt.rules_for()` 가 준 그대로다). 화면이 이것을 제안 옆에 펴고,
승인되면 기록 열에 `produced_by=ai` 사건으로 들어간다. 화면이 규칙을 따로 적으면 모델이
지킨 규칙과 사람이 본 규칙이 갈라지므로 **서비스가 준 목록만 쓴다.**

### `mission_id` 와 `utterance` 는 부르는 쪽 값으로 덮어쓴다

둘 다 부르는 쪽이 이미 아는 값이다. 프롬프트가 「그대로 옮겨 적어라」로 부탁하고 있었고,
**되받아 적을 기회가 있으면 언젠가 틀린다** — 260907 실측에서 한 건이
`utterance.confidence` 를 1 대신 **5** 로 적어 계약을 어겼다(문법은 구조와 타입을
고정하지만 `maximum` 같은 값 제약은 못 건다). 서비스가 응답을 조립할 때 덮어쓰므로 이
실패 유형은 원천에서 사라진다. **덮어쓴 사실은 `extra.overwritten` 에 그대로 남는다** —
고쳐 놓고 안 고친 척하지 않는다.

### 가중치 목록에 라이선스 표식이 붙는다

`models[].license_file` — `models/` 에 **그 가중치의 라이선스 전문이 함께 있으면** 그
파일 이름이 실린다. 이름으로 가르지 않는다(새 모델이 늘 때마다 코드를 고치게 된다).
화면은 이 값으로 **기본 선택을 피한다** — EXAONE 은 비상업 연구용이라 시연·배포 경로가
조용히 물어서는 안 되고, 고르지 못하게 막지는 않는다(대조군으로는 정당하다).

`llama-server` 는 **8803** 을 쓴다. gen-lab 안쪽의 사정이라 화면의 「연결 관리」에는
올리지 않는다 — 화면이 아는 생성 주소는 8802 하나다.

### 프롬프트는 서비스가 만든다

부르는 쪽이 프롬프트 문자열을 통째로 넘기게 하면, 같은 정답셋을 재는 두 사람이 서로 다른
프롬프트로 재고도 그 사실을 모른다. **측정의 조건이 코드에 있어야**(`server/prompt.py`)
숫자가 비교된다. 부르는 쪽이 고르는 것은 **재료** 셋이다.

| 재료 | 원천 | 안 주면 |
|---|---|---|
| 장소 위상 | `places/places.json` | 그라운딩 없이 돈다 (좌표를 든 기하 파일은 **넘기지 않는다**) |
| 장비 어휘 | `equipment/equipment.json` | 규칙도 목록도 안 붙는다 — 7단계 A 판이 그 대조판이다 |
| few-shot 예시 | 정답셋 (leave-one-out) | 예시 0편 — 7단계 C 판 |

화면(`UtterancePanel`)도 **같은 재료**를 보낸다. 장소·장비는 같은 두 파일이고, 예시는
대본 라이브러리에서 만든다 — 정답셋이 애초에 그 대본에서 뽑혀 나왔으므로 내용이 같다
(`viz-debugger/src/generate/fewshot.ts`). 화면에서도 leave-one-out 을 지킨다: **키워드
대조가 맞힌 편은 예시에서 뺀다.** 두 경로의 예시가 글자까지 같은지는 `verify:no-leak` 이
대조한다 — 갈라지면 표의 숫자가 화면을 설명하지 못한다.

예시를 부르는 쪽이 고르는 이유는 하나 더 있다. **채점 대상인 편은 예시에서 빼야 하는데**
서비스는 어느 편이 채점 대상인지 모른다. 뺐는지는 `verify:no-leak` 이 검사한다.

장비 목록은 **채점 어휘보다 넓어야 한다.** 같아지면 「목록에서 고를 줄 아는가」가 아니라
「준 것을 옮겨 적는가」를 재게 되고, 그것도 `verify:no-leak` 이 검사한다
(`equipment/README.md`). 260907 실측에서 목록을 주자 장비를 지어낸 건이 **20건 → 0건**이
됐다 — 260906 에 장소만 목록을 줬을 때 위반이 0건이던 것과 같은 처방이다.

`SttClient` 는 전용 헬스 경로를 두지 않고 같은 경로에 GET 을 던져 405 를 살아 있음의
신호로 쓴다. 생성은 **「무엇이 떠 있는가」(스텁인가 엔진인가)를 화면이 적어야** 하므로
405 로는 부족해서 경로를 하나 두었다.

## 문법은 계약에서 뽑는다 — 손으로 쓴 문법 파일이 없다

`contracts/mission.schema.json` → GBNF 변환은 `viz-debugger/src/generate/gbnf.ts` 가 한다.
클라이언트가 뽑아 요청에 실어 보내므로 **부르는 쪽이 계약 밖 출력을 요구할 수 없다.**

`verify:gen-port` 가 검사하는 것 둘 — 손으로 쓴 문법 파일(`*.gbnf` 등)이 없는가,
계약을 고치면 문법이 따라 바뀌는가.

3단계는 「엔진이 붙으면 서비스도 같은 계약에서 문법을 다시 뽑아 지문을 대조해야 한다」를
숙제로 남겼다. **하지 않기로 했다** (260906). 파이썬으로 GBNF 변환기를 한 벌 더 쓰는
일이고, 그 순간 `gbnf.ts` 와 조용히 갈라지는 두 번째 구현이 생긴다.

대신 **결과를 계약으로 검증한다.** 느슨한 문법이 들어오면 계약 밖 출력이 나오고 그것은
`schema_errors` 에 그대로 잡힌다. 「강제 디코딩이 실제로 듣는가」를 재는 축이 바로 그
숫자이므로, 검사하려던 것이 측정값 자체가 된다. 문법 지문은 기록에만 남긴다.

실측이 그것을 뒷받침한다 (2026-09-06 · Qwen3 8B · 같은 프롬프트 20건):
**문법을 걸면 스키마 통과 100% · 중앙값 7.5초, 끄면 45% · 38.8초.**

## 계약을 베껴 두지 않는다

`server/main.py` 는 저장소 루트의 `contracts/` 를 직접 읽는다. gen-lab 안에 사본을 두면
저장소가 계속 피해 온 「두 벌이 조용히 갈라진다」가 그대로 난다.

검증기도 `jsonschema` 패키지를 끌어오지 않고 `contracts/` 가 실제로 쓰는 문법만 다루는
최소 구현을 안에 두었다 (`viz-debugger/scripts/lib/json-schema.mjs` 와 같은 범위).
못 다루는 키워드는 조용히 넘기지 않고 오류 목록에 적는다.

## 정답셋

`goldset/` — 대본 4편에서 뽑은 (발화 → 마일스톤 → 태스크) 쌍과 손으로 적은 발화 변형 16개.
만드는 것은 `viz-debugger/scripts/extract-goldset.mjs` 이고 **대본은 읽기만 한다.**
채점은 `npm run score:generation` — **축을 따로 낸다.** 합산 점수 하나로 뭉치지 않는다:
스키마 · 마일스톤(개수·순서·제목) · 장소 어휘 위반 · 장비 어휘 위반 · 추상 위반 ·
노드 문법 · 그래프. 실패 유형을 못 가르면 학습 판단이 성립하지 않는다.

## 엔진을 하나 더 붙일 때

`server/engines/` 에 파일 하나를 더하고 `server/engines/__init__.py` 의 `_ENGINE_MODULES`
에 한 줄을 적는다. **교체가 파일 하나여야 한다.**
`server/main.py` 에 엔진 이름이 나오면 안 된다 (`stt-lab/server/main.py` 와 같은 규칙 ·
`REQ-1302`). 지금 `llama.cpp` 라는 문자열이 나오는 파일은
`server/engines/llama_cpp_server.py` 하나다.

`stt/engines/*.py` 처럼 원본에서 이식하는 것이 아니라 여기서 새로 쓴다 —
그래서 `verify:stt-port` 같은 바이트 동일성 검사가 이 폴더에는 없다.

## 겪은 것 — 유령 `llama-server`

gen-lab 을 다시 띄우면 앞선 실행이 낳은 `llama-server` 가 **8803 을 잡은 채 남는다.**
새 gen-lab 은 자기 자식이 없으니 새로 띄우려 하는데, `/health` 는 유령이 ok 로 답한다.
그래서 260906 에 「8B 를 쟀다」고 적힌 표가 실제로는 4B 의 답이 됐다 — 두 모델의 20건이
글자 하나까지 같게 나와서 알았다.

지금은 셋으로 막는다.
1. `/props` 로 **실제로 답하는 가중치 파일**을 확인한다. `/health` 만으로는 부족하다
2. 원하는 가중치를 이미 물고 있으면 받아 쓰고, **다른 것을 물고 있으면 멈춘다**
3. 서비스가 내려갈 때 자식을 반드시 내린다 (`shutdown` 훅)

그래도 강제 종료로 유령이 남을 수 있다. 그때는 `Get-Process llama-server | Stop-Process`.
