export type AppRole = { role: string; zones: readonly string[] };

/** 권한 판정의 공통 경계. 실제 역할 응답 연결 전에는 읽기/시연 범위만 허용한다. */
export function canIssueCommands(role: AppRole) {
  return role.role === 'operator' || role.role === 'admin';
}
