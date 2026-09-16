/**
 * src/tabs/views/ZoneMapMini.tsx (260831 신설)
 *
 * 탭② **구역 맵 미니뷰** — 2편(사각지대 탐지)의 「가상 맵」.
 *
 * 가상 맵 본체는 Unity 트윈(VZ-U-02 · 별도 앱) 몫이지만 이번 시연은 웹 하나로 본다.
 * 503호 평면 · 카메라 시야(FOV) · 사각지대 칸 · 로봇 위치 · 칸별 마지막 탐지 시각을 그린다.
 *
 * 데이터 경로는 둘이다:
 *  - 로봇 위치      : 기존 `telemetry.position` (이미 있다 — site-global 좌표)
 *  - 시야·칸·탐지 시각: 새 채널 `coverage` (camera-02 · 대본이 몰아 주는 합성본)
 *
 * 맵의 좌표계는 로봇 telemetry 와 같은 **site-global** 이다 — 화면에 좌표 변환이 있으면
 * 안 되기 때문이다(REQ-302, 변환은 백엔드 책임).
 *
 * 평소(placeholder 기본값)에는 자리표시다 — 실제로는 백엔드 디지털 트윈(DT-04 커버리지 ·
 * DT-05 시의성)이 줄 데이터다. scenario 모드에서 대본에 맵이 없으면(1·3편)
 * **로봇 위치·궤적만** 그린다(RobotTrailMap — 평면은 맵 데이터가 올 때 얹는다).
 */

import { useEffect, useState } from 'react';
import { useMission } from '../../data/scenario.ts';
import { PendingSource } from '../../shared/PendingSource.tsx';
import { useScenarioCast } from '../../shared/renderMode.ts';
import { useEntities } from '../data/hooks.ts';
import { Explain } from '../../shared/Explain.tsx';

const MAP_MIN_HEIGHT = 220;

type CoveragePayload = {
  mission_id?: string;
  at_sec?: number;
  rescan_threshold_sec?: number | null;
  cells?: Array<{ cell: string; last_scan_at_sec: number | null }>;
};

export function ZoneMapMini() {
  const scenarioCast = useScenarioCast();

  return (
    <section className="panel zonemap">
      <header className="panel__head">
        <h2 className="panel__title">구역 맵 미니뷰</h2>
        <span className="panel__tag">VZ-U-01 · VZ-U-02(웹 축소판)</span>
      </header>
      {scenarioCast === null
        ? <PendingSource id="zone-map" minHeight={MAP_MIN_HEIGHT} />
        : <ScenarioMap />}
    </section>
  );
}

function ScenarioMap() {
  const mission = useMission();
  const entities = useEntities();
  const map = mission.current.map;

  // 맵(평면) 데이터가 없는 대본(1·3편) — 로봇 위치·궤적만 그린다 (8/31 점검 후 결정 b).
  // 구역 평면·시야는 맵 데이터를 불러올 수 있을 때(백엔드 DT-04) 이 위에 얹는다.
  if (map === null) return <RobotTrailMap />;

  const coverage = (entities.get(map.camera.entity)?.coverage?.payload ?? null) as CoveragePayload | null;
  const threshold = coverage?.rescan_threshold_sec ?? null;
  // 「지금」은 대본 시각이다 — 재생 머리. 10분(600초) 지나면 칸이 다시 비어 보인다.
  const nowSec = mission.headSec;

  const { room } = map;
  const width = room.x_max - room.x_min;
  const depth = room.z_max - room.z_min;
  // site-global x → SVG x. z 는 북쪽(z_max)이 위로 오도록 뒤집는다. 변환은 이 표시 뒤집기뿐이다.
  const sx = (x: number) => x - room.x_min;
  const sy = (z: number) => room.z_max - z;

  const robot = robotPosition(entities, mission.current.cast);

  return (
    <div className="zonemap__body">
      <svg viewBox={`-0.5 -0.5 ${width + 1} ${depth + 1}`} className="zonemap__svg" role="img" aria-label="구역 맵">
        {/* 503호 평면 */}
        <rect x={0} y={0} width={width} height={depth} className="zonemap__room" />
        {/* 카메라 시야 (FOV 투영) */}
        <polygon
          points={map.camera.fov_polygon.map(([x, z]) => `${sx(x)},${sy(z)}`).join(' ')}
          className="zonemap__fov"
        />
        {/* 사각지대 칸 — 채워지면 초록, 임계 초과·미탐색이면 빈 칸 */}
        {map.blind_cells.map((cell) => {
          const scan = coverage?.cells?.find((c) => c.cell === cell.id)?.last_scan_at_sec ?? null;
          const fresh = scan !== null && (threshold === null || nowSec - scan <= threshold);
          const cx = sx((cell.x_min + cell.x_max) / 2);
          const cy = sy((cell.z_min + cell.z_max) / 2);
          return (
            <g key={cell.id}>
              <rect
                x={sx(cell.x_min)} y={sy(cell.z_max)}
                width={cell.x_max - cell.x_min} height={cell.z_max - cell.z_min}
                className={fresh ? 'zonemap__cell zonemap__cell--filled' : 'zonemap__cell'}
              >
                <title>{cell.id} · {cell.reason}</title>
              </rect>
              <text x={cx} y={cy - 0.35} className="zonemap__celllabel">{cell.id}</text>
              <text x={cx} y={cy + 0.75} className="zonemap__celltime">
                {scan === null ? '미탐색' : nowSec - scan > (threshold ?? Infinity) ? `T+${scan}s · 경과 초과` : `마지막 탐지 T+${scan}s`}
              </text>
            </g>
          );
        })}
        {/* 카메라 */}
        <circle cx={sx(map.camera.position.x)} cy={sy(map.camera.position.z)} r={0.35} className="zonemap__camera" />
        <text x={sx(map.camera.position.x) + 0.5} y={sy(map.camera.position.z) + 0.2} className="zonemap__celllabel">{map.camera.entity}</text>
        {/* 로봇 — telemetry.position (site-global, 변환 없음) */}
        {robot !== null && (
          <g>
            <circle cx={sx(robot.x)} cy={sy(robot.z)} r={0.4} className="zonemap__robot" />
            <text x={sx(robot.x) + 0.55} y={sy(robot.z) + 0.2} className="zonemap__celllabel">{robot.id}</text>
          </g>
        )}
      </svg>
      <Explain id="map-1" className="note note--dim">
        시야(FOV)·사각지대·탐지 시각은 대본의 합성본 — 실제 원천은 백엔드 디지털 트윈(DT-04 · DT-05).
        로봇 위치는 telemetry.position(site-global) 그대로다. 재탐색 임계 {threshold ?? '—'}초.
      </Explain>
    </div>
  );
}

/**
 * 맵(평면) 데이터가 없는 대본의 미니뷰 — **로봇 위치·궤적만** 그린다 (8/31 점검 후 결정 b).
 *
 * 1편(503호 → 복도 → 엘리베이터)의 이동이 미니뷰에서도 보여야 하는데, 그 경로의 평면
 * (복도·엘리베이터 홀)은 어느 데이터에도 없다 — 지어내지 않고 위치·궤적만 그린다.
 * 구역 평면·시야는 **나중에 맵 데이터를 불러올 수 있을 때**(백엔드 DT-04) 이 위에 얹는다.
 * 궤적은 수신한 telemetry.position 을 화면이 쌓은 것이다(합성 아님 — 받은 값의 기록).
 */
function RobotTrailMap() {
  const mission = useMission();
  const entities = useEntities();
  const robot = robotPosition(entities, mission.current.cast);
  const [trail, setTrail] = useState<Array<{ x: number; z: number }>>([]);
  const missionId = mission.current.missionId;

  // 임무가 바뀌면 궤적을 비운다 — 다른 대본의 길이 겹쳐 보이면 안 된다.
  useEffect(() => setTrail([]), [missionId]);
  useEffect(() => {
    if (robot === null) return;
    setTrail((current) => {
      const last = current.at(-1);
      if (last !== undefined && Math.hypot(last.x - robot.x, last.z - robot.z) < 0.05) return current;
      const next = [...current, { x: robot.x, z: robot.z }];
      return next.length > 400 ? next.slice(-400) : next;
    });
  }, [robot?.x, robot?.z]);

  const points = robot === null ? trail : [...trail, { x: robot.x, z: robot.z }];
  if (points.length === 0) {
    return (
      <p className="zonemap__empty" style={{ minHeight: MAP_MIN_HEIGHT }}>
        위치를 낼 로봇이 아직 없습니다 — 로봇이 등장하는 대본(1·2편)에서 위치·궤적이 그려집니다.
      </p>
    );
  }

  // 보기 범위는 궤적에 맞춘다 (여백 2 m · 최소 폭 8 m). 좌표는 site-global 그대로다.
  const xs = points.map((p) => p.x); const zs = points.map((p) => p.z);
  const pad = 2; const minSpan = 8;
  let xMin = Math.min(...xs) - pad; let xMax = Math.max(...xs) + pad;
  let zMin = Math.min(...zs) - pad; let zMax = Math.max(...zs) + pad;
  if (xMax - xMin < minSpan) { const c = (xMin + xMax) / 2; xMin = c - minSpan / 2; xMax = c + minSpan / 2; }
  if (zMax - zMin < minSpan) { const c = (zMin + zMax) / 2; zMin = c - minSpan / 2; zMax = c + minSpan / 2; }
  const sx = (x: number) => x - xMin;
  const sy = (z: number) => zMax - z; // 북쪽(z 큰 쪽)이 위 — 2편 맵과 같은 방향.

  return (
    <div className="zonemap__body">
      <svg viewBox={`0 0 ${xMax - xMin} ${zMax - zMin}`} className="zonemap__svg" role="img" aria-label="로봇 위치·궤적">
        <polyline className="zonemap__trail" points={points.map((p) => `${sx(p.x)},${sy(p.z)}`).join(' ')} />
        {trail[0] !== undefined && <circle cx={sx(trail[0].x)} cy={sy(trail[0].z)} r={0.25} className="zonemap__trailstart" />}
        {robot !== null && (
          <g>
            <circle cx={sx(robot.x)} cy={sy(robot.z)} r={0.4} className="zonemap__robot" />
            <text x={sx(robot.x) + 0.55} y={sy(robot.z) + 0.2} className="zonemap__celllabel">{robot.id}</text>
          </g>
        )}
      </svg>
      <Explain id="map-2" className="note note--dim">
        이 대본에는 평면(맵) 데이터가 없어 로봇 위치·궤적만 그립니다 — 위치는 telemetry.position
        (site-global) 그대로, 궤적은 수신값의 누적입니다. 구역 평면·시야는 맵 데이터가 오면
        (백엔드 DT-04) 이 위에 그려집니다.
      </Explain>
    </div>
  );
}

/** cast 의 로봇 하나 — telemetry.position 의 전역 좌표. 없으면 안 그린다(지어내지 않는다). */
function robotPosition(
  entities: ReadonlyMap<string, { telemetry: { payload: unknown } | null }>,
  cast: readonly string[],
): { id: string; x: number; z: number } | null {
  for (const id of cast) {
    const payload = entities.get(id)?.telemetry?.payload as
      | { position?: { x?: number; z?: number } }
      | undefined;
    const pos = payload?.position;
    if (pos && typeof pos.x === 'number' && typeof pos.z === 'number') {
      return { id, x: pos.x, z: pos.z };
    }
  }
  return null;
}
