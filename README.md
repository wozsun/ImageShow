# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是面向个人服务器的自托管图片画廊、随机图 API 与轻量后台管理服务。项目由
Node.js 26 / Hono、React 19、PostgreSQL、Redis 8 和 Docker 构成。

## 功能

- 公开首页、瀑布流画廊、图片详情与可选无导航嵌入页；长画廊使用有界 DTO / DOM 窗口，
  远页按 keyset cursor 恢复。
- `/random` 随机图 API，以及职责隔离的 `random.*`、`static.*`、`link.*` 子域出口。
- 后台图片上传、URL / JSONL / 微博导入、编辑、分类、回收站、日志与运行状态检查。
- local 与多个 S3 兼容对象存储后端并存；支持单图、批量和整后端迁移，以及检查页显式
  预览、确认后执行的存储维修与孤儿清理。
- 成功提交的图片以正式缩略图为不变量；正常读取严格只读，缺图显示统一损坏图标并由
  检查页“存储维护”显式修复。
- PostgreSQL 保存全部业务真值，Redis 只承载会话、限流、统一就绪图片投影与可重建缓存。
- 检查页先以固定成本展示图片投影数量、revision 与重建时间，再自动执行一次有界 Redis
  深检，扫描当前 ImageShow 键空间并汇总核心 / 派生占用；手动 Redis 检查复用同一查询。
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

`schema.sql` 是上一个已确认版本的干净安装基线；镜像另带只跨一个发布周期的
`schema-additions.sql`，两者共同组成当前版本的完整空库结构。版本 N 的行为中性字段、必要
索引或稳定系统种子先进入 additions；全部受控非空数据库部署 N 并通过 readiness 后，版本
N+1 把同一定义移入 `schema.sql`，再把 additions 清空为注释占位。该流程不支持跳过 N，恢复
早于 N 的数据库备份时也必须先应用 N 的增量。应用不提供编号迁移、通用 schema diff、删除、
重命名、类型改变、推测回填、版本标记或清库。精确契约见
[数据库结构](docs/guide/database.md#启动与结构契约)。

当前 `v4.9.12` 没有待执行的 additions SQL，文件只保留过渡规则注释；
`metadata.purge_error`、`admin_account.preferences` 与 `theme.none` 已属于 `schema.sql`
基线，并已由全部受控生产数据库在上一版本完成确认。

Redis 不是业务真相源，普通升级不要求手工清空。连接必须支持 Redis 8 以及项目使用的
`INCREX`、`ARRING`、`ARLASTITEMS` 命令；应用启动时会实际验证命令与 ACL 权限。

## 生产部署

当前生产拓扑只支持一个 ImageShow 应用实例；Compose 或部署平台必须保证不会并行启动第二个
连接同一数据库的应用进程，应用不实现多实例互斥、接管或跨进程一致性。应用应只监听回环或
私有网络，由可信反向代理终止 HTTPS，并覆盖客户端传入的 `Host`、`X-Real-IP`、
`X-Forwarded-For` 与 `X-Forwarded-Proto`；应用不解析转发 Host 或多级 IP 链。
产品无关的代理要求与唯一一份可替换的 Nginx 最简示例见[部署指南](docs/guide/deployment.md#反向代理与-https)。

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
镜像。门禁实现和 benchmarks 位于本地、Git 忽略的 `tests/`；上传后的 GitHub Actions
只做基础完整性检查、容器构建和发布，不代替本地验收。

常用独立门禁：

- `npm run verify:source`：只读源码、依赖方向和静态契约。
- `npm run verify:build`：生产构建及产物边界。
- `npm run verify:runtime`：最终测试及隔离镜像运行验收。
- `npm run test:final:web`：当前 Web 最终测试。

## 文档索引

按身份进入：

- [普通用户](docs/guide/roles/ordinary-user.md)
- [图片管理员](docs/guide/roles/image-admin.md)
- [超级管理员](docs/guide/roles/super-admin.md)
- [实例维护者](docs/guide/roles/instance-maintainer.md)

技术参考：

- [架构总览](docs/guide/architecture.md)、[项目结构](docs/guide/project-structure.md)
- [配置说明](docs/guide/configuration.md)、[数据库结构](docs/guide/database.md)、
  [存储](docs/guide/storage.md)、[安全](docs/guide/security.md)
- [功能与流程](docs/guide/flows.md)、[随机图 API](docs/guide/random-api.md)、
  [生产部署](docs/guide/deployment.md)

完整导航见[文档首页](docs/README.md)。

## 许可

见 [LICENSE](LICENSE)。
