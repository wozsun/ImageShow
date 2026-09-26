# 生产单实例部署与反向代理

本文说明当前生产部署要求。首次安装见[快速开始](guide/getting-started.md)，
配置参数见[配置说明](CONFIG.md)，内部契约见[技术参考](README.md#技术参考)。

## 支持的生产拓扑

运行一个 ImageShow 应用容器，连接 PostgreSQL 18 与 Redis 8；数据库可以独立部署。
应用端口只向回环或私有网络开放，由可信反向代理提供 HTTPS。同一数据库只运行一个应用实例。

使用外部数据库时，可参考：

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

- Compose 部署须在 `.env` 中填写 `DATABASE_PASSWORD`、`ADMIN_PASSWORD` 和实际 `SITE_DOMAIN`。
  初始管理员变量只用于创建账号，不覆盖已有账号。
- `.env.example` 列出可用变量；额外变量须显式加入 Compose 的 `environment`。
  已有 `config.json` 时，运行配置以文件为准，见[环境变量](CONFIG.md#环境变量)。
- 应用停止宽限至少为 **50 秒**，允许请求和后台任务排空。
- 外部 PostgreSQL 的权限与连接要求见[数据库说明](guide/database.md#运行期连接与公开回源)；
  Redis 使用应用专用逻辑库，认证与命令权限见[安全说明](guide/security.md)。

## 持久化目录

默认 Compose 的目录均相对部署目录：

| 宿主目录 | 容器目录 | 内容 |
| --- | --- | --- |
| `./data` | `/app/data` | 配置、本地图片、临时文件和日志 |
| `./postgres` | `/var/lib/postgresql` | PostgreSQL 数据 |
| `./redis` | `/data` | Redis 持久化文件 |

调整挂载位置前，先停止应用和数据库服务，完整复制原有数据并保留恢复副本；不要把空目录
直接挂到已有实例。数据库目录只能在数据库停机时进行文件级复制。

## 日常启停

```bash
docker compose stop imageshow
docker compose up -d imageshow
docker compose logs --tail 100 imageshow
```

配置文件修改后可在后台重新读取；部署环境变量变更需重新创建容器。
启停不会替代数据库结构维护。数据库须满足[当前安装契约](guide/database.md#启动与结构契约)，
非空数据库不自动补表、改列或回填。

## 数据维护与恢复

维护前完成需要保留的上传 / 导入并保存草稿，停止应用，备份 PostgreSQL、Redis、`data/`
和外部正式存储对象。明确操作范围，保留可恢复的镜像与配置。

恢复时确认数据库、配置和对象属于同一备份状态，先在隔离环境核对正常 / 回收站图片数量及
对象内容，再恢复服务。永久删除后的文件不能仅靠恢复数据库找回。存储结构和对象维护见
[存储指南](guide/storage.md)。手工修改存储注册表后应重启应用，浏览器 / CDN 缓存按实际变更处理。

Redis 数据丢失会使登录会话和未完成接入失效，已提交的 PostgreSQL 数据与正式图片不受影响。
确需重置 Redis 时，先停应用并备份，确认可以丢弃这些临时状态，再核对主机与 `REDIS_DB`，
只对应用专用逻辑库执行 `FLUSHDB`；运行中清空或局部删除 key 不受支持。
`data/temp` 由应用管理，不作为任务恢复来源。

不使用 `docker compose down -v` 代替普通停机，也不使用全量 prune 清理部署资源。

## 健康检查与故障定位

```bash
docker compose ps
docker inspect --format '{{.State.Health.Status}} {{.Image}}' imageshow
docker compose logs --tail 100 imageshow
```

`/livez` 表示进程存活，`/readyz` 核对数据库与 Redis 就绪状态。恢复访问以镜像自带的健康检查为准，
随后核查图片数量、图片访问和后台操作。Redis 故障时后台返回 `503 redis_unavailable`，公开只读
请求可有界回源 PostgreSQL；`/random` 的非白名单请求必须完成 Redis 频次计数，计数失败
同样返回 503，白名单请求仍可回源。重连后自动重新校验。

## 三档预生成

既有数据库结构准备、CLI、运行要求与核验步骤见[三档预生成](guide/normalize-preparation.md)。升级至带准备表的版本前须完成其中的手工结构维护；不在应用启动时自动修改既有数据库。预生成期间保留 `full/thumbs`，新目录不开放公共读取。

## 管理员密码恢复

优先在后台账号页修改密码。无法登录时，在交互式终端执行，按提示隐藏输入并确认新密码：

```bash
docker exec -it imageshow imageshow reset-password <username>
```

源码环境使用 `npm run admin:reset-password -- <username>`。改密后其他旧密码会话失效。

## 反向代理与 HTTPS

证书覆盖主站域名，将页面、API 和 `/images` 原样转发到应用。代理覆盖请求来源头，
不要追加访客提供的转发链。最小 Nginx 示例：

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

Compose 网络内可将上游改为 `http://imageshow:5518`。请求体上限须覆盖应用设置；示例支持最高
200 MiB 单图与 128 MiB JSONL。流式上传可为 `/api/admin/ingestion/` 单独设置
`proxy_request_buffering off`，保留同一上游与超时。

配置[本地图片公开 URL](guide/image-resources.md#本地存储公开-url)或
[静态资源公开 URL](CONFIG.md#siteassets_base_url)时，为对应域名配置证书和代理，
同样保留 Host、完整路径及配置的路径前缀；每个代理块都须设置 `proxy_set_header Host $host`。

CDN 保留完整查询参数并遵守应用缓存头，不额外强制缓存或改写正文、安全头。应用负责压缩，
代理保留 `Accept-Encoding` 并透传编码、长度、验证器与缓存响应头，不重复编码。
`index.html` 由应用注入站点配置，不能交给代理直接静态托管。配置变更不会自动刷新 CDN。

外部图片存储需允许无凭据跨域读取，供展映加载图片。外部原图入口 `/images/original/*`
只允许管理员访问，反向代理 / CDN 必须透传会话 Cookie 并遵守 `private, no-cache`，不得强制共享缓存。
调整原图访问策略时，部署方须清理该路径在 CDN / 代理中的既存缓存，同时清理公开详情
`/api/images/*` 的既存表示。应用响应头不能撤回浏览器已缓存或已下载的内容，也不能限制
外部源站自身公开的原图地址；部署时需纳入此边界。
详细缓存规则见[图片资源](guide/image-resources.md)。嵌入与 HSTS 见[安全说明](guide/security.md)。

完整图与缩略图的应用入口校验 Referer，允许空值、本站及子域和 `embed.allowed_origins`。
代理须透传 Referer，图片共享缓存须遵守 `Vary: Referer`；启用策略或收紧白名单后清理对应
既存共享缓存。不支持此 Vary 维度的 CDN 应在边缘执行相同规则或正确区分缓存，应用校验
不能约束直接命中 CDN 或 S3 / COS 的请求。`/random` 保持 `no-store`，不可强制共享缓存，
并依赖代理覆盖的真实 IP 头执行两档限流；不要把所有访客映射到代理 IP 或透传访客伪造的 IP 头。
