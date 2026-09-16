/**
 * src/views/DeviceCard.tsx
 *
 * 장치 카드 한 장. 표시값은 전부 **파생**이며 여기서 판정하지 않는다.
 *  - 4종 구분은 statusModel.deriveDisplayStatus(3층 원본)
 *  - stale 여부는 서버가 이미 판정해서 availability에 실어 보낸 값
 *  - 경과 시간은 서버 시각끼리의 뺄셈 (클라이언트 시계 미사용)
 */

import type { EntityRecord } from '../data/index.ts';
import {
  ACTUATOR_PHASE_LABEL,
  COMMAND_DISPLAY_LABEL,
  DISPLAY_STATUS_LABEL,
  aggregationBadge,
  toDisplay,
  deriveDisplayStatus,
  describeActuator,
  formatAge,
  formatLayers,
  lastSeenAgeMs,
} from '../data/index.ts';
import type { ActuatorState, CommandResult } from '../transport/index.ts';

type Props = { record: EntityRecord };

/** 대상 종류별 "지금 무엇을 하고 있는가" 한 줄. 표준 3층과 겹치지 않는 도메인 정보다. */
function domainLine(record: EntityRecord): string | null {
  const type = record.registry?.entity_type;

  if (type === 'robot') {
    const t = record.telemetry?.payload as
      | { battery_pct?: number; is_moving?: boolean; mission?: unknown }
      | undefined;
    if (!t) return null;
    const battery = t.battery_pct === undefined ? '배터리 —' : '배터리 ' + t.battery_pct + '%';
    return battery + ' · ' + (t.is_moving ? '임무 수행 중' : '대기 중');
  }

  if (type === 'sensor') {
    const t = record.telemetry?.payload as
      | { water_level?: { value: number; unit: string }; report_mode?: string }
      | undefined;
    if (!t?.water_level) return null;
    const mode = t.report_mode === 'event' ? '이벤트 모드' : '평시 모드';
    return '수위 ' + t.water_level.value.toFixed(2) + ' m · ' + mode;
  }

  if (type === 'camera') {
    const t = record.videoMeta?.payload as { fps?: number; frame_seq?: number } | undefined;
    if (!t) return null;
    return t.fps + 'fps · 프레임 ' + t.frame_seq;
  }

  if (type === 'actuator') {
    return describeActuator((record.actuator?.payload as ActuatorState | undefined) ?? null);
  }

  if (type === 'edge_node') {
    const m = record.metrics?.payload as { cpu_pct?: { value: number } } | undefined;
    if (!m?.cpu_pct) return null;
    return 'CPU ' + m.cpu_pct.value.toFixed(1) + '%';
  }

  return null;
}

export function DeviceCard({ record }: Props) {
  const layers = record.state?.payload ?? null;
  const status = deriveDisplayStatus(layers);
  const age = lastSeenAgeMs(layers, record.state?.ts ?? null);

  const name = record.registry?.display_name ?? record.id;
  const domain = domainLine(record);

  const actuator = (record.actuator?.payload as ActuatorState | undefined) ?? null;
  const commandResult = (record.commandResult?.payload as CommandResult | undefined) ?? null;

  // 이 카드의 도메인 값이 어느 채널에서 왔는지에 따라 집약 표기가 달라진다.
  const valueSlot = record.metrics ?? record.telemetry ?? null;
  const valueBadge = valueSlot === null ? null : aggregationBadge(valueSlot.aggregation);
  const coordinateFrame = record.telemetry?.coordinateFrame ?? null;
  const command = commandResult === null ? null : toDisplay(commandResult.status);

  const footer =
    status === 'not_deployed'
      ? '레지스트리 목록에만 존재'
      : formatAge(age) +
        (layers?.availability === 'stale'
          ? ' · 임계 ' + Math.round(layers.stale_threshold_ms / 1000) + '초'
          : '');

  return (
    <article className={'card card--' + status} data-entity={record.id}>
      <header className="card__head">
        <h3 className="card__title">{record.id}</h3>
        <span className={'badge badge--' + status}>{DISPLAY_STATUS_LABEL[status]}</span>
      </header>

      <p className="card__name">{name}</p>

      {/* 3층 원본 그대로. 뭉쳐 저장하지 않았으므로 세 층을 각각 보여줄 수 있다. */}
      <p className="card__layers">{formatLayers(layers)}</p>

      {domain !== null && (
        <p className="card__domain">
          {domain}
          {/* VZ-C-03 — 이 값이 원본인지 요약인지가 카드에도 보여야 한다.
              표기 해석은 데이터 레이어가 끝냈고 여기서는 붙이기만 한다. */}
          {/* 3상태를 그대로 클래스에 싣는다 — 불리언으로 접으면 '표기 불명'이
              원본처럼 보이고, 그게 이 가드가 막으려는 실패 모드다. */}
          {valueBadge !== null && (
            <span className={'aggbadge aggbadge--' + valueBadge.state} title={valueBadge.title}>
              {valueBadge.short}
            </span>
          )}
        </p>
      )}

      {/* BE-C-04 — 좌표 기준계는 **읽기만** 한다. 변환은 백엔드 단독 책임이다. */}
      {coordinateFrame !== null && (
        <p className="card__frame">
          좌표계 <code>{coordinateFrame}</code> <em>변환은 백엔드가 이미 끝냈다</em>
        </p>
      )}

      {/* 액추에이터는 표준 3층과 **별개인** 자기 어휘를 따로 단다. */}
      {actuator !== null && (
        <p className="card__actuator">
          <span className={'chip chip--act-' + actuator.phase}>{ACTUATOR_PHASE_LABEL[actuator.phase]}</span>
          {command !== null && <span className={'chip chip--cmd-' + command}>{COMMAND_DISPLAY_LABEL[command]}</span>}
          {actuator.control_locked && <span className="chip chip--locked">제어 잠금</span>}
        </p>
      )}

      {layers?.reason != null && <p className="card__reason">{layers.reason}</p>}

      <footer className="card__foot">{footer}</footer>
    </article>
  );
}
