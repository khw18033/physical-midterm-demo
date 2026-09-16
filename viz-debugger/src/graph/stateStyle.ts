import type { TaskStatus } from '../model/types.ts';

export const STATE_STYLE: Record<TaskStatus, { label: string; icon: string; className: string }> = {
  pending: { label: '대기', icon: '·', className: 'state-pending' },
  running: { label: '진행', icon: '▶', className: 'state-running' },
  done: { label: '완료', icon: '✓', className: 'state-done' },
  failed: { label: '실패', icon: '×', className: 'state-failed' },
  skipped: { label: '건너뜀', icon: '↷', className: 'state-skipped' },
  awaiting_evaluation: { label: '평가 대기', icon: '◌', className: 'state-awaiting' },
  not_executed: { label: '미수행', icon: '—', className: 'state-not-executed' },
  rerunning: { label: '재실행', icon: '↻', className: 'state-rerunning' },
};
