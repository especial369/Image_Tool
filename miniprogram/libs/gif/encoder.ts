/**
 * GIF89a 编码器（纯 TS，无 wx 依赖，可进 Node 单测）。
 * 全局色表 + 逐帧索引 + LZW 压缩；支持透明（disposal=2）与 NETSCAPE 循环。
 * 与 decoder.ts 构成往返对，正确性由 tests/gif.test.js 的像素级 round-trip 保证。
 */
import { buildPalette, mapToIndices, type PaletteResult } from './quantize';

export interface GifEncodeFrame {
  rgba: ArrayLike<number>;
  delayMs: number;
}

export interface GifEncodeOptions {
  width: number;
  height: number;
  /** 循环次数，0 = 无限 */
  loop?: number;
  /** 调色板上限 2-256，默认 256 */
  maxColors?: number;
}

/** GIF 变宽 LZW 码压缩（与 decoder.lzwDecode 互为逆） */
export function lzwEncode(indices: ArrayLike<number>, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map<number, number>();
  const bytes: number[] = [];
  let bitBuf = 0;
  let bitCnt = 0;
  const emit = (code: number): void => {
    bitBuf |= code << bitCnt;
    bitCnt += codeSize;
    while (bitCnt >= 8) {
      bytes.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCnt -= 8;
    }
  };
  emit(clear);
  if (indices.length === 0) {
    emit(eoi);
    if (bitCnt > 0) bytes.push(bitBuf & 0xff);
    return Uint8Array.from(bytes);
  }
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (cur << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      cur = hit;
      continue;
    }
    emit(cur);
    if (next === 4096) {
      // 表满：发 clear 重置字典（omggif 策略）
      emit(clear);
      dict = new Map<number, number>();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (next >= 1 << codeSize && codeSize < 12) codeSize++;
      dict.set(key, next++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoi);
  if (bitCnt > 0) bytes.push(bitBuf & 0xff);
  return Uint8Array.from(bytes);
}

function pow2Bits(n: number): { size: number; bits: number } {
  let size = 2;
  let bits = 1;
  while (size < n) {
    size *= 2;
    bits++;
  }
  return { size: Math.min(size, 256), bits: Math.min(bits, 8) };
}

/** 低层装配：已量化的索引帧 + 调色板 → GIF 字节 */
export function encodeGifIndexed(
  frames: Uint8Array[],
  delaysMs: number[],
  quant: PaletteResult,
  opts: { width: number; height: number; loop?: number }
): Uint8Array {
  const { width, height } = opts;
  const loop = opts.loop ?? 0;
  const { size: gctSize, bits: gctBits } = pow2Bits(quant.palette.length);
  const out: number[] = [];
  const push = (...b: number[]) => out.push(...b);
  const pushStr = (s: string) => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  };
  const pushU16 = (n: number) => push(n & 0xff, (n >> 8) & 0xff);

  pushStr('GIF89a');
  pushU16(width);
  pushU16(height);
  push(0x80 | (gctBits - 1)); // 全局色表存在，size = 2^(N+1)
  push(0); // 背景色
  push(0); // 宽高比
  for (let i = 0; i < gctSize; i++) {
    const c = quant.palette[i];
    if (c === undefined || c < 0) {
      push(0, 0, 0);
    } else {
      push((c >> 16) & 255, (c >> 8) & 255, c & 255);
    }
  }

  // NETSCAPE2.0 循环扩展
  push(0x21, 0xff, 0x0b);
  pushStr('NETSCAPE2.0');
  push(0x03, 0x01);
  pushU16(loop);
  push(0x00);

  const minCodeSize = 8;
  for (let f = 0; f < frames.length; f++) {
    const delayCs = Math.min(65535, Math.max(2, Math.round(delaysMs[f] / 10)));
    // 图形控制扩展：disposal=2（透明帧清底）、disposal=1（不透明帧保留）
    push(0x21, 0xf9, 0x04);
    push(((quant.transparent ? 2 : 1) << 2) | (quant.transparent ? 1 : 0));
    pushU16(delayCs);
    push(0); // 透明索引
    push(0x00);

    // 图像描述符（全画布，无局部色表，不交错）
    push(0x2c);
    pushU16(0);
    pushU16(0);
    pushU16(width);
    pushU16(height);
    push(0x00);

    push(minCodeSize);
    const lzw = lzwEncode(frames[f], minCodeSize);
    for (let i = 0; i < lzw.length; i += 255) {
      const chunk = lzw.subarray(i, i + 255);
      push(chunk.length);
      for (const b of chunk) push(b);
    }
    push(0x00);
  }
  push(0x3b);
  return Uint8Array.from(out);
}

/** 高层入口：RGBA 帧 → 量化 → GIF 字节 */
export function encodeGif(frames: GifEncodeFrame[], opts: GifEncodeOptions): Uint8Array {
  const maxColors = Math.min(256, Math.max(2, opts.maxColors ?? 256));
  const quant = buildPalette(
    frames.map((f) => f.rgba),
    maxColors,
    true
  );
  const indexed = frames.map((f) => mapToIndices(f.rgba, quant.palette, quant.transparent));
  return encodeGifIndexed(
    indexed,
    frames.map((f) => f.delayMs),
    quant,
    { width: opts.width, height: opts.height, loop: opts.loop }
  );
}
