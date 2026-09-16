/** 탭② 장치 표시 어휘. 태스크 실행 상태와 의도적으로 분리한다. */
export type DeviceDisplayStatus = 'normal' | 'fault' | 'not_deployed' | 'stale';

/** 탭① 임무 실행 어휘. 장치 상태와 호환 타입으로 취급하지 않는다. */
export type MissionTaskStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'awaiting_evaluation'
  | 'not_executed'
  | 'rerunning';
