App({
  onLaunch() {
    // 全局异常兜底（实施文档 4.5：MVP 先打日志，v1.x 接云函数上报）
  },
  onError(msg: string) {
    console.error('[onError]', msg);
  },
  onUnhandledRejection(res: { reason: unknown }) {
    console.error('[onUnhandledRejection]', res.reason);
  },
});
