# 架构总览

ImageShow 是一个 npm workspaces 单仓多包项目：自托管图库 + 随机图 API。后端用 Hono（Node.js `>=26.3.0 <27`），前端用 React + Vite，文档站用 VitePress，三者随应用一起构建、部署。服务端开发入口由 Node.js 26 直接执行可擦除类型的 TypeScript 源码，生产镜像仍运行 TypeScript 编译后的 JavaScript。

数据分两层：PostgreSQL 是唯一业务真相源，Redis 承载可重建缓存、运行时状态和可丢失的管理员界面偏好；图片字节存在可插拔的存储后端（本地磁盘 / S3 兼容对象存储 / WebDAV / 外部链接）。本地上传与链接下载在请求内完成限流、标准化和 prepared 暂存；缩略图补建、移动清理、上传清理、缓存重建等持久任务交给后台 Worker 异步处理。

## 整体结构

<img src="/architecture.svg" alt="ImageShow 架构图：客户端经反向代理按 Host 分流到 Hono 应用，应用读写 PostgreSQL、Redis 与存储后端，后台 Worker 消费 background_job 队列" style="width:100%;height:auto;max-width:680px;display:block;margin:0 auto" />

## 多主机分流

同一个应用按请求的 `Host` 头切成几个互相隔离的“虚拟站点”（在 `index.ts` 的中间件中完成）。详见[子域名](./subdomains)。

| 主机 | 作用 |
| --- | --- |
| `<域名>`（主站） | SPA 前端 + 后台 + 公共 API |
| `random.<域名>` | 只有随机图 API（`/` 的 GET/HEAD），其余一律 404 |
| `static.<域名>` | 只提供对象字节 `/media/*`、`/thumbs/*`（cookie 隔离，主站从不直接吐字节） |
| `link.<域名>` | 外链资源专用：`/thumbs/*` 取 link 图缩略图，`/media/*` 代理 link 图展示原图，`/original/*` 仅在详情原图 URL 与展示 URL 不同时代理详情字段 |
| `docs.<域名>` | 本文档站（VitePress 构建产物） |
| `<theme>.<域名>` | 该主题作用域的导航；`/random` 等价于 `/random?t=<theme>` |

所有请求统一附带安全响应头：`Content-Security-Policy: frame-ancestors 'none'`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 等。SPA 文档还以 report-only 模式观测 Trusted Types 兼容性，并通过同源 `/api/security/csp-report` 为浏览器 Reporting API / 旧版 CSP 报告提供接收地址。默认接收器直接返回 204，不读取正文、不解析 JSON、也不写日志；以后如需观测，可在应用装配处注入有界的异步接收器。`report-to` 指向 HTTP 端点而非邮箱地址。

## 分层

- `packages/shared`：服务端完整配置常量（`appConfig`）与前后端共享类型；浏览器安全常量、稳定 API DTO 和错误响应结构通过 `@imageshow/shared/browser` 独立子入口提供，避免把数据库、Redis 等运行时默认值打入 Web 产物。
- `packages/server`：业务全部在此，按领域分层 —— `core/`（DB / Redis 客户端 / HTTP 基础设施 / 校验）、`config/`、`storage/`、`images/`、`random/`、`tags/`、`themes/`、`authors/`、`users/`、`checks/`、`jobs/`、`routes/`。`core/` 不反向依赖业务领域，账号初始化、Redis 巡检和对象读取等能力分别由 `users/`、`checks/`、`storage/` 承担；`routes/` 只是 HTTP 薄层，真正逻辑在各领域模块。
- `packages/web`：React SPA，含公共页（首页 / 画廊）与后台（图片 / 上传 / 标签 / 主题 / 作者 / 用户 / 设置 / 存储 / 检查 / 日志）。
- `packages/docs`：本文档站。

逐文件职责见[项目结构](./project-structure)。

## 数据与缓存

- PostgreSQL 是唯一真相源，承载图片元数据、标签 / 主题 / 作者（含 `image_tag` 关联表）、统一导入会话、后台任务、存储后端注册表与管理员账号，共 9 张业务表（见[数据库结构](./database)）。
- Redis 8 承载两套彼此独立的代际协议。随机池使用 `random:<generation>:*` 的 snapshot 与 axis/category/tag/author 集合；全量与增量更新共享 mutation revision，只有 Lua 原子确认 revision 未变化才发布新 generation。图片读缓存使用统一 `image_cache_revision`：公共列表 / 详情、gallery facets、后台概览、MD5 和对象键 / 缩略图键 / 图片 id lookup 都写入取得的 revision，写入前再次校验，任何图片写操作先推进 revision 再做精确清理。若 Redis 暂时无法确认新 revision，本实例的 dirty fence 会让这些读路径直接回源 PostgreSQL 并跳过缓存写入，修复成功后才恢复命中，因此不会重新发布写操作前的旧快照。原图直连探测、后台实体计数、词表、随机去重历史和管理员界面偏好仍按各自 TTL / revision 管理；界面偏好同时缓存到浏览器 `localStorage`，不进入 PostgreSQL。正常 `/random` 不依赖 PostgreSQL；Redis 为空时启动阶段异步重建随机池，Redis 不可用时随机 API 返回 503，其他读路径按场景降级到 PostgreSQL。
- 存储后端按图片记录的 `storage_slug`（外键 → `storage_backend` 注册表）决定：本地磁盘、S3 兼容对象存储或 WebDAV；外部链接（link，自身不存字节，仅缩略图落于某后端）由 `is_link` 标记。注册表同时拥有配置快照、driver 生命周期和统一读写解析入口；图片 serving 只消费已解析的可读对象，不自行拼装第二套后端访问逻辑。详见[存储](./storage)。

分类移动、主题重分配、单图 / 整后端迁移、彻底删除等会改变图片对象位置的操作共用单图 advisory lock。锁内重新读取数据库真值，先复制并回读校验候选对象，再用旧 `storage_slug + object_key` 条件更新翻转引用，最后清理旧对象；失败只清理本次候选。两个 slug 的物理命名空间 identity 相同时先用目标凭据回读校验共享对象，再只切换数据库归属，不复制也不删除。延迟 `move.cleanup` 同样在单图锁内重读当前位置，已被图片重新采用的对象会保留。导入创建、prepared 暂存写入、commit 和暂存清理使用全局共享位置锁；物理位置变更与全盘清理使用独占位置锁。

生产支持边界为单应用实例停机部署。存储后端注册表和 driver 使用进程内 TTL 缓存，管理端在本实例修改后会即时清理；系统没有跨实例 Redis version / generation 失效协议，因此不要用滚动多实例方式同时写配置或存储注册表。

## 后台 Worker

`background_job` 表是一个持久化后台任务队列。Worker 每 5 秒一拍，先执行到期的僵尸恢复、导入清理调度和历史裁剪，再统计所有可运行任务类型并并行处理各自的有界时间片。每种类型单次 tick 最多领取 50 项或运行 2 秒，仍保留各自并发上限与 `SELECT … FOR UPDATE SKIP LOCKED`，因此持续堆积的慢队列不会饿死定时维护或其他任务类型。每个时间片记录 backlog、最老等待时间、处理数、耗时和预算耗尽状态。失败任务使用指数退避；任务类型包括缩略图生成、移动清理、导入清理、回收站分批清理和缓存重建。终态确定性幂等记录可重置后再次入队，执行中与可重试任务仍保持去重。完整流程见[功能与流程](./flows)。
