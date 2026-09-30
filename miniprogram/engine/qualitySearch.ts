/**
 * 压缩到指定体积的搜索策略（实施文档 4.4）：
 * 先按「目标字节/原图字节」估算定位初始质量与缩放，再局部收敛，
 * 替代纯二分的 6-8 次全量导出（低端机单张数秒、批量分钟级，不可接受）。
 *
 * fixedDims（证件照组合预设/手动限定尺寸）：像素是硬性要求，锁定 scale=1 只搜质量，
 * 质量到底仍超标则返回最优结果且 targetMet=false，不做降采样。
 */

export interface SearchDeps {
  /** 以指定质量与缩放渲染并导出，返回产物信息 */
  exportAt(quality01: number, scale: number): Promise<{ path: string; bytes: number; w: number; h: number }>;
  /** 删除废弃的中间产物（坑 13：临时文件必须即时清理） */
  cleanup(path: string): void;
}

export interface SearchOptions {
  targetBytes: number;
  sourceBytes: number;
  /** 最多导出试探次数，默认 6（估算定位后通常 2-4 次收敛，留余量） */
  maxIterations?: number;
  /** 尺寸为硬性要求时置 true：scale 锁 1、禁用降采样兜底 */
  fixedDims?: boolean;
}

export interface SearchResult {
  bestPath: string;
  bestBytes: number;
  w: number;
  h: number;
  quality01: number;
  scale: number;
  iterations: number;
  targetMet: boolean;
}

/** 达标的相对误差：结果体积不超过目标的 10% 即视为命中 */
const TOLERANCE = 0.1;
const QUALITY_FLOOR = 0.05;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 最优判定：不超标优先，其次最接近目标 */
function isBetter(bytes: number, bestBytes: number, target: number): boolean {
  const overNew = bytes > target;
  const overOld = bestBytes > target;
  if (overNew !== overOld) return !overNew;
  return Math.abs(bytes - target) < Math.abs(bestBytes - target);
}

export async function searchForTargetBytes(deps: SearchDeps, opt: SearchOptions): Promise<SearchResult> {
  const maxIter = opt.maxIterations ?? 6;
  const ratio = opt.targetBytes / Math.max(1, opt.sourceBytes);

  // 估算定位：体积大致随质量单调、随面积平方变化；比例过小（<0.3）时叠加降采样
  let q = clamp(0.25 + ratio * 0.75, 0.25, 0.9);
  let scale = opt.fixedDims ? 1 : ratio < 0.3 ? clamp(Math.sqrt(ratio / 0.3), 0.35, 1) : 1;

  let best: { path: string; bytes: number; w: number; h: number; q: number; scale: number } | null = null;
  let downsizeLeft = 3;
  let iterations = 0;
  let prevQ = -1;
  let prevBytes = -1;

  while (iterations < maxIter) {
    // 质量到底且本轮无调整（如限定尺寸下的下限）：继续导出只会得到相同结果
    if (prevQ >= 0 && Math.abs(q - prevQ) < 0.001) break;
    prevQ = q;
    iterations += 1;

    const attempt = await deps.exportAt(q, scale);
    const met = attempt.bytes <= opt.targetBytes * (1 + TOLERANCE);
    if (!best || isBetter(attempt.bytes, best.bytes, opt.targetBytes)) {
      if (best) deps.cleanup(best.path);
      best = { ...attempt, q, scale };
    } else {
      deps.cleanup(attempt.path);
    }
    if (met) {
      return finish(true);
    }

    // 与上一轮导出结果完全一致：导出器未响应质量/尺寸变化（如模拟器忽略参数），继续试探无意义
    if (attempt.bytes === prevBytes) {
      return finish(false);
    }
    prevBytes = attempt.bytes;

    // 仍超标：先降质量；非限定尺寸且质量到底时按 ×0.8 降分辨率兜底（4.4）
    // 阻尼 0.85：比纯比例略保守，避免在凸响应曲线上过冲到远低于目标
    const corr = opt.targetBytes / attempt.bytes;
    q = clamp(q * Math.pow(corr, 0.85), QUALITY_FLOOR, 1);
    if (!opt.fixedDims && q <= QUALITY_FLOOR + 0.01 && downsizeLeft > 0) {
      scale = Math.max(0.2, scale * 0.8);
      downsizeLeft -= 1;
      q = 0.75;
      prevQ = -1; // 降采样后重新计进度
    }
  }

  return finish(false);

  function finish(met: boolean): SearchResult {
    if (!best) throw new Error('searchForTargetBytes: no attempt produced');
    return {
      bestPath: best.path,
      bestBytes: best.bytes,
      w: best.w,
      h: best.h,
      quality01: best.q,
      scale: best.scale,
      iterations,
      targetMet: met,
    };
  }
}
