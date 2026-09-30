/**
 * GIF 能力引擎：压缩（降色/降帧/缩放 + 可选目标体积）与拆帧（逐帧导出 PNG）。
 * 编解码走 libs/gif（纯 JS，无 WASM，见实施文档第八节既定路线）；
 * 画布仅拆帧导出 PNG 时使用，压缩链路纯 JS（含缩放）。
 */
import { openGif } from '../../libs/gif/decoder';
import { encodeGifIndexed } from '../../libs/gif/encoder';
import { buildPalette, mapToIndices } from '../../libs/gif/quantize';
import { resizeRgba } from '../../libs/gif/resize';
import type { ProcessResult } from '../types';
import { canvasToTempFilePath } from '../../utils/wxp';
import type { CanvasProvider, CanvasLike } from '../types';

/** 单 GIF 帧数上限：纯 JS 解码在低端机上的耗时保护 */
export const MAX_GIF_FRAMES = 400;
/** 拆帧硬上限 */
export const MAX_SPLIT_FRAMES = 200;
/** 压缩会话像素预算（缩放后 宽×高×保留帧数×4 字节） */
const PIXEL_BUDGET = 120 * 1024 * 1024;

export interface GifPreset {
  key: string;
  name: string;
  maxColors: number;
  keepRatio: number;
}

export const GIF_PRESETS: GifPreset[] = [
  { key: 'strong', name: '强压', maxColors: 64, keepRatio: 0.5 },
  { key: 'balanced', name: '平衡', maxColors: 128, keepRatio: 0.75 },
  { key: 'high', name: '高清', maxColors: 256, keepRatio: 1 },
];

interface DecodedPass {
  width: number;
  height: number;
  delays: number[];
}

/** 第一遍：拿尺寸与每帧时长（不解码像素到业务侧） */
function scanPass(buf: ArrayBuffer, onProgress?: (text: string) => void): DecodedPass {
  const gif = openGif(buf);
  const delays: number[] = [];
  let width = gif.width;
  let height = gif.height;
  for (const f of gif.frames()) {
    delays.push(f.delayMs);
    if (delays.length > MAX_GIF_FRAMES) {
      throw new Error(`GIF 帧数超过 ${MAX_GIF_FRAMES}，暂不支持压缩，可尝试「拆帧」`);
    }
    if (delays.length % 50 === 0) onProgress?.(`解析中 ${delays.length} 帧…`);
  }
  if (!delays.length) throw new Error('GIF 中没有可用帧');
  return { width, height, delays };
}

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

interface AttemptConfig {
  maxColors: number;
  keepRatio: number;
  maxWidth: number;
}

function runAttempt(
  buf: ArrayBuffer,
  cfg: AttemptConfig,
  onProgress?: (text: string) => void
): { bytes: Uint8Array; width: number; height: number; frames: number } {
  const pass1 = scanPass(buf, onProgress);
  const step = Math.max(1, Math.round(1 / cfg.keepRatio));
  const keptDelays: number[] = [];
  {
    let acc = 0;
    for (let i = 0; i < pass1.delays.length; i++) {
      acc += pass1.delays[i];
      if (i % step === 0 || i === pass1.delays.length - 1) {
        keptDelays.push(acc);
        acc = 0;
      }
    }
  }
  const scaledW = cfg.maxWidth > 0 ? even(Math.min(pass1.width, cfg.maxWidth)) : even(pass1.width);
  const scaledH = even(pass1.height * (scaledW / pass1.width));
  const keptCount = keptDelays.length;
  if (scaledW * scaledH * keptCount * 4 > PIXEL_BUDGET) {
    throw new Error('该 GIF 体量过大（帧数×分辨率超限），请先尝试更小的宽度档');
  }

  // 第二遍：收集保留帧的像素（缩放后）
  const collected: Uint8ClampedArray[] = [];
  const gif = openGif(buf);
  let idx = 0;
  for (const f of gif.frames()) {
    if (idx % step === 0) {
      const rgba =
        scaledW === pass1.width && scaledH === pass1.height
          ? new Uint8ClampedArray(f.rgba)
          : resizeRgba(f.rgba, pass1.width, pass1.height, scaledW, scaledH);
      collected.push(rgba);
      if (collected.length % 20 === 0) onProgress?.(`解码 ${collected.length}/${keptCount} 帧…`);
    }
    idx++;
  }

  onProgress?.(`量化配色（${cfg.maxColors} 色）…`);
  const quant = buildPalette(collected, cfg.maxColors, true);
  onProgress?.('编码中…');
  const indices = collected.map((rgba) => mapToIndices(rgba, quant.palette, quant.transparent));
  const out = encodeGifIndexed(indices, keptDelays, quant, {
    width: scaledW,
    height: scaledH,
    loop: 0,
  });
  return { bytes: out, width: scaledW, height: scaledH, frames: keptCount };
}

function writeGifFile(bytes: Uint8Array): string {
  const path = `${wx.env.USER_DATA_PATH}/gif_${Date.now()}_${Math.floor(Math.random() * 1e6)}.gif`;
  wx.getFileSystemManager().writeFileSync(path, bytes.buffer as ArrayBuffer, 'binary');
  return path;
}

export async function compressGif(opts: {
  path: string;
  bytes: number;
  preset: GifPreset;
  maxWidth: number;
  targetKB?: number;
  onProgress?: (text: string) => void;
}): Promise<ProcessResult> {
  const base: ProcessResult = { inputPath: opts.path, inputBytes: opts.bytes, ok: false };
  try {
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: opts.path,
        success: (r) => resolve(r.data as ArrayBuffer),
        fail: (e) => reject(new Error(e.errMsg)),
      });
    });

    // 第一轮：用户选择的档位
    let attempt: AttemptConfig = {
      maxColors: opts.preset.maxColors,
      keepRatio: opts.preset.keepRatio,
      maxWidth: opts.maxWidth,
    };
    let out = runAttempt(buf, attempt, opts.onProgress);
    let outPath = writeGifFile(out.bytes);
    let outBytes = out.bytes.length;

    // 目标体积未达标：自动降一档重试（最多一次）
    if (opts.targetKB && outBytes > opts.targetKB * 1024 * 1.1) {
      opts.onProgress?.('未达目标体积，自动加压重试…');
      attempt = {
        maxColors: Math.max(32, Math.floor(attempt.maxColors / 2)),
        keepRatio: Math.max(0.3, attempt.keepRatio * 0.6),
        maxWidth: attempt.maxWidth > 0 ? Math.min(attempt.maxWidth, 320) : 480,
      };
      const harder = runAttempt(buf, attempt, opts.onProgress);
      const harderPath = writeGifFile(harder.bytes);
      if (harder.bytes.length < outBytes) {
        wx.getFileSystemManager().unlink({ filePath: outPath, fail: () => undefined });
        outPath = harderPath;
        out = harder;
        outBytes = harder.bytes.length;
      } else {
        wx.getFileSystemManager().unlink({ filePath: harderPath, fail: () => undefined });
      }
    }

    // 重编码没变小：保留原 GIF（与图片「已保留原图」同一策略）
    if (!opts.targetKB && outBytes >= opts.bytes) {
      wx.getFileSystemManager().unlink({ filePath: outPath, fail: () => undefined });
      return {
        ...base,
        ok: true,
        outputPath: opts.path,
        outputBytes: opts.bytes,
        width: out.width,
        height: out.height,
        keptOriginal: true,
        note: `GIF · ${out.frames} 帧 · 已保留原图`,
      };
    }

    const presetName = opts.preset.name;
    return {
      ...base,
      ok: true,
      outputPath: outPath,
      outputBytes: outBytes,
      width: out.width,
      height: out.height,
      targetMet: opts.targetKB ? outBytes <= opts.targetKB * 1024 * 1.1 : undefined,
      note: `GIF · ${presetName} · ${out.frames} 帧 · ${attempt.maxColors} 色`,
    };
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 拆帧：逐帧导出 PNG（复用画布，串行导出） */
export async function splitGif(opts: {
  path: string;
  bytes: number;
  /** 0 = 全部（仍受 MAX_SPLIT_FRAMES 硬上限） */
  limit: number;
  provider: CanvasProvider;
  onProgress?: (text: string) => void;
}): Promise<ProcessResult[]> {
  const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath: opts.path,
      success: (r) => resolve(r.data as ArrayBuffer),
      fail: (e) => reject(new Error(e.errMsg)),
    });
  });
  const gif = openGif(buf);
  const canvas: CanvasLike = await opts.provider();
  const results: ProcessResult[] = [];
  let index = 0;
  for (const frame of gif.frames()) {
    if (results.length >= (opts.limit > 0 ? Math.min(opts.limit, MAX_SPLIT_FRAMES) : MAX_SPLIT_FRAMES)) {
      break;
    }
    opts.onProgress?.(`导出第 ${index + 1} 帧…`);
    const rgba = new Uint8ClampedArray(frame.rgba); // 导出是异步的，必须先拷贝
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d') as unknown as {
      createImageData?: (w: number, h: number) => { data: Uint8ClampedArray };
      putImageData: (img: unknown, x: number, y: number) => void;
    };
    const img = ctx.createImageData
      ? ctx.createImageData(frame.width, frame.height)
      : { data: new Uint8ClampedArray(frame.width * frame.height * 4) };
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    try {
      const pngPath = await canvasToTempFilePath({
        canvas,
        fileType: 'png',
        quality: 1,
        destWidth: frame.width,
        destHeight: frame.height,
      });
      results.push({
        inputPath: opts.path,
        inputBytes: opts.bytes,
        ok: true,
        outputPath: pngPath,
        width: frame.width,
        height: frame.height,
        note: `第 ${index + 1} 帧 · ${(frame.delayMs / 1000).toFixed(1)}s`,
      });
    } catch (e) {
      results.push({
        inputPath: opts.path,
        inputBytes: opts.bytes,
        ok: false,
        error: `第 ${index + 1} 帧导出失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
    index++;
    canvas.width = 0;
    canvas.height = 0;
  }
  if (!results.length) throw new Error('GIF 中没有可用帧');
  return results;
}
