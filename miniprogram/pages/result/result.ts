import { formatSize } from '../../utils/file';
import { saveToAlbum } from '../../utils/auth';
import { resultBannerUnitId } from '../../utils/ads';
import { track } from '../../utils/track';
import { store } from '../../utils/store';
import type { ProcessResult } from '../../engine/index';

interface ResultItem {
  path: string;
  inSize: string;
  outSize: string;
  dim: string;
  metaText: string;
  badgeText: string;
  badgeClass: string;
}

Page({
  data: {
    items: [] as ResultItem[],
    failedList: [] as string[],
    okCount: 0,
    failCount: 0,
    notMetCount: 0,
    savedPct: 0,
    adUnitId: '',
  },

  onLoad() {
    // 广告容器：开关未开启时为空串，wx:if 隐藏（优雅降级，实施文档 4.5）
    this.setData({ adUnitId: resultBannerUnitId() });
  },

  onAdError() {
    this.setData({ adUnitId: '' });
  },

  onShow() {
    this.refresh();
  },

  /** 转发小程序卡片（MVP：结果页分享） */
  onShareAppMessage(): { title: string; path: string; imageUrl?: string } {
    track('share_card', { n: this.data.items.length });
    return {
      title: '图片压缩到指定大小，图片不离开手机',
      path: '/pages/index/index',
      imageUrl: this.data.items[0]?.path,
    };
  },

  refresh() {
    const results = store.results;
    const ok = results.filter((r) => r.ok && r.outputPath);
    const failed = results.filter((r) => !r.ok);

    const items: ResultItem[] = ok.map((r) => this.toItem(r));
    const totalIn = ok.reduce((s, r) => s + (r.inputBytes ?? 0), 0);
    const totalOut = ok.reduce((s, r) => s + (r.outputBytes ?? 0), 0);
    const savedPct = totalIn > 0 ? Math.round((1 - totalOut / totalIn) * 100) : 0;

    this.setData({
      items,
      failedList: failed.map((r) => r.error ?? '未知错误'),
      okCount: ok.length,
      failCount: failed.length,
      notMetCount: ok.filter((r) => r.targetMet === false).length,
      savedPct,
    });
  },

  toItem(r: ProcessResult): ResultItem {
    const inBytes = r.inputBytes ?? 0;
    const outBytes = r.outputBytes ?? 0;
    const savedPct = inBytes > 0 ? Math.round((1 - outBytes / inBytes) * 100) : 0;
    const meta: string[] = [];
    if (r.qualityUsed != null) meta.push(`质量 ${r.qualityUsed}`);
    if (r.downsampled) meta.push('已降采样');
    if (r.keptOriginal) meta.push('已保留原图');
    const badge =
      savedPct > 0
        ? { text: `省 ${savedPct}%`, cls: 'badge-good' }
        : savedPct < 0
          ? { text: `增 ${Math.abs(savedPct)}%`, cls: 'badge-bad' }
          : { text: '无变化', cls: 'badge-neutral' };
    return {
      path: r.outputPath as string,
      inSize: formatSize(inBytes),
      outSize: formatSize(outBytes),
      dim: `${r.width ?? '?'} × ${r.height ?? '?'}`,
      metaText: meta.length ? ` · ${meta.join(' · ')}` : '',
      badgeText: badge.text,
      badgeClass: badge.cls,
    };
  },

  onPreview(e: { currentTarget: { dataset: { path?: string } } }) {
    const path = e.currentTarget.dataset.path;
    if (!path) return;
    wx.previewImage({ urls: [path] });
  },

  async onSaveOne(e: { currentTarget: { dataset: { path?: string } } }) {
    const path = e.currentTarget.dataset.path;
    if (!path) return;
    try {
      await saveToAlbum(path);
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel|deny|auth/i.test(msg)) {
        wx.showToast({ title: '保存失败', icon: 'none' });
      }
    }
  },

  async onSaveAll() {
    let ok = 0;
    for (const item of this.data.items) {
      try {
        await saveToAlbum(item.path);
        ok += 1;
      } catch {
        // 单张失败不阻塞整批
      }
    }
    track('save_album', { n: ok });
    wx.showToast({ title: ok ? `已保存 ${ok} 张` : '保存失败', icon: 'none' });
  },

  async onShareOne(e: { currentTarget: { dataset: { path?: string; idx?: number } } }) {
    const path = e.currentTarget.dataset.path;
    const idx = e.currentTarget.dataset.idx ?? 0;
    if (!path) return;
    const ext = path.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
    track('share_file', { ext });
    try {
      wx.shareFileMessage({
        filePath: path,
        fileName: `compressed-${Number(idx) + 1}.${ext}`,
        success: () => undefined,
        fail: (r) => {
          if (!/cancel/i.test(r.errMsg)) {
            wx.showToast({ title: '发送失败，请使用手机微信', icon: 'none' });
          }
        },
      });
    } catch {
      wx.showToast({ title: '当前环境不支持发送文件', icon: 'none' });
    }
  },

  onTuneAgain() {
    wx.navigateBack();
  },

  /** 失败重试：回传待重试路径给处理页（onShow 接管），保持参数不变 */
  onRetryFailed() {
    const failed = store.results.filter((r) => !r.ok).map((r) => r.inputPath);
    if (!failed.length) return;
    store.retryPaths = failed;
    wx.navigateBack();
  },

  onPickAgain() {
    wx.reLaunch({ url: '/pages/index/index' });
  },
});
