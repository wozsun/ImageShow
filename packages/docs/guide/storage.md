# 存储：本地 / S3 / WebDAV，多后端并存

后端是「命名实例」而非「类型」——同一类型可注册多个（例如两个不同的 S3 桶）。在后台「设置 → 存储」新建并配置：

- **本地存储**：无需额外配置，图片保存在容器的存储目录。
- **S3 兼容存储**：填写 HTTPS endpoint、region、bucket、access key、secret key、根目录与可选 HTTPS 公开访问域名（public base URL），可点击「设为默认上传位置」。
- **WebDAV 存储**：填写 HTTPS base URL、用户名、密码（HTTP Basic）、根目录与可选 HTTPS 公开访问域名（public base URL）。连接 / 首字节超时默认 15 秒，流读取空闲超时默认 15 秒，任务总超时默认 300 秒，三者均可在后端编辑窗口调整；持续收到数据的大文件不会只因传输超过 15 秒被中断。服务器用标准 WebDAV 动词（PROPFIND/MKCOL/PUT/GET/DELETE/COPY）读写，按需自动创建父目录；PROPFIND 响应用 XML parser 解析，并只接受与配置端点同源且位于当前列举根目录内的资源链接，避免将认证信息发送到服务端响应指定的其他地址。临时性 429/5xx、连接 / 首字节 / 空闲超时或网络失败会有限重试和退避，调用方 Abort、Range 流切片和流取消仍向下传递。后端内复制优先使用原生 COPY，异常时退化为 GET+PUT。GET / HEAD 固定请求 `Accept-Encoding: identity`；若服务端忽略 Range 并返回完整 200，ImageShow 用流式跳过与截取产生 206，不缓冲完整对象。**Depth: infinity 列举**默认关闭；关闭时并发递归 `Depth: 1`，开启后单次列举整棵子树，两种方式都有最大结果数保护。

多个后端可同时存在：每张图片记录自己所在的后端（`storage_slug`），读取、缩略图与删除都按该图自身的后端解析。在**图片编辑窗口**可把单张图迁移到另一后端，在**批量编辑窗口**可批量迁移。批量迁移响应返回 `migrated`、`unchanged` 与 `failed`；管理端仅在 `failed=0` 时按完全成功关闭窗口，部分或全部失败会保留迁移窗口并显示统计结果。在用的后端无法删除（外键 `ON DELETE RESTRICT`），需先迁走其全部图片。**链接图片同样可迁移**——它没有我们的原图，迁移即把其缩略图搬到目标后端（缩略图仍存于独立的 `link/` 前缀，不与本地图的 `thumbs/` 缩略图混放），随后翻转 `storage_slug`；因此后端腾空后即可删除。

后台存储后端列表按 `type` 返回唯一有效的配置分支：S3 项只含脱敏后的 `s3`，WebDAV 项只含脱敏后的 `webdav`，本地项不携带远端配置。Secret Key / 密码只返回是否已配置的布尔标记，不返回凭据本身。

本地上传与链接下载的原始字节统一先进入服务端 `data/tmp`。服务端在本地完成校验、标准化、缩略图与最终 MD5 后，才把 processed image 和 prepared thumbnail 写入目标后端 `_uploads`；代理链接只写 prepared thumbnail。因此无需为存储桶配置浏览器 CORS，远端后端也不会发生“上传 raw 后再下载回来处理”的重复传输。详见[功能与流程](./flows#三种图片导入模式)。
