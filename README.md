# 피지컬팀 프로젝트 mk2 — 가시화 파트

로봇 임무를 **계층과 시간축이 한 화면에** 놓이도록 가시화하고, 그 화면으로 임무를
**디버깅**하는 도구를 만든다. 논문 주제도 같다 — 「디버깅을 위한 가시화」(2026-08-26 회의 확정).

요구사항은 **v1.2 · 51건**이고, 화면은 탭이 아니라 **노드 캔버스 하나**다.

---

## 어디부터 읽나

**[`문서/현재상황_읽기순서.txt`](문서/현재상황_읽기순서.txt)** 하나만 열면 된다.
지금 무엇이 끝났고 무엇이 남았는지, 그리고 나머지 문서를 어떤 순서로 볼지가 거기 있다.

바로 돌려보려면:

```bash
git clone -b khw_VZ https://github.com/khw18033/Physical-Project-mk2.git
cd Physical-Project-mk2/viz-debugger
npm install
npm run dev
```

**`npm` 을 못 찾는다고 하면** Node.js 가 없거나 PATH 에 아직 안 올라온 것이다.

1. [nodejs.org](https://nodejs.org) 에서 **22.18 이상**(24 권장)을 받아 설치한다. 이 저장소는
   `.ts` 파일을 그대로 실행하므로(`node gateway/server.ts`) 그보다 낮으면 게이트웨이가 안 뜬다.
2. **터미널을 닫았다 다시 연다.** 설치 중에 열려 있던 창은 옛 PATH 를 들고 있어서, 깔고도
   똑같이 「인식할 수 없는 명령」이 뜬다. 가장 흔한 자리다.
3. `node -v` 와 `npm -v` 로 확인한다. `node` 는 되는데 `npm` 만 안 되면 설치가 반만 된 것이니
   같은 설치 파일로 한 번 더 돌린다(복구 · Repair).
4. nvm 을 쓰면 창마다 판을 골라야 한다 — `nvm use 24`.

---

## 음성 인식(STT)과 생성까지 붙이려면

`npm run dev` 하나가 **넷**을 띄운다 — 게이트웨이(8790) · 화면(5174) · STT(8801) · 생성(8802).
STT·생성은 **파이썬 환경이 있을 때만** 뜨고, 없으면 콘솔에 `[stt]`·`[generate]` 줄을 남기고
나머지는 그대로 뜬다(화면에서는 그 기능만 꺼진다). 새로 받은 저장소에는 파이썬 환경도 모델도
없으므로(`.gitignore`) 아래를 한 번 해야 한다.

아래 명령은 **cmd 와 PowerShell 양쪽에서 그대로 된다.** 셸마다 모양이 다른 것(환경변수·프로세스
종료)만 둘을 나란히 적었다. PowerShell 에서 `curl` 은 다른 명령의 별칭이라 반드시 `curl.exe` 로 쓴다.

### 먼저 깔 것

| 무엇 | 왜 | 확인 |
|---|---|---|
| **Python 3.10 이상, 64비트** | 두 서비스 다 FastAPI 다. 이 저장소에서 확인한 판은 3.10.10 | `py -0p` |
| **Microsoft Visual C++ 재배포 패키지 (2015–2022, x64)** — [받기](https://aka.ms/vs/17/release/vc_redist.x64.exe) | STT 엔진(CTranslate2)이 이 DLL 을 쓴다. 새 노트북에는 없는 일이 많다 | 아래 STT 확인 한 줄 |
| NVIDIA 드라이버 *(있으면)* | 없으면 STT 는 CPU 로 알아서 내려가고, 생성은 CPU 빌드를 받는다 | `nvidia-smi` |

`py -0p` 목록에 3.10 이 없으면 아래의 `py -3.10` 을 **있는 판 번호**(예: `py -3.12`)로 바꾼다.

### STT — `npm run dev` 가 같이 띄운다

```bat
cd viz-debugger\stt
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -c "import service; print(service.engines.load_errors())"
```

마지막 줄이 **엔진이 실제로 붙는지** 본다. `[]` 가 나와야 하고, 뭔가 찍히면 그 `error` 가 사유다.

- **폴더와 이름이 정확히 `viz-debugger\stt\.venv` 여야 한다.** `npm run dev` 는 그 자리만 찾고,
  없으면 PATH 의 `python` 으로 띄운다. 그 파이썬에 fastapi 만 있으면 **서비스는 뜨는데 엔진이
  없다** — 아래 표의 503 이 이것이다.
- 첫 인식 때 모델(`large-v3-turbo`, 1.5 GB 안팎)을 HuggingFace 에서 받는다. **발표장에 가기 전에
  인터넷이 되는 곳에서 한 번 녹음해 둔다.** 두 번째부터는 캐시에서 읽는다.
- 자세한 것은 [`viz-debugger/stt/README.md`](viz-debugger/stt/README.md).

### 생성 — `npm run dev` 가 같이 띄운다

```bat
cd gen-lab
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

- **폴더와 이름이 정확히 `gen-lab\.venv` 여야 한다.** STT 와 달리 없으면 PATH 의 python 으로
  시도하지도 않고 `[generate] gen-lab/.venv 가 없어 …` 한 줄만 남긴다. 다른 python 을 쓰려면
  `VIZ_GENERATE_PYTHON` 에 경로를 넣는다.
- 생성만 따로 띄우려면 `viz-debugger\` 에서 `npm run dev:generate`.
- `npm run dev` 를 끄면 gen-lab 이 띄운 `llama-server` 까지 **같이 내려간다.**

이것만 하면 **스텁**으로 뜬다. 연결은 되지만 답이 모델에서 나온 것이 아니다. 실제 모델을
쓰려면 `llama-server` 바이너리와 가중치를 `gen-lab\vendor\` · `gen-lab\models\` 에 받아야 한다.

- **NVIDIA GPU 가 있으면** [`gen-lab/README.md`](gen-lab/README.md) 의 CUDA 절차 그대로.
- **없으면 CPU 빌드**를 받는다. `cudart` 는 필요 없고, 느리므로 가중치는 Qwen3 4B 하나만 받는다.
  `gen-lab\` 에서:

  ```bat
  mkdir vendor\llama.cpp
  mkdir models
  curl.exe -L -o vendor\llama.zip https://github.com/ggml-org/llama.cpp/releases/download/b10825/llama-b10825-bin-win-cpu-x64.zip
  tar -xf vendor\llama.zip -C vendor\llama.cpp
  curl.exe -L -o models\Qwen3-4B-Q4_K_M.gguf https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf
  vendor\llama.cpp\llama-server.exe --version
  ```

  마지막 줄이 `build 10825` 를 찍으면 바이너리는 된 것이다. `gen-lab/README.md` 의 CUDA 절차도
  `curl` · `Expand-Archive` 를 쓰는데, cmd 라면 위처럼 `curl.exe` · `tar -xf` 로 바꿔 쓴다.

떴는지는 브라우저로 `http://127.0.0.1:8802/generate/health` 를 연다. `engine` 이 `llama.cpp` 이고
`binary_present: true` · `models` 에 파일이 보이면 된다. `stub` 이면 `why` 칸이 사유다.
모델은 **첫 생성 요청 때** 올라가므로 첫 건은 오래 걸린다. 기동할 때 뜨는 `on_event is deprecated`
경고는 무시해도 된다.

### 띄운 뒤에는 브라우저를 새로고침한다

발화 패널은 **처음 그려질 때 한 번만** 두 서비스를 확인한다. 화면을 먼저 열어 두고 나중에
서비스를 띄우면 서비스가 살아 있어도 「닿지 않습니다」가 남는다 — **F5** 로 다시 확인시킨다.

### 막혔을 때

| 보이는 것 | 원인 | 대처 |
|---|---|---|
| 콘솔에 `POST /stt/transcribe` **503** · 화면에 「등록된 STT 엔진이 없다」 | 서비스는 떴는데 **엔진을 못 불렀다** | 위 `load_errors()` 한 줄로 사유를 보고 아래 줄 중 하나를 따른다 |
| `ModuleNotFoundError: No module named 'faster_whisper'` | 엔진 패키지가 그 파이썬에 없다. `.venv` 없이 PATH 의 python 으로 떴거나 설치가 중간에 실패했다 | `viz-debugger\stt\.venv` 를 만들고 `pip install -r requirements.txt` 를 다시 돌려 **출력 끝을 읽는다** |
| `ImportError: DLL load failed while importing …` | Visual C++ 재배포 패키지가 없다 | 위 표의 링크로 설치 → **터미널을 닫았다 다시 열고** `npm run dev` |
| `pip install` 이 `No matching distribution found for ctranslate2` | 휠이 없는 파이썬이다(32비트이거나 너무 새 판) | 64비트 3.10 으로 `.venv` 를 지우고 다시 만든다 |
| `pip install` 이 `UnicodeDecodeError` | `requirements.txt` 첫 줄 `# -*- coding: utf-8 -*-` 가 지워졌다 | 그 줄을 되살린다 |
| 첫 인식이 **500** 이고 사유에 HuggingFace·Hub·connection 이 보인다 | 모델을 못 받았다(인터넷·방화벽) | 인터넷이 되는 곳에서 한 번 녹음한다 |
| STT 「서비스가 떠 있지 않습니다 (…:8801)」 | 이전 세션이 포트를 잡고 있어 새 스택이 같이 내려갔다 | [`viz-debugger/stt/README.md`](viz-debugger/stt/README.md) 의 포트 정리 절차 |
| 생성 「서비스가 떠 있지 않습니다 (…:8802)」 · 콘솔에 `[generate] gen-lab/.venv 가 없어` | 생성용 파이썬 환경이 없다 | 위 절차로 `gen-lab\.venv` 를 만들고 `npm run dev` 를 다시 → **F5** |
| 콘솔에 `[generate] 종료(코드 1)` | 대개 8802 를 이미 누가 쓰고 있다 — 따로 띄워 둔 gen-lab 이나 이전 세션 | 따로 띄운 창을 닫거나 8802 를 잡은 프로세스를 끄고 `npm run dev` 를 다시 |
| 생성 결과에 「스텁」 | `vendor\` 나 `models\` 가 없다 | `/generate/health` 의 `why` 를 읽고 받는다 |
| `llama-server 가 뜨지 못하고 종료했습니다` | 사유는 그 메시지 아래 로그 끝줄에 있다. 흔한 것은 VRAM 부족(`out of memory`) | 4B 로 바꾸거나 GPU 에 올릴 층을 줄인다. **같은 창에서** 지정하고 `npm run dev` 를 다시 — cmd `set GEN_LAB_NGL=20` · PowerShell `$env:GEN_LAB_NGL = "20"` |
| 모델 파일을 못 연다(`failed to load model`)는데 파일은 있다 | 저장소 경로의 **한글**이 원인일 수 있다 | 가중치를 영문 경로로 옮기고 **같은 창에서** 지정한 뒤 `npm run dev` — cmd `set GEN_LAB_MODEL_DIR=C:\models` · PowerShell `$env:GEN_LAB_MODEL_DIR = "C:\models"` |
| `포트 8803 을 다른 가중치의 llama-server 가 잡고 있습니다` | 앞선 실행의 유령 `llama-server`. `npm run dev` 가 내린 것은 안 남지만, 창을 강제로 닫았거나 따로 띄웠던 gen-lab 이 남긴 것일 수 있다 | cmd `taskkill /IM llama-server.exe /F` · PowerShell `Get-Process llama-server \| Stop-Process` |

---

## 폴더

### 문서

| 폴더 | 무엇이 있나 |
|---|---|
| [`문서/`](문서/) | **현행 문서 전부.** 요구사항 정의서·엑셀, 쉬운 설명, 프로토타입 설명서, 구현진행·기술스택·논문진행, 관련연구, 진행 중인 작업 지시서 |
| [`meeting/`](meeting/) | 회의록. 그 시점의 사실이라 낡지 않는 문서다 |
| [`reports/`](reports/) | 날짜별 작업 보고서. **본문은 고치지 않는다** — 그 시점의 기록이다 |
| [`docs/`](docs/) | 다이어그램 원본(mermaid) · 인터페이스 시트 · 조사 메모 · 문서 검증 스크립트 |
| [`_archive/`](_archive/) | **지운 것이 아니라 현행이 아닌 것.** 무엇이 왜 밀려났는지는 [`_archive/README.md`](_archive/README.md) |

### 코드

| 폴더 | 무엇이 있나 |
|---|---|
| [`viz-debugger/`](viz-debugger/) | **현행 통합 가시화 앱.** 노드 캔버스 하나 + 뷰 노드 넷 |
| [`web-dashboard/`](web-dashboard/) | 데이터 레이어와 목 게이트웨이의 기준선. 손대지 않고 살려 둔다 |
| [`Unity_Map/`](Unity_Map/) | **Unity ↔ Pyjevsim 디지털 트윈.** Go1 로봇의 실내 맵과 경로계획 연동, 그리고 C1~C3 실험 결과 |
| [`unity-twin/`](unity-twin/) | 전역 좌표를 받아 공간에 배치하는 Unity 뷰어 (`VZ-U-02`) |
| [`stt-lab/`](stt-lab/) | STT 엔진·모델을 같은 오디오로 비교하는 실험 하네스 |
| [`gen-lab/`](gen-lab/) | 발화에서 임무 객체를 만드는 생성 서비스 (`VZ-G-01`·`VZ-G-02`) |

### 계약·데이터

| 폴더 | 무엇이 있나 |
|---|---|
| [`contracts/`](contracts/) | 파트 간 JSON 스키마와 예제, 검증 스크립트 |
| [`places/`](places/) | 장소 계약. Unity 맵에서 뽑되 좌표와 의미를 층으로 가른다 |
| `mission-history/` | **임무 기록** — 관제 웹이 판마다 남기는 기록과 받은 그림(날짜/시각_임무). git 에 안 올라간다. [viz-debugger/README.md](viz-debugger/README.md) 「임무 기록」 |

---

## 루트에는 이 README만 둔다

**2026-09-06 정리.** 그전까지 현행 문서 19개가 루트에 흩어져 있었고, 폴더와 파일이
섞여 있어 저장소를 처음 열었을 때 어디부터 볼지가 보이지 않았다. 문서는 [`문서/`](문서/)로
모으고 루트에는 이 README만 남긴다. `.gitignore`·`.gitattributes` 는 루트에 있어야
동작하므로 그대로 둔다.

**파일이 사라진 것이 아니라 한 칸 들어갔다.** 예전 문서와 보고서가 「루트의 `요구사항정의서.md`」
처럼 가리키고 있다면 지금은 `문서/요구사항정의서.md` 다. 보고서 본문은 그 시점의 기록이라
고치지 않았다.

### Unity_Map 은 무엇을 추적하나

`Assets/` · `Packages/` · `ProjectSettings/` 와 실험 결과(`GO1_*`)를 추적한다.
`Library/` 는 **4.1GB** 이고 에디터가 `Assets/` 에서 그대로 복원하므로 추적하지 않는다
(`Temp/` · `Logs/` · `UserSettings/` · `.csproj` · `.sln` 도 같다).
