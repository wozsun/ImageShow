# 数据库结构

PostgreSQL，单一迁移文件 `packages/server/migrations/0001_initial.sql`，共 11 张业务表（另有一张迁移记录表 `schema_migrations`）。PostgreSQL 是唯一真相源，Redis 仅作加速。

## metadata —— 图片主表

| 字段 | 含义 |
| --- | --- |
| `id` (UUID, PK) | 图片唯一 id（uuid v7，时间有序） |
| `device` | 设备：`pc`（横屏）/ `mb`（竖屏）。永远具体，由宽高比得出（无「未设置」） |
| `brightness` | 亮度：`dark` / `light`。永远具体（上传默认自动识别，无「未设置」） |
| `theme` | 主题 slug（小写 ASCII，≤32，正则约束；`none` 表示无主题） |
| `category_key` | 派生分类键 = `device-brightness-theme`（CHECK 强制一致） |
| `category_index` | 该分类内序号（≥1，连续无洞） |
| `index_key` | `category_key-000123`（6 位补零），供随机池 / 索引使用 |
| `width` / `height` | 像素尺寸（探测得到；link 也下载一次获取） |
| `image_size` / `thumbnail_size` | 原图字节数 / 缩略图字节数（存储用量统计；link 原图不自存故 `image_size=0`，仅计其缩略图） |
| `ext` | 扩展名：`jpg` / `png` / `webp` / `gif` / `avif` |
| `object_key` (UNIQUE) | 对象存储键；**`is_link` 为真时此处直接是外部 URL** |
| `title` / `description` / `source` / `original` | 标题 / 描述 / 来源 / 原图链接（`original` 必须 http(s)，≤2048） |
| `md5` | 文件 MD5（判重用；空或 32 位十六进制） |
| `storage_slug` | 该图所在存储后端 slug（外键 → `storage_backend.slug`，`ON DELETE RESTRICT`）。上传图原图与缩略图都在此；link 图仅缩略图在此 |
| `is_link` | 是否为导入的外部链接（true 时 `object_key` 为外部 URL，仅自存其缩略图） |
| `author` | 作者 slug（可空，外键 → `author.slug`，`ON DELETE SET NULL`；`NULL` 表示未设置，无 `none` 哨兵）。可选的单值属性，不参与分类键，驱动随机 API 的 `a=` 筛选与详情页署名 |
| `status` | `ready` / `deleted`（软删除） |
| `deleted_at` | 软删时间 |
| `created_at` / `updated_at` | 时间戳 |

关键索引：`ready` 状态下 `index_key` 与 `(category_key, category_index)` 唯一；另有 `md5`、缺失 MD5 回填、`object_key → .webp` 缩略图反查等部分索引。

## category —— 分类计数表

| 字段 | 含义 |
| --- | --- |
| `category_key` (PK) | 分类键 |
| `device` / `brightness` / `theme` | 构成分类的三个轴 |
| `count` | 该分类下 ready 图数量（≥0） |
| `created_at` / `updated_at` | 时间戳 |

用于折叠空分类、维护 `category_index` 的连续性。

## upload_session —— 上传会话

| 字段 | 含义 |
| --- | --- |
| `id` / `staging_object_key` (UNIQUE) | 会话 id / 暂存键 |
| `final_object_key` | 完成后的正式键 |
| `storage_slug` | 该会话目标后端 slug（不加外键，瞬时状态） |
| `expected_size` | 本地上传声明的 raw 字节数；链接下载创建时为 NULL，prepare 后写实测值 |
| `metadata_payload` (JSONB) | 待落库元数据与服务端 prepared 真值（最终 MD5 / 尺寸 / 质量 / 缩略图键） |
| `status` | `created` / `receiving` / `preparing` / `ready` / `committing` / `finalized` / `failed` / `cancelled` |
| `idempotency_key` (UNIQUE) | 幂等键（防重复完成） |
| `error` | 失败原因 |
| `expires_at` | 过期时间（默认 10 分钟，过期由 `upload.cleanup` 清暂存） |
| `created_at` / `updated_at` | 时间戳 |

## operation_log —— 后台任务队列

| 字段 | 含义 |
| --- | --- |
| `id` (PK) | 任务 id |
| `type` | 任务类型：`thumb.generate` / `move.cleanup` / `upload.cleanup` / `cache.rebuild` |
| `target_id` | 目标图片 id |
| `idempotency_key` | 幂等键（如 `cache.rebuild` / `upload.cleanup` 全局仅一个活跃） |
| `status` | `pending` / `running` / `succeeded` / `failed` / `ignored` |
| `payload` / `result` / `error` | 入参 / 结果 / 错误 |
| `retry_count` / `next_retry_at` | 重试次数与下次重试时间（指数退避 60s → 6h） |
| `created_at` / `updated_at` | 时间戳 |

## storage_backend —— 命名存储后端注册表

| 字段 | 含义 |
| --- | --- |
| `slug` (PK) | 后端标识（小写 ASCII slug，≤32）；内置 `local` 不可删 |
| `display_name` | 显示名 |
| `type` | 驱动类型：`local`（容器文件系统）/ `s3`（对象存储）/ `webdav` |
| `config` (JSONB) | 驱动配置（`s3` 的 endpoint/bucket/密钥等；`webdav` 的 base_url/用户名/密码等；`local` 为 `{}`）。密钥/密码明文存此，从不回传前端 |
| `enabled` | 是否可作为**新图片写入**目标：仅决定上传/导入的存储选择框里是否出现此后端；不影响已有图片读取，也不影响能否迁入 |
| `is_default` | 是否为新上传默认后端（局部唯一索引保证全局恰好一个） |
| `sort_order` | 存储管理页拖动排序（升序）；内置 `local` 由读取查询恒定置顶，不参与排序 |
| `created_at` / `updated_at` | 时间戳 |

一个后端是“实例”而非“类型”，因此同为对象存储的两个桶可并存。`metadata.storage_slug` 以真实外键（`ON DELETE RESTRICT`）引用它（在用后端删不掉，需先迁走图片）。`upload_session.storage_slug` 是同样的 slug 但**不加外键**（瞬时状态，否则已完成的会话会让其后端永远删不掉）。热路径解析走进程内 TTL 备忘（密钥不入 Redis）。

## app_config —— 应用配置（KV）

| 字段 | 含义 |
| --- | --- |
| `key` (PK) | 配置键 |
| `value` (JSONB) | 配置值 |
| `updated_at` | 时间戳 |

存储配置已迁出到 `storage_backend` 表，此表目前未使用，保留以备将来的单例小配置。其余运行时设置存在文件 `config.json` 中（见[配置说明](./configuration)）。

## admin_account —— 管理员

| 字段 | 含义 |
| --- | --- |
| `username` (PK) | 用户名 |
| `password_hash` | Argon2id 密码哈希 |
| `role` | `super` / `image` |
| `created_at` / `updated_at` | 时间戳 |

部分唯一索引保证 super 仅一个；super 只能由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 环境变量配置（密码丢失重新部署即可恢复，故 super 自助改密会在重启时被环境变量覆盖）。image 管理员在后台创建，仅能管理图片 / 上传 / 标签 / 主题 / 作者。用户名 2–32 位；密码至少 8 位且需含字母与数字。所有管理员都可在「账户设置」页自助修改密码（输入一次原密码 + 两次新密码）。

## tag / theme / image_tag —— 标签与主题

`tag` 与 `theme` 同构：

| 字段 | 含义 |
| --- | --- |
| `slug` (PK) | URL 安全的小写 slug（≤32，正则约束） |
| `display_name` | 人类可读名（如 `fddm → 房东的猫`，搜索可反查），≤64 |
| `created_at` / `updated_at` | 时间戳 |

二者唯一区别在基数：

- 一图一主题 —— 主题直接存于 `metadata.theme`，并驱动分类键与 `<theme>.<域名>` 子域名。
- 一图多标签 —— 通过 `image_tag` 连接表：

| 字段 | 含义 |
| --- | --- |
| `image_id` | 引用 `metadata(id)`，级联删除 |
| `tag_slug` | 引用 `tag(slug)`，级联删除 |
| `created_at` | 时间戳 |
| PK | `(image_id, tag_slug)`，另有 `(tag_slug, image_id)` 反查索引 |

## author —— 作者

与 `theme` 同构（`slug` 主键 + `display_name` + 手动排序 `sort_order`），但多一个 `link` 字段，且没有 `none` 哨兵（未设置即 `metadata.author = NULL`）：

| 字段 | 含义 |
| --- | --- |
| `slug` (PK) | URL 安全的小写 slug（≤32，正则约束） |
| `display_name` | 人类可读名（搜索可反查），≤64 |
| `link` | 作者主页/来源链接（可选 `http(s)`，≤2048），显示在图片详情 |
| `sort_order` | 作者管理页拖动排序 |
| `created_at` / `updated_at` | 时间戳 |

一图一作者（可选）—— 作者直接存于可空的 `metadata.author`（外键 → `author(slug)`，`ON DELETE SET NULL`）。与主题不同，作者**不**参与分类键，因此改作者只是普通字段更新、无需重排序号；删除作者由外键自动把其图片的作者清为 `NULL`，无需先迁移。
