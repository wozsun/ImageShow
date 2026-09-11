# 生产单实例部署与反向代理

首次安装见[快速开始](guide/getting-started.md)，配置参数见[配置说明](CONFIG.md)。本文保留部署、升级和恢复所需步骤。

## 支持的生产拓扑

运行一个 ImageShow 应用容器，连接唯一的 PostgreSQL 和 Redis；数据库可独立部署。
Server 与 Web 使用同一镜像，升级时停止旧容器后原位启动新容器，不并行运行两个应用实例。
应用端口只向回环或私有网络开放，由可信反向代理提供 HTTPS。

```bash
docker run -d --name imageshow --restart unless-stopped --stop-timeout 50 \
  -p 127.0.0.1:5518:5518 \
  -e SITE_DOMAIN=img.example.com -e TZ=UTC \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?}" \
  -e DATABASE_HOST=db.example.internal -e DATABASE_NAME=imageshow \
  -e DATABASE_USER=imageshow -e DATABASE_PASSWORD="${DATABASE_PASSWORD:?}" \
  -e REDIS_HOST=redis.example.internal \
  -v /srv/imageshow/data:/app/data \
  wozsun/imageshow:latest
```

- 挂载 `/app/data` 保存配置、本地图片和日志；使用外部 PostgreSQL 与 Redis 时另行持久化。
- 使用 Compose 时在 `.env` 中设置 `DATABASE_PASSWORD`、`ADMIN_PASSWORD` 和实际 `SITE_DOMAIN`。
  首次管理员变量只用于创建账号，已有账号不会被覆盖。
- `.env.example` 是变量目录；额外变量须显式加入 Compose 的 `environment`。
  已有 `config.json` 时，运行配置继续以文件为准，详见[环境变量](CONFIG.md#环境变量)。
- 停止宽限至少为 **50 秒**，允许请求和后台任务排空。
- 默认资源配置面向 `2C / 4 GiB` 单机；并发参数及调整边界见[配置说明](CONFIG.md)。

## PostgreSQL 与 Redis

默认 Compose 的持久化目录均相对部署目录：

| 宿主目录 | 容器目录 | 内容 |
| --- | --- | --- |
| `./data` | `/app/data` | 应用配置、本地图片、临时文件和日志 |
| `./postgres` | `/var/lib/postgresql` | PostgreSQL 数据 |
| `./redis` | `/data` | Redis 持久化文件 |

调整挂载位置前，先停止应用和数据库服务，把原有数据完整复制到对应目录，保留原存储用于
回退；不要将空目录直接挂到已有实例。数据库目录只能在数据库停机时进行文件级复制。

PostgreSQL 是图片和业务数据的持久真相源。空库执行当前完整 `schema.sql` 并检查就绪；
非空库只做只读就绪检查，结构新增、修改、删除及数据整理由维护者在升级前人工处理。
额外表不读取、不要求权限或自动删除，缺失必需结构仍拒绝启动。详见[数据库结构](guide/database.md#启动与结构契约)。

Redis 8 保存会话、接入临时状态和派生缓存，使用应用专用逻辑库。内置 Compose 通过私有网络
无密码连接；外部认证使用 `REDIS_PASSWORD`，内存与淘汰策略由部署方管理。
ACL 须允许当前业务命令以及 `EVAL` / `EVALSHA`，启动会自动核对必需能力，详见[安全说明](guide/security.md)。
Redis 数据丢失会使未完成接入和登录状态失效，已提交的 PostgreSQL 数据与正式图片不受影响。

## 版本升级

1. 阅读目标版本及跨越版本的 [Release 说明](https://github.com/wozsun/ImageShow/releases)，
   完成需要保留的上传 / 导入，关闭旧后台窗口。
2. 停止应用并等待排空，备份 PostgreSQL、Redis、`data/` 与正式存储对象，保留旧镜像用于恢复。
3. 按实际变更人工处理数据库结构和临时运行状态。当前接入临时目录为 `data/temp`；历史临时
   文件由维护者处理，不作为接入任务恢复来源。接受丢弃未完成任务时，可在停机并核对应用
   专用逻辑库后清理 Redis；这也会使登录会话失效，已提交的图片由 PostgreSQL 和正式对象保存。
4. 启动新版本，确认容器 `healthy`、图片数量和访问正常，重新登录并核查新接入。

数据库结构须满足当前就绪检查，清理 Redis 不能替代结构维护。公开页面或 API 变化时清理
受影响的 CDN 缓存；升级失败按备份与旧镜像恢复。

## 健康检查与停机

`/livez` 只表示进程存活，`/readyz` 核对数据库与 Redis 就绪状态。恢复访问以镜像自带的健康检查为准：

```bash
docker inspect --format '{{.State.Health.Status}} {{.Image}}' imageshow
```

Redis 故障时后台返回 `503 redis_unavailable`，公开只读请求可有界回源 PostgreSQL；重连后自动重新校验。
不要用 `docker compose down -v` 代替普通停机或升级。

## 管理员密码恢复

优先在后台账号页修改密码。无法登录时，在交互式终端执行以下命令，按提示隐藏输入并确认新密码：

```bash
docker exec -it imageshow imageshow reset-password <username>
```

源码环境使用 `npm run admin:reset-password -- <username>`。密码以 PostgreSQL 为准，改密后其他旧密码会话失效。

## 反向代理与 HTTPS

证书覆盖主站域名，将页面、API 和 `/images` 原样转发到应用。代理覆盖以下请求头，不追加访客提供的转发链。
最小 Nginx 示例：

```nginx
server {
  listen 80;
  server_name img.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  http2 on;
  server_name img.example.com;

  ssl_certificate /etc/nginx/cert/fullchain.pem;
  ssl_certificate_key /etc/nginx/cert/privkey.pem;
  client_max_body_size 256m;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 300s;
  proxy_send_timeout 300s;

  location / {
    proxy_pass http://127.0.0.1:5518;
  }
}
```

Compose 网络内可把上游换成 `http://imageshow:5518`。请求体上限须覆盖应用配置；示例支持最高
200 MiB 单图与 128 MiB JSONL。需要流式上传时，为 `/api/admin/ingestion/` 单独设置
`proxy_request_buffering off`，保留相同上游和超时。

CDN 保留完整查询参数并遵守应用的 `Cache-Control`、`Vary` 和条件请求；代理不额外强制缓存，
也不覆盖 CSP 等安全响应头。外部图片存储应允许无凭据跨域读取，供展映加载纹理。
原图资源始终公开，访客原图按钮仅控制详情链接显示；缓存边界见[图片资源](guide/image-resources.md)。
启用嵌入页或配置 HSTS 前，按[安全说明](guide/security.md)核对代理策略。

## 本地发布门禁与镜像清理

源码发布前运行 `npm run verify:release`，前提见[测试说明](../scripts/tests/README.md)。
通过后推送 `dev`，等待三仓镜像分发成功，再同步 `main` 和版本标签；Release 复用同提交镜像，
不重新构建。流程和产物边界见[项目结构](guide/project-structure.md)。

只删除已核对、无容器引用且不再用于回滚的精确镜像 ID：

```bash
docker image ls --digests --no-trunc wozsun/imageshow
docker ps -a --no-trunc --filter ancestor=<sha256:image-id>
docker image rm <sha256:image-id>
```

保留当前版本、`latest` 与回滚镜像，不使用全量 prune 或通配清理。
