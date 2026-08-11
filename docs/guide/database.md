# 数据库结构

PostgreSQL 共 10 张业务表，不保存迁移账本或 schema 版本表。
`packages/server/schema.sql` 是上一个已确认版本的干净安装基线；它与当前版本只跨一个发布
周期的 `schema-additions.sql` 共同组成完整的新安装结构。随机图 `id` 的末 12 位查询所需 ready
部分表达式索引，以及统一 Redis 图片投影的权威 revision 单行表均属于当前基线。PostgreSQL
是唯一真相源，Redis 图片投影、查询缓存与管理员会话均不替代数据库真值。

`schema.sql` 按依赖和运行职责排列：存储注册表 →
公共词表 → 图片真值、关联与投影 revision → 导入生命周期 → 后台任务 → 管理员身份。
每张表内部统一为标识、状态 / 所有权、业务字段、错误 / 重试和时间字段；种子、约束与
索引紧跟所属表，图片索引再按直接查询 / 外键、列表游标、随机选择 / 回收职责排列。

## 启动与结构契约

当前代码库不提供编号迁移、迁移账本或通用数据库升级路径。启动在 advisory bootstrap lock
内串行化：空数据库在一个事务中先执行已封版的 `schema.sql`，再执行当前
`schema-additions.sql`；非空数据库只执行 additions，随后进入轻量 readiness。additions、
readiness 或干净初始化任一步失败都会回滚本次事务。全部连接固定使用 `search_path=public`。

additions 只保存一个发布周期的安全增量。版本 N 新增经审查的行为中性字段、与其直接相关的
必要普通索引或稳定系统种子时，先写入 additions；全部受控非空数据库部署 N 并通过 readiness
后，版本 N+1 将同一定义移入 `schema.sql`，同时从 additions 删除。没有当前增量时仍保留注释
占位文件及稳定的启动、构建入口。该模型不支持跳过 N 直接部署 N+1；恢复早于 N 的数据库
备份时，也必须先运行 N 或人工执行同一份经审查 SQL。

当前 `v4.8.17` 的 additions 没有待执行 SQL，只保留过渡规则注释。
`metadata.purge_error TEXT`、`admin_account.preferences JSONB NOT NULL DEFAULT '{}'` 与
`theme.none` 已在 `schema.sql` 形成基线，并已由全部受控生产数据库在上一版本完成确认。
后续 additions 仍只保存当期真实增量：不补业务表、外键、CHECK，不删除或重命名对象，
不推测回填，不更新已有数据，也不写版本行；同名列存在但类型不兼容时不改型，由 readiness
明确拒绝，稳定种子也不得覆盖已有显示值。

readiness 只读核对 10 张当前业务表、源码实际使用的列及其 PostgreSQL 类型、必需系统种子，
并确认会话可写、public schema 可用且当前角色具备各表实际操作所需的 SELECT / INSERT /
UPDATE / DELETE 权限，不使用回滚写探针。核心表、必需列、列类型、种子或权限缺失会在业务
启动前明确失败。

readiness 不复制 `schema.sql` 的可空性、默认值、PK / FK / CHECK、触发器和索引，也不识别
旧版本号或旧结构形状。额外表、额外列、额外索引以及更宽的 CHECK 不影响启动，只要当前
代码不读写它们。当前封版结构不含 `metadata.extra`、`background_job.result`，存储与后台
任务 CHECK 也只允许当前值；应用不再携带旧结构识别、清理或版本分支。

## 运行期连接与公开回源

单实例使用上限 30 的主查询池和上限 30 的 advisory lock 池。Redis 图片投影不可读时，
公开只读路径通过主池内一个 FIFO 回源门访问 PostgreSQL：最多 12 个活动 client、64 个
等待者，等待 1.5 秒或执行 7.5 秒即失败。这个预算不作用于管理事务和 Worker，因此主池
仍为二者保留独立余量。调用点为一次公开读取建立显式惰性 reader scope；只有首个缓存 miss
真正执行 SQL 时才借 client，同一请求后续多条查询都复用它并在读阶段结束时统一释放。
不存在 AsyncLocalStorage 查询上下文、按查询类别调度或额外的数据库后端取消连接。请求取消、
执行超时和连接错误都会正常释放或直接淘汰 client；Redis 恢复并重新通过能力与投影校验后，
公开读取自动回到 Redis-first。

图片投影协调器只在当前进程内保留四态、一个活动校验或重建任务，以及 PostgreSQL / Redis
revision；图片事务与投影发布共用一个短写栅栏。Redis 重连、revision 不一致或重建失败时
读门保持关闭并继续走上述 PostgreSQL 回源，不维护独立 publication、release task 或跨实例
代际状态。

## metadata —— 图片主表

| 字段 | 含义 |
| --- | --- |
| `id` (UUID, PK) | 图片唯一 id（uuid v7，时间有序）；目录中的文件名也使用它 |
| `status` | `ready` / `deleted` |
| `storage_slug` | 图片所在存储后端 slug（外键 → `storage_backend.slug`） |
| `object_key` (UNIQUE) | 标准化图片在所属后端中的对象存储键 |
| `device` | 设备：`pc`（横屏）/ `mb`（竖屏），由宽高比或用户选择得到 |
| `brightness` | 亮度：`dark` / `light`，上传默认自动识别 |
| `theme` | 主题 slug；`none` 表示无主题 |
| `author` | 作者 slug，可空，外键 → `author.slug`，删除作者时自动置空 |
| `ext` | 扩展名：`jpg` / `png` / `webp` / `gif` / `avif` |
| `md5` | 文件 MD5，32 位十六进制；用于判重 |
| `width` / `height` | 像素尺寸 |
| `image_size` / `thumbnail_size` | 标准化图片字节数 / 缩略图字节数 |
| `title` / `description` / `source` / `original` | 标题 / 描述 / 来源 / 原图链接；标题和描述在去除首尾空白后分别最多 80 / 500 个普通汉字，外部链接仅允许 HTTPS |
| `image_time` | 图片展示 / 图库排序时间；JSONL 可指定，同一前端批次未指定时共享 `batch_time`，省略时使用会话创建时间 |
| `deleted_at` | 软删时间 |
| `purge_state` | 彻底删除认领状态：`idle` / `purging` / `failed`；只有 `idle` 可恢复 |
| `purge_started_at` | 当前彻底删除认领开始时间，用于回收崩溃遗留的过期认领 |
| `purge_attempts` | 单调递增的彻底删除尝试号，同时作为当前执行者的所有权令牌 |
| `purge_error` | 最近一次彻底删除失败的有界错误信息 |
| `created_at` | 实际导入 ImageShow 的时间 |
| `updated_at` | 图片元数据最后更新时间 |

图片分类直接由 `device`、`brightness` 与 `theme` 表达，人工可读目录也使用这三项；
随机候选由统一 Redis ready-image ZSET 投影维护，PostgreSQL 不保存分类连续编号。

成功提交的图片以正式原图与正式缩略图同时存在为数据库外对象不变量。正常缩略图 GET
只按 `storage_slug + object_key` 解析唯一地址并读取正式对象，不查询 repair 状态、不探测
存在性、不读取原图降级，也不在请求中写对象或 `thumbnail_size`。缺图返回 404；分类移动
和存储迁移返回结构化 `storage_thumbnail_missing`，要求先运行检查页“存储维护”。

检查页显式维护是独立的管理员同步操作：它在全局存储位置写锁内重读当前图片位置，只为
原图仍存在且缩略图确实缺失的记录生成、强摘要回读并写回 `thumbnail_size`。该路径不创建
`background_job`，也不把修复字节写入 JSONB；数据库回写未确认时会清理本次候选并逐项报告
失败。维修写对象前用现有合法值 `thumbnail_size=0` 标记尚未最终采用的候选；即使数据库
最终更新和候选清理同时无法确认，后续显式维护仍会重新进入该记录，而不需要新表、任务或
修复 payload。它是当前唯一会生成缩略图的维修入口。

彻底删除先用 `FOR UPDATE SKIP LOCKED` 把 deleted 行原子认领为 `purging` 并增加
`purge_attempts`，随后在该图的存储 mutation lock 内再次核对状态、尝试号和对象位置。
对象删除完成后，数据库删除仍以尝试号、`storage_slug` 和 `object_key` 做条件更新；恢复只
接受 `purge_state='idle'`。进程崩溃留下的过期 `purging` 可重新认领，旧执行者不能用过期
令牌删除或覆盖新执行者的结果。一次认领最多 `trashBatchSize` 行；软删除、恢复事务与
`scope: "all"` 的水位捕获共享一个短时 advisory lock，水位查询直接复用持锁连接，因此
捕获前已经开始的成员变更必先提交或回滚。HTTP 请求捕获当前总数及 `deleted_at + id` 上界
后，先持久化携带该上界的 `trash.purge` 任务，再处理一个批次；首批中止或收口失败也不会
丢失已确认范围。上界之后新进入回收站，或恢复后再次删除而取得新 `deleted_at` 的行不会
被该任务认领。请求中止或批次异常时，
已经进入当前并发片的图片先收口各自的删除结果；尚未处理以及失败状态写回未完成的认领，
通过一次有界更新按 `id + purge_attempts` 立即恢复为 `idle`。该更新不会命中已删除、
已标记失败或已被新 attempt 领取的行。

关键索引：`ready` 状态下的随机轴 `(device, brightness, theme, id)`，以及随机图定向
候选使用的 `right(id::text, 12)` ready 部分表达式索引；前后台图库按
`image_time DESC, id DESC` 游标分页，并为常用筛选预建 ready 部分索引：无筛选、
单设备、单亮度、设备+亮度、单主题、设备+主题、亮度+主题、设备+亮度+主题、作者。
标签查询依赖 `image_tag(tag_slug, image_id)` 命中标签集合，结合 `metadata` 的 ready/
图片时间与主题等索引完成 Redis 降级时的分页；另有 MD5、缩略图反查、主题、作者和
存储后端索引。

## ready_image_revision —— Redis 投影权威修订号

该表只允许 `singleton=1` 一行，保存非负 `BIGINT revision` 与 `updated_at`。所有会改变
ready 图片 rich 投影、筛选成员或统计的业务事务都在 COMMIT 前原子递增 revision。
Redis meta 的 `applied_revision` 只有在精确同步或全量重建完成完整性校验后才可发布；
二者不一致时缓存读门关闭。该表不保存 Redis 状态；当前协议只服务于单个 ImageShow
应用进程，不支持多应用实例。

## import_session —— 统一导入会话

| 字段 | 含义 |
| --- | --- |
| `id` (UUID, PK) | 服务端按 `image_time` 生成的 UUIDv7；最终图片 id 与对象键复用该值。同时间的批量导入记录会把单批次位置编码到 `rand_a`，使靠后的输入排序更新 |
| `mode` | `upload` / `download`；分别由浏览器上传和服务器下载素材 |
| `status` | `created` / `materializing` / `received` / `preparing` / `ready` / `committing` / `finalized` / `failed` / `cancelled` |
| `execution_token` | 当前 materialize / prepare / commit 执行者的 UUID 栅栏 token；阶段发布必须匹配，进入稳定状态或取消时清空 |
| `raw_token` | `received` / `preparing` 状态采用的 attempt 专属完整 raw UUID；prepare 只读取该 token 对应文件，进入 `ready` 或终态时清空 |
| `idempotency_key` | 幂等键 |
| `request_hash` | 幂等请求摘要；同一幂等键仅在摘要一致时复用会话，JSONL 的临时清单位置也参与摘要 |
| `storage_slug` | 该会话锁定的目标后端 slug（外键 → `storage_backend.slug`）；需等待会话完成或过期清理后才能删除后端 |
| `final_object_key` | 进入 `committing` 时确定的 `media` 正式存储键，提交前为空 |
| `source_url` | URL 导入来源，仅允许 HTTPS；upload 模式为空 |
| `expected_size` | 本地上传声明的 raw 字节数 |
| `metadata_payload` | 创建会话时的草稿元数据 |
| `prepared_payload` | 服务端 prepared 真值：MD5、尺寸、质量、暂存键，以及不受人工选择影响、每次 prepare 都重新计算的 `detected_device` / `detected_brightness` 等 |
| `error` | 失败原因 |
| `image_time` | 本次导入的图片展示时间；也参与 UUIDv7 和 `request_hash` |
| `expires_at` | 30 分钟空闲过期时间；素材化、prepare 和 commit 期间持续续租。普通过期会话由 `import.cleanup` 原子认领；过期的 `committing` 仅在确认其提交 advisory lock 空闲后取消并清理 |
| `created_at` / `updated_at` | 时间戳 |

## background_job —— 后台任务队列

| 字段 | 含义 |
| --- | --- |
| `id` (PK) | 任务 id |
| `type` | `move.cleanup` / `import.cleanup` / `trash.purge` / `cache.rebuild` |
| `status` | `pending` / `running` / `succeeded` / `failed` / `ignored` |
| `execution_token` | 每次领取生成的 UUID 所有权栅栏；仅当前 `running` 执行者持有，退出运行态时清空 |
| `target_id` | 目标图片 id |
| `idempotency_key` | 幂等键 |
| `payload` / `error` | 入参与错误；终态结果不在队列表中重复持久化 |
| `retry_count` / `next_retry_at` | 重试次数与下次重试时间 |
| `created_at` / `updated_at` | 时间戳 |

`cache.rebuild` 会从 PostgreSQL 全量重建统一 ready-image Redis 投影，`trash.purge` 在 payload
中保存发起清空操作时的删除水位，并在 HTTP 首批开始前持久化；每次只执行该稳定范围内的
一个有界批次并按范围内剩余数量重新调度。确定性幂等键只阻止 `pending`、`running` 和仍可重试
的 `failed` 重复入队；`succeeded`、`ignored` 与耗尽重试的 `failed` 会在同一记录上重置
为 `pending`，因此同一对象以后再次需要 `move.cleanup` 时不会被历史任务静默拦截。
Worker 会按保留策略裁剪历史记录：`succeeded` / `ignored` 保留 7 天；普通任务耗尽
重试且 `next_retry_at IS NULL` 的 `failed` 同样保留 7 天。耗尽的 `move.cleanup` 不按历史
保留期删除，因为它仍是后端对象的未解决保护引用，必须通过管理端重试并实际核验成功。
每次 `FOR UPDATE SKIP LOCKED` 领取都会生成新的 `execution_token`；续租、成功、忽略、
重排和失败写入必须同时匹配任务 id、`running` 状态与该 token。僵尸恢复及所有退出
`running` 的路径会清空 token，因此租约超时后又被重新领取的旧执行者不能写入迟到
终态。`retry_count` 只统计失败与僵尸恢复次数，所有权代际不会进入 payload。

`move.cleanup` 的 payload 只保存原因、保留策略，以及固化后端 slug、对象前缀 / 键和入队时
物理命名空间 identity 的对象条目，不携带图片或缩略图字节。`pending`、`running` 以及所有
`failed`（包括耗尽重试）都属于未解决引用；
对应后端不能删除或修改物理位置，管理接口会返回总数、失败数和耗尽重试数。超级管理员
可按后端把耗尽任务恢复为 `pending`；Worker 删除前还会核对当前 slug 的 identity，并把
对象已不存在视为核验完成。它不会生成或采用缩略图，也不会更新 `metadata`。未解决记录
也是该 identity、前缀与对象键的持久删除租约；
commit、分类移动和存储迁移在写入或采用正式对象前必须确认不存在该租约，避免远端
DELETE 发出后失锁时由后继重新采用同一对象。

## storage_backend —— 命名存储后端注册表

| 字段 | 含义 |
| --- | --- |
| `slug` (PK) | 后端标识；内置 `local` 不可删 |
| `display_name` | 显示名 |
| `type` | `local` / `s3` |
| `config` | 驱动配置；S3 密钥明文存库但不回传前端 |
| `namespace_identities` | 经验证且合并后的物理命名空间访问身份集合；当前配置身份始终隐式参与 |
| `enabled` | 是否可作为新图片及存量图片迁移的写入目标 |
| `is_default` | 是否为新上传默认后端 |
| `sort_order` | 后台排序 |
| `created_at` / `updated_at` | 时间戳 |

`metadata.storage_slug` 与 `import_session.storage_slug` 以外键引用它；后端需先迁走图片、
清理全部导入会话、未解决 `move.cleanup` 和 `_uploads` 暂存对象才能删除。后端注册表同时
管理配置快照与按签名复用的 driver/client 生命周期；只有 driver 连接参数变化或后端
删除才会安全退役相关实例，显示名、启停、默认项和排序变化只刷新注册表快照。S3 的
bucket / root_path 是物理布局；仍有
图片、任意导入会话、未解决清理任务或暂存对象时不允许原地修改。S3 endpoint 可在
独占位置锁内通过 `_uploads` 完整快照、既有对象的有界 Range 读取和双向随机挑战证明
为同一命名空间的访问别名；成功后合并全部相交后端的 `namespace_identities`，使别名
等价关系保持传递性；已在集合中或与其他注册项共享 identity 的空后端也不得无证明地
脱离该集合。验证失败不写配置；COMMIT 回包丢失时按事务 ID 查询确定结果，
无法确认则明确要求刷新核对。region、凭据、公开 URL 等访问参数不改变物理 identity，
其中 region、凭据、path-style 和请求时限会改变 driver；保存时取得独占位置锁，在没有
并发多请求存储操作的边界完成验证和提交；后续操作发布当前 PostgreSQL 快照时原子选取
新 driver，并让失去签名引用的旧 driver 拒绝新操作。公开 URL 只参与响应地址投影，仅校验
HTTPS 格式并在后端配置锁内保存，不创建探针 driver，也不退役当前连接。

## admin_account —— 管理员

| 字段 | 含义 |
| --- | --- |
| `username` (PK) | 用户名 |
| `password_hash` | Argon2id PHC 密码哈希；数据库约束基本格式和长度，应用校验参数安全范围 |
| `role` | `super` / `image` |
| `preferences` | 管理员界面偏好 JSONB；顶层必须是对象、最大 4 KiB，当前可保存 `color_scheme` 与 `image_card_density` |
| `created_at` / `updated_at` | 时间戳 |

仅在数据库没有 super 时，首次启动才使用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 创建首个 super；已有 super 的账号、密码和偏好始终以 PostgreSQL 为准。偏好 PATCH 使用 JSONB 顶层合并，不同键的并发修改由同一账号行串行化后各自保留；API 只返回当前 shared schema 认识的键。`color_scheme` 只接受 `light` / `dark` / `system`，缺失时使用 `system` 并由浏览器实时解析；`image_card_density` 缺失时使用紧凑。默认值集中在 shared，数据库只保存用户选择的模式，不保存自动模式解析出的设备明暗结果。

## tag / theme / image_tag —— 标签与主题

`tag` 与 `theme` 都使用小写 slug、显示名、排序和时间戳。主题是一图一值，直接存在 `metadata.theme`；标签是一图多值，通过 `image_tag(image_id, tag_slug)` 关联。

图片标签关联与 import commit 对最终解析、去重后的 tag slug 按排序顺序组合取得
共享 advisory lock，并在锁内使用同一列表幂等确保缺失标签存在、替换
`image_tag`。标签管理只提供单项删除，删除时取得对应独占锁，因此不能穿过并发
关联或在外键写入中途执行。删除标签会级联删除
`image_tag`，在同一事务推进图片 revision，提交后精确更新 Redis rich item、核心统计与
词表 / 计数派生状态。旧 revision 的按需标签索引会被读取端拒绝，后续请求从 PostgreSQL
真值重新构建，保证 `tag=` 随机过滤和 gallery facets 不会沿用旧成员；旧索引仍受统一
派生 registry 的 TTL、LRU、结果数和成员数上限约束，不参与核心完整性判定。

## author —— 作者

作者有 `slug`、`display_name`、`link`、排序和时间戳。一图最多一个作者，存在
`metadata.author`。作者关联持有共享 slug 租约，并在同一锁边界内幂等完成“确保作者存在”和
图片写入；显式词表管理与删除持有独占 slug 锁，因此删除不能穿过并发关联。删除事务
返回本次实际置空的图片 id，推进 revision 后只用这组真值精确同步 Redis rich item、
核心统计与词表 / 计数；旧 revision 的按需作者索引由读取端拒绝并重建，避免删除与并发
关联互相覆盖。
