# 图片压缩小程序（P1 骨架）

纯工具型微信小程序：所有图片处理在用户本地完成，不上传服务器。实施依据见《图片压缩小程序-实施文档.md》（v0.2）。

## 打开方式

1. 用微信开发者工具「导入项目」，目录选本仓库根目录（`project.config.json` 所在处），AppID 可先用测试号（当前为 `touristappid`，注册正式小程序后替换）。
2. 开发者工具会自动编译 TypeScript（已配置 `useCompilerPlugins: ["typescript"]`）。
3. 如需编辑器类型提示，先执行 `npm install` 安装 `miniprogram-api-typings`；类型校验可跑 `npm run typecheck`，引擎算法自测跑 `npm test`。

## 目录结构

```
miniprogram/
├── app.{ts,json,wxss}       入口与全局样式
├── engine/                  处理引擎（与 UI 分离，纯函数式：输入文件+参数 → 输出文件）
│   ├── types.ts             引擎接口与类型（CanvasLike/CanvasProvider 供页面隐藏 canvas 或离屏注入）
│   ├── source.ts            源图加载（尺寸/格式/orientation/体积）
│   ├── canvasEngine.ts      Canvas 2D 引擎：orientation 绘制表、底色填充、导出、尺寸上限降采样、内存释放
│   ├── qualitySearch.ts     指定 KB：估算定位 + 局部收敛（替代纯二分）
│   ├── queue.ts             批量串行队列（单张失败不阻塞）
│   └── gif/gifEngine.ts     GIF 能力引擎（压缩/拆帧业务流）
├── libs/gif/                GIF 编解码（纯 TS 无 wx 依赖：decoder/encoder/quantize/resize，进 Node 单测）
├── capabilities/            能力注册表：首页卡片、分组、路由由此驱动
├── utils/
│   ├── wxp.ts               wx API Promise 封装（chooseMedia 锁定原图等约束在此）
│   ├── file.ts              体积读取/临时产物清理/格式化
│   ├── store.ts             会话级选图与结果传递
│   └── auth.ts              保存相册授权引导（拒绝后引导 openSetting）
└── pages/
    ├── index/               首页：四入口 + 相册选图 + 聊天文件选图
    ├── process/             处理页：参数 + 隐藏 canvas + 串行进度
    ├── gif/                 GIF 页：压缩/拆帧
    ├── result/              结果页：前后体积/压缩率/预览/保存/发好友/微调再压
    └── about/               关于/隐私占位（正式文案 P3 接入）
```

## P1 已实现

- 选原图链路（`sizeType: ['original']`，聊天文件扩展名过滤）
- 质量压缩 / 指定 KB（估算定位+收敛，中间产物即时清理）/ PNG→JPG 底色填充
- 批量串行处理 + 逐张进度 + 单张失败不阻塞
- 结果页：压缩率、`wx.previewImage` 预览、保存相册（含授权引导）、`wx.shareFileMessage` 发送、微调再压

## P2 已实现

- **改尺寸**：25%/50%/75% 快捷比例、常用像素预设（一寸/二寸/720P/1080P）、宽高输入等比锁定
- **指定 KB 限定尺寸（证件照组合预设）**：一寸 295×413 ≤100KB / 二寸 413×579 ≤200KB 一键套用；限定尺寸后仅搜质量、禁止自动降采样，不达标给出最优结果并提示
- **compressImage 快速通道**：JPG 源走原生压缩（质量/尺寸试探+输出），失败或非 JPG 源自动回退 Canvas；总开关 `engine/canvasEngine.ts` 的 `FAST_PATH_ENABLED`
- **失败重试**：结果页一键重试失败项（参数不变）
- **断点续跑**：逐张累积结果 + 参数指纹去重，处理中断后重进自动跳过已成功项

## v0.3 已实现（P3 收口 + 多媒体能力层）

- P3 全项：结果页分享卡片、意见反馈、隐私政策/用户协议全文、广告容器+远程开关（`utils/ads.ts`）、埋点（`utils/track.ts`，7 事件）、处理页逐张原图信息、智能推荐目标档
- **能力注册表**：首页卡片/分组/路由由 `capabilities/registry.ts` 驱动
- **GIF 压缩**：降色（64/128/256）+ 降帧（50%/75%/全帧）+ 缩放，可选目标体积（未达标自动加压一次）；重编码未变小自动保留原 GIF
- **GIF 拆帧**：逐帧导出 PNG（前 10/30/全部/仅首帧），复用结果页保存与分享
- GIF 编解码为自研纯 TS 实现（`libs/gif/`，无 WASM），`npm test` 含像素级往返回归

## 如何扩展新能力（架构约定）

1. 在 `miniprogram/capabilities/registry.ts` 登记一个 Capability（名称/图标/分组/路由），首页自动渲染；
2. 图片类能力复用处理页，给 `setFuncKey`；新页面类型（如 GIF）给 `route + query`，页面内自行选文件；
3. 业务流放 `engine/`（可依赖 wx），纯算法放 `libs/`（不依赖 wx，必须进 `npm test` 回归）；
4. 结果统一产出 `ProcessResult` 列表写入 `store.results`——结果页的保存/分享/广告位/徽标对新能力零改动复用。

## P1 真机验证清单（对应实施文档 4.6）

- [ ] 页面隐藏 Canvas 导出链路（destWidth/destHeight、quality 0-1 生效性）
- [ ] 离屏 Canvas 对照：`pages/process/process.ts` 中 `USE_OFFSCREEN = true` 后真机复测
- [ ] EXIF 竖拍/镜像照片方向（orientation 各取值抽样；不符则调 `engine/canvasEngine.ts` 的 `drawOriented` 表）
- [ ] `wx.compressImage` iOS/Android 行为对照（已接入快速通道：重点验证 **EXIF 方向**与 compressedWidth/Height 输出尺寸，异常时置 `FAST_PATH_ENABLED = false` 回退纯 Canvas；**开发者工具/PC 端的 compressImage 不可信**，快速通道已限定真机 iOS/Android，并有输出尺寸/体积校验兜底）
- [ ] 证件照组合预设真机验证：295×413 源图/大图压到 ≤100KB，核对输出尺寸与体积
- [ ] 失败重试与断点续跑：批量处理中途杀进程后重进，确认跳过已成功项
- [ ] GIF 真机验证：真实 GIF 素材压缩（强压/平衡/高清三档 + 目标体积）、拆帧导出、透明边缘、大 GIF（>100 帧）解码耗时
- [ ] 真机 canvas 2d 的 `createImageData/putImageData` 可用性（GIF 拆帧导出依赖）
- [ ] 48MP 级大图内存与 `MAX_DIM` 降采样（`engine/canvasEngine.ts`）
- [ ] 处理中切后台/锁屏中断表现（P1 仅前台提示）
- [ ] `wx.shareFileMessage` 真机发送与文件名
- [ ] 首次保存相册的隐私弹窗触发时机
