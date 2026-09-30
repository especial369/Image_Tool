import type { ProcessResult } from './types';

/**
 * 串行队列（坑 5：禁止并行处理大图）。
 * worker 内部自行捕获异常返回失败结果，保证单张失败不阻塞整批（MVP 要求）。
 */
export async function runSerial<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<ProcessResult>,
  hooks?: {
    onItemDone?: (done: number, total: number, result: ProcessResult) => void;
  }
): Promise<ProcessResult[]> {
  const out: ProcessResult[] = [];
  for (let i = 0; i < items.length; i += 1) {
    let result: ProcessResult;
    try {
      result = await worker(items[i], i);
    } catch (e) {
      result = {
        inputPath: String(items[i]),
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    out.push(result);
    hooks?.onItemDone?.(i + 1, items.length, result);
  }
  return out;
}
