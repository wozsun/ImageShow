# 配置说明

配置按持久化位置分为三类：

1. **数据库**：管理员账号；S3 的 endpoint/region/bucket/access key/secret key/根目录/public URL 等存储配置。secret key 由数据库持久化，不会返回给前端（管理页只显示「已配置」），请限制数据库与配置目录访问。
2. **配置文件** `/app/data/config.json`：站点名 / 域名 / icon / 根路径跳转、监听端口、PostgreSQL 与 Redis 连接、上传与画廊参数、随机图默认模式等非敏感项。
3. **环境变量**：仅在配置文件**首次生成**时读取；此后修改配置请使用后台设置页，或编辑配置文件后在设置页点击「读取配置文件」热加载（数据库 / Redis / 端口等连接类配置仍需重启容器）。部分进阶项（首页预览延迟、S3 预签名有效期、概览「最近上传」数量）只在配置文件中调整。

## 常用环境变量

首次生成配置文件的常用可选变量（括号内为默认值）：`APP_DOMAIN`(example.com，请改为你的真实域名)、`SITE_NAME`(ImageShow)、`PORT`(5518)、`REDIS_HOST`(redis)，以及保留子域名前缀 `RANDOM_SUBDOMAIN`(random) / `STATIC_SUBDOMAIN`(static) / `DOCS_SUBDOMAIN`(docs)，均见仓库根的 `.env.example`。

## 进阶环境变量

上传限制、画廊与后台分页、默认随机方式等进阶变量同样可经环境变量设置（与配置文件字段一一对应），为简洁起见未列入 `.env.example`：

| 环境变量 | 配置文件字段 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `SITE_ICON_URL` | `site.icon_url` | `/assets/brand/favicon.svg` | 站点图标 URL |
| `ROOT_REDIRECT` | `site.root_redirect` | `home` | 根路径跳转目标（`home` / `gallery`） |
| `STATIC_BASE_URL` | `site.static_base_url` | 自动派生 | 本地图片公开域名，留空时为 `https://<static_subdomain>.<domain>`；仅在指向不同主机（如 CDN）时设置 |
| `HOME_PREVIEW_DELAY_MS` | `home.preview_delay_ms` | `1000` | 首页随机预览切换延迟 |
| `UPLOAD_MAX_FILE_SIZE_MB` | `upload.max_file_size_mb` | `15` | 单文件大小上限 |
| `UPLOAD_PRESIGN_EXPIRES_SECONDS` | `upload.presign_expires_seconds` | `600` | S3 预签名有效期 |
| `UPLOAD_MAX_LONG_EDGE` | `upload.max_long_edge` | `8192` | 图片长边上限 |
| `UPLOAD_LIST_PAGE_SIZE` | `upload.list_page_size` | `20` | 上传列表每页数量 |
| `GALLERY_DEFAULT_LIMIT` | `gallery.default_limit` | `50` | 画廊默认每页数量 |
| `ADMIN_IMAGE_PAGE_SIZE` | `admin.image_page_size` | `50` | 后台图片每页数量 |
| `RANDOM_DEFAULT_METHOD` | `random.default_method` | `redirect` | `/random` 默认返回方式（`proxy` / `redirect`） |
