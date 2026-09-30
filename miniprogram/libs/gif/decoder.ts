/**
 * GIF89a 解码器（纯 TS，无 wx 依赖，可进 Node 单测）。
 * 按 GIF 规范实现：LZW 解码、全局/局部色表、透明索引、 disposal 合成、交错还原、循环次数。
 * 设计为生成器逐帧产出（复用同一合成缓冲区），消费方可边解码边做异步导出（如拆帧存 PNG）。
 */

export interface GifMeta {
  width: number;
  height: number;
  /** 0 = 无限循环 */
  loopCount: number;
}

export interface GifFrameView {
  index: number;
  /** 全画布 RGBA（复用缓冲区！消费方需在拉取下一帧前同步处理或自行拷贝） */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** 原始帧时长（毫秒，0 已按浏览器惯例归一为 100） */
  delayMs: number;
}

export interface OpenedGif extends GifMeta {
  /** 逐帧迭代（每次调用都会新建解析器，可多次迭代；生成器内部不可交错使用） */
  frames(): Generator<GifFrameView>;
}

class Reader {
  pos = 0;
  constructor(private readonly v: Uint8Array) {}
  u8(): number {
    return this.v[this.pos++];
  }
  u16(): number {
    const x = this.v[this.pos] | (this.v[this.pos + 1] << 8);
    this.pos += 2;
    return x;
  }
  bytes(n: number): Uint8Array {
    const out = this.v.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.v[this.pos + i]);
    this.pos += n;
    return s;
  }
  /** 跳过子块序列（count=0 结束），返回拼接数据（仅当 collect） */
  subBlocks(collect = false): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const size = this.u8();
      if (size === 0) break;
      const c = this.bytes(size);
      if (collect) chunks.push(c);
    }
    return chunks;
  }
}

/** GIF 变宽 LZW 码解码 */
function lzwDecode(minCodeSize: number, data: Uint8Array, outSize: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 8) throw new Error(`GIF LZW 最小码长非法: ${minCodeSize}`);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const out = new Uint8Array(outSize);
  let outPos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let dataPos = 0;
  let prev = -1;
  const stack: number[] = [];

  const readCode = (): number => {
    while (bitCnt < codeSize) {
      if (dataPos >= data.length) return -1;
      bitBuf |= data[dataPos++] << bitCnt;
      bitCnt += 8;
    }
    const c = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>= codeSize;
    bitCnt -= codeSize;
    return c;
  };
  const chainToStack = (code: number): number => {
    // 把码链压栈（栈顶为末像素），返回链首的基础像素值
    let c = code;
    while (c >= clear) {
      stack.push(suffix[c]);
      c = prefix[c];
    }
    return c;
  };

  for (;;) {
    if (outPos >= outSize) break;
    const code = readCode();
    if (code === -1) break; // 数据截断，尽力输出
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;

    stack.length = 0;
    let first: number;
    if (code < next && (code < clear || prefix[code] >= 0 || code < clear + 1)) {
      first = chainToStack(code);
    } else if (code === next && prev >= 0) {
      // KwKwK： prev 链 + prev 首像素
      first = chainToStack(prev);
    } else {
      break; // 非法码，尽力输出
    }
    // 栈序为逆序：先落链首
    out[outPos++] = first;
    while (stack.length > 0 && outPos < outSize) {
      out[outPos++] = stack.pop() as number;
    }
    // KwKwK 补首像素
    if (code === next && prev >= 0 && outPos < outSize) {
      out[outPos++] = first;
    }

    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

/** 交错存储还原为逐行 */
function deinterlace(indices: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ];
  let srcRow = 0;
  for (const p of passes) {
    for (let row = p.start; row < h; row += p.step) {
      out.set(indices.subarray(srcRow * w, srcRow * w + w), row * w);
      srcRow++;
    }
  }
  return out;
}

export function openGif(buf: ArrayBuffer): OpenedGif {
  const v = new Uint8Array(buf);
  const meta: GifMeta = { width: 0, height: 0, loopCount: 0 };

  // 头部快速解析（供 meta）
  {
    const r = new Reader(v);
    const sig = r.ascii(6);
    if (!/^GIF8[79]a$/.test(sig)) throw new Error('不是有效的 GIF 文件');
    meta.width = r.u16();
    meta.height = r.u16();
  }

  function* frames(): Generator<GifFrameView> {
    const r = new Reader(v);
    const sig = r.ascii(6);
    if (!/^GIF8[79]a$/.test(sig)) throw new Error('不是有效的 GIF 文件');
    const width = r.u16();
    const height = r.u16();
    const packed = r.u8();
    r.u8(); // 背景色索引
    r.u8(); // 像素宽高比
    const gct = (packed & 0x80) ? r.bytes(3 * (2 << (packed & 7))) : null;

    let canvas = new Uint8ClampedArray(width * height * 4);
    let snapshot: Uint8ClampedArray | null = null;
    // 待应用的 GCE
    let gceDisposal = 0;
    let gceDelayCs = 0;
    let gceTransparent = -1;
    let frameIndex = 0;

    for (;;) {
      const block = r.pos < v.length ? r.u8() : 0x3b;
      if (block === 0x3b) break; // trailer
      if (block === 0x21) {
        const label = r.u8();
        if (label === 0xf9) {
          const size = r.u8(); // 规范为 4
          const gPacked = r.u8();
          gceDelayCs = r.u16();
          const transIdx = r.u8(); // 第 4 字节始终存在，仅透明标志置位时生效
          gceTransparent = gPacked & 1 ? transIdx : -1;
          gceDisposal = (gPacked >> 2) & 7;
          if (size > 4) r.pos += size - 4; // 容错：个别编码器会多写
          r.u8(); // block terminator
        } else if (label === 0xff) {
          r.u8(); // 应用扩展标识块长（11）
          const appId = r.bytes(11);
          const chunks = r.subBlocks(true);
          if (appId[0] === 0x4e && chunks.length > 0 && chunks[0][0] === 0x01) {
            // NETSCAPE2.0 循环扩展
            meta.loopCount = chunks[0][1] | (chunks[0][2] << 8);
          }
        } else {
          r.subBlocks();
        }
        continue;
      }
      if (block !== 0x2c) break; // 未知块，停止

      const left = r.u16();
      const top = r.u16();
      const fw = r.u16();
      const fh = r.u16();
      const iPacked = r.u8();
      const lct = iPacked & 0x80 ? r.bytes(3 * (2 << (iPacked & 7))) : null;
      const interlaced = !!(iPacked & 0x40);
      const minCodeSize = r.u8();
      const chunks = r.subBlocks(true);
      let total = 0;
      for (const c of chunks) total += c.length;
      const lzwData = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        lzwData.set(c, off);
        off += c.length;
      }

      let indices = lzwDecode(minCodeSize, lzwData, fw * fh);
      if (interlaced) indices = deinterlace(indices, fw, fh);

      if (gceDisposal === 3) snapshot = canvas.slice();
      const table = lct ?? gct;
      if (!table) throw new Error('GIF 缺少色表');
      for (let row = 0; row < fh; row++) {
        const cy = top + row;
        if (cy < 0 || cy >= height) continue;
        for (let col = 0; col < fw; col++) {
          const cx = left + col;
          if (cx < 0 || cx >= width) continue;
          const idx = indices[row * fw + col];
          if (idx === gceTransparent) continue;
          const o = (cy * width + cx) * 4;
          const c = idx * 3;
          canvas[o] = table[c];
          canvas[o + 1] = table[c + 1];
          canvas[o + 2] = table[c + 2];
          canvas[o + 3] = 255;
        }
      }

      yield {
        index: frameIndex++,
        rgba: canvas,
        width,
        height,
        delayMs: gceDelayCs === 0 ? 100 : gceDelayCs * 10,
      };

      if (gceDisposal === 2) {
        for (let row = 0; row < fh; row++) {
          const cy = top + row;
          if (cy < 0 || cy >= height) continue;
          for (let col = 0; col < fw; col++) {
            const o = ((cy * width) + left + col) * 4;
            canvas[o] = 0;
            canvas[o + 1] = 0;
            canvas[o + 2] = 0;
            canvas[o + 3] = 0;
          }
        }
      } else if (gceDisposal === 3 && snapshot) {
        canvas.set(snapshot);
        snapshot = null;
      }
      gceDisposal = 0;
      gceDelayCs = 0;
      gceTransparent = -1;
    }
  }

  return { width: meta.width, height: meta.height, loopCount: meta.loopCount, frames };
}

/** 一次性解码全部帧（拷贝，测试与小图用） */
export function decodeAll(buf: ArrayBuffer, maxFrames = Infinity): { meta: GifMeta; frames: GifFrameView[] } {
  const gif = openGif(buf);
  const frames: GifFrameView[] = [];
  for (const f of gif.frames()) {
    frames.push({ ...f, rgba: new Uint8ClampedArray(f.rgba) });
    if (frames.length >= maxFrames) break;
  }
  return { meta: { width: gif.width, height: gif.height, loopCount: gif.loopCount }, frames };
}
