/**
 * 处理引擎类型定义。
 * 引擎与 UI 分离：页面只负责提供 Canvas 和收集参数，处理逻辑全部在此模块内，
 * 接口为纯函数式约定（输入文件 + 参数 → 输出文件），便于单测与后续复用。
 */

export type OutputFormat = 'jpg' | 'png';

export type ProcessMode = 'quality' | 'targetKB' | 'resize' | 'convert';

export interface SourceImage {
  /** 本地临时文件路径（chooseMedia / chooseMessageFile 产物） */
  path: string;
  /** 文件字节数 */
  bytes: number;
  /** 原始（存储方向）像素尺寸 */
  width: number;
  height: number;
  /** getImageInfo.type，如 jpg / png / webp */
  format: string;
  /** getImageInfo.orientation，共 8 种取值（对应 EXIF 1-8） */
  orientation: string;
}

export interface ProcessParams {
  mode: ProcessMode;
  /** 输出格式：'auto' 表示跟随源图（png→png，其余→jpg） */
  outputFormat: OutputFormat | 'auto';
  /** 压缩质量，口径 1-100（UI 与 compressImage 口径）。引擎内部转 0-1 供 canvasToTempFilePath，注意两者单位不同 */
  quality?: number;
  /** targetKB 模式：目标体积（KB） */
  targetKB?: number;
  /** resize 模式：目标宽/高（等比锁定见 lockRatio） */
  targetWidth?: number;
  targetHeight?: number;
  /** resize 模式等比锁定，默认 true */
  lockRatio?: boolean;
  /** resize 模式：按百分比缩放（如 50 表示 50%） */
  scalePercent?: number;
  /** 透明区域填充色（输出 JPG 时使用），默认 '#ffffff' */
  background?: string;
}

export interface ProcessResult {
  inputPath: string;
  /** 输入文件字节数，用于结果页压缩率展示 */
  inputBytes?: number;
  ok: boolean;
  outputPath?: string;
  outputBytes?: number;
  /** 输出像素尺寸 */
  width?: number;
  height?: number;
  /** 实际使用的质量（1-100 口径） */
  qualityUsed?: number;
  /** targetKB 模式：导出试探次数 */
  iterations?: number;
  /** targetKB 模式：是否达标 */
  targetMet?: boolean;
  /** 因 canvas 尺寸上限触发过降采样 */
  downsampled?: boolean;
  /** 同格式重编码未变小，已保留原图（坑 1） */
  keptOriginal?: boolean;
  error?: string;
}

/** 最小结构化 Canvas 约定：页面隐藏 canvas 与离屏 canvas 都满足（坑 12） */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): Ctx2D;
  createImage(): ImageLike;
}

export interface ImageLike {
  src: string;
  width: number;
  height: number;
  onload: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
}

/** 只约定引擎实际用到的方法面 */
export interface Ctx2D {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: ImageLike, dx: number, dy: number, dw: number, dh: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  scale(x: number, y: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

/** 引擎不关心 canvas 来源：页面隐藏 canvas（默认）或离屏 canvas（优化项） */
export type CanvasProvider = () => Promise<CanvasLike>;

export interface ImageEngine {
  process(source: SourceImage, params: ProcessParams): Promise<ProcessResult>;
}
