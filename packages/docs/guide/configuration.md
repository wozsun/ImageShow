# 配置说明

ImageShow 的配置按持久化位置分为三类：数据库、`/app/data/config.json`、环境变量。排查配置时先确认“这项配置存在哪里”，再判断修改后是否需要热加载或重启。

## 配置来源

| 来源 | 保存内容 | 修改方式 |
| --- | --- | --- |
| PostgreSQL | 管理员账号；本地 / S3 / WebDAV 存储后端注册表；S3 endpoint、region、bucket、access key、secret key、根目录、public URL 等敏感或实例化数据。 | 后台设置页。secret key 只保存，不返回给前端。 |
| `/app/data/config.json` | 站点名、域名、icon、根路径跳转、首页 / 画廊 / 随机图默认行为、登录页背景、监听端口、PostgreSQL / Redis 连接、上传限制、链接导入、标准化、缩略图、安全、验证码、日志等非敏感运行时配置。 | 后台设置页，或直接编辑文件后在后台「设置 → 读取配置文件」；上传文件大小、上传长边校验和服务端全局导入并发只通过配置文件维护。 |
| 环境变量 | 只用于首次生成 `config.json`，以及初始化管理员账号和 PostgreSQL 官方镜像变量。 | 修改 `.env` 后重建 / 重启；配置文件生成后，普通运行时配置以 `config.json` 为准。 |

完整字段清单、默认值和中英文注释见仓库根目录的 `config.example.jsonc`。实际运行文件是纯 JSON，不支持注释。

## 热加载边界

大多数 `config.json` 配置可在后台点击「读取配置文件」后生效。以下连接类配置改动后需要重启容器：

- `database.*`
- `redis.*`
- `port`

`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在数据库没有 super 管理员时创建首个账号，最终写入 PostgreSQL 的 `admin_account` 表，不进入 `config.json`。已有 super 时默认不会同步环境变量密码；只有显式设置 `ADMIN_FORCE_SYNC=true` 且同时提供账号密码，启动时才会强制同步 super。

## 常用配置组

| 配置路径 | 用途 |
| --- | --- |
| `site.name` / `site.domain` / `site.icon_url` | 站点名称、主域名和图标；`site.name` 也会写入 SPA HTML 的 `<title>`。 |
| `site.root_redirect` | 根路径跳转目标：`home` 或 `gallery`。 |
| `site.home.enabled` | 是否启用公共首页 `/home`，默认 `true`。关闭后 `/home` 重定向到画廊，导航不再显示首页入口，根路径也强制进画廊。 |
| `site.home.tagline` / `site.home.hero_background` / `site.home.preview_delay_ms` | 站点描述、首页 hero 背景与随机预览切换延迟；`site.home.tagline` 也会写入 SPA HTML 的 description。 |
| `site.gallery.default_limit` / `site.gallery.order` | 画廊默认分页数量与排序。 |
| `site.random_default_method` | `/random` 默认返回方式：`redirect` 或 `proxy`。 |
| `site.random_subdomain` / `site.static_subdomain` / `site.docs_subdomain` / `site.link_subdomain` | 保留子域名前缀。 |
| `site.docs_enabled` | 是否启用 `docs.<域名>` 文档站，默认 `true`。关闭后该主机返回 404，但前缀仍保留，主题不可占用。 |
| `site.robots_enabled` | 是否提供 `robots.txt`，默认 `false`。开启后主站首页与文档站可抓取，资源域和主题域禁抓。 |
| `upload.*` | 上传文件大小、图片长边限制、上传列表分页、单客户端上传队列并发与服务端全局上传 prepare 并发；其中 `upload.max_file_size_mb`、`upload.max_long_edge` 和 `upload.global_concurrency` 只在配置文件中维护。 |
| `link_image.fill_original_url` | 两种链接导入模式是否自动把输入 URL 填入「原图 URL」字段；不做可直达探测。 |
| `link_image.concurrency` | 单客户端 URL 导入队列并发数，覆盖“下载保存”和“代理链接”。 |
| `link_image.global_concurrency` | 服务端 URL 导入 prepare 全局并发数，多个客户端共享；只在配置文件中维护。 |
| `link_image.fetch_timeout_seconds` | 外链图片请求超时，单位秒；只覆盖下载和代理准备阶段的外部请求。 |
| `normalize.*` | 本地上传与下载导入共用的最终入库文件标准化策略。 |
| `thumbnail.*` | 缩略图长边和压缩质量，只影响此后新生成的缩略图。 |
| `image_detail.title_opens_image` | 图片详情弹窗标题是否链接到图片直链。 |
| `admin.login_background` | 后台登录页背景；留空时使用站点自身随机图。 |
| `admin.image_page_size` / `admin.recent_uploads` / `admin.show_unset_theme_card` | 后台图片分页、概览最近上传数量、主题页「未设置」占位卡片开关。 |
| `background_job.*` | 后台任务并发：移动清理、删除主题时图片搬运、批量迁移存储拷贝。默认各 5。 |
| `security.*` | 登录会话有效期和登录限流阈值。 |
| `captcha.*` | 登录验证码开关、位数、有效期、干扰线和噪点数量。字符集与几何样式仍是代码常量。 |
| `log.*` | 日志级别、单文件大小上限和轮转文件保留数量。日志写入 `data/log/app.log`，并同时输出到容器 stdout / stderr；超级管理员可在后台「日志」页实时调整 `log.level` 并查看最近日志。后台非 GET 写操作会记录操作者、路径、状态、耗时和 IP，不记录请求体。 |

## 入库图片标准化

本地上传与「下载图片」共用顶层 `normalize` 配置。原始文件先落到容器本地 `data/tmp`，服务端完成校验、缩略图和最终入库文件处理后，才把候选文件写入选定存储后端。代理链接不保存原图，只保存缩略图与外部 URL。

```json
{
  "upload": {
    "max_file_size_mb": 100,
    "max_long_edge": 32000,
    "concurrency": 2,
    "global_concurrency": 5
  },
  "link_image": {
    "fill_original_url": false,
    "concurrency": 2,
    "global_concurrency": 5,
    "fetch_timeout_seconds": 30
  },
  "normalize": {
    "quality": 80,
    "quality_step": 5,
    "min_quality": 20,
    "max_long_edge": 4500,
    "max_size_kb": 500,
    "skip_webp_under_kb": 700
  }
}
```

`normalize.quality` 是首次 WebP 编码质量。输出超过 `normalize.max_size_kb` 时，会按超限倍数放大 `normalize.quality_step` 降低质量，最大不超过 `3 * quality_step`。某轮达标后会按原步进向上回补探测，最多补回本轮跳过的质量档位，尽量避免一次跳过可用画质。最低降到 `normalize.min_quality`；到达最低质量后即使仍超出目标体积，也会直接入库。尺寸会按比例缩小到 `normalize.max_long_edge` 以内，不会放大。

输入本身是 WebP、体积小于 `normalize.skip_webp_under_kb` 且长边已经达标时，原字节直接成为最终候选文件；服务端仍会执行解码校验、标准缩略图生成和最终 MD5 计算。`upload.concurrency` / `link_image.concurrency` 只约束单个后台页面自己的队列；`upload.global_concurrency` / `link_image.global_concurrency` 约束服务端 prepare 全局并发，即使调用方绕过前端队列直接打接口，进程内也会排队并支持取消等待中的任务。

## 环境变量

`compose.yaml` 默认只向容器注入少数变量：

| 环境变量 | 用途 |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 数据库没有 super 时初始化首个管理员账号。 |
| `ADMIN_FORCE_SYNC` | 设为 `true` 时启动阶段强制同步 super 账号和密码；默认不启用。 |
| `DATABASE_NAME` / `DATABASE_USER` / `DATABASE_PASSWORD` | 初始化应用数据库和 PostgreSQL 容器。 |
| `SITE_DOMAIN` | 首次生成配置文件时播种 `site.domain`，默认 `example.com`。 |
| `LINK_IMAGE_FETCH_TIMEOUT_SECONDS` | 首次生成配置文件时播种外链图片请求超时，默认 `30`。 |
| `HOST_PORT` | 应用宿主机端口映射，默认 `5518`。 |
| `TZ` | 应用容器时区，影响日志时间格式，默认 `UTC`。 |

支持环境变量播种的配置字段统一按完整路径转成大写下划线，例如：

| 配置字段 | 环境变量 |
| --- | --- |
| `site.domain` | `SITE_DOMAIN` |
| `site.docs_enabled` | `SITE_DOCS_ENABLED` |
| `site.robots_enabled` | `SITE_ROBOTS_ENABLED` |
| `site.home.tagline` | `SITE_HOME_TAGLINE` |
| `site.home.preview_delay_ms` | `SITE_HOME_PREVIEW_DELAY_MS` |
| `admin.login_background` | `ADMIN_LOGIN_BACKGROUND` |
| `normalize.quality_step` | `NORMALIZE_QUALITY_STEP` |
| `thumbnail.long_edge` | `THUMBNAIL_LONG_EDGE` |
| `thumbnail.quality` | `THUMBNAIL_QUALITY` |
| `upload.max_file_size_mb` | `UPLOAD_MAX_FILE_SIZE_MB` |
| `upload.max_long_edge` | `UPLOAD_MAX_LONG_EDGE` |
| `upload.concurrency` | `UPLOAD_CONCURRENCY` |
| `upload.global_concurrency` | `UPLOAD_GLOBAL_CONCURRENCY` |
| `link_image.concurrency` | `LINK_IMAGE_CONCURRENCY` |
| `link_image.global_concurrency` | `LINK_IMAGE_GLOBAL_CONCURRENCY` |
| `link_image.fetch_timeout_seconds` | `LINK_IMAGE_FETCH_TIMEOUT_SECONDS` |
| `port` | `PORT` |

仓库自带 `compose.yaml` 不注入所有可选项。配置文件已经生成后，请直接修改 `config.json` 并热加载；连接类配置仍需重启容器。
