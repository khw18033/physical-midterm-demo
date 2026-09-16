# viz-debugger/stt — STT 서비스

가시화가 **자기 기능으로 갖는** 음성 인식이다 (`VZ-L-01`). `stt-lab/`을 띄워서 부르지 않는다.
`stt-lab/`은 모델 비교 실험 하네스로 계속 살아 있고, 여기 있는 것은 그중 **알맹이만 무수정 복사한 것**이다.

## 무엇이 여기 있고 무엇이 없는가

| 파일 | 출처 | 비고 |
|---|---|---|
| `engines/base.py` | `stt-lab/server/engines/base.py` | **무수정 이식.** 엔진 추상화(`REQ-1302`) |
| `engines/faster_whisper.py` | 〃 | **무수정 이식.** CUDA→CPU 자동 폴백, 모델 캐시, 로드 시간 분리 |
| `engines/__init__.py` | 〃 | **무수정 이식.** 엔진 등록 |
| `vocab.py` | `stt-lab/server/registry.py` | **부분 이식.** hotwords 부분만. 시험 발화 생성은 가져오지 않았다 |
| `service.py` | — | 새로 썼다. 엔드포인트 하나 |

`scoring.py`(CER·WER)·`store.py`(JSONL 누적·CSV)·`main.py`(실험용 라우팅 8개)·`web/index.html`과
시험 발화 프리셋 67건은 **가져오지 않았다.** 전부 실험 하네스의 일이다.

`engines/*.py`는 **고치지 않는다.** `npm run verify:stt-port`가 stt-lab 원본과 바이트 동일한지
검사한다(파일 맨 위 출처 주석만 예외). 고쳐야 할 이유가 생기면 코드를 쓰기 전에 보고할 것 —
조용히 두 벌이 갈라지는 것만 막으면 된다.

### `server` 라는 이름의 껍데기 모듈

이식본 `engines/__init__.py`는 구현체를 `server.engines.faster_whisper`라는 **절대 경로**로
import 한다(stt-lab에서는 그것이 맞는 경로였다). 여기엔 `server` 패키지가 없으므로 그대로 두면
로드가 실패하는데, 그 실패는 예외로 터지지 않고 `load_errors()`에 담겨 조용히 "엔진 없음"이 된다.

**파일을 고치는 대신 이름을 맞춰 준다.** `service.py`의 `_install_engines()`가 `server`라는
껍데기 모듈의 `__path__`를 이 폴더로 두어 `server.engines`가 곧 `stt/engines/`가 되게 한다.
이식본은 한 글자도 바뀌지 않는다.

## 실행

Python **3.10 이상**이 필요하다 (`fastapi`가 끌어오는 `anyio` 최신판이 3.10+를 요구한다).

```powershell
cd viz-debugger\stt
py -3.10 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe service.py
```

`npm run dev`(`scripts/dev-all.mjs`)는 위 `.venv`가 있으면 자동으로 이 서비스를 함께 띄운다.
없으면 **경고 한 줄만 남기고 나머지는 그대로 뜬다.** 환경을 여기서 자동으로 만들어 주지 않는다 —
첫 실행에 몇 분짜리 설치가 말없이 시작되면 "왜 안 뜨지"를 진단할 수가 없다.

`npm run dev:stt`로 이것만 따로 띄울 수도 있다.

### 「STT 서비스에 닿지 않습니다」가 뜰 때 — 먼저 볼 것 *(2026-09-01)*

**대부분 STT 문제가 아니다.** 실제로 났던 원인은 이것이었다.

이전 세션의 목 게이트웨이(8790)나 vite(5174)가 아직 살아 있으면, 새 `npm run dev` 는 포트
바인딩에 실패해 즉시 종료하고 **그러면서 자기가 띄운 STT 까지 같이 내린다**(`dev-all.mjs` 의
`stop()`). 그런데 브라우저는 **옛 세션**의 vite·게이트웨이에 그대로 붙어 있으므로 화면은 뜨고
상단도 「게이트웨이 연결됨」이다 — 없어진 것이 STT 하나뿐이라 증상이 STT 문제로 보인다.

```powershell
# 1) 콘솔 위쪽에서 [mock-gateway] 또는 [dev] 로 시작하는 종료 사유를 먼저 본다
# 2) 남은 프로세스 정리
Get-NetTCPConnection -LocalPort 8790,5174,8801 -State Listen |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 3) 다시 npm run dev — 세 줄이 다 떠야 한다
#    [mock-gateway] 기동 … / VITE ready / INFO: Uvicorn running on http://127.0.0.1:8801
```

정리한 뒤에도 안 되면 `npm run dev:stt` 로 STT 만 띄워 파이썬 트레이스백을 본다.
화면의 실패 문구에는 **주소와 사유**가 함께 뜬다(2026-09-01) — 「서비스가 떠 있지 않습니다」와
「떠 있는데 브라우저가 막았습니다(CORS)」가 구별되므로 그 문장부터 읽으면 된다.

### 모델 최초 다운로드는 오래 걸린다

기본 모델은 `large-v3-turbo`이고 첫 요청에서 HuggingFace 캐시로 내려받는다(1.5 GB 안팎).
**첫 요청이 몇 분 걸려도 실패가 아니다.** 두 번째 요청부터는 프로세스 수명 동안 캐시된다.
캐시 위치는 `STT_LAB_MODEL_DIR`(이식본이 쓰는 이름 그대로)로 바꿀 수 있다.

### GPU

`ctranslate2`가 CUDA를 잡으면 float16으로 돌고, 못 잡거나 cuDNN/cuBLAS가 없으면 **CPU int8로
자동 폴백**한다. 폴백 사유는 응답의 `extra.fallback_reason`에 그대로 실려 온다 — 조용히
느려지는 대신 왜 느린지가 보인다.

## 엔드포인트 — 하나뿐이다

```
POST /stt/transcribe    (multipart/form-data)
```

| 필드 | 기본값 | 비고 |
|---|---|---|
| `audio` | (필수) | webm/opus·wav·mp3·m4a·ogg·flac·mp4 |
| `use_hotwords` | `true` | **켬/끔 플래그만 받는다.** 어휘 문자열은 받지 않는다 |
| `vad_filter` | `true` | 끄면 무음 구간 환각이 그대로 나온다 (아래 참조) |
| `model` | 엔진 기본값 | |
| `language` | `ko` | |
| `engine_id` | 첫 번째 엔진 | |

응답: `text` · `segments` · `words` · `avg_logprob` · `no_speech_prob` · `mean_word_prob` ·
`min_word_prob` · `engine` · `model` · `device` · `compute_type` · `duration_sec` · `elapsed_sec` ·
`load_sec` · `rtf` · `applied_options` · `extra` · `audio_ref`.

**세 수치를 하나로 합치지 않는다.** Whisper는 단일 confidence를 주지 않으므로
`avg_logprob`·`no_speech_prob`·평균 단어 확률을 각각 그대로 올려보낸다. 임의 가중합을 만들면
`VZ-L-03` 임계를 실측할 근거가 사라진다. 판정은 화면 쪽 `src/stt/confidence.ts` 한 곳에서만 한다.

세그먼트가 여럿일 때 대표값은 **불리한 쪽**으로 고른다 — `avg_logprob`은 최소, `no_speech_prob`은 최대.
평균을 내면 한 구간의 오인식이 나머지에 묻힌다. 원본 배열도 함께 나가므로 분포를 다시 볼 수 있다.

### hotwords를 요청에서 받지 않는 이유 (`REQ-305`)

화면이 보낸 어휘 문자열을 믿으면 레지스트리가 바뀌었을 때 **조용히 옛 어휘로 인식**한다.
그래서 매 요청마다 `vocab.py`가 원본에서 새로 뽑는다. 원본은
`web-dashboard/mock-gateway/registry.json`을 **읽기만** 하고 복사본을 두지 않는다.
경로는 `VIZ_STT_REGISTRY`로 바꿀 수 있다.

실제로 몇 개가 적용됐는지는 응답 `applied_options.hotword_count`에 실려 나가고 화면이 그 값을 표시한다.
요청했는데 0이면 "요청했지만 안 먹었다"는 뜻이다 — `engines/base.py`가 약속한 규칙이다.

## 무엇을 어디에 남기는가

| | |
|---|---|
| 녹음 원본 | `stt/recordings/` — `.gitignore`로 제외 |
| 응답의 `audio_ref` | `recordings/<타임스탬프>-<6자리>.<확장자>` (이 폴더 기준 상대 경로) |
| 실행 기록 | **남기지 않는다.** 실험 기록 적재는 `stt-lab/`의 일이다 |

오디오를 보관하는 이유는 `contracts/mission.schema.json`의 `utterance.audio_ref`가 요구하기 때문이다.
버리면 오인식을 다시 들어볼 수 없고 `VZ-L-03` 임계 실측의 원자료도 사라진다.
**사람 목소리와 발화 내용이 들어 있으므로 저장소에 올리지 않는다.**

## 포트

`8801`. 기존과 겹치지 않는다 — web-dashboard `5173`/`8787~8788`, viz `5174`,
목 게이트웨이 `8790`, stt-lab `8799`. `VIZ_STT_PORT`로 바꿀 수 있고, 바꾸면 화면 쪽
`VITE_STT_URL`도 함께 바꿔야 한다.

## torch는 없다

faster-whisper는 CTranslate2 런타임이라 PyTorch가 필요 없다.
`pip list`에 `torch`가 보이면 엔진을 잘못 잡은 것이다.

`requirements.txt` 맨 위의 `# -*- coding: utf-8 -*-`를 지우지 말 것 — pip는 이 파일을 로케일
인코딩(한국어 Windows에서는 cp949)으로 읽어서, 그 줄이 없으면 한글 주석 때문에
`UnicodeDecodeError`로 설치가 통째로 실패한다.
