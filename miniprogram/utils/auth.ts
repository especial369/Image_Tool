import { getSetting, openSetting, saveImageToPhotosAlbum } from './wxp';

/**
 * 保存到相册，授权被拒绝时引导至设置页（坑 8），不硬请求。
 * 注意：读取相册/选图不需要授权（chooseMedia 自带选择器），只有保存需要本权限。
 */
export async function saveToAlbum(filePath: string): Promise<void> {
  try {
    await saveImageToPhotosAlbum(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/auth|denied|deny/i.test(msg)) {
      const setting = await getSetting().catch(() => null);
      if (setting && setting['scope.writePhotosAlbum'] === false) {
        const confirmed = await askOpenSetting();
        if (confirmed) await openSetting();
      }
    }
    throw err;
  }
}

function askOpenSetting(): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: '需要相册权限',
      content: '用于将压缩后的图片保存到你的相册。请在设置中开启「添加到相册」权限。',
      confirmText: '去设置',
      success: (r) => resolve(r.confirm),
      fail: () => resolve(false),
    });
  });
}
