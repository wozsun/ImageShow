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
| `browser.ts` | 可安全进入浏览器产物的独立子入口：管理路径、校验长度、slug 规则、保留子域名与管理员界面偏好键和值域。Web 运行时值只从 `@imageshow/shared/browser` 导入，避免带入数据库、Redis 等服务端默认配置。 |

## packages/server —— 后端

### 入口与配置

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 应用装配：挂载安全响应头、多主机路由中间件、注册所有路由；启动时依次 `ensureRuntimeDirectories → pingDb → runMigrations → initializeAdmin → pingRedis → startWorker`，再异步确保随机池存在，并处理 SIGTERM 优雅退出。 |
| `admin-password-cli.ts` | 宿主机/容器管理员密码恢复入口：隐藏读取新密码、更新 PostgreSQL 账号，并尽力清除 Redis 管理会话。 |
| `config/bootstrap-env.ts` | 启动环境边界：解析 `NODE_ENV`、首次管理员凭据和首次生成 `config.json` 所需环境变量；集中导出数据、存储、临时文件和日志目录。环境变量只在配置文件首次生成时播种。 |
| `config/runtime-config.ts` | 完整运行时配置的严格 zod schema、可迁移配置投影、当前配置解析和嵌套 patch 合并。 |
| `config/runtime-config-store.ts` | `data/config.json` 的读取、按 schema 归一化、原子写入、内存快照、热重载与变更监听；配置文件生成后成为运行时配置真相源。 |
| `config/config-package.ts` | `imageshow-config` 版本化配置包的构建、严格解析、敏感存储配置投影、slug 冲突预检和带普通异常补偿的导入编排。 |
| `config/full-config.ts` | 完整运行时配置的危险字段差异、只读预检、共享写锁与精准保存编排。 |
| `config/fields.ts` | 运行时配置字段的 zod 边界值：站点、上传、链接导入、标准化、缩略图、安全、验证码和日志等设置校验。 |
| `config/app-settings.ts` | 设置页可编辑字段的严格嵌套 patch schema、按前端实际用途投影的最小后台设置 DTO、公开站点配置和图片输入 / 缩略图运行时设置；不返回连接配置、完整默认值或纯服务端限流字段，也不负责存储后端注册表。 |

### core/ —— 基础设施

| 文件 | 职责 |
| --- | --- |
| `core/db.ts` | PostgreSQL 连接池、事务与 advisory lock 工具、迁移串行执行，并把启动期 super 初始化交给 users 领域。 |
| `core/listening-port.ts` | 原子记录并校验当前服务进程的实际监听端口，供独立 healthcheck 进程读取，避免待重启配置提前改变探测目标。 |
| `core/password.ts` | Node.js 原生异步 Argon2id 密码派生与 PHC 编解码：当前参数生成、安全范围内的旧参数验证、升级判断和恒定时间比较。 |
| `core/uuid.ts` | Node.js 原生 UUIDv7 封装：生成当前时间 ID，为历史 `image_time` 替换 48 位时间戳，并可显式写入 12 位 `rand_a`。 |
| `core/redis-client.ts` | Redis 8 连接实例与 `pingRedis()`；业务缓存逻辑按领域拆到 `random/`、`images/`、`vocab/`。 |
| `core/redis-pipeline.ts` | 执行 pipeline 并检查每条命令返回的错误，避免只等待 `exec()` 而漏掉部分失败。 |
| `core/redis-inspect.ts` | 后台“检查”页用的 Redis 健康 / 键值巡检。 |
| `core/http.ts` | HTTP 工具：`ok()` / `fail()` / `routeError()`、`ApiError`、`requireAuth` / `requireCsrf` / `requireSuper`、会话 cookie、登录限流、`clientIp()`。 |
| `core/audit-log.ts` | 后台非 GET 写操作审计：记录操作者、角色、路径、状态、耗时、IP，失败时附带响应 code/error。 |
| `core/coalesce.ts` | 进程内 in-flight 合并工具，用于公共列表 / 详情 / facets / 概览 / MD5 等缓存 miss 后避免重复查询。 |
| `core/redis-json.ts` | PostgreSQL 派生 JSON 缓存的类型化 GET / SET EX / 删除 helper；Redis 故障只产生 cache miss。 |
| `core/http-validator.ts` | 静态资源与图片字节出口共用的 ETag 强弱比较、条件请求、If-Range 和 HTTP 日期语义。 |
| `core/concurrency.ts` | 简单有界并发遍历工具，用于存储检查 / 清理等批量操作。 |
| `core/validation.ts` | 请求体 / 查询参数的 zod schema：`listQuery`（含 `shuffle`）、`metadataInput`、导入 / 批量操作输入等。 |
| `core/external-image-fetch.ts` | 外部图片 URL 安全边界：限制 HTTPS、要求域名、验证证书、用连接级受控 DNS lookup 阻断 rebinding 与内网 / metadata 地址、逐跳重定向校验、超时请求与图片内容嗅探，并对外统一安全拒绝提示，供链接导入和 link/original 代理复用。 |
| `core/term-resolve.ts` · `core/selectors.ts` | 共享解析：`resolveTermMap` / `resolveSlugs`（主题 / 标签 / 作者「别名·显示名 → slug」的统一规则），`splitSelectors`（逗号分隔、`!` 排除选择子拆分，随机 API 与画廊筛选共用）。 |
| `core/captcha.ts` | 登录验证码：生成并存 Redis、渲染带噪点 SVG、一次性校验。 |
| `core/logger.ts` | 站点日志：分级输出到 stdout/stderr，并按大小轮转写入 `data/log/app.log`。 |
| `core/log-files.ts` | 后台日志页用的日志文件枚举、尾部读取和 `log.level` 热更新。 |

### storage/ —— 存储抽象（多后端）

| 文件 | 职责 |
| --- | --- |
| `storage/storage.ts` | 门面：`openObject` / `removeObject` / `copyObject` / `exists`、`publicImageUrls()`、`testStorageBackend()`、`ensureRuntimeDirectories()`。 |
| `storage/backend-config.ts` | S3 / WebDAV 配置 schema、`StorageConfig` / 输入类型、默认值和完整性校验。 |
| `storage/backend-registry.ts` | `storage_backend` 数据库注册表、默认后端、CRUD、排序、启停、脱敏后台 DTO 与进程内 TTL 缓存；变更时同步失效 driver cache，并通知公共图片 URL 读缓存失效。 |
| `storage/maintenance-lock.ts` | 存储变更共享锁与维护独占锁，避免导入、重分类、迁移和全盘清理互相删除对象。 |
| `storage/storage-backend.ts` | `driverFor(config)` 按配置签名缓存并返回 Local / S3 / WebDAV 驱动，避免热路径反复创建 S3/WebDAV client；链接图由图片层的 `is_link` 处理，无独立驱动。 |
| `storage/local-backend.ts` | 本地磁盘后端（`/app/data/storage` 下 media / thumbs / _uploads / link），含空目录回收 `pruneEmptyDirs()`。 |
| `storage/s3-backend.ts` | S3 / COS 后端：processed image / thumbnail 读写删与服务端复制/移动、`root_path` 前缀。 |
| `storage/webdav-backend.ts` | WebDAV 后端：PROPFIND/MKCOL/PUT/GET/DELETE/COPY，HTTP Basic 认证，XML parser 解析 PROPFIND，`base_url + root_path` 前缀，统一 timeout / 临时错误重试、有界目录遍历，以及服务端忽略 Range 时的流式切片。 |
| `storage/image-paths.ts` | 键名规则：`storageObjectKey()`、`thumbnailObjectKey()`、`linkThumbnailKey(device,brightness,theme,id)`，以及集中助手 `thumbnailRef(row)`——link 缩略图按分类分文件夹存在该图自己的存储后端的 `link/` 前缀下。所有清理 / 检查路径都走它，避免孤儿。 |
| `storage/object-keys.ts` | 路径 / 键名映射与防穿越：本地 `safeStoragePath()`、S3 `storageS3ObjectName()` 等，物理布局 `<root_path>/<media｜thumbs｜_uploads｜link>/<key>`。 |
| `storage/object-validator.ts` | 规范化 S3 / WebDAV 实体标签，并按本地文件版本元数据生成对象 ETag。 |
| `storage/migration.ts` | 单图在任意后端间（local / s3 / webdav）迁移字节（含缩略图），以及整后端批量迁移 `migrateStorageBackend()`。 |
| `storage/stream-buffer.ts` | 流 ↔ Buffer、Node ↔ Web Stream 与有界流式切片辅助。 |

### images/ —— 图片领域

| 文件 | 职责 |
| --- | --- |
| `images/service.ts` | 软删除 `deleteImage()`、改元数据 / 换分类 `updateImageMetadata()`（换分类＝移动对象键并同步 Redis 随机池，link 只移动缩略图）、单 / 批量迁移存储。 |
| `images/read-models/` | 图片读取模型：`public-images.ts`（公共列表 / 详情与 Redis 缓存）、`admin-images.ts`（后台列表 / 详情）、`duplicates.ts`（MD5 判重）、`facets.ts`、`overview.ts`，以及复用的 `pagination.ts`；Redis miss 后按场景做同进程 in-flight 合并。 |
| `images/image-cache.ts` | 图片读缓存：公共列表 generation、公共列表 / 公开详情缓存、后台概览缓存、原图直连探测缓存、Redis 8 `HSETEX` 原子写入且字段 TTL 独立为 6 小时的对象键 / 缩略图键 / 图片 id lookup、MD5 判重缓存，以及公共 generation / facets / 定向 lookup 分层失效；不触发实体缓存刷新。 |
| `images/serving.ts` | 存储对象、缩略图、link 与后台字节出口；集中处理 Content-Length、内容 / 对象版本 ETag、304、单段 Range / If-Range、外部回源代理、原图直连探测及其短 TTL 缓存、缓存策略和缩略图缺失时的乐观读取 / 补建。 |
| `images/original-link.ts` | 原图入口判断工具：计算展示 URL、规范化比较 URL，并只在 `original` 为 HTTPS 且不同于展示图时开放原图按钮 / 跳转。 |
| `images/presenter.ts` | `publicImage()` / `publicImages()` 把 DB 行变成后台可复用的完整图片视图、`publicImageDetail()`（公开详情字段白名单）、`publicImageCard()`（公共列表卡片白名单）、`importCommitImage()`（提交结果仅投影最终 URL）、`adminImageView()`（后台投影：去 `ext`、已删除图改指鉴权字节端点）。缓存键与 lookup 预热归读取 / 缓存模块。 |
| `images/processing.ts` | sharp 封装：图片格式 / 尺寸探测、缩略图、`transcodeStoredImage()`、`generateStoredThumbnail()`，以及运行时 Sharp 并发配置。 |
| `images/classification.ts` | 设备 / 明暗三态分类工具：`auto` 解析、按宽高落设备、导入与编辑共用的最终分类收敛。 |
| `images/image-time.ts` | 图片展示时间专用解析与 UUIDv7 生成：用原生 Temporal 处理带偏移 ISO 8601、按 `TZ` 严格解析无偏移本地时间并拒绝夏令时歧义；JSONL 可把临时清单位置映射到 `rand_a`。 |
| `images/brightness.ts` | 明暗识别 `detectBrightness()`：缩小图片后用 CIELAB L\* 直方图计算平均值、分位数、亮暗像素比例，并按运行时常量判定 `dark` / `light`。 |
| `images/imports/` | 统一 `import_session` 生命周期：`session.ts` 负责创建 / 接收 / 预览 / 取消，`prepare.ts` 与 `commit.ts` 分管处理和提交，`progress.ts` 管租约 / 状态 / SSE，`execution.ts` 统一管理 prepare / commit 动态并发限制与 active promise，`staging.ts` 管暂存对象；另含 JSONL、微博公开帖子解析、请求摘要、安全抓取和临时文件模块。 |
| `images/batch-delete.ts` | 批量软删除 `batchDeleteImages()`：标记 `status='deleted'` 并从 Redis 随机池移除（不动文件）。 |
| `images/batch-update.ts` | 批量编辑协调：不同图片固定低并发 2、单图 metadata→tags 有序，隔离业务错误并按请求顺序返回结果；批次末统一同步派生缓存与实体计数缓存。 |
| `images/mutation-sync.ts` | 图片写入后的派生状态协调器：合并随机池、公共读缓存、MD5 与精确 lookup 失效；单图调用即时执行，批量编辑按请求收集后执行一次。 |
| `images/cursor.ts` | 游标编解码（稳定分页）。 |
| `images/trash.ts` | 回收站编排：单图 / 批量恢复后统一失效 MD5 与图片读缓存；彻底清除时删除本站持有的对象，本地图删除原图和缩略图，link 图只删除本站缩略图。 |
| `images/restore.ts` | 单图 / 批量恢复数据库状态，并把恢复后的图片增量同步回 Redis 随机池。 |

### tags / themes / authors / users —— 配套领域

| 文件 | 职责 |
| --- | --- |
| `tags/{types,query,service}.ts` | 标签：类型、查询（批量取图标签、`resolveTagTermMap` 别名解析）、增删改。一图多标签（`image_tag` 连接表）。 |
| `themes/{types,query,service}.ts` | 主题：注册表、`resolveThemeTermMap` 别名 / 显示名解析。一图一主题。 |
| `themes/host.ts` | 主机名解析：`specialHost()`、`themeFromHost()`、`enforceThemeHostNavigation`、`isReservedSubdomain()`。 |
| `authors/{types,query,service}.ts` | 作者：注册表、`resolveAuthorTermMap` 别名 / 显示名解析。一图一作者，多一个 `link` 字段，不参与分类键。 |
| `vocab/vocab-cache.ts` | 主题 / 标签 / 作者词表和后台带计数列表的六个独立 Redis 读模型；缓存值携带单实例进程 epoch 与本地 revision，失效失败或进程重启后的遗留值不会重新命中；词表只在实体定义变化时刷新，计数列表用 dirty revision 合并重复失效并在 miss 时按实体类型 `coalesce()` 单飞回源；提供批量失效收集器。 |
| `users/admin-bootstrap.ts` · `users/credentials.ts` | advisory lock 保护的首个 super 初始化，以及初始化、后台接口和恢复 CLI 共用的账号规则。 |
| `users/password-{recovery,upgrade}.ts` | 紧急密码恢复与登录成功后的旧参数哈希条件升级。 |
| `users/session-invalidation.ts` · `users/admin-password-command.ts` | Redis 管理会话全量 / 按账号失效和恢复命令参数解析。 |
| `users/preferences.ts` | 按管理员用户名隔离的 Redis 界面偏好读写、已知值过滤与账号删除清理；不写 PostgreSQL。 |
| `users/service.ts` | 后台管理员查询，以及 image 管理员创建、密码重置和删除。 |

### random/ —— 随机图 API

| 文件 | 职责 |
| --- | --- |
| `random/service.ts` | 编排一次随机：校验→解析主题 / 标签 / 作者别名→定候选轴→取最近已服务列表→Redis 池取→记录已服务 id。 |
| `random/random-cache.ts` | Redis generation 随机池、axis/category/tag/author 集合与 `RandomCategoryCounts` 分类计数、随机池派生的画廊筛选轴、单飞全量重建、带 token 续租的增量同步及 Lua 合并读；数据库快照提交后才写 generation，随机池不预热 lookup，Redis 更新不确定时排 `cache.rebuild`。 |
| `random/rebuild-spool.ts` | 随机池全量重建的受控内存 / NDJSON spool：16 MiB 阈值、格式和大小校验、活动文件及启动遗留清理。 |
| `random/picker.ts` | `resolveCandidateAxes()`（按 UA 推设备）、`pickFromRedisPool()`（按 axis/category 计数加权选集合，tag/author 用 Redis 临时过滤集合，跳过最近项并保留 fallback）。 |
| `random/dedupe.ts` | 短时不重复：`filterSignature()`、`recentlyServedIds()`、`rememberServedId()`（Redis LPUSH + LTRIM + EXPIRE）。 |
| `random/query.ts` | 随机请求参数校验、主题 / 标签 / 作者选择子解析、`img-count` 统计数据。 |

### checks/ —— 后台检查与维护

| 文件 | 职责 |
| --- | --- |
| `checks/service.ts` | 检查领域出口：聚合数据库、随机池、存储后端和文件数量，重导出各检查 / 清理 / 迁移能力。 |
| `checks/database-check.ts` | 数据库与随机池一致性检查、回收站候选抽样。 |
| `checks/storage-check.ts` | 存储一致性检查：缺失原图 / 缩略图、孤儿对象、有效 / 失效 `_uploads` 暂存和不可用后端；只有失效暂存作为问题报告。 |
| `checks/storage-cleanup.ts` | 存储清理：删除孤儿 media / thumbs / link 与失效 `_uploads` 对象，保留有效导入会话暂存并回收本地空目录。 |
| `checks/storage-common.ts` | 存储检查共享类型、有效导入会话引用索引、暂存会话 ID 提取 / 分类与 expected thumbs/link 缩略图集合计算。 |
| `checks/storage-migrate.ts` | 后端迁移与旧对象路径迁移入口，完成后重建随机池并失效图片读缓存。 |

### jobs/ —— 后台 Worker

| 文件 | 职责 |
| --- | --- |
| `jobs/repository.ts` | `background_job` 数据库仓储：入队、领取、成功 / 忽略 / 失败状态、退避重试、僵尸任务恢复、导入清理排队和历史裁剪。 |
| `jobs/handlers.ts` | `thumb.generate` / `move.cleanup` / `import.cleanup` / `cache.rebuild` 任务处理器；导入清理会先用会话提交锁确认并取消崩溃遗留的过期 `committing`，handler 只返回统一 outcome，不直接写后台任务状态。 |
| `jobs/worker.ts` | 按任务类型并发轮询、执行 handler、统一落任务状态、定时恢复 / 导入清理 / 历史裁剪，以及启动、停止和优雅 drain。 |

### routes/ —— HTTP 薄层

| 文件 | 端点 |
| --- | --- |
| `routes/public.ts` | `GET /api/images`、`/api/images/:id`、`/api/images/:id/original`、`/api/site-config`、`/api/gallery-facets`、`/media/*`、`/thumbs/*`、`/original/:id` |
| `routes/random.ts` | `GET /random`、`GET /img-count`、`random.<域名>/`、`<theme>.<域名>/random` |
| `routes/auth.ts` | 登录 / 登出 / `/api/admin/auth/me`（登录态、CSRF token、验证码开关、登录背景） |
| `routes/admin-images.ts` | 后台图片增删改查、单请求批量元数据 / 标签编辑、迁移、回收站原图、登录态轻量 `admin-info` |
| `routes/imports.ts` | 统一 `/api/admin/imports/*`：JSONL / 微博 parse、create、PUT file、prepare、preview、status、SSE events、commit、cancel |
| `routes/admin-tags.ts` · `admin-themes.ts` · `admin-authors.ts` · `admin-users.ts` | 标签 / 主题 / 作者 / 用户管理 |
| `routes/admin-preferences.ts` | 当前登录管理员的界面偏好读取与局部更新；用户名只取自鉴权会话。 |
| `routes/admin-entity-routes.ts` | 标签 / 主题 / 作者相同 CRUD 路由骨架及精简导入词表入口；删除副作用仍由各领域 service 承担。 |
| `routes/settings.ts` | 读取、保存与重载应用设置 |
| `routes/advanced-config.ts` | super 完整配置读取 / 预检 / 保存，以及配置包导出、导入预检和应用接口 |
| `routes/storage.ts` | 存储后端选项、CRUD、排序、默认后端切换与 `POST /storage/test` 自检 |
| `routes/check.ts` | 数据库、Redis、随机池和存储一致性检查，以及存储清理 / 迁移 |
| `routes/admin-logs.ts` | 超级管理员日志页：读取 `app.log` / 轮转日志尾部内容、实时修改 `log.level` |
| `routes/health.ts` | `/livez`、`/readyz` |
| `routes/docs.ts` | `docs.<域名>` 提供文档站（`site.docs_enabled=false` 时该域名返回 404） |
| `routes/spa.ts` | 前端 SPA 静态资源与 fallback |
| `routes/robots.ts` | 按主机区分的 `GET /robots.txt`（主站仅放行首页；资源 / API / 主题子域禁抓；docs 可抓） |

## packages/web —— 前端

| 区域 | 关键文件 |
| --- | --- |
| 入口 / 路由 | `main.tsx`、`AppRoutes.tsx` |
| 公共页 | `pages/home/`（首页与专属预览进度）、`pages/gallery/`（画廊、懒加载图片和瀑布流布局；含设备 / 亮度 / 主题 / 标签 / 作者 / 排序筛选） |
| 后台 | `pages/admin/AdminShell.tsx` 及同目录 Overview / ImageAdmin / Uploader（共享 URL 列表、JSONL 清单、微博链接三标签输入窗口与 prepared import 队列）/ EntityAdmin / SettingsPage / AdvancedConfigPage（`advanced-config/` 内含完整 JSON 编辑器和配置包导入模态窗口）/ StorageSettings / UserAdmin / AccountSettings / CheckPage / LogPage / `BatchMetadataModal` / `ImageEditModal` |
| 组件 | `components/actions` / `data-display` / `feedback` / `form` / `icon` / `image` / `layout` / `navigation` 下的跨页面 UI 组件。 |
| hooks | `hooks/` 下存放跨页面复用的交互 Hook，例如锚定菜单、动画关闭、滚动锁定，以及 `useAdminPreferences.tsx` 提供的 Redis / 用户级 `localStorage` 界面偏好同步。 |
| lib | 无界面代码，按 `api` / `auth` / `gallery` / `ui` / `upload` 分类；页面专属状态机留在对应页面目录。 |
| styles | `styles/` 下存放全局样式入口，按 base / home / gallery / admin / responsive 拆分。 |
| 导入队列 | `pages/admin/uploader/`（统一 ImportJob 队列；最终 MD5 只由服务端 prepared 阶段计算） |

## packages/docs —— 文档站

VitePress 站点。`.vitepress/config.mts` 定义导航与侧边栏；`guide/` 下为各篇文档；构建产物经根目录 `scripts/build/copy-server-assets.mjs` 拷入服务端，由 `routes/docs.ts` 在 `docs.<域名>` 提供。Web 图标映射由 `scripts/build/generate-web-icons.mjs` 生成。
