/**
 * RGBA 缩放（盒式均值降采样，纯函数，无 wx 依赖）。
 * GIF 压缩的降采样在纯 JS 里完成，避免为每帧分配第二个画布。
 */
export function resizeRgba(
  src: ArrayLike<number>,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yr);
    const sy1 = Math.min(sh, Math.max(sy0 + 1, Math.ceil((y + 1) * yr)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xr);
      const sx1 = Math.min(sw, Math.max(sx0 + 1, Math.ceil((x + 1) * xr)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          cnt++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / cnt;
      out[o + 1] = g / cnt;
      out[o + 2] = b / cnt;
      out[o + 3] = a / cnt;
    }
  }
  return out;
}
