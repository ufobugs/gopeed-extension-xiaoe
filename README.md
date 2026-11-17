# Gopeed 小鹅通课程扩展

在 Gopeed 中解析本人有权访问的小鹅通视频和专栏，勾选课时后下载。第一版沿用本地 `xet_rebuild` 工程中已整理的目录、视频详情和地址编码协议，使用 JavaScript 实现，不调用 Python、原软件或本机凭证文件。

**当前版本：0.1.6。23 项自动化测试通过；用户已确认本店铺的解析、下载和课时名称命名正常。** 本地模拟接口测试不等于真实下载成功。

## 本地安装

需要桌面 Gopeed **2.0.0-beta.3 或更新版本**；推荐使用当前已安装的 beta.4 或更新版。HLS 依赖宿主原生下载器。

1. 项目已包含 `dist/index.js`，可直接安装，无需安装 Python、FFmpeg 或 npm 依赖。
2. 在 Gopeed 扩展页面连续点击“安装”按钮 5 次，开启开发者模式。
3. 选择本地扩展目录：`E:\github\gopeed-extension-xiaoe`。
4. 找到“小鹅通课程”，启用并填写设置。

也可以在 Gopeed 扩展页面输入 `https://github.com/ufobugs/gopeed-extension-xiaoe` 安装，仓库已包含打包产物。Gopeed 的安装步骤见[官方扩展文档](https://gopeed.com/zh/docs/dev-extension#本地调试)。

## 登录设置

先在浏览器登录自己购买课程的店铺，确认视频能够正常播放。按 F12 打开网络面板，找到店铺的 `column.items.get`、`resource_catalog_list.get` 或 `video.detail_info.get` 请求。

| 设置              | 内容                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| 登录店铺/API 域名 | 填该请求实际使用的主机，例如 `app5vfffdhz8371.pc.xiaoe-tech.com`，不含接口路径             |
| 店铺 Cookie       | 填该请求完整的 Cookie 值，不含 `Cookie:` 前缀                                              |
| 目录/播放接口     | 当前网页选择 `business_go.column.items（JSON）`；旧版表单接口和 PC e_course 保留为独立选项 |

API 主机必须与课程链接属于同一个 `app_id`，并且是支持的标准店铺域名。课程链接可以是 PC 域名，API 域名可以是同一店铺的 H5 域名；必须填写浏览器实际请求使用的域名，插件不会猜测主机或复制学习中心登录令牌。

**学习中心登录和店铺登录不同。** 本版本不提供扫码界面或“本人课程”列表，也不会读取其他程序的 Cookie/会话文件。一次配置绑定一个店铺；更换店铺时需同时更换 API 域名和 Cookie。Cookie 只发送给配置的 API 主机，不写入任务标签、源码或测试报告，也不转发给媒体 CDN。

## 下载课程

支持标准店铺域名 `appxxx.pc.xiaoe-tech.com`、`appxxx.h5.xiaoeknow.com`、`appxxx.h5.xeknow.com` 下的以下路径：

```text
https://app5vfffdhz8371.pc.xiaoe-tech.com/p/t_pc/course_pc_detail/column/p_60f40504e4b08f7ad23e0e60
```

在 Gopeed 中新建任务、粘贴链接，等待目录分页和视频解析完成，再勾选需要的课时。示例课程不代表任何账号自动获得访问权限。

先测试第一节，可在原链接末尾添加 `?p=1`；如果已有查询参数则添加 `&p=1`。也支持 `p=1,3,5-8`。序号按照接口返回的完整视频列表计算，解析失败的课时会跳过并写入扩展日志，其他课时继续处理。

单视频链接使用 `/p/t_pc/course_pc_detail/video/v_资源编号`。专栏会遍历全部页及同店铺子专栏，检测重复页和总数不完整；跨店铺条目、题库、音频、直播等不支持条目跳过。数量与层级有上限，达到上限明确报错。

解析顺序遵循接口的 `sort=desc`，不是按标题推断的教学顺序。播放地址容器中的常规清晰度依次尝试 original、fhd、hd、sd；编码列表按现有 Python 协议取最后一项，不保证它一定是最高画质。当前没有单独的画质切换设置。

## 视频格式和 HLS

- 普通 MP4/M4V/WebM 保留原格式。
- HLS 先核对播放列表，交给 Gopeed 原生 HLS 下载器下载、续传和合并。TS 分片保存为 `.ts`，fMP4 初始化分片保存为 `.mp4`；**TS 不会只改扩展名伪装成 MP4**。
- 支持已结束的点播、包含音画的主列表变体，以及原生引擎支持的标准 AES-128 / identity。媒体与密钥请求不附带店铺 Cookie；需要额外专用鉴权的资源可能不支持。
- 直播、独立音轨 HLS、SAMPLE-AES、DRM、专有密钥和不支持的时间线特性明确报错。进一步的分片/密钥合法性由 Gopeed 原生引擎校验。
- 仅支持公共 HTTPS 媒体；不对未知 HTTP 链接做自动改写。
- 任务开始时重新解析当前课时，错误最多自动刷新重试两次。格式变化则要求重新建任务。没有课程级完成记录和下载后的整节时长/解码校验。

Gopeed 原生 HLS 的支持范围与真实输出格式依据：[上游 HLS 说明](https://github.com/GopeedLab/gopeed/blob/main/internal/protocol/hls/doc.go)。Gopeed 任务会保存当前媒体地址以执行和续传下载，请不要分享整个任务数据库。

## 开发和验证

要求 Node.js 20 或更新版本；无第三方 npm 依赖。

```powershell
cd E:\github\gopeed-extension-xiaoe
npm run check
npm run build
npm test
```

`npm run build` 将 `src/core.js` 和 `src/index.js` 打包成没有 ESM import 的独立脚本。已用模拟 Gopeed 全局执行生产包，检查解析与任务事件。测试覆盖分页、同店铺子专栏、Cookie 主机绑定、地址混淆还原、HLS/媒体预检、单节失败隔离、文件命名、刷新和重试。

安装后的日志位于 Gopeed 数据目录 `storage/logs/extension.log`。接口返回空目录或 HTML 不会被视作成功下载。

`code=8` 不能统一解释为 Cookie 失效。例如示例店铺的原 `column.items` 接口在未登录探测中返回 `code=8,msg=参数有误`。新版提示包含接口名称及服务器消息类别；参数不匹配时，先按浏览器真实请求切换“目录/播放接口”：`resource_catalog_list.get` 对应 **PC e_course**，`column.items.get` 对应默认专栏接口。必须保留真实 API 主机，不自动把 Cookie 复制到其他主机。PC 目录返回 `code=0` 仍须通过 `available` 及每节播放信息检查，不能视作已取得视频权限。

## 当前网页目录适配（0.1.2）

根据浏览器实际请求，新增 `/xe.course.business_go.column.items.get/2.0.0`，使用 application/json，字段为 column_id、数值 page_index/page_size、content_app_id:null 和 sort:desc，每页20条。不能与旧 `/xe.course.business.column.items.get/2.0.0` 的 bizData 表单混用。未登录公开探测确认示例店铺返回 code=0、list 和 total；这只验证目录协议，不证明播放权限。`sale.before.column.items` 是另一条售前目录请求，本插件不以售前目录证明已购视频权限。

这次抓包仅包含目录，没有视频详情请求。播放接口使用先前 PC 参数适配，用户随后已确认本店铺下载正常；其他店铺若播放解析失败，应继续核对 video.detail_info 的 URL、Content-Type 和请求体（不要分享 Cookie）。本仓库不保存真实 Cookie。

0.1.3：扩展日志显示目录总数和逐节解析进度。开头连续三节失败时停止，避免对整套课程重复失败；目录读取后的视频解析阶段最多等待约两分钟（在每节之间检查，当前网络请求仍有独立超时），超时明确报错并建议分批，不把已解析部分当成完整结果。建议首次使用 p=1。

0.1.4：课时播放信息改为有界并发解析（默认3，可设置1–4），每批完成后保持原目录顺序展示结果。HLS预检仍会产生请求，整套课程仍需等待，不承诺固定耗时或倍数提速。首次测试可用 p=1，分批可用 p=1-20。

0.1.5：新任务按“001 课时名称.ts/mp4”命名，保留目录接口的课时标题和排序编号，不再添加资源ID前缀。资源ID仍保留在任务标签用于刷新播放地址。文件名遵守宿主100字节限制，过长标题截断，Windows不支持的字符替换为下划线。已下载文件不会自动改名；新建任务后生效。

0.1.6：根据真实网页目录响应修正标题字段，优先读取 resource_title（新版 business_go 接口），再兼容 resource_name/title/name。避免文件名回退成资源ID。
