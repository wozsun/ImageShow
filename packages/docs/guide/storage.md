# 存储：本地 / S3 / WebDAV，多后端并存

后端是「命名实例」而非「类型」——同一类型可注册多个（例如两个不同的 S3 桶）。在后台「设置 → 存储」新建并配置：

- **本地存储**：无需额外配置，图片保存在容器的存储目录。
- **S3 兼容存储**：填写 endpoint、region、bucket、access key、secret key、根目录与公开访问域名（public base URL），可点击「设为默认上传位置」。
- **WebDAV 存储**：填写 base URL、用户名、密码（HTTP Basic）、根目录与可选的公开访问域名（public base URL）。服务器用标准 WebDAV 动词（PROPFIND/MKCOL/PUT/GET/DELETE/COPY）读写，按需自动创建父目录；PROPFIND 响应用 XML parser 解析，兼容带命名空间和实体转义的 href。所有 WebDAV 请求都有统一 timeout，临时性 429/5xx、初始请求超时或网络失败会有限重试和退避。换分类 / 主题重指派需要在后端内复制对象时优先用服务端 **COPY**（字节不经服务器中转）；**部分 WebDAV 服务器虽在 OPTIONS 里声明 COPY 却实际拒绝**（见过 405、跨目录复制 423），此时自动退回「读取 + 写回」（GET+PUT，各服务器都支持），故这些操作在不支持 COPY 的服务器上也能正常工作。还有一个 **Depth: infinity 列举** 开关（**默认关闭**）：关闭时按可移植的递归 `Depth: 1` PROPFIND 列举目录（同级子目录有并发上限）；开启后改用单次 `Depth: infinity` PROPFIND 一把拉回整棵子树，存储检查/清理会快很多——但部分 WebDAV 服务器不支持 `Depth: infinity`，故默认关闭，确认服务器支持再开启。两种列举方式都有最大结果数保护，避免异常大目录拖垮进程。

多个后端可同时存在：每张图片记录自己所在的后端（`storage_slug`），读取、缩略图与删除都按该图自身的后端解析。在**图片编辑窗口**可把单张图迁移到另一后端，在**批量编辑窗口**可批量迁移。在用的后端无法删除（外键 `ON DELETE RESTRICT`），需先迁走其全部图片。**链接图片同样可迁移**——它没有我们的原图，迁移即把其缩略图搬到目标后端（缩略图仍存于独立的 `link/` 前缀，不与本地图的 `thumbs/` 缩略图混放），随后翻转 `storage_slug`；因此后端腾空后即可删除。

本地上传与链接下载的原始字节统一先进入服务端 `data/tmp`。服务端在本地完成校验、标准化、缩略图与最终 MD5 后，才把 processed image 和 prepared thumbnail 写入目标后端 `_uploads`；代理链接只写 prepared thumbnail。因此无需为存储桶配置浏览器 CORS，远端后端也不会发生“上传 raw 后再下载回来处理”的重复传输。详见[功能与流程](./flows#三种图片导入模式)。
