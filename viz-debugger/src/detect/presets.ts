/**
 * src/detect/presets.ts (260914 신설)
 *
 * **탐지 서비스 주소의 네트워크 환경 프리셋.** 로봇(`src/physical/presets.ts` 의
 * `BROKER_PRESETS`)과 같은 모양이고, 연결 관리가 같은 칸으로 그린다.
 *
 * ## 탐지는 시연장 밖에 있다
 *
 * 탐지 프로그램은 GPU 가 있는 데스크톱(`desktop-oaujese`)에서 돈다. 데스크톱은 시연장에
 * 못 가져가므로 **관제 웹(노트북) · 로봇(pi7) · 탐지(데스크톱)가 전부 테일넷으로 붙는다.**
 * 그래서 기본값이 Tailscale 이름이다 — 로봇 기본값을 Tailscale 로 옮긴 260913 과 같은 이유다.
 *
 * 포트 8000 은 `physical_demo` 의 `detect_api_server.py` 기본값이다.
 *
 * **여기 밖에서 탐지 주소 문자열을 만들지 않는다** — 탐지를 아는 면은 `src/detect/` 하나다.
 */

export type DetectPreset = {
  id: string;
  label: string;
  /** 빈 문자열이면 **아직 값이 없다는 뜻**이다. 화면이 고를 수 없게 막는다. */
  url: string;
  why: string;
};

export const DETECT_PRESETS: readonly DetectPreset[] = [
  // **기본값.** 노트북이 어느 망에 있든 같은 이름으로 데스크톱에 닿는다.
  { id: 'tailscale', label: 'Tailscale', url: 'http://desktop-oaujese.tailcb6bfb.ts.net:8000', why: '기본값. 탐지 데스크톱의 테일넷 이름' },
  // 노트북에서 MagicDNS 가 꺼져 있으면 이름이 안 풀린다 — 그때는 테일넷 IP 로 붙는다.
  { id: 'tailscale-ip', label: 'Tailscale (IP)', url: 'http://100.125.71.51:8000', why: '이름이 안 풀릴 때. 테일넷 IP 는 기기가 바뀌지 않는 한 그대로다' },
  // 관제 웹과 탐지를 한 PC 에서 같이 돌릴 때(데스크톱에서 개발·점검할 때).
  { id: 'local', label: '같은 PC', url: 'http://127.0.0.1:8000', why: '관제 웹과 탐지가 한 PC 에 있을 때' },
  { id: 'manual', label: '직접 입력', url: '', why: '사용자가 적는다' },
];

/** 고를 수 있는 프리셋인가. 값이 빈 것은 아직 없는 것이다. */
export function detectPresetReady(preset: DetectPreset): boolean {
  return preset.id === 'manual' || preset.url.trim() !== '';
}
