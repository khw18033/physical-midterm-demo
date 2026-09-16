/**
 * src/record/loadRecord.ts (260914 신설)
 *
 * **저장된 판을 다시 본다.** 기록 파일을 읽어 기록기가 떠 둔 그대로 저장소에 도로 채운다 — 그러면
 * 지금 판을 그리는 **같은 화면**이 지난 판을 그린다. 그래프 노드 상태 · 여덟 칸 · 액션 아이템의
 * 로봇 명령과 탐지 로그 · 경로 산출 과정 · 2D 맵 · 탐지 영상이 모두 그 판의 것이다.
 *
 * 순서가 뜻이다.
 *  1. 지금 판을 봉인한다 — 리허설 도중에 눌러도 그 판은 거기까지 파일로 남는다.
 *  2. 다시보기 표시를 켠다 — 그 뒤로 채우는 값에 탐지 구독·로봇 수신기·준비 단계가 반응하지 않는다.
 *  3. 로봇 명령 · 탐지 결과 · 로그 · 준비 값을 채운다.
 *  4. 임무와 기록 열을 올린다 — 화면이 이것을 보고 다시 그린다.
 *
 * 로봇은 붙어 있는 채로 둔다. 다시보기는 로봇에 아무것도 안 보낸다(승인이 안 되살아난다).
 */

import type { MissionView } from '../data/scenario.ts';
import { loadRecordedMission } from '../data/scenario.ts';
import { sealRun } from '../data/missionHistory.ts';
import { floorPlanUrls } from '../detect/DetectClient.ts';
import { restoreDetectLog, type DetectLogLine } from '../detect/detectLog.ts';
import { restoreDetect, type RecordedDetect } from '../detect/store.ts';
import type { ScenarioEvent } from '../model/types.ts';
import { restorePrepStage, type PrepState } from '../physical/prepStage.ts';
import { restoreRobotSession, type RecordedRobotSession } from '../physical/robotSession.ts';
import type { ArrivedFrame } from '../viewpoint/store.ts';
import { fetchRecordJson } from './recordClient.ts';
import { enterRecordReplay, leaveRecordReplay } from './replayMode.ts';

type MissionFile = { schema?: string; view?: MissionView };
type ProgressFile = {
  schema?: string;
  headSec?: number;
  trace?: ScenarioEvent[];
  viewpointFrames?: ArrivedFrame[];
  robot?: Partial<RecordedRobotSession>;
  detect?: Partial<RecordedDetect>;
  detectLog?: DetectLogLine[];
  prep?: PrepState;
};

export type OpenResult = { ok: true } | { ok: false; reason: string };

export async function openRecordedRun(date: string, run: string): Promise<OpenResult> {
  let mission: MissionFile;
  let progress: ProgressFile;
  try {
    [mission, progress] = await Promise.all([
      fetchRecordJson<MissionFile>(date, run, 'mission.json'),
      fetchRecordJson<ProgressFile>(date, run, 'progress.json'),
    ]);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const view = mission.view;
  if (view === undefined || !Array.isArray(view.tasks)) return { ok: false, reason: 'mission.json 에 임무 정의(view)가 없습니다' };

  sealRun();
  enterRecordReplay(date, run);
  try {
    restoreRobotSession(progress.robot ?? {});
    restoreDetect(progress.detect ?? {}, { date, run });
    restoreDetectLog(progress.detectLog ?? []);
    if (progress.prep !== undefined) {
      const map = progress.prep.map;
      // 도면 주소는 그 판의 기록 폴더로 — 탐지 창구의 도면은 판마다 지워진다. 기록에 없으면 저장소 사본.
      const urls = floorPlanUrls({ kind: 'record', date, run });
      restorePrepStage({
        ...progress.prep,
        map: { ...map, url: map.url === null ? null : map.bundled ? map.url : urls[0] },
      });
    }
    loadRecordedMission(view, progress.trace ?? [], progress.viewpointFrames ?? [], progress.headSec ?? 0);
  } catch (error) {
    leaveRecordReplay();
    return { ok: false, reason: `기록을 채우다 멈췄습니다 — ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true };
}
