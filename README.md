# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是面向个人服务器的自托管图片画廊、随机图 API 与轻量后台管理服务。项目由
Node.js 26 / Hono、React 19、PostgreSQL、Redis 8 和 Docker 构成。

## 功能

- 公开首页、瀑布流画廊、图片详情与可选无导航嵌入页；长画廊使用有界 DTO / DOM 窗口，
  远页按 keyset cursor 恢复。
- `/random` 随机图 API，以及职责隔离的 `random.*`、`static.*`、`link.*` 子域出口。
- 后台图片上传、URL / JSONL / 微博导入、编辑、分类、回收站、日志与运行状态检查。
- local 与多个 S3 兼容对象存储后端并存；支持单图、批量和整后端迁移。
- PostgreSQL 保存全部业务真值，Redis 只承载会话、限流、统一就绪图片投影与可重建缓存。
- 图片管理员与超级管理员使用集中权限矩阵；高风险接口在服务端独立鉴权。
- 管理员偏好跨端同步，公开页面固定暗色，后台可选亮色、暗色或跟随设备。
- 单应用实例、可信反向代理和容器健康检查组成当前生产边界。

完整行为见[维护文档](docs/README.md)，随机接口见
[随机图 API 指南](docs/guide/random-api.md)。

## 快速开始

仓库根目录的 `compose.yaml` 用于本地体验、开发和干净安装验证，包含 PostgreSQL 与
Redis。Docker 部署不需要宿主机安装 Node.js；只有源码开发时需要 Node.js
`>=26.3.0 <27`。

### 配置

首次启动空数据库前必须设置有效的 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`，否则应用会
拒绝创建初始 super 管理员并退出。生产使用还应修改站点域名和数据库密码；可以先复制
环境变量模板：

```bash
cp .env.example .env
```

关键环境变量：

```ini
SITE_DOMAIN=img.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=                   # 首次创建账号使用，至少 8 位且含字母和数字
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=
REDIS_PASSWORD=                   # 仅外部 Redis 启用认证时填写
```

`ADMIN_*` 只在数据库尚无 super 管理员时使用，不会覆盖已有账号。数据库和 Redis 连接
配置每次启动都从部署环境读取；其他应用配置保存在 `data/config.json`，完整字段见
[`config.example.jsonc`](config.example.jsonc)。

### 启动

```bash
docker compose pull
docker compose up -d
```

Linux bind mount 用户应先确保镜像用户 UID/GID `1000` 可写数据目录：

```bash
sudo install -d -o 1000 -g 1000 data
```

默认应用端口为 `5518`。配置域名后可访问：

- `https://img.example.com/home`
- `https://img.example.com/gallery`
- `https://img.example.com/admin`
- `https://img.example.com/random`

本地数据位于 `./data`，PostgreSQL 和 Redis 使用各自 Docker volume。内置 PostgreSQL
默认不向宿主发布端口；需要直连时使用：

```bash
docker compose exec postgresql sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

## 数据库与升级边界

`schema.sql` 是唯一完整的新安装结构；镜像另带小型累积 `schema-additions.sql`。空数据库
在单事务内依次执行两者，非空数据库只执行克制 additions 后做只读 readiness。additions
只补当前白名单中的行为中性字段和稳定系统种子，不提供编号迁移、通用 schema diff、
删除、重命名、类型改变、推测回填、版本标记或清库。精确契约见
[数据库结构](docs/guide/database.md#启动与结构契约)。

从旧版持续升级且仍保留遗留列 / CHECK 的生产库，在 `v4.8.8` 期间须按
[一次性数据库归一化手册](docs/guide/v4.8-database-normalization.md)备份、停应用并人工执行；
该入口不会被启动流程自动调用，并将在确认生产完成后的紧邻版本删除。

Redis 不是业务真相源，普通升级不要求手工清空。连接必须支持 Redis 8 以及项目使用的
`INCREX`、`ARRING`、`ARLASTITEMS` 命令；应用启动时会实际验证命令与 ACL 权限。

## 生产部署

当前生产拓扑只支持一个 ImageShow 应用实例；Compose 或部署平台必须保证不会并行启动第二个
连接同一数据库的应用进程，应用不实现多实例互斥、接管或跨进程一致性。应用应只监听回环或
私有网络，由可信反向代理终止 HTTPS，并覆盖客户端传入的 `Host` 与 `X-Forwarded-*` 头。
示例按 Nginx 1.30 stable 线编写；2026-08-10 对照
[Nginx 官方下载页](https://nginx.org/en/download.html)核验的 stable 补丁为 1.30.4，
实际部署应跟随 1.30.x 的最新安全补丁。

反向代理请求体上限不得低于应用配置。仓库示例使用 `client_max_body_size 256m`，覆盖
默认 200 MiB 单图上限并留出代理层余量。完整 Docker、健康检查、停机、密码恢复及
Nginx 配置见[生产部署指南](docs/guide/deployment.md)。

## 开发与验证

```bash
npm ci
npm run check
npm run build
npm run knip
npm run verify:release
```

`verify:release` 是完整本地发布门禁，依次覆盖源码契约、生产构建、最终测试和隔离生产
镜像。上传后的 GitHub Actions 只做基础完整性检查、容器构建和发布，不代替本地验收。

常用独立门禁：

- `npm run verify:source`：只读源码、依赖方向和静态契约。
- `npm run verify:build`：生产构建及产物边界。
- `npm run verify:runtime`：最终测试及隔离镜像运行验收。
- `npm run test:final:web`：当前 Web 最终测试。

## 文档索引

- [快速开始](docs/guide/getting-started.md)
- [架构总览](docs/guide/architecture.md)
- [项目结构](docs/guide/project-structure.md)
- [配置说明](docs/guide/configuration.md)
- [数据库结构](docs/guide/database.md)
- [v4.8 一次性数据库归一化](docs/guide/v4.8-database-normalization.md)
- [功能与流程](docs/guide/flows.md)
- [生产部署](docs/guide/deployment.md)
- [存储](docs/guide/storage.md)
- [安全](docs/guide/security.md)

## 许可

见 [LICENSE](LICENSE)。
