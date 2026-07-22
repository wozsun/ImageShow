# 项目结构

ImageShow 是 npm workspaces 单仓多包项目，四个包随应用一起构建、部署。本页逐文件说明职责。

```
ImageShow/
├── compose.yaml          # 三个服务：postgresql:18 / redis:8 / imageshow
├── Dockerfile            # 多阶段构建：build shared/web/docs → 运行时镜像
├── package.json          # workspaces 根，统一脚本
├── scripts/build/        # 跨 workspace 的构建辅助脚本
├── tsconfig.base.json    # 共享 TS 配置
├── .env.example          # 环境变量样例
└── packages/
    ├── shared/   # 前后端共享的常量与类型
    ├── server/   # Hono 后端（业务全部在这）
    ├── web/      # React + Vite 前端（SPA + 后台）
    └── docs/     # VitePress 文档站
```

本地测试统一放在根目录 `tests/`，由 `.gitignore` 排除，不进入发布仓库和
CI，也不在受版本控制的 `package.json` 中声明测试生命周期或测试依赖。
GitHub Actions 只执行 Docker 生产构建和镜像 / Release 发布。

## packages/shared —— 共享层

| 文件 | 职责 |
| --- | --- |
| `app-config.ts` | 服务端完整配置常量与共享类型源：`appConfig` 默认值、分页 / 缩略图 / 随机去重 / 链接导入超时 / 后台任务重试等常量；导出 `Device` / `Brightness` / `ImageExt` / `RuntimeConfig`、最小化后台响应 `AdminSettings` 与 `SiteSettings`。 |
| `browser.ts` | 可安全进入浏览器产物的独立子入口：管理路径、校验规则、界面偏好，以及前后端共享的图片、鉴权、facets、批量更新 / 迁移和统一错误 DTO。Web 运行时值只从 `@imageshow/shared/browser` 导入，避免带入数据库、Redis 等服务端默认配置。 |

## packages/server —— 后端

### 入口与配置

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 应用装配：挂载安全响应头、多主机路由中间件、注册所有路由；启动时先准备运行目录 / 清理随机池 spool，再依次 `pingDb → runMigrations → cleanupOrphanRawImports → initializeAdmin → pingRedis → startWorker`，随后异步确保随机池存在，并处理 SIGTERM 优雅退出。 |
| `admin-password-cli.ts` | 宿主机/容器管理员密码恢复入口：隐藏读取新密码、更新 PostgreSQL 账号，并尽力清除 Redis 管理会话。 |
| `config/bootstrap-env.ts` | 应用配置播种边界：解析 `NODE_ENV`、首次管理员凭据和首次生成 `config.json` 所需环境变量；集中导出数据、存储、临时文件和日志目录。应用字段只在配置文件首次生成时播种。 |
| `config/deployment-config.ts` | 部署配置边界：每次启动严格解析 PostgreSQL 与 Redis 环境变量，供主进程、CLI 和检查功能统一使用。监听端口由共享代码常量固定。 |
| `config/runtime-config.ts` | 完整运行时配置的严格 zod schema、可迁移配置投影、当前配置解析和嵌套 patch 合并。 |
| `config/runtime-config-store.ts` | `data/config.json` 的读取、按 schema 归一化、原子写入、内存快照、进程内写租约、revision 补偿、热重载与变更监听；配置文件生成后成为运行时配置真相源。 |
| `config/config-package.ts` | `imageshow-config` 版本化配置包的构建、严格解析、敏感存储配置投影、slug 冲突预检，以及用同会话 xid8 receipt 判定数据库结果的补偿式导入编排。 |
| `config/full-config.ts` | 完整运行时配置的访问地址差异、只读预检、共享写锁与精准保存编排。 |
| `config/fields.ts` | 运行时配置字段的 zod 边界值：站点、上传、链接导入、标准化、缩略图、安全、ALTCHA 和日志等设置校验。 |
| `config/app-settings.ts` | 设置页可编辑字段的严格嵌套 patch schema、按前端实际用途投影的最小后台设置 DTO、公开站点配置和图片输入 / 缩略图运行时设置；不返回连接配置、完整默认值或纯服务端限流字段，也不负责存储后端注册表。 |

### core/ —— 基础设施

| 文件 | 职责 |
| --- | --- |
| `core/db.ts` | PostgreSQL 主查询池、独立长生命周期 advisory-lock 池、事务与可靠的组合锁工具、同会话附加锁及迁移串行执行；持锁连接丢失会发送中止信号并等待回调协作式收口，锁取得或释放结果不确定时销毁连接，迁移 DDL 与版本记录使用持锁的同一会话，迁移目录优先使用生产 bundle，源码运行时回退到仓库 migrations，账号初始化由入口显式交给 users 领域。 |
| `core/api-error.ts` | 与 HTTP 路由解耦的领域错误 `ApiError`、普通错误消息和 details 边界。 |
| `core/credentials.ts` | 首次管理员环境凭据的纯校验与规范化，供配置播种和 users 初始化复用。 |
| `core/byte-range.ts` | 存储 driver 与 HTTP serving 共用的单段 Range 解析，不依赖图片领域。 |
| `core/password.ts` | Node.js 原生异步 Argon2id 密码派生与 PHC 编解码：当前参数生成、安全范围内的旧参数验证、升级判断和恒定时间比较。 |
| `core/uuid.ts` | Node.js 原生 UUIDv7 封装：生成当前时间 ID，为历史 `image_time` 替换 48 位时间戳，并可显式写入 12 位 `rand_a`。 |
| `core/redis-client.ts` | Redis 8 连接实例与 `pingRedis()`；业务缓存逻辑按领域拆到 `random/`、`images/`、`vocab/`。 |
| `core/redis-pipeline.ts` | 执行 pipeline 并检查每条命令返回的错误，避免只等待 `exec()` 而漏掉部分失败。 |
| `core/http.ts` | HTTP 工具：`ok()` / `fail()` / `routeError()`、`requireAuth` / `requireCsrf` / `requireSuper`、会话 cookie 和 `clientIp()`；领域错误定义不再由 HTTP 模块反向承载。 |
| `core/login-rate-limit.ts` · `core/runtime-key-namespace.ts` | 可注入命名空间的登录限流与 ALTCHA 临时键隔离；测试进程使用唯一 volatile namespace，不复用生产 Redis 状态。 |
| `core/audit-log.ts` | 后台非 GET 写操作审计：记录操作者、角色、路径、状态、耗时、IP，失败时附带响应 code/error。 |
| `core/coalesce.ts` | 进程内 in-flight 合并工具，用于公共列表 / 详情 / facets / 概览 / MD5 等缓存 miss 后避免重复查询。 |
| `core/redis-json.ts` | PostgreSQL 派生 JSON 缓存的类型化 GET / SET EX / 删除 helper；Redis 故障只产生 cache miss。 |
| `core/http-validator.ts` | 静态资源与图片字节出口共用的 ETag 强弱比较、条件请求、If-Range 和 HTTP 日期语义。 |
| `core/concurrency.ts` | 有界并发遍历、动态数量限流与 FIFO 动态字节加权限流，用于导入、存储检查 / 清理等批量操作。 |
| `core/application-version.ts` | 从根包读取并缓存当前应用版本，供配置包与后台站点配置共同展示。 |
| `core/validation.ts` | 请求体 / 查询参数的 zod schema：`listQuery`（含 `shuffle`）、`metadataInput`、导入 / 批量操作输入等。 |
| `core/external-image-fetch.ts` | 外部图片 URL 安全边界：限制 HTTPS、要求域名、验证证书、用连接级受控 DNS lookup 阻断 rebinding 与内网 / metadata 地址、逐跳重定向校验、超时请求与图片内容嗅探，并对外统一安全拒绝提示，供链接导入和 link/original 代理复用。 |
| `core/term-resolve.ts` · `core/selectors.ts` | 共享解析：`resolveTermMap` / `resolveSlugs`（主题 / 标签 / 作者「别名·显示名 → slug」的统一规则），`splitSelectors`（逗号分隔、`!` 排除选择子拆分，随机 API 与画廊筛选共用）。 |
| `core/altcha.ts` | 登录安全验证：签发 ALTCHA 工作量挑战、验证签名，并用 Redis 原子防重放。 |
| `core/logger.ts` | 站点日志：分级输出到 stdout/stderr，并按大小轮转写入 `data/log/app.log`。 |
| `core/log-files.ts` | 后台日志页用的日志文件枚举、尾部读取和 `log.level` 热更新。 |

### storage/ —— 存储抽象（多后端）

| 文件 | 职责 |
| --- | --- |
| `storage/storage.ts` | 存储操作门面：统一 buffer / remove / list、`resolveReadableObject()`、`publicImageUrls()`、`testStorageBackend()` 与运行目录初始化；verified copy 由 `object-transfer.ts` 统一承载。 |
| `storage/backend-config.ts` | S3 / WebDAV 配置 schema、`StorageConfig` / 输入类型、默认值和完整性校验。 |
| `storage/backend-registry.ts` | `storage_backend` 数据库注册表、默认后端、CRUD、排序、启停、脱敏后台 DTO、generation 化配置快照与 driver 生命周期；在用物理字段保护、S3 Endpoint 安全重绑定、既有对象访问探测、同锁会话配置事务和变更后的实例关闭也集中于此。 |
| `storage/endpoint-rebind.ts` | S3 Endpoint 别名证明：每端一次 `_uploads` 快照、attempt 会话映射、既有对象探测配合双向随机读写挑战与精确探针清理。 |
| `storage/maintenance-lock.ts` | 存储变更共享锁与维护独占锁，并把锁连接和失锁 Signal 贯穿组合锁回调；已持有位置锁时，同会话 FIFO 追加附加锁，避免锁池嵌套自饿。 |
| `storage/storage-namespace.ts` | 本地 / S3 / WebDAV 配置 identity、布局 identity 与经验证的 identity 集合；排除凭据等访问参数，并以集合交集识别两个 slug 是否共享对象键空间。 |
| `storage/object-transfer.ts` | 流式计算对象 SHA-256 / MD5，区分既有目标冲突与写后完整性故障，并优先使用驱动原生复制；共享命名空间禁止重复写入，正式目标采用前检查持久删除租约。 |
| `storage/image-relocation.ts` | 图片重分类与主题重分配共用的 verified transfer 计划：源校验、候选跟踪、CAS 前准备及提交后清源。 |
| `storage/move-cleanup.ts` | 固化待删对象的物理命名空间并可靠入队；未解决任务同时作为正式对象键的删除租约，阻止迟到 DELETE 与后继采用并发。 |
| `storage/storage-backend.ts` | Local / S3 / WebDAV driver 接口、打开结果类型与工厂；缓存和关闭生命周期由注册表拥有。 |
| `storage/local-backend.ts` | 本地磁盘后端（`/app/data/storage` 下 media / thumbs / _uploads），含空目录回收 `pruneEmptyDirs()`。 |
| `storage/s3-backend.ts` | S3 / COS 后端：processed image / thumbnail 读写删与服务端复制/移动、`root_path` 前缀。 |
| `storage/webdav-backend.ts` | WebDAV 后端：PROPFIND/MKCOL/PUT/GET/DELETE/COPY，HTTP Basic 认证，XML parser 解析 PROPFIND，`base_url + root_path` 前缀，统一 timeout / 临时错误重试、有界目录遍历，以及服务端忽略 Range 时的流式切片。 |
| `storage/image-paths.ts` | 图片正式键名规则：`storageObjectKey()`、`thumbnailObjectKey()` 与集中助手 `thumbnailRef(row)`；所有清理 / 检查路径都走它，避免孤儿。 |
| `storage/object-keys.ts` | 路径 / 键名映射与防穿越：本地 `safeStoragePath()`、S3 `storageS3ObjectName()` 等，物理布局 `<root_path>/<media｜thumbs｜_uploads>/<key>`。 |
| `storage/object-validator.ts` | 规范化 S3 / WebDAV 实体标签，并按本地文件版本元数据生成对象 ETag。 |
| `storage/migration.ts` | 单图位置锁、锁内真值重读、物理 identity 判断、verified copy→CAS→旧对象清理协议，以及任意后端间的单图 / 整后端迁移。 |
| `storage/stream-buffer.ts` | 流 ↔ Buffer、Node ↔ Web Stream 与有界流式切片辅助。 |

### images/ —— 图片领域

| 文件 | 职责 |
| --- | --- |
| `images/service.ts` | 软删除 `deleteImage()`、改元数据 / 换分类 `updateImageMetadata()`（换分类＝移动对象键并同步 Redis 随机池）、单 / 批量迁移存储。 |
| `images/read-models/` | 图片读取模型：`public-images.ts`（公共列表 / 详情与 Redis 缓存）、`admin-images.ts`（后台列表 / 详情）、`duplicates.ts`（MD5 判重）、`facets.ts`、`overview.ts`，以及复用的 `pagination.ts`；Redis miss 后按场景做同进程 in-flight 合并。 |
| `images/image-cache.ts` | 统一 `image_cache_revision` 下的公共列表 / 详情、facets、后台概览、MD5 与 Redis 8 `HSETEX` lookup；lookup 另带响应 schema 版本，写前 revision 校验、本地 dirty fence 和“先推进代际、再精确清理”避免旧读回填。原图直连探测另用短 TTL。 |
| `images/serving.ts` | 存储对象、缩略图、外部原图代理与后台字节出口；集中处理 Content-Length、内容 / 对象版本 ETag、304、单段 Range / If-Range、外部回源代理、原图直连探测及其短 TTL 缓存、缓存策略和缩略图缺失时的乐观读取 / 补建。 |
| `images/original-link.ts` | 原图入口判断工具：计算展示 URL、规范化比较 URL，并只在 `original` 为 HTTPS 且不同于展示图时开放原图按钮 / 跳转。 |
| `images/presenter.ts` | `publicImage()` / `publicImages()` 把 DB 行变成后台可复用的完整图片视图、`publicImageDetail()`（公开详情字段白名单）、`publicImageCard()`（公共列表卡片白名单）、`importCommitImage()`（提交结果仅投影最终 URL）、`adminImageView()`（后台投影：去 `ext`、已删除图改指鉴权字节端点）。缓存键与 lookup 预热归读取 / 缓存模块。 |
| `images/processing.ts` | sharp 封装：图片格式 / 尺寸探测、缩略图、`transcodeStoredImage()`、`generateStoredThumbnail()`，以及运行时 Sharp 并发配置。 |
| `images/classification.ts` | 设备 / 明暗三态分类工具：`auto` 解析、按宽高落设备、导入与编辑共用的最终分类收敛。 |
| `images/image-time.ts` | 图片展示时间专用解析与 UUIDv7 生成：用原生 Temporal 处理带偏移 ISO 8601、按 `TZ` 严格解析无偏移本地时间并拒绝夏令时歧义；JSONL 可把临时清单位置映射到 `rand_a`。 |
| `images/brightness.ts` | 明暗识别 `detectBrightness()`：缩小图片后用 CIELAB L\* 直方图计算平均值、分位数、亮暗像素比例，并按运行时常量判定 `dark` / `light`。 |
| `images/imports/` | 统一 `import_session` 生命周期：`session.ts` 负责创建 / 预览 / 取消，`materialize.ts` 负责浏览器上传与服务器下载素材化，`prepare.ts` 与 `commit.ts` 分管处理和提交，`progress.ts` 管租约 / 状态 / SSE，`execution.ts` 管动态并发与 active promise，`session-lock.ts` 提供跨进程生命周期锁，`staging.ts` 管暂存对象，`staging-keys.ts` 独立承载 attempt 键名与会话解析，避免存储检查反向加载导入领域；另含 JSONL、微博公开帖子解析、请求摘要、安全抓取和临时文件模块。 |
| `images/batch-delete.ts` | 批量软删除 `batchDeleteImages()`：标记 `status='deleted'` 并从 Redis 随机池移除（不动文件）。 |
| `images/batch-update.ts` | 批量编辑协调：不同图片固定低并发 2、单图 metadata→tags 有序，隔离业务错误并按请求顺序返回结果；批次末统一同步派生缓存与实体计数缓存。 |
| `images/mutation-sync.ts` | 图片写入后的派生状态协调器：合并随机池、公共读缓存、MD5 与精确 lookup 失效；单图调用即时执行，批量编辑按请求收集后执行一次。 |
| `images/cursor.ts` | 游标编解码（稳定分页）。 |
| `images/trash.ts` | 回收站彻底删除：每次最多认领 `trashBatchSize`、SKIP LOCKED、尝试号所有权令牌、单图位置锁、对象删除与位置 CAS；失败可重试，旧执行者不能覆盖新认领。 |
| `images/restore.ts` | 只恢复 `purge_state=idle` 的单图 / 批量数据库状态，并把实际恢复图片增量同步回 Redis 随机池。 |

### tags / themes / authors / users —— 配套领域

| 文件 | 职责 |
| --- | --- |
| `tags/{types,query,service}.ts` | 标签：类型、查询（批量取图标签、`resolveTagTermMap` 别名解析）、增删改。一图多标签（`image_tag` 连接表）。 |
| `themes/{types,query,service}.ts` | 主题：注册表、`resolveThemeTermMap` 别名 / 显示名解析。一图一主题。 |
| `themes/host.ts` | 主机名解析：`specialHost()`、`themeFromHost()`、`enforceThemeHostNavigation`、`isReservedSubdomain()`。 |
| `authors/{types,query,service}.ts` | 作者：注册表、`resolveAuthorTermMap` 别名 / 显示名解析。一图一作者，多一个 `link` 字段，不参与分类键。 |
| `vocab/vocab-cache.ts` | 主题 / 标签 / 作者词表和后台带计数列表的六个独立 Redis 读模型；缓存值携带单实例进程 epoch 与本地 revision，失效失败或进程重启后的遗留值不会重新命中；词表只在实体定义变化时刷新，计数列表用 dirty revision 合并重复失效并在 miss 时按实体类型 `coalesce()` 单飞回源；提供批量失效收集器。 |
| `vocab/mutation-sync.ts` | 标签 / 主题 / 作者共享的 slug 校验、实体 advisory lock、冲突 / 不存在错误和“随机池→词表 / 计数→图片 revision”派生修复顺序。 |
| `users/admin-bootstrap.ts` | advisory lock 保护的首个 super 初始化；基础凭据规则来自 `core/credentials.ts`。 |
| `users/password-{recovery,upgrade}.ts` | 紧急密码恢复与登录成功后的旧参数哈希条件升级。 |
| `users/session-invalidation.ts` · `users/admin-password-command.ts` | Redis 管理会话全量 / 按账号失效和恢复命令参数解析。 |
| `users/preferences.ts` | 按管理员用户名读取 PostgreSQL 偏好、原子合并局部 PATCH，并按 shared 注册表投影已知值；不依赖 Redis。 |
| `users/legacy-preferences-cleanup.ts` | 一次性、失败不阻塞启动地扫描并删除旧管理员偏好 Redis hash，以完成 PostgreSQL 权威存储切换。 |
| `users/service.ts` | 后台管理员查询，以及 image 管理员创建、密码重置和删除。 |

### random/ —— 随机图 API

| 文件 | 职责 |
| --- | --- |
| `random/service.ts` | 编排一次随机：校验→解析主题 / 标签 / 作者别名→定候选轴→取最近已服务列表→Redis 池取→记录已服务 id。 |
| `random/random-cache.ts` | 随机池领域的稳定门面，只重导出 schema、读取、重建和增量同步能力；其他领域不依赖内部 Redis 实现文件。 |
| `random/cache-schema.ts` · `cache-lock.ts` | 带 schema 版本的 generation key / Lua / 数据映射协议，以及带 token 续租和所有权校验的更新 / 重建锁。 |
| `random/cache-rebuild.ts` · `cache-sync.ts` · `cache-read.ts` | 分别负责 PostgreSQL 快照全量重建、图片增量同步和 generation 读取 / 临时筛选集合；不再由单个超大模块混合承担。 |
| `random/cache-consistency.ts` | 原子读取 requested/completed revision 与增量锁，用有界退避抖动等待合法同步完成，并区分陈旧缓存和更新中状态。 |
| `random/rebuild-spool.ts` | 随机池全量重建的受控内存 / NDJSON spool：16 MiB 阈值、格式和大小校验、活动文件及启动遗留清理。 |
| `random/picker.ts` | `resolveCandidateAxes()`（按 UA 推设备）、`pickFromRedisPool()`（按 axis/category 计数加权选集合，tag/author 用 Redis 临时过滤集合，跳过最近项并保留 fallback）。 |
| `random/dedupe.ts` | 短时不重复：`filterSignature()`、`recentlyServedIds()`、`rememberServedId()`（Redis LPUSH + LTRIM + EXPIRE）。 |
| `random/query.ts` | 随机请求参数校验、主题 / 标签 / 作者选择子解析、`img-count` 统计数据。 |

### checks/ —— 后台检查与维护

| 文件 | 职责 |
| --- | --- |
| `checks/service.ts` | 检查领域出口：聚合数据库、随机池、存储后端和文件数量，重导出各检查 / 清理 / 迁移能力。 |
| `checks/redis-inspect.ts` | 后台“检查”页的 Redis 健康、随机代际和图片缓存 revision 键值巡检。 |
| `checks/database-check.ts` | 数据库与随机池一致性检查、回收站候选抽样。 |
| `checks/storage-check.ts` | 存储一致性检查：缺失原图 / 缩略图、孤儿对象、有效 / 失效 `_uploads` 暂存和不可用后端；只有失效暂存作为问题报告。 |
| `checks/storage-cleanup.ts` | 存储清理：只删除已无 PostgreSQL 所有者的 media / thumbs / `_uploads`，保留任意图片或导入会话 UUID 对应对象并回收本地空目录。 |
| `checks/storage-common.ts` | 存储检查共享类型、有效导入会话引用索引、暂存会话 ID 提取 / 分类与 expected media / thumbs 集合计算。 |
| `checks/storage-migrate.ts` | 后端迁移与旧对象路径迁移入口，完成后重建随机池并失效图片读缓存。 |

### jobs/ —— 后台 Worker

| 文件 | 职责 |
| --- | --- |
| `jobs/repository.ts` | `background_job` 数据库仓储：按 created_at 领取、各类型 backlog / oldest wait 统计、运行中清理 rerun、按后端恢复耗尽任务、退避重试、僵尸恢复和历史裁剪；未解决 `move.cleanup` 不随历史过期。 |
| `jobs/handlers.ts` | `thumb.generate` / `move.cleanup` / `import.cleanup` / `trash.purge` / `cache.rebuild` 任务处理器；缩略图生成与 `move.cleanup` 都持有单图位置锁，后者按当前命名空间保留已重新采用的对象，并把已不存在对象视为核验完成；导入清理会先用会话提交锁确认并取消崩溃遗留的过期 `committing`，回收站任务每次只处理一个有界批次。 |
| `jobs/worker.ts` | 先运行到期维护，再并行调度各任务类型的 50 项 / 2 秒公平时间片；记录队列压力指标，并负责启动、停止和优雅 drain。 |

### routes/ —— HTTP 薄层

| 文件 | 端点 |
| --- | --- |
| `routes/public.ts` | `GET /api/images`、`/api/images/:id`、`/api/images/:id/original`、`/api/site-config`、`/api/gallery-facets`、`/media/*`、`/thumbs/*`、`/original/:id` |
| `routes/random.ts` | `GET /random`、`GET /img-count`、`random.<域名>/`、`<theme>.<域名>/random` |
| `routes/auth.ts` | 登录 / 登出 / ALTCHA 挑战 / `/api/admin/auth/me`（登录态、CSRF token、应用版本、安全验证开关、登录背景） |
| `routes/admin-images.ts` | 后台图片增删改查、单请求批量元数据 / 标签编辑、迁移、回收站原图、登录态轻量 `admin-info` |
| `routes/imports.ts` | 统一 `/api/admin/imports/*`：JSONL / 微博 parse、create、PUT file、download materialize、prepare、preview、status、SSE events、commit、cancel |
| `routes/admin-tags.ts` · `admin-themes.ts` · `admin-authors.ts` · `admin-users.ts` | 标签 / 主题 / 作者 / 用户管理 |
| `routes/admin-preferences.ts` | 当前登录管理员的界面偏好读取与局部更新；用户名只取自鉴权会话。 |
| `routes/admin-entity-routes.ts` | 标签 / 主题 / 作者相同 CRUD 路由骨架及精简导入词表入口；删除副作用仍由各领域 service 承担。 |
| `routes/settings.ts` | 读取、保存与重载应用设置 |
| `routes/advanced-config.ts` | super 完整配置读取 / 预检 / 保存，以及配置包导出、导入预检和应用接口 |
| `routes/storage.ts` | 存储后端选项、CRUD、排序、默认后端切换与 `POST /storage/test` 自检 |
| `routes/check.ts` | 数据库、Redis、随机池和存储一致性检查，以及存储清理 / 迁移 |
| `routes/admin-logs.ts` | 超级管理员日志页：读取 `app.log` / 轮转日志尾部内容、实时修改 `log.level`；已登录管理页可把有界客户端错误详情写入应用日志。 |
| `routes/health.ts` | `/livez`、`/readyz` |
| `routes/docs.ts` | `docs.<域名>` 提供文档站（`site.docs_enabled=false` 时该域名返回 404） |
| `routes/spa.ts` | 前端 SPA 静态资源与 fallback |
| `routes/robots.ts` | 按主机区分的 `GET /robots.txt`（主站仅放行首页；资源 / API / 主题子域禁抓；docs 可抓） |

## packages/web —— 前端

| 区域 | 关键文件 |
| --- | --- |
| 入口 / 路由 | `main.tsx`、`AppRoutes.tsx` |
| 公共页 | `pages/home/`（首页与专属预览进度）、`pages/gallery/`（画廊、懒加载图片和瀑布流布局；含设备 / 亮度 / 主题 / 标签 / 作者 / 排序筛选） |
| 后台 | `pages/admin/AdminShell.tsx` 及同目录 Overview / ImageAdmin（列表编排）/ `AdminImageCard` / `useImageAdminOperations` / Uploader（共享 URL 列表、JSONL 清单、微博链接三标签输入窗口与 prepared import 队列）/ EntityAdmin / SettingsPage / AdvancedConfigPage（`advanced-config/` 内含完整 JSON 编辑器和配置包导入模态窗口）/ StorageSettings / UserAdmin / AccountSettings / CheckPage / LogPage / `BatchMetadataModal` / `BatchMetadataSaveSummary` / `useBatchMetadataOperations` / `ImageEditModal` |
| 组件 | `components/actions` / `data-display` / `feedback` / `form` / `icon` / `image` / `layout` / `navigation` 下的跨页面 UI 组件；`actions/AsyncActionButton.tsx` 用重叠文案稳定异步按钮宽度，`feedback/ActionFeedback.tsx` 只管理单条消息展示与关闭生命周期，`ActionFeedbackRegion.tsx` 管理显式宿主注册、目标路由和缺失区域降级，`layout/WorkspaceHeader.tsx` 提供稳定页头。 |
| hooks | `hooks/` 下存放跨页面复用的交互 Hook，例如锚定菜单、动画关闭、滚动锁定；`useAsyncActionStatus.ts` 管理按钮的最短进行态，并按操作边界选择三秒结果态或自然结果，`useAdminPreferences.tsx` 提供 PostgreSQL / 用户级 `localStorage` 界面偏好同步。 |
| lib | 无界面代码，按 `api` / `auth` / `gallery` / `ui` / `upload` 分类；`api/client.ts` 统一解析 JSON / 非 JSON 错误、details 与 401 失效事件，`api/query-keys.ts` 集中查询 key，页面专属状态机留在对应页面目录。 |
| styles | `styles/` 下存放全局样式入口，按 base / home / gallery / admin / responsive 拆分；后台图片组件和对应移动端规则集中在 `styles/admin/images.css`，不再跨多个 responsive 文件重复覆盖。 |
| 导入队列 | `pages/admin/uploader/`（统一 ImportJob 队列；`materialization-pipeline.ts` 为 upload / download 提供每 lane 单项前瞻调度，最终 MD5 只由服务端 prepared 阶段计算） |

按钮绑定反馈由所在组件持有；只有按钮持续可见、结果未被页面状态自然表达且适合原位
重试时才保留完整四态。没有唯一按钮承载点的页面反馈由功能父组件持有，二者
都不进入全局消息总线。页面和卡片通过实例安全的目标对象注册区域，展示层只把消息 portal 到指定
宿主；宿主尚未挂载或已经卸载时，统一降级到视口右上角。区域生命周期完全由
React 驱动，不扫描页面选择器、不测量空白，也不注册全局 DOM 观察器或滚动监听。
通用 `WorkspaceHeader` 用明确的 Grid area 分隔标题、反馈、说明和操作组；
图片工具栏与高级配置头部按各自已知空白单独声明网格，反馈出现或消失不改变原布局。
管理页通过 `lib/ui/error-reporting.ts` 上报原始页面异常，服务端日志路由补充操作者、页面
路径和客户端信息后写入应用错误日志；展示组件只使用短中文错误文案。

## packages/docs —— 文档站

VitePress 站点。`.vitepress/config.mts` 定义导航与侧边栏；`guide/` 下为各篇文档；构建产物经根目录 `scripts/build/copy-server-assets.mjs` 拷入服务端，由 `routes/docs.ts` 在 `docs.<域名>` 提供。Web 图标映射由 `scripts/build/generate-web-icons.mjs` 生成。
