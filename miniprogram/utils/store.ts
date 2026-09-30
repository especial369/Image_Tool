import type { ProcessParams, ProcessResult } from '../engine/types';

/** 首页四个功能入口 */
export type FuncKey = 'compress' | 'targetKB' | 'resize' | 'convert';

/**
 * 轻量会话级 store：页面间传递选图与结果。
 * 临时文件路径在本会话内有效，无需持久化；历史记录（v1.x）才涉及 USER_DATA_PATH。
 */
export const store = {
  funcKey: 'compress' as FuncKey,
  /** 选中的临时文件路径（chooseMedia sizeType original / chooseMessageFile） */
  sources: [] as string[],
  /** 路径 → 字节数（来自 chooseMedia.tempFiles.size，避免重复 getFileInfo） */
  sourceSizes: {} as Record<string, number>,
  /** 上次使用的参数（微调再压时回填） */
  lastParams: null as ProcessParams | null,
  results: [] as ProcessResult[],
  /** 已成功处理的路径 → 参数指纹（断点续跑：同参数下不重跑，坑 11 配套） */
  doneKeys: {} as Record<string, string>,
  /** 结果页发起的失败重试路径，process 页 onShow 接管 */
  retryPaths: null as string[] | null,
};

export function setSelection(paths: string[], sizes: Record<string, number>): void {
  store.sources = paths;
  store.sourceSizes = sizes;
  store.results = [];
  store.doneKeys = {};
  store.retryPaths = null;
}
