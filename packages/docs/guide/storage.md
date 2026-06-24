# 存储：本地 / S3，多后端并存

在后台「设置 → 存储」选择存储类型并配置：

- **本地存储**：无需额外配置，图片保存在容器的存储目录。
- **S3 兼容存储**：填写 endpoint、region、bucket、access key、secret key、根目录与公开访问域名（public base URL），可点击「设为默认上传位置」。

两种后端可同时存在：每张图片记录自己所在的后端，读取、缩略图与删除都按该图自身的后端解析。在**图片编辑窗口**可把单张图迁移到另一后端，在**批量编辑窗口**可批量迁移。浏览器直传要求存储桶 CORS 允许站点 Origin、`PUT`/`GET`/`HEAD` 方法及 `Content-Type`、`Content-MD5` 请求头（或使用通配 `*`）；后台检查页可验证 CORS。

S3 直传默认开启上传完整性校验：服务端把图片 MD5 以 `Content-MD5` 头签入预签名 PUT，对象存储据此校验收到的字节，不一致则以 `BadDigest` 拒绝（前端会提示重试）。该校验需要上面的 CORS 允许 `Content-MD5` 头；如某后端无法放行，可在配置文件中将 `upload.verify_content_md5` 设为 `false` 关闭。
