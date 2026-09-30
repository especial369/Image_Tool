import type { CanvasLike, CanvasProvider } from '../engine/types';

/** 页面内隐藏 canvas 的取节点封装（process 页与 gif 页共用） */
export function pageCanvasProvider(page: unknown, selector: string): CanvasProvider {
  return () =>
    new Promise<CanvasLike>((resolve, reject) => {
      wx.createSelectorQuery()
        .select(selector)
        .fields({ node: true })
        .exec((res) => {
          const node = res && res[0] && (res[0] as { node?: unknown }).node;
          if (!node) {
            reject(new Error('获取引擎 Canvas 失败'));
            return;
          }
          resolve(node as CanvasLike);
        });
    });
}
