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

- `packages/shared`：服务端完整配置常量（`appConfig`）与前后端共享类型；浏览器安全常量通过 `@imageshow/shared/browser` 独立子入口提供，避免把数据库、Redis 等运行时默认值打入 Web 产物。
- `packages/server`：业务全部在此，按领域分层 —— `core/`（DB / Redis / HTTP / 校验）、`config/`、`storage/`、`images/`、`random/`、`tags/`、`themes/`、`authors/`、`users/`、`checks/`、`jobs/`、`routes/`。`routes/` 只是 HTTP 薄层，真正逻辑在各领域模块。
- `packages/web`：React SPA，含公共页（首页 / 画廊）与后台（图片 / 上传 / 标签 / 主题 / 作者 / 用户 / 设置 / 存储 / 检查 / 日志）。
- `packages/docs`：本文档站。

逐文件职责见[项目结构](./project-structure)。

## 数据与缓存

- PostgreSQL 是唯一真相源，承载图片元数据、标签 / 主题 / 作者（含 `image_tag` 关联表）、统一导入会话、后台任务、存储后端注册表与管理员账号，共 9 张业务表（见[数据库结构](./database)）。
- Redis 8 承载 generation 随机池（`random:<generation>:item`、snapshot 与 axis/category/tag/author 集合）、画廊筛选项、公共列表 / 详情缓存、后台实体计数列表、导入词表、后台概览短缓存、原图直连探测缓存、MD5 判重、对象键 / 缩略图键 / 图片 id lookup、随机去重历史，以及按管理员用户名隔离的非业务界面偏好。界面偏好同时缓存到该用户浏览器的 `localStorage`；Redis 丢失时可由已使用设备补回，两端都没有时回到默认值，不进入 PostgreSQL。实体词表与带 `image_count` 的后台列表使用独立 key：图片写入只把相关计数列表标为 dirty，实体定义变化才刷新对应词表。generation snapshot 只保留分类计数，主题列表由计数派生并原子发布为画廊筛选项；高频标签筛选使用 axis 与 tag 集合。lookup hash 使用 Redis 8 `HSETEX` 原子写入字段值与独立 6 小时 TTL，并按读请求回填。正常 `/random` 不依赖 PostgreSQL；Redis 为空时启动阶段异步重建随机池，全量与增量更新共享 mutation revision，只有 Lua 原子校验 revision 未变化才切换 generation；Redis 不可用时随机 API 返回 503，其他读路径可按场景降级到 PostgreSQL。
- 存储后端按图片记录的 `storage_slug`（外键 → `storage_backend` 注册表）决定：本地磁盘、S3 兼容对象存储或 WebDAV；外部链接（link，自身不存字节，仅缩略图落于某后端）由 `is_link` 标记。详见[存储](./storage)。

生产支持边界为单应用实例停机部署。存储后端注册表和 driver 使用进程内 TTL 缓存，管理端在本实例修改后会即时清理；系统没有跨实例 Redis version / generation 失效协议，因此不要用滚动多实例方式同时写配置或存储注册表。

## 后台 Worker

`background_job` 表是一个持久化后台任务队列。Worker 每 5 秒一拍，用 `SELECT … FOR UPDATE SKIP LOCKED` **按任务类型并发**领取（每种类型各自的并发上限，详见[功能与流程](./flows)）、指数退避重试、恢复上次进程崩溃时遗留的“僵尸任务”，并按保留策略裁剪任务历史。任务类型包括缩略图生成、移动清理、上传清理和缓存重建。完整流程见[功能与流程](./flows)。
