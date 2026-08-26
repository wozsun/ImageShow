export type AdminLoginSessionState = {
  established: boolean;
};

// 凭据登录与登录后引导是两个独立阶段。服务端会话一旦建立，后续模块或
// /auth/me 暂时失败时保留这一事实，供调用方通过全新页面安全恢复，而不是
// 再次提交凭据并创建重复会话。
export async function establishAndConfirmAdminSession(
  session: AdminLoginSessionState,
  establishSession: () => Promise<void>,
  confirmSession: () => Promise<boolean>
) {
  if (!session.established) {
    await establishSession();
    session.established = true;
  }

  const authenticated = await confirmSession();
  if (!authenticated) session.established = false;
  return authenticated;
}
