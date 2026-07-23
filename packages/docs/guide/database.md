# 数据库结构

PostgreSQL 共 9 张业务表，另有迁移记录表 `schema_migrations`。全新数据库从
`packages/server/migrations/0001_initial.sql` 初始化。当前仓库只保留这一份已确认的
当前基线；数据库的迁移记录应为 `0001_initial`。后续 schema 变化从 `0002` 开始，
通过按文件名顺序执行的新前向迁移应用，已发布的迁移不再改写。
PostgreSQL 是唯一真相源，Redis 随机池、列表缓存和判重缓存均可重建。

## metadata —— 图片主表

| 字段 | 含义 |
| --- | --- |
| `id` (UUID, PK) | 图片唯一 id（uuid v7，时间有序）；目录中的文件名也使用它 |
| `device` | 设备：`pc`（横屏）/ `mb`（竖屏），由宽高比或用户选择得到 |
| `brightness` | 亮度：`dark` / `light`，上传默认自动识别 |
| `theme` | 主题 slug；`none` 表示无主题 |
| `width` / `height` | 像素尺寸 |
| `image_size` / `thumbnail_size` | 标准化图片字节数 / 缩略图字节数 |
| `ext` | 扩展名：`jpg` / `png` / `webp` / `gif` / `avif` |
| `object_key` (UNIQUE) | 标准化图片在所属后端中的对象存储键 |
| `storage_slug` | 图片所在存储后端 slug（外键 → `storage_backend.slug`） |
| `md5` | 文件 MD5，32 位十六进制；用于判重 |
| `title` / `description` / `source` / `original` | 标题 / 描述 / 来源 / 原图链接；标题和描述在去除首尾空白后分别最多 80 / 500 个普通汉字，外部链接仅允许 HTTPS |
| `extra` | 预留扩展属性 JSON；用于后续 EXIF、AI 标签、主色、来源平台等非核心字段 |
| `author` | 作者 slug，可空，外键 → `author.slug`，删除作者时自动置空 |
| `status` | `ready` / `deleted` |
| `deleted_at` | 软删时间 |
| `purge_state` | 彻底删除认领状态：`idle` / `purging` / `failed`；只有 `idle` 可恢复 |
| `purge_started_at` | 当前彻底删除认领开始时间，用于回收崩溃遗留的过期认领 |
| `purge_attempts` | 单调递增的彻底删除尝试号，同时作为当前执行者的所有权令牌 |
| `purge_error` | 最近一次彻底删除失败的有界错误信息 |
| `image_time` | 图片展示 / 图库排序时间；JSONL 可指定，同一前端批次未指定时共享 `batch_time`，省略时使用会话创建时间 |
| `created_at` | 实际导入 ImageShow 的时间 |
| `updated_at` | 图片元数据最后更新时间 |

图片分类直接由 `device`、`brightness` 与 `theme` 表达，人工可读目录也使用这三项；随机候选由 Redis 集合维护，PostgreSQL 不保存分类连续编号。

彻底删除先用 `FOR UPDATE SKIP LOCKED` 把 deleted 行原子认领为 `purging` 并增加
`purge_attempts`，随后在该图的存储 mutation lock 内再次核对状态、尝试号和对象位置。
对象删除完成后，数据库删除仍以尝试号、`storage_slug` 和 `object_key` 做条件更新；恢复只
接受 `purge_state='idle'`。进程崩溃留下的过期 `purging` 可重新认领，旧执行者不能用过期
令牌删除或覆盖新执行者的结果。一次认领最多 `trashBatchSize` 行；清空回收站的 HTTP
请求只处理一个批次，其余行由 `trash.purge` 后台任务继续领取。

关键索引：`ready` 状态下的随机轴 `(device, brightness, theme, id)`；前后台图库按 `image_time DESC, id DESC` 游标分页，并为常用筛选预建 ready 部分索引：无筛选、单设备、单亮度、设备+亮度、单主题、设备+主题、亮度+主题、设备+亮度+主题、作者。标签查询依赖 `image_tag(tag_slug, image_id)` 命中标签集合，结合 `metadata` 的 ready/图片时间与主题等索引完成分页；另有 MD5、缩略图反查、主题、作者和存储后端索引。

## import_session —— 统一导入会话

| 字段 | 含义 |
| --- | --- |
| `id` (UUID, PK) | 服务端按 `image_time` 生成的 UUIDv7；最终图片 id 与对象键复用该值。同时间的批量导入记录会把单批次位置编码到 `rand_a`，使靠后的输入排序更新 |
| `mode` | `upload` / `download`；分别由浏览器上传和服务器下载素材 |
| `final_object_key` | 进入 `committing` 时确定的 `media` 正式存储键，提交前为空 |
| `storage_slug` | 该会话锁定的目标后端 slug（外键 → `storage_backend.slug`）；需等待会话完成或过期清理后才能删除后端 |
| `source_url` | URL 导入来源，仅允许 HTTPS；upload 模式为空 |
| `expected_size` | 本地上传声明的 raw 字节数 |
| `metadata_payload` | 创建会话时的草稿元数据 |
| `prepared_payload` | 服务端 prepared 真值：MD5、尺寸、质量、暂存键，以及不受人工选择影响、每次 prepare 都重新计算的 `detected_device` / `detected_brightness` 等 |
| `execution_token` | 当前 materialize / prepare / commit 执行者的 UUID 栅栏 token；阶段发布必须匹配，进入稳定状态或取消时清空 |
| `raw_token` | `received` / `preparing` 状态采用的 attempt 专属完整 raw UUID；prepare 只读取该 token 对应文件，进入 `ready` 或终态时清空 |
| `status` | `created` / `materializing` / `received` / `preparing` / `ready` / `committing` / `finalized` / `failed` / `cancelled` |
| `idempotency_key` | 幂等键 |
| `request_hash` | 幂等请求摘要；同一幂等键仅在摘要一致时复用会话，JSONL 的临时清单位置也参与摘要 |
| `image_time` | 本次导入的图片展示时间；也参与 UUIDv7 和 `request_hash` |
| `error` | 失败原因 |
| `expires_at` | 30 分钟空闲过期时间；素材化、prepare 和 commit 期间持续续租。普通过期会话由 `import.cleanup` 原子认领；过期的 `committing` 仅在确认其提交 advisory lock 空闲后取消并清理 |
| `created_at` / `updated_at` | 时间戳 |

## background_job —— 后台任务队列

| 字段 | 含义 |
| --- | --- |
| `id` (PK) | 任务 id |
| `type` | `thumb.generate` / `move.cleanup` / `import.cleanup` / `trash.purge` / `cache.rebuild` |
| `target_id` | 目标图片 id |
| `idempotency_key` | 幂等键 |
| `status` | `pending` / `running` / `succeeded` / `failed` / `ignored` |
| `payload` / `result` / `error` | 入参 / 结果 / 错误 |
| `retry_count` / `next_retry_at` | 重试次数与下次重试时间 |
| `created_at` / `updated_at` | 时间戳 |

`cache.rebuild` 会从 PostgreSQL 全量重建 Redis 随机池，`trash.purge` 每次只执行一个
有界删除批次并按剩余数量重新调度。确定性幂等键只阻止 `pending`、`running` 和仍可重试
的 `failed` 重复入队；`succeeded`、`ignored` 与耗尽重试的 `failed` 会在同一记录上重置
为 `pending`，因此同一对象以后再次需要 `move.cleanup` 时不会被历史任务静默拦截。
Worker 会按保留策略裁剪历史记录：`succeeded` / `ignored` 保留 7 天；普通任务耗尽
重试且 `next_retry_at IS NULL` 的 `failed` 保留 90 天。耗尽的 `move.cleanup` 不按历史
保留期删除，因为它仍是后端对象的未解决保护引用，必须通过管理端重试并实际核验成功。

`move.cleanup` 的对象条目同时固化后端 slug、对象前缀 / 键和入队时的物理命名空间
identity。`pending`、`running` 以及所有 `failed`（包括耗尽重试）都属于未解决引用；
对应后端不能删除或修改物理位置，管理接口会返回总数、失败数和耗尽重试数。超级管理员
可按后端把耗尽任务恢复为 `pending`；Worker 删除前还会核对当前 slug 的 identity，并把
对象已不存在视为核验完成。未解决记录也是该 identity、前缀与对象键的持久删除租约；
commit、分类移动和存储迁移在写入或采用正式对象前必须确认不存在该租约，避免远端
DELETE 发出后失锁时由后继重新采用同一对象。

## storage_backend —— 命名存储后端注册表

| 字段 | 含义 |
| --- | --- |
| `slug` (PK) | 后端标识；内置 `local` 不可删 |
| `display_name` | 显示名 |
| `type` | `local` / `s3` / `webdav` |
| `config` | 驱动配置；密钥/密码明文存库但不回传前端 |
| `namespace_identities` | 经验证且合并后的物理命名空间访问身份集合；当前配置身份始终隐式参与 |
| `enabled` | 是否可作为新图片写入目标 |
| `is_default` | 是否为新上传默认后端 |
| `sort_order` | 后台排序 |
| `created_at` / `updated_at` | 时间戳 |

`metadata.storage_slug` 与 `import_session.storage_slug` 以外键引用它；后端需先迁走图片、
清理全部导入会话、未解决 `move.cleanup` 和 `_uploads` 暂存对象才能删除。后端注册表同时
管理配置快照与按签名复用的 driver/client 生命周期，配置或默认后端变化会关闭并清理
相关实例。S3 的 bucket / root_path 与 WebDAV 的 base_url / root_path 是物理布局；仍有
图片、任意导入会话、未解决清理任务或暂存对象时不允许原地修改。S3 endpoint 可在
独占位置锁内通过 `_uploads` 完整快照、既有对象的有界 Range 读取和双向随机挑战证明
为同一命名空间的访问别名；成功后合并全部相交后端的 `namespace_identities`，使别名
等价关系保持传递性；已在集合中或与其他注册项共享 identity 的空后端也不得无证明地
脱离该集合。验证失败不写配置；COMMIT 回包丢失时按事务 ID 查询确定结果，
无法确认则明确要求刷新核对。region、凭据、公开 URL 等访问参数不改变物理 identity，
可在共享位置锁下验证并轮换。

## admin_account —— 管理员

| 字段 | 含义 |
| --- | --- |
| `username` (PK) | 用户名 |
| `password_hash` | Argon2id PHC 密码哈希；数据库约束基本格式和长度，应用校验参数安全范围 |
| `role` | `super` / `image` |
| `preferences` | 管理员界面偏好 JSONB；顶层必须是对象、最大 4 KiB，当前可保存 `image_card_density` |
| `created_at` / `updated_at` | 时间戳 |

仅在数据库没有 super 时，首次启动才使用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 创建首个 super；已有 super 的账号、密码和偏好始终以 PostgreSQL 为准。偏好 PATCH 使用 JSONB 顶层合并，不同键的并发修改由同一账号行串行化后各自保留；API 只返回当前 shared schema 认识的键。

## tag / theme / image_tag —— 标签与主题

`tag` 与 `theme` 都使用小写 slug、显示名、排序和时间戳。主题是一图一值，直接存在 `metadata.theme`；标签是一图多值，通过 `image_tag(image_id, tag_slug)` 关联。

标签写操作按实体 slug advisory lock 串行化。删除标签会级联删除 `image_tag`，并按
“随机池 → 词表 / 计数 → 图片缓存代际”顺序修复派生状态，保证 `tag=` 随机过滤和
gallery facets 不会重新物化旧值。

## author —— 作者

作者有 `slug`、`display_name`、`link`、排序和时间戳。一图最多一个作者，存在
`metadata.author`。作者关联持有共享 slug 租约，并在同一锁边界内幂等完成“确保作者存在”和
图片写入；显式词表管理与删除持有独占 slug 锁，因此删除不能穿过并发关联。删除事务返回本次实际
置空的图片 id，事务后只用这组真值修复随机池、词表和图片缓存，避免删除与并发关联
互相覆盖。
