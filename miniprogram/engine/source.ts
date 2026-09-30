import type { SourceImage } from './types';
import { getImageInfo } from '../utils/wxp';
import { getFileSize } from '../utils/file';

/** 小程序 Canvas 可解码的常见图片格式 */
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif)$/i;

export function isSupportedImagePath(path: string): boolean {
  return IMAGE_EXT.test(path);
}

/**
 * 加载源图信息（尺寸/格式/方向/体积）。
 * knownBytes 来自 chooseMedia.tempFiles.size，可省一次 getFileInfo。
 * 解码不支持时 getImageInfo 会 reject（坑 14：聊天文件中的 HEIC 等），由上层转为友好提示。
 */
export async function loadSource(path: string, knownBytes?: number): Promise<SourceImage> {
  const [info, bytes] = await Promise.all([
    getImageInfo(path),
    knownBytes != null ? Promise.resolve(knownBytes) : getFileSize(path),
  ]);
  return {
    path,
    bytes,
    width: info.width,
    height: info.height,
    format: info.type,
    orientation: info.orientation,
  };
}
