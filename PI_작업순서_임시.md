# Pi 작업 순서 (임시)

**이 파일만 보고 순서대로 하면 된다.** 자세한 이유는 [`docs/00_통합개발계획서_x500.md`](docs/00_통합개발계획서_x500.md).

> 🗑 **임시 파일이다.** 8번까지 끝나면 이 파일과 `.gitignore` 의 해당 줄을 지운다.

---

## ⚠ 시작 전 세 가지

1. **프로펠러를 제거한 상태로 한다** (8번에서 모터가 돈다)
2. **arm 상태에서는 어떤 서비스도 재시작하지 않는다**
3. **1번(기준선)을 2번(pull) 보다 먼저 한다** — 순서가 바뀌면 기준선의 의미가 없어진다

---

## 0. 시작 확인

```bash
cd ~/drone
git branch --show-current
git status --short
git fetch origin
cat state/mode
```

✅ `drone-pi3` / `git status` 가 **비어 있음** / `mode` 가 `drone`

> `git status` 에 뭔가 나오면 **여기서 멈추고 알려 줄 것.** 4번의 `--ff-only` 가 막힌다.

---

## 1. 기준선 — ★ pull 하기 전에

```bash
cd ~/drone && mkdir -p baseline/fc_260924
date -Is                                  | tee baseline/fc_260924/TIMESTAMP
git log --oneline -1                      | tee baseline/fc_260924/git-head.txt
systemctl is-active drone-detect drone-mavlink-router drone-linkmon drone-node \
                                          | tee baseline/fc_260924/services.txt
cat state/mode                            | tee baseline/fc_260924/mode.txt
vcgencmd get_throttled                    | tee baseline/fc_260924/throttled.txt
vcgencmd measure_temp                     | tee baseline/fc_260924/temp.txt
./venv/bin/python scripts/fc_state.py     | tee baseline/fc_260924/fc_state.txt
./venv/bin/python scripts/check_link.py --device udpin:0.0.0.0:14540 \
                                          | tee baseline/fc_260924/check_link.txt
```

✅ `services` 전부 `active` / `throttled=0x0` / `check_link` 가 **성공(종료 코드 0)**

---

## 2. 코드 받기

```bash
cd ~/drone && git merge --ff-only origin/drone-pi3 && git log --oneline -1
```

✅ `87d417f` 가 보인다

---

## 3. import 스모크 — ★ 받은 직후 바로

```bash
cd ~/drone/scripts
../venv/bin/python -c "import dronelink, fc_detect, linkmon, check_link; print('import ok')"
cd ~/drone
```

✅ `import ok`

> ❌ 실패하면 **더 진행하지 말고** 9번 롤백 후 알려 줄 것.
> 이게 깨진 상태로 두면 `drone-detect` 가 재시작될 때 부팅 경로가 죽는다.

---

## 4. FC 파라미터 감사 (확장판)

```bash
cd ~/drone
./venv/bin/python scripts/failsafe_audit.py | tee baseline/fc_260924/failsafe.txt
```

✅ 출력 맨 아래 "비행 중 이런 일이 일어나면" 단락까지 나온다

**★ 여기서 두 값을 확인해 알려 줄 것** (아래 10번)

---

## 5. 기준선 커밋

```bash
cd ~/drone
git add baseline/fc_260924/ && git commit -m "P0-3: FC 기준선 스냅샷 (2026-09-27)"
```

✅ 커밋됨 — **커밋해야 기준선이다**

---

## 6. `PROGRESS.md` 에 3단계 통과 기록

`drone/PROGRESS.md` **맨 뒤**에 덧붙인다. 지금 저장소는 아직 arm 이 거부됐다고 적고 있다.

- [ ] 3단계 통과 일시
- [ ] **실내 / 실외** ← 가장 중요 (`heading` 이 여기에 좌우된다)
- [ ] GPS `fix_type` · 위성 수 · `system_status`
- [ ] arm 까지 걸린 시간 · 모터 4개 상태
- [ ] 안전 스위치를 눌렀는지
- [ ] 기준선 경로 `drone/baseline/fc_260924/`

그리고 `drone/FLIGHT_CHECKLIST_x500.md` §7 의 **"PX4 가 `action.arm()` 을 수락하는가"** 를
"아직 모르는 것" → **"검증 끝"** 으로 옮긴다.

---

## 7. 서비스 재시작

```bash
sudo systemctl restart drone-detect
sleep 12 && cat ~/drone/state/mode
systemctl is-active drone-mavlink-router drone-linkmon drone-node
```

✅ `mode` 가 **`drone`** / 나머지 셋 전부 `active`

> ⚠ `systemctl is-active drone-detect` 로 판정하지 말 것.
> 실패해도 계속 재시작해서 "도는 것처럼" 보인다. **판정은 `state/mode` 로 한다.**

---

## 8. arm 재확인 — 회귀가 없다는 증명

```bash
cd ~/drone && ./venv/bin/python scripts/arm_disarm_test.py
```

**프로펠러가 빠져 있는지 다시 확인.** 3단계를 통과했던 것과 같은 조건(실내/실외)에서 한다.

✅ 모터 4개 회전 → `DISARMED ✔`

**여기까지 통과하면 끝이다.**

---

## 9. 롤백 (3·7·8번이 실패했을 때)

```bash
cd ~/drone
cat baseline/fc_260924/git-head.txt          # 변경 전 해시
git checkout <그 해시> -- scripts/dronelink.py scripts/check_link.py
sudo systemctl restart drone-detect
sleep 12 && cat state/mode                   # drone 으로 돌아오는지
```

---

## 10. ★ 알려 줄 것

4번 `failsafe.txt` 에서 이 두 값:

| 값 | 왜 |
|---|---|
| **`NAV_DLL_ACT`** | **0** = 파이가 죽어도 기체가 계속 호버 → **조종기로 내려야 함**. **0 아님** = 스스로 RTL·착륙 → 놀라서 개입하면 위험. **비행 시나리오가 갈린다** |
| **`COM_DISARM_PRFLT`** | arm 후 자동 disarm 까지의 시간. 다음 단계 코드의 타임아웃을 이보다 짧게 잡아야 한다 |

그리고 8번 결과 (통과 / 실패 + 메시지).

→ 이 값들을 받아 **P2(모드 로깅)** 코드부터 작성한다.
