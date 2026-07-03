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
| `app-config.ts` | 唯一的配置常量源 `appConfig`（分页 / 缩略图 / 随机去重 / 链接导入超时 / 操作日志重试等）；导出 `Device` / `Brightness` / `ImageExt` 类型、`categoryKey()`、`indexKey()`、`reservedSubdomains`、`adminApiBasePath` 等前后端共用项。 |

## packages/server —— 后端

### 入口与配置

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 应用装配：挂载安全响应头、多主机路由中间件、注册所有路由；启动时依次 `ensureStorage → pingDb → runMigrations → initializeAdmin → pingRedis → startWorker`，并处理 SIGTERM 优雅退出。 |
| `config/env.ts` | 三级运行时配置：环境变量只在首次启动时播种 `config.json`，之后该文件权威、原子写入；DB / Redis / 端口等连接级值固化到 `env`。含热重载。 |
| `config/settings.ts` | 命名存储后端注册表（`storage_backend` 表，含密钥，进程内 TTL 备忘）：`listStorageBackends` / `getStorageBackend(slug)` / `getDefaultStorageBackend` / CRUD / `assertStorageWritable` / `assertStorageUploadable`；定义 `StorageType` 与 `StorageConfig`（`{slug,type,s3,webdav}`）、`missingS3Fields()`、对外脱敏的列表；文件型运行时设置经 `getAppSettings()` / `getSettingsForAdmin()` 读取。 |

### core/ —— 基础设施

| 文件 | 职责 |
| --- | --- |
| `core/db.ts` | PostgreSQL 连接池、`runMigrations()`、`initializeAdmin()`（用环境变量强制同步 super 管理员）、`cleanupEmptyCategories()`。 |
| `core/redis.ts` | 整个缓存层：随机池、画廊筛选项、公共列表缓存、MD5 / 对象查找缓存；`rebuildFolderMap()` 全量重建、`bumpFolder()` 增量刷新单分类，Redis 不可用时降级或排 `cache.rebuild` 任务。 |
| `core/redis-inspect.ts` | 后台“检查”页用的 Redis 健康 / 键值巡检。 |
| `core/http.ts` | HTTP 工具：`ok()` / `fail()` / `routeError()`、`ApiError`、`requireAuth` / `requireCsrf` / `requireSuper`、会话 cookie、登录限流、`clientIp()`。 |
| `core/validation.ts` | 请求体 / 查询参数的 zod schema：`listQuery`（含 `shuffle`）、`metadataInput`、`normalizedCategory()` 等。 |
| `core/term-resolve.ts` · `core/selectors.ts` | 共享解析：`resolveTermMap` / `resolveSlugs`（主题 / 标签 / 作者「别名·显示名 → slug」的统一规则），`splitSelectors`（逗号分隔、`!` 排除选择子拆分，随机 API 与画廊筛选共用）。 |
| `core/captcha.ts` | 登录验证码：生成并存 Redis、渲染带噪点 SVG、一次性校验。 |
| `core/logger.ts` | 站点日志：分级输出到 stdout/stderr，并按大小轮转写入 `data/log/app.log`。 |

### storage/ —— 存储抽象（多后端）

| 文件 | 职责 |
| --- | --- |
| `storage/storage.ts` | 门面：`readObject` / `removeObject` / `moveObject` / `copyObject` / `exists`、`publicImageUrls()`、`ensureStorage()`。 |
| `storage/storage-backend.ts` | `driverFor(config)` 按 `config.type` 返回 Local / S3 / WebDAV 驱动。链接图由图片层的 `is_link` 处理，无独立驱动。 |
| `storage/local-backend.ts` | 本地磁盘后端（`/app/data/storage` 下 objects / thumbs / _uploads / link），含空目录回收 `pruneEmptyDirs()`。 |
| `storage/s3-backend.ts` | S3 / COS 后端：processed image / thumbnail 读写删与服务端复制/移动、`root_path` 前缀。 |
| `storage/webdav-backend.ts` | WebDAV 后端：PROPFIND/MKCOL/PUT/GET/DELETE/MOVE/COPY，HTTP Basic 认证，`base_url + root_path` 前缀。 |
| `storage/image-paths.ts` | 键名规则：`storageObjectKey()`、`thumbnailObjectKey()`、`linkThumbnailKey(device,brightness,theme,id)`，以及集中助手 `thumbnailRef(row)`——link 缩略图按分类分文件夹存在该图自己的存储后端的 `link/` 前缀下。所有清理 / 检查路径都走它，避免孤儿。 |
| `storage/object-keys.ts` | 路径 / 键名映射与防穿越：本地 `safeStoragePath()`、S3 `storageS3ObjectName()` 等，物理布局 `<root_path>/<objects｜thumbs｜_uploads｜link>/<key>`。 |
| `storage/migration.ts` | 单图在任意后端间（local / s3 / webdav）迁移字节（含缩略图），以及整后端批量迁移 `migrateStorageBackend()`。 |
| `storage/stream-buffer.ts` | 流 ↔ Buffer 辅助。 |

### images/ —— 图片领域

| 文件 | 职责 |
| --- | --- |
| `images/service.ts` | 软删除 `deleteImage()`、改元数据 / 换分类 `updateImageMetadata()`（换分类＝移动对象键 + 重排两个分类索引，事务内完成，link 不动字节）、单 / 批量迁移存储。 |
| `images/query.ts` | 画廊列表：游标分页 + Redis 列表缓存 + `withShuffle()`（出口处洗牌，不污染共享缓存）。 |
| `images/serving.ts` | 存储对象、缩略图、link 与后台字节出口；集中处理外部回源代理、原图直连探测和缓存策略。 |
| `images/presenter.ts` | `publicImage()` / `publicImages()` 把 DB 行变成 API 响应、`publicListImage()`（公共列表出口白名单）、`adminImageView()`（后台投影：去 `ext`、已删除图改指鉴权字节端点）、列表缓存键、`cacheImageLookups()`（link 跳过）。 |
| `images/processing.ts` | sharp 封装：探测、缩略图、`transcodeStoredImage()` 与设备识别。 |
| `images/brightness.ts` | 明暗识别 `detectBrightness()`：在 CIELAB L\* 直方图上算感知亮度评分判 dark/light。评分源自 `scripts/classify.py`，按本程序的标注样本重标定（去掉人工复核用的救回规则，准确率 95.3%→97.0%）。 |
| `images/link-import/` | 链接来源适配：限时下载到本地 raw、代理链接 Redis stage 与提交。 |
| `images/prepared-import/` | 本地上传与链接下载共用的 raw 临时文件、标准化、prepared 会话、commit/cancel 生命周期。 |
| `images/batch.ts` | 批量软删除 `batchDeleteImages()`：按分类分组、回填索引空洞、标记 `status='deleted'`（不动文件）。 |
| `images/cursor.ts` | 游标编解码（稳定分页）。 |
| `images/trash.ts` | 回收站：恢复 `restoreDeletedImage()` / `batchRestoreImages()`（纯数据库，不动文件）、彻底清除 `purgeDeletedImages()`（物理删原图 + 缩略图，用 `thumbnailRef` 定位）。 |

### tags / themes / authors / users —— 配套领域

| 文件 | 职责 |
| --- | --- |
| `tags/{types,query,service}.ts` | 标签：类型、查询（批量取图标签、`resolveTagTermMap` 别名解析）、增删改。一图多标签（`image_tag` 连接表）。 |
| `themes/{types,query,service}.ts` | 主题：注册表、`resolveThemeTermMap` 别名 / 显示名解析。一图一主题。 |
| `themes/host.ts` | 主机名解析：`specialHost()`、`themeFromHost()`、`enforceThemeHostNavigation`、`isReservedSubdomain()`。 |
| `authors/{types,query,service}.ts` | 作者：注册表、`resolveAuthorTermMap` 别名 / 显示名解析。一图一作者，多一个 `link` 字段，不参与分类键。 |
| `users/service.ts` | 多管理员：super（唯一，环境变量同步）/ image（UI 创建，仅管图）。 |

### random/ —— 随机图 API

| 文件 | 职责 |
| --- | --- |
| `random/service.ts` | 编排一次随机：校验→解析主题 / 标签 / 作者别名→定候选轴→取最近已服务列表→Redis 池取（失败降级 PostgreSQL）→记录已服务 id。 |
| `random/picker.ts` | `resolveCandidateAxes()`（按 UA 推设备）、`pickFromRedisPool()`（按分类计数加权抽，跳过最近项留 fallback）、`pickFromDatabase()`（带标签或作者筛选时走 SQL）。 |
| `random/dedupe.ts` | 短时不重复：`filterSignature()`、`recentlyServedIds()`、`rememberServedId()`（Redis LPUSH + LTRIM + EXPIRE）。 |
| `random/query.ts` | 随机请求参数校验、主题 / 标签 / 作者选择子解析、`img-count` 统计数据。 |

### jobs/ —— 后台 Worker

| 文件 | 职责 |
| --- | --- |
| `jobs/tasks.ts` | 持久化任务队列（`operation_log`）。按任务类型并发领取（各类型独立并发上限）、指数退避重试、僵尸任务恢复。 |
| `jobs/restore.ts` | 从回收站恢复（重排索引，非 link 才排重生成缩略图）。 |
| `jobs/maintenance.ts` | 维护：为缺失 md5 的旧图按其所在后端回补 `backfillMissingMd5()`。 |

### routes/ —— HTTP 薄层

| 文件 | 端点 |
| --- | --- |
| `routes/public.ts` | `GET /api/images`、`/api/site-config`、`/api/gallery-options`、`/media/*`、`/thumbs/*` |
| `routes/random.ts` | `GET /random`、`GET /img-count`、`<theme>.<域名>/random` |
| `routes/auth.ts` | 登录 / 登出 / `/me`（CSRF token） |
| `routes/admin-images.ts` | 后台图片增删改查、批量、迁移 |
| `routes/uploads.ts` | 创建上传会话 / PUT 原始字节 / prepared preview、SSE 与批量 status、commit、cancel |
| `routes/admin-links.ts` | 链接批量导入 |
| `routes/admin-tags.ts` · `admin-themes.ts` · `admin-authors.ts` · `admin-users.ts` | 标签 / 主题 / 作者 / 用户管理 |
| `routes/settings.ts` | 读取 / 保存设置、`POST /storage/test` 存储自检 |
| `routes/check.ts` | 存储一致性检查 / 清理 / 迁移 |
| `routes/health.ts` | `/livez`、`/readyz`、`/healthcheck` |
| `routes/docs.ts` | `docs.<域名>` 提供文档站（`site.docs_enabled=false` 时该域名返回 404） |
| `routes/spa.ts` | 前端 SPA 静态资源与 fallback |
| `routes/robots.ts` | 按主机区分的 `GET /robots.txt`（主站仅放行首页；资源 / API / 主题子域禁抓；docs 可抓） |

## packages/web —— 前端

| 区域 | 关键文件 |
| --- | --- |
| 入口 / 路由 | `main.tsx`、`AppRoutes.tsx` |
| 公共页 | `pages/HomePage.tsx`（首页随机预览）、`pages/GalleryPage.tsx`（画廊，含设备 / 亮度 / 主题 / 标签 / 作者 / 排序筛选） |
| 后台 | `pages/AdminShell.tsx` 及 `admin/` 下 Overview / ImageAdmin / Uploader（含链接导入模式）/ EntityAdmin（主题、标签、作者共用）/ UserAdmin / SettingsPage / AccountSettings（自助改密，全角色）/ CheckPage / ImageModals |
| 组件 | `components/actions` / `data-display` / `feedback` / `form` / `icon` / `image` / `layout` / `navigation` 下的跨页面 UI 组件。 |
| hooks | `hooks/` 下存放跨页面复用的交互 Hook，例如锚定菜单、动画关闭和滚动锁定。 |
| lib | 无界面代码，按 `api` / `auth` / `gallery` / `ui` / `upload` 分类；页面专属状态机留在对应页面目录。 |
| 导入队列 | `pages/admin/uploader/`（统一 ImportJob 队列；最终 MD5 只由服务端 prepared 阶段计算） |

## packages/docs —— 文档站

VitePress 站点。`.vitepress/config.mts` 定义导航与侧边栏；`guide/` 下为各篇文档；构建产物经 `packages/server/scripts/copy-assets.mjs` 拷入服务端，由 `routes/docs.ts` 在 `docs.<域名>` 提供。
