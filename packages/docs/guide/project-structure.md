# 项目结构

ImageShow 是 npm workspaces 单仓多包项目，四个包随应用一起构建、部署。本页逐文件说明职责。

```
ImageShow/
├── compose.yaml          # 三个服务：postgresql:18 / redis:8 / imageshow
├── Dockerfile            # 多阶段构建：build shared/web/docs → 运行时镜像
├── package.json          # workspaces 根，统一脚本
├── tsconfig.base.json    # 共享 TS 配置
├── .env.example          # 环境变量样例
└── packages/
    ├── shared/   # 前后端共享的常量与类型
    ├── server/   # Hono 后端（业务全部在这）
    ├── web/      # React + Vite 前端（SPA + 后台）
    └── docs/     # VitePress 文档站
```

## packages/shared —— 共享层

| 文件 | 职责 |
| --- | --- |
| `app-config.ts` | 唯一的共享配置常量与纯类型源：`appConfig` 默认值、分页 / 缩略图 / 随机去重 / 链接导入超时 / 操作日志重试等常量；导出 `Device` / `Brightness` / `ImageExt` / `RuntimeConfig` / `AdminSettings` / `SiteSettings`、`reservedSubdomains`、`adminApiBasePath` 等前后端共用项。 |

## packages/server —— 后端

### 入口与配置

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 应用装配：挂载安全响应头、多主机路由中间件、注册所有路由；启动时依次 `ensureStorage → pingDb → runMigrations → initializeAdmin → pingRedis → startWorker`，并处理 SIGTERM 优雅退出。 |
| `config/env.ts` | 三级运行时配置：环境变量只在首次启动时播种 `config.json`，之后该文件权威、原子写入；DB / Redis / 端口等连接级值固化到 `env`。含热重载。 |
| `config/settings.ts` | 命名存储后端注册表（`storage_backend` 表，含密钥，进程内 TTL 备忘）：`listStorageBackends` / `getStorageBackend(slug)` / `getDefaultStorageBackend` / CRUD / `assertStorageWritable` / `assertStorageUploadable`；定义 `StorageConfig`（`{slug,type,s3,webdav}`）、`missingS3Fields()`、对外脱敏的列表；文件型运行时设置经 `getAppSettings()` / `getSettingsForAdmin()` 读取；存储后端或运行时配置变更会清理 driver/client 缓存。 |

### core/ —— 基础设施

| 文件 | 职责 |
| --- | --- |
| `core/db.ts` | PostgreSQL 连接池、`runMigrations()`、`initializeAdmin()`（首次创建 super；仅 `ADMIN_FORCE_SYNC=true` 时强制同步）。 |
| `core/redis-client.ts` | Redis 连接实例与 `pingRedis()`；业务缓存逻辑按领域拆到 `random/`、`images/`、`vocab/`。 |
| `core/redis-inspect.ts` | 后台“检查”页用的 Redis 健康 / 键值巡检。 |
| `core/http.ts` | HTTP 工具：`ok()` / `fail()` / `routeError()`、`ApiError`、`requireAuth` / `requireCsrf` / `requireSuper`、会话 cookie、登录限流、`clientIp()`。 |
| `core/validation.ts` | 请求体 / 查询参数的 zod schema：`listQuery`（含 `shuffle`）、`metadataInput`、导入 / 批量操作输入等。 |
| `core/external-image-fetch.ts` | 外部图片 URL 安全边界：限制 HTTPS、要求域名、验证证书、阻断内网 / metadata 地址、逐跳重定向校验、超时请求与图片内容嗅探，并对外统一安全拒绝提示，供链接导入和 link/original 代理复用。 |
| `core/term-resolve.ts` · `core/selectors.ts` | 共享解析：`resolveTermMap` / `resolveSlugs`（主题 / 标签 / 作者「别名·显示名 → slug」的统一规则），`splitSelectors`（逗号分隔、`!` 排除选择子拆分，随机 API 与画廊筛选共用）。 |
| `core/captcha.ts` | 登录验证码：生成并存 Redis、渲染带噪点 SVG、一次性校验。 |
| `core/logger.ts` | 站点日志：分级输出到 stdout/stderr，并按大小轮转写入 `data/log/app.log`。 |
| `core/log-files.ts` | 后台日志页用的日志文件枚举、尾部读取和 `log.level` 热更新。 |

### storage/ —— 存储抽象（多后端）

| 文件 | 职责 |
| --- | --- |
| `storage/storage.ts` | 门面：`readObject` / `removeObject` / `copyObject` / `exists`、`publicImageUrls()`、`ensureStorage()`。 |
| `storage/storage-backend.ts` | `driverFor(config)` 按配置签名缓存并返回 Local / S3 / WebDAV 驱动，避免热路径反复创建 S3/WebDAV client；链接图由图片层的 `is_link` 处理，无独立驱动。 |
| `storage/local-backend.ts` | 本地磁盘后端（`/app/data/storage` 下 media / thumbs / _uploads / link），含空目录回收 `pruneEmptyDirs()`。 |
| `storage/s3-backend.ts` | S3 / COS 后端：processed image / thumbnail 读写删与服务端复制/移动、`root_path` 前缀。 |
| `storage/webdav-backend.ts` | WebDAV 后端：PROPFIND/MKCOL/PUT/GET/DELETE/COPY，HTTP Basic 认证，XML parser 解析 PROPFIND，`base_url + root_path` 前缀，统一 timeout / 临时错误重试与有界目录遍历。 |
| `storage/image-paths.ts` | 键名规则：`storageObjectKey()`、`thumbnailObjectKey()`、`linkThumbnailKey(device,brightness,theme,id)`，以及集中助手 `thumbnailRef(row)`——link 缩略图按分类分文件夹存在该图自己的存储后端的 `link/` 前缀下。所有清理 / 检查路径都走它，避免孤儿。 |
| `storage/object-keys.ts` | 路径 / 键名映射与防穿越：本地 `safeStoragePath()`、S3 `storageS3ObjectName()` 等，物理布局 `<root_path>/<media｜thumbs｜_uploads｜link>/<key>`。 |
| `storage/migration.ts` | 单图在任意后端间（local / s3 / webdav）迁移字节（含缩略图），以及整后端批量迁移 `migrateStorageBackend()`。 |
| `storage/stream-buffer.ts` | 流 ↔ Buffer 辅助。 |

### images/ —— 图片领域

| 文件 | 职责 |
| --- | --- |
| `images/service.ts` | 软删除 `deleteImage()`、改元数据 / 换分类 `updateImageMetadata()`（换分类＝移动对象键并同步 Redis 随机池，link 只移动缩略图）、单 / 批量迁移存储。 |
| `images/query.ts` | 画廊列表、公开详情与后台概览：公共列表使用轻量卡片投影、游标分页、Redis 列表缓存和 `withShuffle()`（出口处洗牌，不污染共享缓存）；公开详情按 id 缓存；后台概览使用短 TTL 缓存；公共列表、公开详情、facets、后台概览和 MD5 判重在 Redis miss 后做同进程 in-flight 合并。 |
| `images/image-cache.ts` | 图片读缓存：公共列表 generation、公共列表 / 公开详情缓存、后台概览缓存、原图直连探测缓存、对象 / 缩略图反查、MD5 判重缓存、画廊 facets 缓存与统一失效。 |
| `images/serving.ts` | 存储对象、缩略图、link 与后台字节出口；集中处理外部回源代理、原图直连探测及其短 TTL 缓存、缓存策略和缩略图缺失时的乐观读取 / 补建。 |
| `images/presenter.ts` | `publicImage()` / `publicImages()` 把 DB 行变成后台可复用的完整图片视图、`publicImageDetail()`（公开详情补充字段白名单）、`publicImageCard()`（公共列表卡片出口白名单）、`adminImageView()`（后台投影：去 `ext`、已删除图改指鉴权字节端点）、列表缓存键、`cacheImageLookups()`（link 跳过）。 |
| `images/processing.ts` | sharp 封装：图片格式 / 尺寸探测、缩略图、`transcodeStoredImage()`。 |
| `images/classification.ts` | 设备 / 明暗三态分类工具：`auto` 解析、按宽高落设备、导入与编辑共用的最终分类收敛。 |
| `images/brightness.ts` | 明暗识别 `detectBrightness()`：在 CIELAB L\* 直方图上算感知亮度评分判 dark/light。评分源自 `scripts/classify.py`，按本程序的标注样本重标定（去掉人工复核用的救回规则，准确率 95.3%→97.0%）。 |
| `images/imports/` | 统一 `import_session` 生命周期：本地上传、链接下载保存、代理链接的创建、接收文件、URL 抓取、prepare、preview、status/SSE、commit/cancel 与过期清理。 |
| `images/batch.ts` | 批量软删除 `batchDeleteImages()`：标记 `status='deleted'` 并从 Redis 随机池移除（不动文件）。 |
| `images/cursor.ts` | 游标编解码（稳定分页）。 |
| `images/trash.ts` | 回收站：恢复 `restoreDeletedImage()` / `batchRestoreImages()`（纯数据库，不动文件）、彻底清除 `purgeDeletedImages()`（物理删原图 + 缩略图，用 `thumbnailRef` 定位）。 |

### tags / themes / authors / users —— 配套领域

| 文件 | 职责 |
| --- | --- |
| `tags/{types,query,service}.ts` | 标签：类型、查询（批量取图标签、`resolveTagTermMap` 别名解析）、增删改。一图多标签（`image_tag` 连接表）。 |
| `themes/{types,query,service}.ts` | 主题：注册表、`resolveThemeTermMap` 别名 / 显示名解析。一图一主题。 |
| `themes/host.ts` | 主机名解析：`specialHost()`、`themeFromHost()`、`enforceThemeHostNavigation`、`isReservedSubdomain()`。 |
| `authors/{types,query,service}.ts` | 作者：注册表、`resolveAuthorTermMap` 别名 / 显示名解析。一图一作者，多一个 `link` 字段，不参与分类键。 |
| `vocab/vocab-cache.ts` | 主题 / 标签 / 作者词表 Redis 缓存与 gallery facets 联动失效。 |
| `users/service.ts` | 多管理员：super（唯一，环境变量同步）/ image（UI 创建，仅管图）。 |

### random/ —— 随机图 API

| 文件 | 职责 |
| --- | --- |
| `random/service.ts` | 编排一次随机：校验→解析主题 / 标签 / 作者别名→定候选轴→取最近已服务列表→Redis 池取→记录已服务 id。 |
| `random/random-cache.ts` | Redis generation 随机池、axis/category/tag/author 集合、随机池派生的画廊筛选轴、`rebuildRandomPool()` 全量重建、`syncRandomImage(s)` 增量同步；Redis 更新失败时排 `cache.rebuild`。 |
| `random/picker.ts` | `resolveCandidateAxes()`（按 UA 推设备）、`pickFromRedisPool()`（按 axis/category 计数加权选集合，tag/author 用 Redis 临时过滤集合，跳过最近项并保留 fallback）。 |
| `random/dedupe.ts` | 短时不重复：`filterSignature()`、`recentlyServedIds()`、`rememberServedId()`（Redis LPUSH + LTRIM + EXPIRE）。 |
| `random/query.ts` | 随机请求参数校验、主题 / 标签 / 作者选择子解析、`img-count` 统计数据。 |

### jobs/ —— 后台 Worker

| 文件 | 职责 |
| --- | --- |
| `jobs/tasks.ts` | 持久化后台任务队列（`background_job`）。按任务类型并发领取（各类型独立并发上限）、指数退避重试、僵尸任务恢复、过期导入暂存与任务历史清理。 |
| `jobs/restore.ts` | 从回收站恢复，并把图片重新加入 Redis 随机池。 |

### routes/ —— HTTP 薄层

| 文件 | 端点 |
| --- | --- |
| `routes/public.ts` | `GET /api/images`、`/api/images/:id`、`/api/images/:id/original`、`/api/site-config`、`/api/gallery-facets`、`/media/*`、`/thumbs/*`、`/original/:id` |
| `routes/random.ts` | `GET /random`、`GET /img-count`、`<theme>.<域名>/random` |
| `routes/auth.ts` | 登录 / 登出 / `/me`（CSRF token） |
| `routes/admin-images.ts` | 后台图片增删改查、批量、迁移 |
| `routes/imports.ts` | 统一 `/api/admin/imports/*`：create、PUT file、prepare、preview、status、SSE events、commit、cancel |
| `routes/admin-tags.ts` · `admin-themes.ts` · `admin-authors.ts` · `admin-users.ts` | 标签 / 主题 / 作者 / 用户管理 |
| `routes/settings.ts` | 读取 / 保存设置、`POST /storage/test` 存储自检 |
| `routes/check.ts` | 存储一致性检查 / 清理 / 迁移 |
| `routes/admin-logs.ts` | 超级管理员日志页：读取 `app.log` / 轮转日志尾部内容、实时修改 `log.level` |
| `routes/health.ts` | `/livez`、`/readyz` |
| `routes/docs.ts` | `docs.<域名>` 提供文档站（`site.docs_enabled=false` 时该域名返回 404） |
| `routes/spa.ts` | 前端 SPA 静态资源与 fallback |
| `routes/robots.ts` | 按主机区分的 `GET /robots.txt`（主站仅放行首页；资源 / API / 主题子域禁抓；docs 可抓） |

## packages/web —— 前端

| 区域 | 关键文件 |
| --- | --- |
| 入口 / 路由 | `main.tsx`、`AppRoutes.tsx` |
| 公共页 | `pages/HomePage.tsx`（首页随机预览）、`pages/GalleryPage.tsx`（画廊，含设备 / 亮度 / 主题 / 标签 / 作者 / 排序筛选） |
| 后台 | `pages/AdminShell.tsx` 及 `admin/` 下 Overview / ImageAdmin / Uploader（含链接导入模式）/ EntityAdmin（主题、标签、作者共用）/ UserAdmin / SettingsPage / AccountSettings（自助改密，全角色）/ CheckPage / LogPage / ImageModals |
| 组件 | `components/actions` / `data-display` / `feedback` / `form` / `icon` / `image` / `layout` / `navigation` 下的跨页面 UI 组件。 |
| hooks | `hooks/` 下存放跨页面复用的交互 Hook，例如锚定菜单、动画关闭和滚动锁定。 |
| lib | 无界面代码，按 `api` / `auth` / `gallery` / `ui` / `upload` 分类；页面专属状态机留在对应页面目录。 |
| 导入队列 | `pages/admin/uploader/`（统一 ImportJob 队列；最终 MD5 只由服务端 prepared 阶段计算） |

## packages/docs —— 文档站

VitePress 站点。`.vitepress/config.mts` 定义导航与侧边栏；`guide/` 下为各篇文档；构建产物经 `packages/server/scripts/copy-assets.mjs` 拷入服务端，由 `routes/docs.ts` 在 `docs.<域名>` 提供。
