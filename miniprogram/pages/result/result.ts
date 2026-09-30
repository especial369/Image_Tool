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
    sharePanel: false,
    shareChecks: [] as boolean[],
    shareSelCount: 0,
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
    if (r.note) meta.push(r.note);
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
    const idx = Number(e.currentTarget.dataset.idx ?? 0);
    if (!path) return;
    const ext = path.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
    track('share_file', { ext });
    this.sendOne(path, idx, ext);
  },

  noop() {},

  /** 底部弹层：多选要发送的图片（默认全选） */
  onOpenSharePanel() {
    if (!this.data.items.length) return;
    track('share_panel_open', { n: this.data.items.length });
    this.setData({
      sharePanel: true,
      shareChecks: this.data.items.map(() => true),
      shareSelCount: this.data.items.length,
    });
  },

  onCloseSharePanel() {
    this.setData({ sharePanel: false });
  },

  onToggleShare(e: { currentTarget: { dataset: { idx?: number } } }) {
    const idx = Number(e.currentTarget.dataset.idx ?? -1);
    if (idx < 0 || idx >= this.data.shareChecks.length) return;
    const checks = this.data.shareChecks.slice();
    checks[idx] = !checks[idx];
    this.setData({ shareChecks: checks, shareSelCount: checks.filter(Boolean).length });
  },

  /**
   * 多选发送：微信无一次发多图的 API（单次仅 1 张）。
   * 选 1 张 → 直接以文件形式发送；选多张 → 打开预览由用户长按逐张发送。
   */
  onConfirmShare() {
    const selected = this.data.items.filter((_, i) => this.data.shareChecks[i]);
    if (!selected.length) return;
    this.setData({ sharePanel: false });
    track('share_file', { n: selected.length });
    if (selected.length === 1) {
      this.sendOne(selected[0].path, 0);
      return;
    }
    wx.showModal({
      title: '逐张发送',
      content: `微信单次只能发送 1 张图片，接下来将打开 ${selected.length} 张图片的预览，长按图片并选择“发送给朋友”，可左右滑动逐张发送。`,
      showCancel: false,
      confirmText: '知道了',
      success: () => {
        wx.previewImage({ urls: selected.map((s) => s.path) });
      },
    });
  },

  /** 以文件形式发送单张（保留压缩后原始质量） */
  sendOne(path: string, idx: number, ext?: string) {
    const suffix = ext ?? (path.toLowerCase().endsWith('.png') ? 'png' : 'jpg');
    try {
      wx.shareFileMessage({
        filePath: path,
        fileName: `compressed-${idx + 1}.${suffix}`,
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
