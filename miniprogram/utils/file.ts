/** 文件工具：体积读取、中间产物清理、体积格式化 */

export function getFileSize(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({
      filePath: path,
      success: (r) => resolve(r.size),
      fail: (e) => reject(new Error(e.errMsg)),
    });
  });
}

/** 清理中间临时产物；失败静默（临时文件可能已被系统回收） */
export function removeFileQuiet(path: string): void {
  try {
    wx.getFileSystemManager().unlink({ filePath: path, fail: () => undefined });
  } catch {
    // 忽略
  }
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
