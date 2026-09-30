import { compressGif, GIF_PRESETS, splitGif } from '../../engine/gif/gifEngine';
import type { GifPreset } from '../../engine/gif/gifEngine';
import type { ProcessResult } from '../../engine/index';
import { pageCanvasProvider } from '../../utils/canvas';
import { formatSize } from '../../utils/file';
import { store } from '../../utils/store';
import { track } from '../../utils/track';
import { chooseChatFiles, chooseImages } from '../../utils/wxp';
import type { CanvasProvider } from '../../engine/types';

interface GifFile {
  path: string;
  size: number;
  sizeText: string;
}

const GIF_EXT = /\.gif$/i;

Page({
  data: {
    mode: 'compress' as 'compress' | 'split',
    files: [] as GifFile[],
    presets: GIF_PRESETS,
    presetKey: 'balanced',
    widthChips: [
      { label: '原宽', v: 0 },
      { label: '480px', v: 480 },
      { label: '320px', v: 320 },
    ],
    maxWidth: 480,
    targetKB: '',
    splitLimits: [
      { label: '前 10 帧', v: 10 },
      { label: '前 30 帧', v: 30 },
      { label: '全部帧', v: 0 },
      { label: '仅首帧', v: 1 },
    ],
    splitLimit: 10,
    running: false,
    doneCount: 0,
    total: 0,
    percent: 0,
    statusText: '',
    lastError: '',
  },

  provider: null as unknown as CanvasProvider,

  onLoad(options: { mode?: string }) {
    const mode = options.mode === 'split' ? 'split' : 'compress';
    this.setData({ mode });
    this.provider = pageCanvasProvider(this, '#gifCanvas');
    track('gif_view', { mode });
  },

  onPickAlbum() {
    void this.pick(
      chooseImages(9).then((files) =>
        files.map((f) => ({ path: f.tempFilePath, size: f.size }))
      )
    );
  },

  onPickChat() {
    void this.pick(
      chooseChatFiles(9).then((files) =>
        files.map((f) => ({ path: f.path, size: f.size }))
      )
    );
  },

  async pick(promise: Promise<{ path: string; size: number }[]>) {
    try {
      const all = await promise;
      const gifs = all.filter((f) => GIF_EXT.test(f.path));
      if (!gifs.length) {
        wx.showToast({ title: '未选择 GIF 文件', icon: 'none' });
        return;
      }
      if (gifs.length < all.length) {
        wx.showToast({ title: `已跳过 ${all.length - gifs.length} 个非 GIF 文件`, icon: 'none' });
      }
      this.setData({
        files: gifs.map((f) => ({ ...f, sizeText: formatSize(f.size) })),
        lastError: '',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) {
        wx.showToast({ title: '选择失败', icon: 'none' });
      }
    }
  },

  buildParams() {
    const { presetKey, maxWidth, targetKB, splitLimit } = this.data;
    const preset: GifPreset = GIF_PRESETS.find((p) => p.key === presetKey) ?? GIF_PRESETS[1];
    const kb = parseInt(targetKB, 10);
    return {
      preset,
      maxWidth,
      targetKB: kb > 4 ? kb : undefined,
      splitLimit,
    };
  },

  async onStart() {
    if (this.data.running) return;
    const params = this.buildParams();
    const files = this.data.files;
    const total = files.length;
    this.setData({ running: true, total, doneCount: 0, percent: 0, statusText: '准备中…', lastError: '' });
    track('gif_start', { mode: this.data.mode, count: total });

    const allResults: ProcessResult[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      this.setData({ statusText: `第 ${i + 1}/${total} 个文件` });
      try {
        const out =
          this.data.mode === 'compress'
            ? await compressGif({
                path: file.path,
                bytes: file.size,
                preset: params.preset,
                maxWidth: params.maxWidth,
                targetKB: params.targetKB,
                onProgress: (text) => this.setData({ statusText: `第 ${i + 1}/${total} 个 · ${text}` }),
              })
            : await splitGif({
                path: file.path,
                bytes: file.size,
                limit: params.splitLimit,
                provider: this.provider,
                onProgress: (text) => this.setData({ statusText: `第 ${i + 1}/${total} 个 · ${text}` }),
              });
        allResults.push(...(Array.isArray(out) ? out : [out]));
      } catch (e) {
        allResults.push({
          inputPath: file.path,
          inputBytes: file.size,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      this.setData({ doneCount: i + 1, percent: Math.round(((i + 1) / total) * 100) });
    }

    store.results = allResults;
    const okCount = allResults.filter((r) => r.ok).length;
    track('gif_done', { mode: this.data.mode, ok: okCount, fail: allResults.length - okCount });
    this.setData({ running: false });
    if (okCount > 0) {
      wx.navigateTo({ url: '/pages/result/result' });
    } else {
      this.setData({ lastError: allResults[0]?.error ?? '处理失败，请重试' });
    }
  },

  setMode(e: { currentTarget: { dataset: { mode?: string } } }) {
    this.setData({ mode: e.currentTarget.dataset.mode === 'split' ? 'split' : 'compress' });
  },

  setPreset(e: { currentTarget: { dataset: { key?: string } } }) {
    if (e.currentTarget.dataset.key) this.setData({ presetKey: e.currentTarget.dataset.key });
  },

  setWidth(e: { currentTarget: { dataset: { v?: string | number } } }) {
    this.setData({ maxWidth: Number(e.currentTarget.dataset.v) || 0 });
  },

  onTargetKB(e: { detail: { value: string } }) {
    this.setData({ targetKB: e.detail.value });
  },

  setSplitLimit(e: { currentTarget: { dataset: { v?: string | number } } }) {
    this.setData({ splitLimit: Number(e.currentTarget.dataset.v) || 0 });
  },
});
