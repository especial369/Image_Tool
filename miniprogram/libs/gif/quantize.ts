/**
 * 调色板量化：中位切分法（median cut）+ 最近色映射。
 * 纯函数，无 wx 依赖。插画类输入（有限色数）映射为精确命中。
 */

export interface PaletteResult {
  /** 0xRRGGBB 列表；启用透明时下标 0 为保留位（值 -1），映射时透明像素归 0 */
  palette: number[];
  transparent: boolean;
}

type RgbCount = [number, number, number, number];

/** 从多帧 RGBA 采样构建全局调色板 */
export function buildPalette(
  frames: ArrayLike<number>[],
  maxColors: number,
  useTransparency: boolean
): PaletteResult {
  let hasTransparent = false;
  const counts = new Map<number, number>();
  const totalPixels = frames.reduce((s, f) => s + f.length / 4, 0);
  const stride = Math.max(1, Math.floor(totalPixels / 200000));
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 4 * stride) {
      if (f[i + 3] < 128) {
        hasTransparent = true;
        continue;
      }
      const key = ((f[i] << 16) | (f[i + 1] << 8) | f[i + 2]) >>> 0;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const slots = Math.max(2, useTransparency ? maxColors - 1 : maxColors);
  let distinct: RgbCount[] = [];
  counts.forEach((c, key) => distinct.push([(key >> 16) & 255, (key >> 8) & 255, key & 255, c]));

  // 离散色过多时先按 5bit/通道 归桶，控制中位切分开销
  if (distinct.length > 12000) {
    const buckets = new Map<number, RgbCount>();
    for (const c of distinct) {
      const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
      const cur = buckets.get(key);
      if (cur) {
        cur[0] += c[0] * c[3];
        cur[1] += c[1] * c[3];
        cur[2] += c[2] * c[3];
        cur[3] += c[3];
      } else {
        buckets.set(key, [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]);
      }
    }
    distinct = [];
    buckets.forEach((b) => {
      const w = b[3] || 1;
      distinct.push([Math.round(b[0] / w), Math.round(b[1] / w), Math.round(b[2] / w), b[3]]);
    });
  }

  let colors: number[];
  if (distinct.length <= slots) {
    colors = distinct.map((c) => ((c[0] << 16) | (c[1] << 8) | c[2]) >>> 0);
  } else {
    colors = medianCut(distinct, slots);
  }
  const palette = hasTransparent && useTransparency ? [-1, ...colors] : colors;
  return { palette: palette.slice(0, maxColors), transparent: hasTransparent && useTransparency };
}

function medianCut(colors: RgbCount[], slots: number): number[] {
  interface Box {
    colors: RgbCount[];
  }
  let boxes: Box[] = [{ colors }];
  while (boxes.length < slots) {
    let bi = -1;
    let bRange = -1;
    let bCh = 0;
    for (let i = 0; i < boxes.length; i++) {
      const cs = boxes[i].colors;
      if (cs.length < 2) continue;
      for (const ch of [0, 1, 2]) {
        let mn = 255;
        let mx = 0;
        for (const c of cs) {
          if (c[ch] < mn) mn = c[ch];
          if (c[ch] > mx) mx = c[ch];
        }
        const score = mx - mn;
        if (score > bRange) {
          bRange = score;
          bi = i;
          bCh = ch;
        }
      }
    }
    if (bi < 0 || bRange <= 0) break;
    const box = boxes[bi];
    box.colors.sort((a, b) => a[bCh] - b[bCh]);
    const mid = Math.floor(box.colors.length / 2);
    boxes.splice(bi, 1, { colors: box.colors.slice(0, mid) }, { colors: box.colors.slice(mid) });
  }
  return boxes
    .filter((b) => b.colors.length > 0)
    .map((b) => {
      let r = 0;
      let g = 0;
      let bl = 0;
      let w = 0;
      for (const c of b.colors) {
        r += c[0] * c[3];
        g += c[1] * c[3];
        bl += c[2] * c[3];
        w += c[3];
      }
      if (!w) return 0;
      return (((r / w) << 16) | ((g / w) << 8) | (bl / w)) >>> 0;
    });
}

/** 帧像素映射到调色板下标（透明 → 0；精确命中优先，未命中最近色并缓存） */
export function mapToIndices(
  rgba: ArrayLike<number>,
  palette: number[],
  transparent: boolean
): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  const cache = new Map<number, number>();
  const start = transparent ? 1 : 0;
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    if (transparent && rgba[i + 3] < 128) {
      out[j] = 0;
      continue;
    }
    const key = (((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0) + 1; // +1 避开 0 值键
    let idx = cache.get(key);
    if (idx === undefined) {
      let best = start;
      let bd = Infinity;
      for (let p = start; p < palette.length; p++) {
        const c = palette[p];
        const dr = ((c >> 16) & 255) - rgba[i];
        const dg = ((c >> 8) & 255) - rgba[i + 1];
        const db = (c & 255) - rgba[i + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      idx = best;
      cache.set(key, idx);
    }
    out[j] = idx;
  }
  return out;
}
