import type { FuncKey } from '../utils/store';

export type CapabilityTint = 'green' | 'blue' | 'orange' | 'purple' | 'cyan' | 'pink';

/**
 * 能力注册表：首页卡片、分组、路由全部由此驱动。
 * 扩展新能力 = 在 CAPABILITIES 登记一个描述符；
 * 复用现有处理页的能力（图片类）给 setFuncKey，新页面类型（如 GIF）给 route + query。
 */
export interface Capability {
  key: string;
  name: string;
  desc: string;
  icon: string;
  tint: CapabilityTint;
  group: '图片' | '动图';
  route: string;
  /** 图片类能力：process 页的处理模式 */
  setFuncKey?: FuncKey;
  /** 新页面能力的附加参数 */
  query?: string;
}

export const CAPABILITIES: Capability[] = [
  { key: 'compress', name: '图片压缩', desc: '质量滑杆快速瘦身', icon: '🗜️', tint: 'green', group: '图片', route: '/pages/process/process', setFuncKey: 'compress' },
  { key: 'targetKB', name: '指定大小', desc: '压到 20/50/100 KB', icon: '🎯', tint: 'blue', group: '图片', route: '/pages/process/process', setFuncKey: 'targetKB' },
  { key: 'resize', name: '改尺寸', desc: '像素等比缩放', icon: '📐', tint: 'orange', group: '图片', route: '/pages/process/process', setFuncKey: 'resize' },
  { key: 'convert', name: '转格式', desc: 'PNG ↔ JPG', icon: '🔄', tint: 'purple', group: '图片', route: '/pages/process/process', setFuncKey: 'convert' },
  { key: 'gif-compress', name: 'GIF 压缩', desc: '降色降帧减体积', icon: '🎞️', tint: 'cyan', group: '动图', route: '/pages/gif/gif', query: '?mode=compress' },
  { key: 'gif-split', name: 'GIF 拆帧', desc: '导出每一帧为图片', icon: '✂️', tint: 'pink', group: '动图', route: '/pages/gif/gif', query: '?mode=split' },
];

export const CAPABILITY_GROUPS: Array<'图片' | '动图'> = ['图片', '动图'];
