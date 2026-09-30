import { chooseChatFiles, chooseImages, showModal } from '../../utils/wxp';
import { setSelection, store, type FuncKey } from '../../utils/store';
import { isSupportedImagePath } from '../../engine/index';
import { track } from '../../utils/track';

const MAX_PICK = 20; // 基础库 2.25.0+ chooseMedia 单次上限

Page({
  onPick(e: { currentTarget: { dataset: { mode?: string } } }) {
    const mode = (e.currentTarget.dataset.mode ?? 'compress') as FuncKey;
    store.funcKey = mode;
    track('func_click', { mode });
    void this.chooseFromAlbum();
  },

  onShareAppMessage(): { title: string; path: string } {
    return { title: '免费图片压缩，图片不离开手机', path: '/pages/index/index' };
  },

  async chooseFromAlbum() {
    try {
      const files = await chooseImages(MAX_PICK);
      if (!files.length) return;
      const sizes: Record<string, number> = {};
      files.forEach((f) => {
        sizes[f.tempFilePath] = f.size;
      });
      setSelection(
        files.map((f) => f.tempFilePath),
        sizes
      );
      wx.navigateTo({ url: '/pages/process/process' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) {
        wx.showToast({ title: '选图失败', icon: 'none' });
      }
    }
  },

  async onPickChat() {
    track('chat_pick');
    try {
      const files = await chooseChatFiles(MAX_PICK);
      const images = files.filter((f) => isSupportedImagePath(f.path));
      if (!images.length) {
        wx.showToast({ title: '未找到支持的图片文件', icon: 'none' });
        return;
      }
      if (images.length < files.length) {
        void showModal({
          title: '部分文件已跳过',
          content: `仅支持 jpg/png/webp/bmp/gif，已自动跳过 ${files.length - images.length} 个文件`,
          showCancel: false,
        });
      }
      const sizes: Record<string, number> = {};
      images.forEach((f) => {
        sizes[f.path] = f.size;
      });
      setSelection(
        images.map((f) => f.path),
        sizes
      );
      wx.navigateTo({ url: '/pages/process/process' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/cancel/i.test(msg)) {
        wx.showToast({ title: '选择失败', icon: 'none' });
      }
    }
  },

  onAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },
});
