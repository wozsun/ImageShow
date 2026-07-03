# 架构总览

ImageShow 是一个 npm workspaces 单仓多包项目：自托管图库 + 随机图 API。后端用 Hono（Node），前端用 React + Vite，文档站用 VitePress，三者随应用一起构建、部署。

数据分两层：PostgreSQL 是唯一真相源，Redis 只是可随时丢弃的加速层；图片字节存在可插拔的存储后端（本地磁盘 / S3 兼容对象存储 / WebDAV / 外部链接）。本地上传与链接下载在请求内完成限流、标准化和 prepared 暂存；删除收尾、缩略图补建、迁移清理、缓存重建等持久任务交给后台 Worker 异步处理。

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

所有请求统一附带安全响应头：`Content-Security-Policy: frame-ancestors 'none'`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 等。

## 分层

- `packages/shared`：前后端共享的配置常量（`appConfig`）与类型、`reservedSubdomains`、`adminApiBasePath` 等工具。
- `packages/server`：业务全部在此，按领域分层 —— `core/`（DB / Redis / HTTP / 校验）、`config/`、`storage/`、`images/`、`random/`、`tags/`、`themes/`、`authors/`、`users/`、`checks/`、`jobs/`、`routes/`。`routes/` 只是 HTTP 薄层，真正逻辑在各领域模块。
- `packages/web`：React SPA，含公共页（首页 / 画廊）与后台（图片 / 上传 / 标签 / 主题 / 作者 / 用户 / 设置 / 检查）。
- `packages/docs`：本文档站。

逐文件职责见[项目结构](./project-structure)。

## 数据与缓存

- PostgreSQL 是唯一真相源，承载图片元数据、标签 / 主题 / 作者（含 `image_tag` 关联表）、统一导入会话、后台任务、存储后端注册表与管理员账号，共 9 张业务表（见[数据库结构](./database)）。
- Redis 是加速层：generation 随机池（`random:<generation>:item`、axis/category/tag/author 集合与计数）、画廊筛选项、公共列表缓存、MD5 判重、对象 / 缩略图查找、随机去重历史。正常 `/random` 不依赖 PostgreSQL；Redis 不可用时随机 API 返回 503，其他读路径可按场景降级到 PostgreSQL。
- 存储后端按图片记录的 `storage_slug`（外键 → `storage_backend` 注册表）决定：本地磁盘、S3 兼容对象存储或 WebDAV；外部链接（link，自身不存字节，仅缩略图落于某后端）由 `is_link` 标记。详见[存储](./storage)。

## 后台 Worker

`background_job` 表是一个持久化后台任务队列。Worker 每 5 秒一拍，用 `SELECT … FOR UPDATE SKIP LOCKED` **按任务类型并发**领取（每种类型各自的并发上限，详见[功能与流程](./flows)）、指数退避重试、并能恢复上次进程崩溃时遗留的“僵尸任务”。任务类型包括缩略图生成、删除收尾、恢复收尾、移动清理、上传清理、缓存重建、清空回收站。完整流程见[功能与流程](./flows)。
