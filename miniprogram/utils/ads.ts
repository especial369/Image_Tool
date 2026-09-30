/**
 * 广告配置（实施文档 4.5：MVP 只做容器预留 + 开关，接入待累计 UV≥1000 开通流量主）。
 * 后续接微信云开发后，将 enabled 与广告位 ID 改为远程下发，实现不改代码的开关与降级。
 */
export const ADS_CONFIG = {
  enabled: false,
  /** 结果页 Banner 广告位 ID（流量主后台创建后替换） */
  resultBannerUnitId: 'adunit-placeholder',
};

/** 结果页 Banner 广告位：未开启返回空串，页面据此隐藏容器（优雅降级） */
export function resultBannerUnitId(): string {
  return ADS_CONFIG.enabled ? ADS_CONFIG.resultBannerUnitId : '';
}
