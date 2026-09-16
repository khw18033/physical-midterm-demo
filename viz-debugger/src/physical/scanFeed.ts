/**
 * src/physical/scanFeed.ts (260914 신설)
 *
 * **로봇이 탐지에게 보내는 것을 화면도 듣는다.** 규약은 `physical_demo/detection-protocol_0914.md`.
 *
 *   zoneA/robot/go1-001/frame   방향마다 1건 — JPEG(base64) + rotation_deg + seq + sha1
 *   zoneA/robot/go1-001/scan    한 판의 시작·끝 — scan_start / scan_end
 *
 * 탐지는 이 둘을 받아 결과를 만든다. 결과가 안 오면 **로봇이 안 보냈는지 탐지가 못 받았는지**
 * 가를 수 있어야 하는데, 지금까지 화면은 앞의 절반을 볼 수 없었다. 같은 브로커에 붙어 있으니
 * 같이 들으면 된다.
 *
 * **그림은 화면이 들고 있지 않는다.** 한 장이 34 KB 이고 화면이 쓸 곳이 없다 — 탐지가 상자를 입혀
 * HTTP 로 다시 내준다. 다만 임무 기록(260914)이 원본을 파일로 남기므로 `imageBase64` 로 한 번
 * 넘겨준다 — 받는 쪽이 저장소에 담지 않고 곧바로 흘려보낸다.
 *
 * 토픽 문자열은 여기 없다 — 브로커·토픽을 아는 면은 `PhysicalClient.ts` 하나다.
 */

export type ScanFeedMessage =
  | {
    kind: 'frame';
    deviceId: string;
    missionId: string | null;
    seq: number | null;
    rotationDeg: number;
    width: number | null;
    height: number | null;
    /** JPEG 바이트 수. 로봇이 적어 준 값이고, 없으면 base64 길이로 어림한다. */
    bytes: number | null;
    sha1: string | null;
    /** 직전 프레임과 바이트까지 같다 — 카메라가 얼었다는 뜻이다. 이 판은 탐지가 버린다. */
    duplicateOfPrev: boolean;
    timestamp: string | null;
    /** JPEG 원본(base64). 기록기만 쓴다 — 저장소에 담지 않는다. 없으면 null. */
    imageBase64: string | null;
  }
  | {
    kind: 'scan';
    deviceId: string;
    missionId: string | null;
    event: 'scan_start' | 'scan_end';
    /** scan_start 의 계획 장수 · scan_end 의 기대 장수. */
    expectedFrames: number | null;
    /** scan_end 에만 — 실제로 보낸 장수. */
    framesSent: number | null;
    /** scan_end 에만 — SUCCEEDED · ABORTED · CANCELED. */
    outcome: string | null;
    timestamp: string | null;
  };

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** 이 토픽이 스캔 흐름인가. 채널 이름(마지막 칸)으로 가른다. */
export function scanFeedChannel(topic: string): 'frame' | 'scan' | null {
  const channel = topic.split('/').at(-1);
  return channel === 'frame' || channel === 'scan' ? channel : null;
}

/**
 * 한 건을 뜯는다. **규약에 안 맞으면 null** — 지어 채우지 않는다.
 * 각도가 없는 프레임은 버린다: 탐지가 쓰는 짝이 (그림, 각도)라 각도 없는 프레임은 짝이 아니다.
 */
export function parseScanFeed(topic: string, body: Record<string, unknown>): ScanFeedMessage | null {
  const channel = scanFeedChannel(topic);
  if (channel === null) return null;
  const deviceId = str(body.device_id) ?? topic.split('/').at(-2) ?? '';
  const missionId = str(body.mission_id);
  const timestamp = str(body.timestamp);

  if (channel === 'frame') {
    const rotationDeg = num(body.rotation_deg);
    if (rotationDeg === null) return null;
    const image = typeof body.image === 'string' ? body.image : '';
    return {
      kind: 'frame',
      deviceId,
      missionId,
      seq: num(body.seq),
      rotationDeg,
      width: num(body.width),
      height: num(body.height),
      bytes: num(body.bytes) ?? (image === '' ? null : Math.floor(image.length * 3 / 4)),
      sha1: str(body.sha1),
      duplicateOfPrev: body.duplicate_of_prev === true,
      timestamp,
      imageBase64: image === '' ? null : image,
    };
  }

  const event = body.event;
  if (event !== 'scan_start' && event !== 'scan_end') return null;
  const plan = body.plan as Record<string, unknown> | undefined;
  return {
    kind: 'scan',
    deviceId,
    missionId,
    event,
    expectedFrames: num(body.expected_frames) ?? num(plan?.expected_frames) ?? num(plan?.steps),
    framesSent: num(body.frames_sent),
    outcome: str(body.outcome),
    timestamp,
  };
}
