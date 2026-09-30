/** 常用尺寸与证件照组合预设（实施文档 2.2/2.3）。预设表可按运营数据增删。 */

export interface SizePreset {
  key: string;
  name: string;
  w: number;
  h: number;
}

export interface PhotoPreset {
  key: string;
  name: string;
  w: number;
  h: number;
  /** 目标体积上限（KB） */
  kb: number;
}

/** 改尺寸：常用像素预设 */
export const SIZE_PRESETS: SizePreset[] = [
  { key: '1in', name: '一寸 295×413', w: 295, h: 413 },
  { key: '2in', name: '二寸 413×579', w: 413, h: 579 },
  { key: '720p', name: '720P 1280×720', w: 1280, h: 720 },
  { key: '1080p', name: '1080P 1920×1080', w: 1920, h: 1080 },
];

/** 指定大小：证件照组合预设（像素 + KB 一次套用，输出 JPG） */
export const PHOTO_PRESETS: PhotoPreset[] = [
  { key: 'photo-1in', name: '一寸 295×413 ≤100KB', w: 295, h: 413, kb: 100 },
  { key: 'photo-2in', name: '二寸 413×579 ≤200KB', w: 413, h: 579, kb: 200 },
];

/** 改尺寸：百分比快捷档 */
export const PERCENT_CHIPS = [25, 50, 75];
