import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // 목 게이트웨이는 별도 프로세스이므로 프록시하지 않는다 —
  // 접속 주소를 환경변수로 바꿔 끼우는 것이 실제 게이트웨이 전환 방식이다.
});
