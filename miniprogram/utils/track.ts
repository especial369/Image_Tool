/**
 * 埋点（实施文档 4.5 数据统计：功能点击率、压缩成功率、达标率）。
 * MVP 阶段仅本地日志；提审后接 wx.reportEvent（需在 mp 后台配置事件）或云函数上报。
 */
export function track(event: string, props: Record<string, string | number> = {}): void {
  console.log('[track]', event, JSON.stringify(props));
}
