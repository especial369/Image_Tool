/**
 * Canvas 2D 处理引擎（默认页面隐藏 canvas，离屏为优化项，见坑 12）。
 * 每次处理完将 canvas 尺寸置 0 释放位图内存——JS 侧唯一主动释放手段（坑 5 配套）。
 */
import type {
  CanvasLike,
  CanvasProvider,
  Ctx2D,
  ImageLike,
  ImageEngine,
  OutputFormat,
  ProcessParams,
  ProcessResult,
  SourceImage,
} from './types';
import { searchForTargetBytes } from './qualitySearch';
import { canvasToTempFilePath, compressImage, getImageInfo } from '../utils/wxp';
import { getFileSize, removeFileQuiet } from '../utils/file';

/** 多数真机 canvas 单边上限量级，超限先降采样（坑 4） */
export const MAX_DIM = 4096;

/**
 * compressImage 快速通道开关：jpg 源走原生压缩（更快）。
 * EXIF 方向行为待 4.6 真机验证；若真机出现方向异常，置 false 即全部回退 Canvas。
 */
const FAST_PATH_ENABLED = true;

/** 开发者工具/PC 端的 compressImage 不忠实（可能忽略质量与尺寸参数，导致"越压越大"），快速通道仅限真机 */
const FAST_PLATFORM_OK = ['ios', 'android'].includes(wx.getDeviceInfo().platform);

/** 90° 系 orientation（输出宽高需交换） */
const SWAP_ORIENTATIONS = new Set(['left', 'right', 'left-mirrored', 'right-mirrored']);

export function createOffscreenProvider(): CanvasProvider {
  return async () => wx.createOffscreenCanvas({ type: '2d', width: 8, height: 8 }) as unknown as CanvasLike;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function toErrMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 显示方向下的原始尺寸：90° 系 orientation 时宽高互换 */
function orientedDims(source: SourceImage): { width: number; height: number } {
  return SWAP_ORIENTATIONS.has(source.orientation)
    ? { width: source.height, height: source.width }
    : { width: source.width, height: source.height };
}

function computeTargetDims(
  oriented: { width: number; height: number },
  params: ProcessParams
): { width: number; height: number; downsampled: boolean } {
  let w = oriented.width;
  let h = oriented.height;

  if (params.mode === 'resize') {
    const lock = params.lockRatio !== false;
    if (params.scalePercent && params.scalePercent > 0 && params.scalePercent !== 100) {
      w = (w * params.scalePercent) / 100;
      h = (h * params.scalePercent) / 100;
    } else if (params.targetWidth && params.targetHeight) {
      w = params.targetWidth;
      h = params.targetHeight;
    } else if (params.targetWidth) {
      h = lock ? (h * params.targetWidth) / w : h;
      w = params.targetWidth;
    } else if (params.targetHeight) {
      w = lock ? (w * params.targetHeight) / h : w;
      h = params.targetHeight;
    }
  } else if (params.mode === 'targetKB' && (params.targetWidth || params.targetHeight)) {
    // 指定 KB + 限定尺寸（证件照组合预设）：像素为硬性要求，只填一边时按等比换算
    const tw = params.targetWidth;
    const th = params.targetHeight;
    if (tw && th) {
      w = tw;
      h = th;
    } else if (tw) {
      h = (h * tw) / w;
      w = tw;
    } else if (th) {
      w = (w * th) / h;
      h = th;
    }
  }

  let downsampled = false;
  if (w > MAX_DIM || h > MAX_DIM) {
    const k = MAX_DIM / Math.max(w, h);
    w *= k;
    h *= k;
    downsampled = true;
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), downsampled };
}

function loadImage(img: ImageLike, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = (err) => {
      reject(new Error(`图片解码失败，可能是聊天文件中的 HEIC 等小程序不支持的格式，请保存到相册后重试（${String(err)}）`));
    };
    img.src = src;
  });
}

/**
 * 按输出尺寸与 orientation 绘制（铺满画布并完成旋转/镜像）。
 * 映射表以 P1 真机验证为准（实施文档 4.6 第 3 项），方向不符时只需调本表。
 */
function drawOriented(ctx: Ctx2D, img: ImageLike, orientation: string, outW: number, outH: number): void {
  ctx.save();
  switch (orientation) {
    case 'up':
      ctx.drawImage(img, 0, 0, outW, outH);
      break;
    case 'up-mirrored':
      ctx.translate(outW, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, outW, outH);
      break;
    case 'down':
      ctx.translate(outW, outH);
      ctx.rotate(Math.PI);
      ctx.drawImage(img, 0, 0, outW, outH);
      break;
    case 'down-mirrored':
      ctx.translate(0, outH);
      ctx.scale(1, -1);
      ctx.drawImage(img, 0, 0, outW, outH);
      break;
    case 'left':
      ctx.translate(0, outW);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(img, 0, 0, outH, outW);
      break;
    case 'right':
      ctx.translate(outH, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(img, 0, 0, outH, outW);
      break;
    case 'left-mirrored':
      ctx.transform(0, 1, 1, 0, 0, 0);
      ctx.drawImage(img, 0, 0, outH, outW);
      break;
    case 'right-mirrored':
      ctx.transform(0, -1, -1, 0, outW, outH);
      ctx.drawImage(img, 0, 0, outH, outW);
      break;
    default:
      // 未知值按 'up' 处理
      ctx.drawImage(img, 0, 0, outW, outH);
  }
  ctx.restore();
}

export class CanvasEngine implements ImageEngine {
  constructor(private readonly provider: CanvasProvider) {}

  async process(source: SourceImage, params: ProcessParams): Promise<ProcessResult> {
    const base: ProcessResult = { inputPath: source.path, inputBytes: source.bytes, ok: false };
    let canvas: CanvasLike | null = null;
    try {
      canvas = await this.provider();
      const out = await this.processInner(canvas, source, params);
      return { ...base, ...out, ok: true };
    } catch (e) {
      return { ...base, ok: false, error: toErrMsg(e) };
    } finally {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }

  private async processInner(
    canvas: CanvasLike,
    source: SourceImage,
    params: ProcessParams
  ): Promise<Partial<ProcessResult>> {
    const img = canvas.createImage();
    await loadImage(img, source.path);

    const oriented = orientedDims(source);
    const target = computeTargetDims(oriented, params);
    const ctx = canvas.getContext('2d');
    const dimsChanged = target.width !== oriented.width || target.height !== oriented.height;
    // 输出格式：'auto' 跟随源图（png→png，其余→jpg）；指定 KB 恒为 jpg（坑 1）
    const fmt: OutputFormat =
      params.mode === 'targetKB'
        ? 'jpg'
        : params.outputFormat === 'auto'
          ? source.format === 'png'
            ? 'png'
            : 'jpg'
          : params.outputFormat;

    /** Canvas 渲染并导出：方向校正 + 底色填充的兜底通道（targetKB 搜索会多次调用） */
    const canvasExportAt = async (quality01: number, scale: number) => {
      const w = Math.max(1, Math.round(target.width * scale));
      const h = Math.max(1, Math.round(target.height * scale));
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      if (fmt === 'jpg') {
        // 坑 2：透明区域导出 JPG 为黑底，先填底色
        ctx.fillStyle = params.background ?? '#ffffff';
        ctx.fillRect(0, 0, w, h);
      }
      drawOriented(ctx, img, source.orientation, w, h);
      const path = await this.exportCanvas(canvas, fmt, quality01);
      const bytes = await getFileSize(path);
      return { path, bytes, w, h };
    };

    /**
     * 快速通道：jpg 源走原生 compressImage（质量口径 1-100，注意与 Canvas 的 0-1 不同），
     * 失败自动回退 Canvas（坑 3：iOS 仅 JPG，故仅 jpg 源启用）。
     */
    const fastEligible =
      FAST_PATH_ENABLED &&
      FAST_PLATFORM_OK &&
      fmt === 'jpg' &&
      source.format === 'jpg' &&
      (params.mode === 'targetKB' || params.mode === 'quality');
    const fastExport = async (quality01: number, scale: number) => {
      const w = Math.max(1, Math.round(target.width * scale));
      const h = Math.max(1, Math.round(target.height * scale));
      const downscale = scale < 1 || dimsChanged;
      const path = await compressImage({
        src: source.path,
        quality: clamp(Math.round(quality01 * 100), 1, 100),
        compressedWidth: downscale ? w : undefined,
        compressedHeight: downscale ? h : undefined,
      });
      const bytes = await getFileSize(path);
      // 输出比原图还大且明确在压质量：参数未生效，弃用回退 Canvas
      if (bytes > source.bytes && quality01 < 0.95) {
        throw new Error('compressImage quality ignored');
      }
      let outW = w;
      let outH = h;
      if (downscale) {
        // 校验尺寸参数确实生效（部分实现会忽略 compressedWidth/Height）
        const info = await getImageInfo(path);
        if (Math.abs(info.width - w) > 1 || Math.abs(info.height - h) > 1) {
          removeFileQuiet(path);
          throw new Error('compressImage size ignored');
        }
        outW = info.width;
        outH = info.height;
      }
      return { path, bytes, w: outW, h: outH };
    };

    const exportAt = async (quality01: number, scale: number) => {
      if (fastEligible) {
        try {
          return await fastExport(quality01, scale);
        } catch {
          // 回退 Canvas
        }
      }
      return canvasExportAt(quality01, scale);
    };

    if (params.mode === 'targetKB' && params.targetKB && params.targetKB > 0) {
      // 指定 KB 模式固定输出 JPG（quality 搜索仅对 JPG 有效，见坑 1）；
      // 限定尺寸（证件照组合预设）时像素是硬性要求，仅搜索质量
      const dimsFixed = !!(params.targetWidth || params.targetHeight);
      const targetBytes = params.targetKB * 1024;
      const dimsAlreadyOk =
        !dimsFixed || (oriented.width === target.width && oriented.height === target.height);
      if (source.bytes <= targetBytes && dimsAlreadyOk) {
        if (source.format === 'jpg') {
          // 原图已达标：直接沿用原文件，重编码反而可能"越压越大"（4.4）
          return {
            outputPath: source.path,
            outputBytes: source.bytes,
            width: target.width,
            height: target.height,
            targetMet: true,
            iterations: 0,
          };
        }
        // 非 JPG 源仅需转格式：单次高质量导出
        const converted = await exportAt(0.9, 1);
        return {
          outputPath: converted.path,
          outputBytes: converted.bytes,
          width: converted.w,
          height: converted.h,
          qualityUsed: 90,
          targetMet: converted.bytes <= targetBytes,
          iterations: 1,
        };
      }
      const search = await searchForTargetBytes(
        { exportAt, cleanup: removeFileQuiet },
        { targetBytes, sourceBytes: source.bytes, fixedDims: dimsFixed }
      );
      return {
        outputPath: search.bestPath,
        outputBytes: search.bestBytes,
        width: search.w,
        height: search.h,
        qualityUsed: Math.round(search.quality01 * 100),
        iterations: search.iterations,
        targetMet: search.targetMet,
        downsampled: target.downsampled || search.scale < 1,
      };
    }

    // quality / resize / convert：单次导出（百分比缩放已在目标尺寸中体现，scale 恒为 1）
    const quality01 = clamp((params.quality ?? 80) / 100, 0.05, 1);
    const { path, bytes, w, h } = await exportAt(fmt === 'jpg' ? quality01 : 1, 1);
    // 同格式无损重编码可能不降反增（PNG 尤甚，坑 1）：不如保留原图
    const sameFormat = fmt === (source.format === 'png' ? 'png' : 'jpg');
    if (params.mode === 'quality' && sameFormat && !dimsChanged && bytes >= source.bytes) {
      removeFileQuiet(path);
      return {
        outputPath: source.path,
        outputBytes: source.bytes,
        width: target.width,
        height: target.height,
        keptOriginal: true,
      };
    }
    return {
      outputPath: path,
      outputBytes: bytes,
      width: w,
      height: h,
      qualityUsed: fmt === 'jpg' ? Math.round(quality01 * 100) : undefined,
      downsampled: target.downsampled,
    };
  }

  private exportCanvas(canvas: CanvasLike, fileType: OutputFormat, quality01: number): Promise<string> {
    // 坑 15：显式 destWidth/destHeight = 画布像素，避免高 DPR 机型导出尺寸与预期不符
    return canvasToTempFilePath({
      canvas,
      fileType,
      quality: quality01,
      destWidth: canvas.width,
      destHeight: canvas.height,
    });
  }
}

/** 读取图片方向信息的便捷方法（供 UI 层展示用） */
export { getImageInfo };
