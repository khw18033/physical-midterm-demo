/**
 * src/views/DeviceStatusOverlay.tsx (260904 — 추가 개선 2)
 *
 * 하드웨어 카드를 **더블클릭하면 그 대상의 상태**를 연다. 새 기능이 아니라
 * `VZ-D-07`(대상 배정과 **대상 상태 조회**)의 미구현분이다 — 카드가 드래그로 배정만 되고
 * 눌러도 아무 일이 없었다.
 *
 * ## 규칙은 `VZ-N-05`(확대) 그대로다
 *
 * | 조건 | 여기서 |
 * |---|---|
 * | 오버레이다 | `ZoomOverlay`·`ActionModal` 과 같은 `.modal-backdrop` 위에 얹는다 |
 * | 뒤를 교체하지 않는다 | 마일스톤 목록·하드웨어 목록은 언마운트되지 않는다. 형제로 얹힐 뿐이다 |
 * | 동시 하나 | 상태가 **문자열 하나**(`statusDeviceId`)다. 배열이면 둘이 열린다 |
 * | 닫는 길이 둘 이상 | 닫기 버튼 · Esc · 배경 누르기 |
 *
 * ## 지어내지 않는다 — 다만 오는 것은 보여 준다 (260910)
 *
 * 8/31 결정은 registry 장비의 실측값을 **지어내지 않는다**였고, 그건 값을 줄 채널이
 * 없었기 때문이다. 이제 `zoneA/<type>/<id>/{status,state}` 가 온다.
 *
 * **지어내지 않는 것은 그대로**이고, 안 오는 칸을 「연결 예정」 자리표시로 채우던 것을
 * 걷어냈다 — 시연 화면에서 그 문구가 연결 전 테스트처럼 보인다는 지적이 있었다.
 * 오는 값만 적고, 안 오는 것은 **아예 안 그린다.**
 *
 * 카메라 연결 상태는 여전히 MQTT 로 안 나온다(연동 가이드 §3-4) — 노드 상태 요약에
 * 필드가 추가돼야 한다. 그 칸도 자리표시 대신 없앴다.
 */

import { useEffect } from 'react';
import type { Hardware } from '../model/types.ts';
import { DeviceStrip } from './DeviceStrip.tsx';
import { DeviceFacts } from '../physical/DeviceFacts.tsx';

export function DeviceStatusOverlay({ deviceId, device, source, onClose }: {
  deviceId: string;
  /** 시나리오에 실측 목록이 실려 있을 때만 있다. 대본 세계에서는 없다. */
  device?: Hardware;
  /** 이 목록이 어디서 왔는가. 화면이 목임을 감추지 않는다. */
  source: string;
  onClose(): void;
}) {
  // 여는 길이 둘(더블클릭·앞으로 늘 수 있는 다른 경로)이면 닫는 길도 둘 이상이어야 한다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal device-modal" role="dialog" aria-label={`${deviceId} 대상 상태`}>
      <header>
        <div>
          <h2>{deviceId} · 대상 상태</h2>
          <small>{device ? `${device.kind} · ` : ''}원천 {source} · VZ-D-07 대상 상태 조회</small>
        </div>
        <button onClick={onClose}>닫기 (Esc)</button>
      </header>
      {/* **오는 값만 적는다** (260910). 안 오는 칸은 자리표시로 채우지 않고 아예 안 그린다. */}
      <DeviceFacts entityId={deviceId} />
      {device !== undefined && <DeviceStrip device={device} />}
      <footer>
        <span>이 창은 뒤의 목록을 교체하지 않습니다 — 닫으면 같은 자리입니다.</span>
      </footer>
    </section>
  </div>;
}
