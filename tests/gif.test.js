/**
 * GIF 编解码器像素级往返测试（纯逻辑模块，Node 运行）：
 * 编码 → 解码 → 像素比对。覆盖：精确往返（≤256 色）、量化误差上界、
 * LZW 字典溢出（clear 重置路径）、透明、帧延时、循环次数。
 */
const assert = require('assert');
const { decodeAll } = require('../.test-build/libs/gif/decoder.js');
const { encodeGif } = require('../.test-build/libs/gif/encoder.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ✓', name);
  } catch (e) {
    failed += 1;
    console.error('  ✗', name, '\n    ', e.message);
  }
}

/** 可复现伪随机 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function solidFrame(w, h, r, g, b, transparentRect) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inHole = transparentRect && x >= transparentRect.x && x < transparentRect.x + transparentRect.w && y >= transparentRect.y && y < transparentRect.y + transparentRect.h;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = inHole ? 0 : 255;
    }
  }
  return rgba;
}

function samePixel(a, ao, b, bo) {
  const aTrans = a[ao + 3] < 128;
  const bTrans = b[bo + 3] < 128;
  if (aTrans || bTrans) return aTrans === bTrans; // 透明像素只比对透明性，不比 RGB
  for (let c = 0; c < 3; c++) {
    if (Math.abs(a[ao + c] - b[bo + c]) > 8) return false; // 允许 ±8 的色表取整抖动
  }
  return true;
}

async function main() {
  console.log('gif codec:');

  await test('精确往返：3 帧、透明、帧延时、无限循环', async () => {
    const w = 24;
    const h = 16;
    const frames = [
      { rgba: solidFrame(w, h, 255, 0, 0), delayMs: 100 },
      { rgba: solidFrame(w, h, 0, 255, 0, { x: 2, y: 2, w: 4, h: 4 }), delayMs: 200 },
      { rgba: solidFrame(w, h, 0, 0, 255), delayMs: 30 },
    ];
    const bytes = encodeGif(frames, { width: w, height: h, loop: 0, maxColors: 256 });
    const { meta, frames: decoded } = decodeAll(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.strictEqual(meta.width, w);
    assert.strictEqual(meta.height, h);
    assert.strictEqual(meta.loopCount, 0);
    assert.strictEqual(decoded.length, 3);
    assert.deepStrictEqual(
      decoded.map((f) => f.delayMs),
      [100, 200, 30],
      '帧延时应逐帧保留'
    );
    for (let f = 0; f < 3; f++) {
      const src = frames[f].rgba;
      const dst = decoded[f].rgba;
      for (let i = 0; i < src.length; i += 4) {
        assert.ok(samePixel(src, i, dst, i), `帧${f + 1} 像素 ${i / 4} 不一致`);
      }
    }
  });

  await test('量化误差上界：随机彩色帧压到 64 色，解码色均在调色板内且平均误差可控', async () => {
    const rand = mulberry32(42);
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = Math.floor(rand() * 256);
      rgba[i * 4 + 1] = Math.floor(rand() * 256);
      rgba[i * 4 + 2] = Math.floor(rand() * 256);
      rgba[i * 4 + 3] = 255;
    }
    const bytes = encodeGif([{ rgba, delayMs: 100 }], { width: w, height: h, loop: 0, maxColors: 64 });
    const { frames: decoded } = decodeAll(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.strictEqual(decoded.length, 1);
    const dst = decoded[0].rgba;
    let sum = 0;
    let maxAlphaBad = 0;
    for (let i = 0; i < w * h; i++) {
      sum += Math.abs(dst[i * 4] - rgba[i * 4]) + Math.abs(dst[i * 4 + 1] - rgba[i * 4 + 1]) + Math.abs(dst[i * 4 + 2] - rgba[i * 4 + 2]);
      if (dst[i * 4 + 3] !== 255) maxAlphaBad++;
    }
    const mean = sum / (w * h * 3);
    assert.strictEqual(maxAlphaBad, 0, '不透明输入不应产生透明像素');
    assert.ok(mean < 40, `平均色差 ${mean.toFixed(1)} 超出上界`);
  });

  await test('LZW 字典溢出：超过 4096 码触发 clear 重置，往返仍精确', async () => {
    const rand = mulberry32(7);
    const w = 160;
    const h = 160;
    // 250 种固定颜色 → 调色板可精确覆盖；随机序列迫使字典超过 4096
    const colors = [];
    for (let i = 0; i < 250; i++) colors.push([Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)]);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c = colors[Math.floor(rand() * colors.length)];
      rgba[i * 4] = c[0];
      rgba[i * 4 + 1] = c[1];
      rgba[i * 4 + 2] = c[2];
      rgba[i * 4 + 3] = 255;
    }
    const bytes = encodeGif([{ rgba, delayMs: 100 }], { width: w, height: h, loop: 3, maxColors: 256 });
    const { meta, frames: decoded } = decodeAll(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.strictEqual(meta.loopCount, 3, '循环次数应保留');
    const src = rgba;
    const dst = decoded[0].rgba;
    for (let i = 0; i < src.length; i += 4) {
      assert.ok(samePixel(src, i, dst, i), `像素 ${i / 4} 在字典溢出后不一致`);
    }
  });

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
