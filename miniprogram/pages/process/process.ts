import {
  CanvasEngine,
  createOffscreenProvider,
  loadSource,
  runSerial,
  type CanvasLike,
  type CanvasProvider,
  type ProcessParams,
  type ProcessResult,
  type SourceImage,
} from '../../engine/index';
import { PHOTO_PRESETS, SIZE_PRESETS } from '../../utils/presets';
import { formatSize } from '../../utils/file';
import { store } from '../../utils/store';
import { track } from '../../utils/track';
import { getImageInfo } from '../../utils/wxp';

interface SourceItem {
  path: string;
  meta: string;
}

/**
 * 坑 12：默认使用页面隐藏 Canvas（导出链路最稳）；
 * P1 spike 可临时切为 true，与离屏 Canvas 真机对照验证（实施文档 4.6 第 2 项）。
 */
const USE_OFFSCREEN = false;

const DECODE_FAIL_HINT = '解码失败：可能是聊天文件中的 HEIC 等不支持的格式，请先保存到相册再试';

type PageMode = 'quality' | 'targetKB' | 'resize';

Page({
  data: {
    sources: [] as string[],
    sourceItems: [] as SourceItem[],
    mode: 'quality' as PageMode,
    quality: 80,
    kbChips: [20, 50, 100, 200, 500],
    targetKB: 100,
    recKB: 0,
    customKB: '',
    limitW: '',
    limitH: '',
    photoPresets: PHOTO_PRESETS,
    photoPresetKey: '',
    percentChips: [25, 50, 75],
    scalePercent: 0,
    sizePresets: SIZE_PRESETS,
    sizePresetKey: '',
    inputW: '',
    inputH: '',
    lockRatio: true,
    /** 首张源图尺寸：等比模式下自动换算另一边用 */
    srcW: 0,
    srcH: 0,
    format: 'auto' as 'auto' | 'jpg' | 'png',
    running: false,
    doneCount: 0,
    total: 0,
    percent: 0,
    lastError: '',
  },

  provider: null as unknown as CanvasProvider,

  onLoad() {
    if (!store.sources.length) {
      wx.navigateBack();
      return;
    }
    // resize / convert 入口映射：convert 复用质量模式（输出格式可选即转格式）
    const key = store.funcKey;
    const mode: PageMode = key === 'targetKB' ? 'targetKB' : key === 'resize' ? 'resize' : 'quality';
    // 输出格式默认跟随原图；仅"转格式"入口显式指定 JPG
    const format: 'auto' | 'jpg' | 'png' = key === 'convert' ? 'jpg' : 'auto';
    this.setData({ sources: store.sources, mode, format });
    // 原图信息：分辨率/格式/体积（实施文档 2.1）
    const items: SourceItem[] = store.sources.map((p) => ({
      path: p,
      meta: store.sourceSizes[p] ? formatSize(store.sourceSizes[p]) : '',
    }));
    this.setData({ sourceItems: items });
    void Promise.all(store.sources.map((p) => getImageInfo(p).catch(() => null))).then((infos) => {
      this.setData({
        sourceItems: items.map((it, i) => {
          const info = infos[i];
          if (!info) return it;
          const sizeText = it.meta ? ` · ${it.meta}` : '';
          return { path: it.path, meta: `${info.width}×${info.height} ${info.type}${sizeText}` };
        }),
      });
    });
    // 智能推荐：按平均原图体积选目标快捷档（约压到 15%）（实施文档 2.2）
    const sizes = store.sources.map((p) => store.sourceSizes[p] ?? 0).filter((n) => n > 0);
    if (sizes.length) {
      const avgKB = sizes.reduce((s, n) => s + n, 0) / sizes.length / 1024;
      const rec = [500, 200, 100, 50, 20].find((kb) => kb <= avgKB * 0.15) ?? 20;
      this.setData({ recKB: rec, targetKB: rec });
    }
    // 取首张尺寸，等比模式下输入一边自动换算另一边
    getImageInfo(store.sources[0])
      .then((info) => this.setData({ srcW: info.width, srcH: info.height }))
      .catch(() => undefined);
    track('process_view', { mode, count: store.sources.length });
  },

  onReady() {
    if (USE_OFFSCREEN) {
      this.provider = createOffscreenProvider();
      return;
    }
    this.provider = () =>
      new Promise<CanvasLike>((resolve, reject) => {
        wx.createSelectorQuery()
          .select('#engineCanvas')
          .fields({ node: true })
          .exec((res) => {
            const node = res && res[0] && (res[0] as { node?: unknown }).node;
            if (!node) {
              reject(new Error('获取引擎 Canvas 失败'));
              return;
            }
            resolve(node as CanvasLike);
          });
      });
  },

  onShow() {
    // 失败重试（坑 11 配套）：结果页回传待重试路径，替换当前选区等待再次处理
    if (store.retryPaths && store.retryPaths.length) {
      const paths = store.retryPaths;
      store.retryPaths = null;
      store.sources = paths;
      this.setData({ sources: paths, doneCount: 0, percent: 0, lastError: '' });
    }
  },

  buildParams(): ProcessParams | null {
    const d = this.data;
    if (d.mode === 'targetKB') {
      const kb = d.customKB ? parseInt(d.customKB, 10) : d.targetKB;
      if (!kb || kb < 5) {
        wx.showToast({ title: '目标体积至少 5 KB', icon: 'none' });
        return null;
      }
      const params: ProcessParams = { mode: 'targetKB', outputFormat: 'jpg', targetKB: kb };
      const tw = parseInt(d.limitW, 10);
      const th = parseInt(d.limitH, 10);
      if (tw > 0 && th > 0) {
        params.targetWidth = tw;
        params.targetHeight = th;
      } else if (tw > 0 || th > 0) {
        // 只填一边时按源图等比换算，另一边交给引擎
        if (tw > 0) params.targetWidth = tw;
        if (th > 0) params.targetHeight = th;
      }
      return params;
    }
    if (d.mode === 'resize') {
      if (d.scalePercent > 0) {
        return { mode: 'resize', outputFormat: d.format, scalePercent: d.scalePercent, lockRatio: d.lockRatio };
      }
      const params: ProcessParams = { mode: 'resize', outputFormat: d.format, lockRatio: d.lockRatio };
      const tw = parseInt(d.inputW, 10);
      const th = parseInt(d.inputH, 10);
      if (tw > 0) params.targetWidth = tw;
      if (th > 0) params.targetHeight = th;
      if (!params.targetWidth && !params.targetHeight) {
        wx.showToast({ title: '请选择比例或输入像素', icon: 'none' });
        return null;
      }
      return params;
    }
    return { mode: 'quality', outputFormat: d.format, quality: d.quality };
  },

  async onStart() {
    if (this.data.running || !this.provider) return;
    const params = this.buildParams();
    if (!params) return;
    store.lastParams = params;

    const paramsJson = JSON.stringify(params);
    // 断点续跑：同参数下已成功的不再重跑（坑 11 配套）
    const pending = store.sources.filter((p) => store.doneKeys[p] !== paramsJson);
    if (!pending.length) {
      wx.navigateTo({ url: '/pages/result/result' });
      return;
    }
    // 重跑的路径丢弃其旧参数下的结果
    store.results = store.results.filter((r) => !pending.includes(r.inputPath));

    const total = pending.length;
    this.setData({ running: true, total, doneCount: 0, percent: 0, lastError: '' });
    track('process_start', { mode: params.mode, count: total });

    const engine = new CanvasEngine(this.provider);
    await runSerial(
      pending,
      async (path) => {
        let source: SourceImage;
        try {
          source = await loadSource(path, store.sourceSizes[path]);
        } catch {
          const failed: ProcessResult = { inputPath: path, ok: false, error: DECODE_FAIL_HINT };
          return failed;
        }
        return engine.process(source, params);
      },
      {
        onItemDone: (done, _total, r) => {
          // 逐张累积结果：中途被杀后重进可续跑（坑 11）
          if (r.ok) store.doneKeys[r.inputPath] = paramsJson;
          store.results.push(r);
          this.setData({ doneCount: done, percent: Math.round((done / total) * 100) });
        },
      }
    );

    this.setData({ running: false });
    const okCount = store.results.filter((r) => r.ok).length;
    track('process_done', {
      ok: okCount,
      fail: store.results.length - okCount,
      met: store.results.filter((r) => r.targetMet === true).length,
    });
    if (okCount > 0) {
      wx.navigateTo({ url: '/pages/result/result' });
    } else {
      const last = store.results[store.results.length - 1];
      this.setData({ lastError: last?.error ?? '处理失败，请重试' });
    }
  },

  setMode(e: { currentTarget: { dataset: { mode?: string } } }) {
    const m = e.currentTarget.dataset.mode;
    const mode: PageMode = m === 'targetKB' ? 'targetKB' : m === 'resize' ? 'resize' : 'quality';
    this.setData({ mode });
  },

  onQuality(e: { detail: { value: number } }) {
    this.setData({ quality: e.detail.value });
  },

  /** 拖动中实时回显数值（bindchange 只在松手时触发，导致"不跟手"） */
  onQualityChanging(e: { detail: { value: number } }) {
    this.setData({ quality: e.detail.value });
  },

  setKB(e: { currentTarget: { dataset: { kb?: string } } }) {
    this.setData({ targetKB: Number(e.currentTarget.dataset.kb) || 100, customKB: '' });
  },

  onCustomKB(e: { detail: { value: string } }) {
    this.setData({ customKB: e.detail.value });
  },

  onLimitW(e: { detail: { value: string } }) {
    this.setData({ limitW: e.detail.value, photoPresetKey: '' });
  },

  onLimitH(e: { detail: { value: string } }) {
    this.setData({ limitH: e.detail.value, photoPresetKey: '' });
  },

  clearLimit() {
    this.setData({ limitW: '', limitH: '', photoPresetKey: '' });
  },

  setPhotoPreset(e: { currentTarget: { dataset: { key?: string } } }) {
    const preset = PHOTO_PRESETS.find((p) => p.key === e.currentTarget.dataset.key);
    if (!preset) return;
    this.setData({
      photoPresetKey: preset.key,
      targetKB: preset.kb,
      customKB: '',
      limitW: String(preset.w),
      limitH: String(preset.h),
    });
  },

  setScale(e: { currentTarget: { dataset: { percent?: string | number } } }) {
    const percent = Number(e.currentTarget.dataset.percent) || 0;
    if (percent > 0) {
      this.setData({ scalePercent: percent, sizePresetKey: '', inputW: '', inputH: '' });
    } else {
      this.setData({ scalePercent: 0 });
    }
  },

  setSizePreset(e: { currentTarget: { dataset: { key?: string } } }) {
    const preset = SIZE_PRESETS.find((p) => p.key === e.currentTarget.dataset.key);
    if (!preset) return;
    this.setData({
      sizePresetKey: preset.key,
      inputW: String(preset.w),
      inputH: String(preset.h),
      scalePercent: 0,
    });
  },

  onInputW(e: { detail: { value: string } }) {
    const patch: {
      inputW: string;
      sizePresetKey: string;
      scalePercent: number;
      inputH?: string;
    } = { inputW: e.detail.value, sizePresetKey: '', scalePercent: 0 };
    const w = parseInt(e.detail.value, 10);
    if (this.data.lockRatio && w > 0 && this.data.srcW > 0) {
      patch.inputH = String(Math.max(1, Math.round((this.data.srcH * w) / this.data.srcW)));
    }
    this.setData(patch);
  },

  onInputH(e: { detail: { value: string } }) {
    const patch: {
      inputH: string;
      sizePresetKey: string;
      scalePercent: number;
      inputW?: string;
    } = { inputH: e.detail.value, sizePresetKey: '', scalePercent: 0 };
    const h = parseInt(e.detail.value, 10);
    if (this.data.lockRatio && h > 0 && this.data.srcH > 0) {
      patch.inputW = String(Math.max(1, Math.round((this.data.srcW * h) / this.data.srcH)));
    }
    this.setData(patch);
  },

  toggleLock() {
    this.setData({ lockRatio: !this.data.lockRatio });
  },

  onFormat(e: { detail: { value: string } }) {
    const v = e.detail.value;
    const format: 'auto' | 'jpg' | 'png' = v === 'png' ? 'png' : v === 'jpg' ? 'jpg' : 'auto';
    this.setData({ format });
  },
});
