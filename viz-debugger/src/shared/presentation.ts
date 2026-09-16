export type OriginKind = 'physical' | 'simulation' | 'replay';

export const ORIGIN_LABEL: Record<OriginKind, string> = {
  physical: '실물',
  simulation: '시뮬레이션',
  replay: '기록 재생',
};
