/**
 * src/App.tsx
 *
 * 화면 껍데기. 라우터 라이브러리를 도입하지 않고 탭 하나로 끝낸다 —
 * 이번 범위는 화면 넷이고, 각각 독립적으로 시연 가능해야 한다.
 *
 * **데이터 레이어는 여기서 한 번만 기동한다.** 탭을 옮겨도 구독이 끊기지 않아야
 * 돌아왔을 때 화면이 비지 않는다(VZ-U-03의 "구독을 해제하지 않고 표시 수준만 바꾼다"와 같은 이유).
 */

import { useEffect, useState } from 'react';
import { startDataLayer } from './data/index.ts';
import { useConnectionStatus } from './data/hooks.ts';
import { DeviceGrid } from './views/DeviceGrid.tsx';
import { ControlPanel } from './views/ControlPanel.tsx';
import { MissionView } from './views/MissionView.tsx';
import { MetricsView } from './views/MetricsView.tsx';
import { VideoOverlayView } from './views/VideoOverlayView.tsx';
import { InsightView } from './views/InsightView.tsx';
import { NodeGraphView } from './views/NodeGraphView.tsx';

/** 현재 설계 전제는 구역 1개 (VZ-C-05). */
const ZONE_ID = 'zone-503';

const TABS = [
  { id: 'board', label: '구역 현황판', tag: 'VZ-U-01' },
  { id: 'control', label: '제어 패널', tag: 'VZ-O-01·02·05 · I-05' },
  { id: 'mission', label: '임무 승인·진행', tag: 'VZ-U-07 · U-05' },
  { id: 'metrics', label: '지표 조회', tag: 'VZ-I-04 · C-03' },
  { id: 'video', label: '영상 오버레이', tag: 'VZ-I-06·07·09' },
  { id: 'insight', label: '판단·알림', tag: 'VZ-I-08·10 · O-04 · U-03' },
  { id: 'graph', label: '노드 그래프', tag: 'VZ-U-04' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function App() {
  const [tab, setTab] = useState<TabId>('board');
  const connection = useConnectionStatus();

  // 데이터 레이어 기동은 앱 수명과 같다. 탭 전환으로 구독을 끊지 않는다.
  useEffect(() => startDataLayer(ZONE_ID), []);

  return (
    <>
      <nav className="tabs">
        <span className="tabs__brand">가시화 대시보드</span>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={'tabs__btn' + (tab === t.id ? ' tabs__btn--on' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            <em>{t.tag}</em>
          </button>
        ))}
        <span className={'conn conn--' + connection.state}>
          {connection.state === 'open'
            ? '게이트웨이 연결됨'
            : connection.state === 'reconnecting'
              ? '재연결 중 (' + connection.attempt + '회)'
              : connection.state === 'connecting'
                ? '연결 중'
                : '연결 종료'}
        </span>
      </nav>

      {tab === 'board' && <DeviceGrid />}
      {tab === 'control' && <ControlPanel />}
      {tab === 'mission' && <MissionView />}
      {tab === 'metrics' && <MetricsView />}
      {/* 탭을 떠나면 언마운트되어 프레임 루프가 멈추고 서버 발행도 멈춘다 (VZ-I-06). */}
      {tab === 'video' && <VideoOverlayView />}
      {tab === 'insight' && <InsightView />}
      {tab === 'graph' && <NodeGraphView />}
    </>
  );
}
