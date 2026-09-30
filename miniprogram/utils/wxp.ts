/**
 * wx API 的 Promise 化封装（仅收录项目用到的）。
 * 关键约束：chooseMedia 必须显式 sizeType: ['original'] 锁定原图，否则压缩率展示失真。
 */

export interface WxImageInfo {
  width: number;
  height: number;
  orientation: string;
  /** jpg / png / webp ... */
  type: string;
}

export function getImageInfo(src: string): Promise<WxImageInfo> {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: (r) => resolve({ width: r.width, height: r.height, orientation: r.orientation, type: r.type }),
      fail: (e) => reject(new Error(e.errMsg)),
    });
  });
}

export interface ChosenMediaFile {
  tempFilePath: string;
  size: number;
}

export async function chooseImages(count: number): Promise<ChosenMediaFile[]> {
  const res = await wx.chooseMedia({
    count,
    mediaType: ['image'],
    sizeType: ['original'],
    sourceType: ['album', 'camera'],
  });
  return res.tempFiles.map((f) => ({ tempFilePath: f.tempFilePath, size: f.size }));
}

export interface ChosenChatFile {
  path: string;
  size: number;
  name: string;
}

export async function chooseChatFiles(count: number): Promise<ChosenChatFile[]> {
  const res = await wx.chooseMessageFile({ count, type: 'all' });
  return res.tempFiles.map((f) => ({ path: f.path, size: f.size, name: f.name }));
}

export function canvasToTempFilePath(opt: {
  canvas: unknown;
  fileType: 'jpg' | 'png';
  /** 0-1 浮点（注意与 compressImage 的 1-100 口径不同） */
  quality: number;
  destWidth: number;
  destHeight: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({
      canvas: opt.canvas as never,
      fileType: opt.fileType,
      quality: opt.quality,
      destWidth: opt.destWidth,
      destHeight: opt.destHeight,
      success: (r) => resolve(r.tempFilePath),
      fail: (e) => reject(new Error(e.errMsg)),
    });
  });
}

/** 原生快速压缩（快速通道，坑 3：iOS 仅支持 JPG） */
export function compressImage(opt: {
  src: string;
  /** 1-100 口径 */
  quality: number;
  compressedWidth?: number;
  compressedHeight?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.compressImage({
      ...opt,
      success: (r) => resolve(r.tempFilePath),
      fail: (e) => reject(new Error(e.errMsg)),
    });
  });
}

export function saveImageToPhotosAlbum(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => resolve(),
      fail: (e) => reject(new Error(e.errMsg)),
    });
  });
}

export function getSetting(): Promise<WechatMiniprogram.AuthSetting> {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success: (r) => resolve(r.authSetting),
      fail: (e) => reject(new Error(e.errMsg)),
    });
  });
}

export function openSetting(): Promise<WechatMiniprogram.AuthSetting> {
  return new Promise((resolve, reject) => {
    wx.openSetting({
      success: (r) => resolve(r.authSetting),
      fail: (e) => reject(new Error(e.errMsg)),
    });
  });
}

export function showModal(opt: {
  title: string;
  content: string;
  confirmText?: string;
  showCancel?: boolean;
}): Promise<{ confirm: boolean }> {
  return new Promise((resolve) => {
    wx.showModal({
      title: opt.title,
      content: opt.content,
      confirmText: opt.confirmText ?? '确定',
      showCancel: opt.showCancel ?? true,
      success: (r) => resolve({ confirm: r.confirm }),
      fail: () => resolve({ confirm: false }),
    });
  });
}
