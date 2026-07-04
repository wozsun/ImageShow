# 数据库结构

PostgreSQL，单一迁移文件 `packages/server/migrations/0001_initial.sql`，共 9 张业务表（另有迁移记录表 `schema_migrations`）。PostgreSQL 是唯一真相源；Redis 随机池、列表缓存和判重缓存都可重建。

## metadata —— 图片主表

| 字段 | 含义 |
| --- | --- |
| `id` (UUID, PK) | 图片唯一 id（uuid v7，时间有序）；目录中的文件名也使用它 |
| `device` | 设备：`pc`（横屏）/ `mb`（竖屏），由宽高比或用户选择得到 |
| `brightness` | 亮度：`dark` / `light`，上传默认自动识别 |
| `theme` | 主题 slug；`none` 表示无主题 |
| `width` / `height` | 像素尺寸 |
| `image_size` / `thumbnail_size` | 原图字节数 / 缩略图字节数；代理链接不自存原图，`image_size=0` |
| `ext` | 扩展名：`jpg` / `png` / `webp` / `gif` / `avif` |
| `object_key` (UNIQUE) | 对象存储键；`is_link=true` 时此处直接保存外部 URL |
| `storage_slug` | 图片所在存储后端 slug（外键 → `storage_backend.slug`） |
| `is_link` | 是否为代理链接图；为真时只保存缩略图 |
| `md5` | 文件 MD5，32 位十六进制；用于判重 |
| `title` / `description` / `source` / `original` | 标题 / 描述 / 来源 / 原图链接；`original` 仅允许 HTTPS |
| `extra` | 预留扩展属性 JSON；用于后续 EXIF、AI 标签、主色、来源平台等非核心字段 |
| `author` | 作者 slug，可空，外键 → `author.slug`，删除作者时自动置空 |
| `status` | `ready` / `deleted` |
| `deleted_at` | 软删时间 |
| `created_at` / `updated_at` | 时间戳 |

数据库不再保存 `category_index` / `index_key` / `category_key`。人工可读目录仍由 `device/brightness/theme` 组成，但随机性能由 Redis 集合保证，不需要在 PostgreSQL 中维护连续编号。

关键索引：`ready` 状态下的随机轴 `(device, brightness, theme, id)`；公共列表按 `created_at DESC, id DESC` 游标分页，并为常用筛选预建 ready 部分索引：无筛选、单设备、单亮度、设备+亮度、单主题、设备+主题、亮度+主题、设备+亮度+主题、作者。标签查询依赖 `image_tag(tag_slug, image_id)` 命中标签集合，结合 `metadata` 的 ready/时间与主题等索引完成分页；另有 MD5、缩略图反查、主题、作者和存储后端索引。

## import_session —— 统一导入会话

| 字段 | 含义 |
| --- | --- |
| `id` (UUID, PK) | 会话 id，前端生成并作为幂等基础 |
| `mode` | `upload` / `download` / `proxy` |
| `final_object_key` | 已提交后的正式对象键；未提交为空 |
| `storage_slug` | 该会话锁定的目标后端 slug；不加外键，避免过期会话阻塞后端删除 |
| `source_url` | URL 导入来源，仅允许 HTTPS；upload 模式为空 |
| `expected_size` | 本地上传声明的 raw 字节数 |
| `metadata_payload` | 创建会话时的草稿元数据 |
| `prepared_payload` | 服务端 prepared 真值：MD5、尺寸、质量、暂存键、`resolved_device` / `resolved_brightness` 等 |
| `status` | `created` / `receiving` / `preparing` / `ready` / `committing` / `finalized` / `failed` / `cancelled` |
| `idempotency_key` | 幂等键 |
| `request_hash` | 幂等请求摘要；同一幂等键仅在摘要一致时复用会话 |
| `error` | 失败原因 |
| `expires_at` | 过期时间，过期后由 `upload.cleanup` 清理 |
| `created_at` / `updated_at` | 时间戳 |

## background_job —— 后台任务队列

| 字段 | 含义 |
| --- | --- |
| `id` (PK) | 任务 id |
| `type` | `thumb.generate` / `move.cleanup` / `upload.cleanup` / `cache.rebuild` |
| `target_id` | 目标图片 id |
| `idempotency_key` | 幂等键 |
| `status` | `pending` / `running` / `succeeded` / `failed` / `ignored` |
| `payload` / `result` / `error` | 入参 / 结果 / 错误 |
| `retry_count` / `next_retry_at` | 重试次数与下次重试时间 |
| `created_at` / `updated_at` | 时间戳 |

`cache.rebuild` 会从 PostgreSQL 全量重建 Redis 随机池。Worker 会按保留策略裁剪历史记录：`succeeded` / `ignored` 保留 7 天，耗尽重试且 `next_retry_at IS NULL` 的 `failed` 保留 90 天。

## storage_backend —— 命名存储后端注册表

| 字段 | 含义 |
| --- | --- |
| `slug` (PK) | 后端标识；内置 `local` 不可删 |
| `display_name` | 显示名 |
| `type` | `local` / `s3` / `webdav` |
| `config` | 驱动配置；密钥/密码明文存库但不回传前端 |
| `enabled` | 是否可作为新图片写入目标 |
| `is_default` | 是否为新上传默认后端 |
| `sort_order` | 后台排序 |
| `created_at` / `updated_at` | 时间戳 |

`metadata.storage_slug` 以外键引用它；在用后端需先迁走图片才能删除。后端配置按签名缓存 driver/client，配置或默认后端变化会清理缓存。

## admin_account —— 管理员

| 字段 | 含义 |
| --- | --- |
| `username` (PK) | 用户名 |
| `password_hash` | Argon2id 密码哈希 |
| `role` | `super` / `image` |
| `created_at` / `updated_at` | 时间戳 |

首次启动且没有 super 时由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 创建首个 super；已有 super 时默认不再同步密码，只有 `ADMIN_FORCE_SYNC=true` 才强制同步。

## tag / theme / image_tag —— 标签与主题

`tag` 与 `theme` 都使用小写 slug、显示名、排序和时间戳。主题是一图一值，直接存在 `metadata.theme`；标签是一图多值，通过 `image_tag(image_id, tag_slug)` 关联。

删除标签会级联删除 `image_tag`，随后重建 Redis 随机池，保证 `tag=` 随机过滤即时准确。

## author —— 作者

作者有 `slug`、`display_name`、`link`、排序和时间戳。一图最多一个作者，存在 `metadata.author`。删除作者由外键把图片作者置空，随后重建 Redis 随机池。
