# 生产单实例部署与反向代理

本文只说明部署边界、健康检查、停机和反向代理。数据库结构以
[数据库结构](./database.md)为准，运行时配置以[配置说明](./configuration.md)为准，
存储生命周期以[存储](./storage.md)为准。

## 支持的生产拓扑

当前生产边界是一台主机上的一个 ImageShow 应用容器。PostgreSQL 与 Redis 可以来自独立的
基础设施 Compose，但都必须是该应用唯一明确配置的连接目标。升级时先停止当前应用容器，
等待有界排空完成，再原位启动新容器。

多应用实例不受支持。Compose 或部署平台必须保证不并行运行连接同一数据库的第二个
ImageShow 进程；应用不检测误部署，也不实现多实例 fencing、接管或零停机切换协议。

示例容器：

```bash
docker run -d --name imageshow --restart unless-stopped --stop-timeout 50 \
  -p 127.0.0.1:5518:5518 \
  -e SITE_DOMAIN=img.example.com -e TZ=UTC \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?set ADMIN_PASSWORD first}" \
  -e DATABASE_HOST=db.example.internal -e DATABASE_NAME=imageshow \
  -e DATABASE_USER=imageshow -e DATABASE_PASSWORD="${DATABASE_PASSWORD:?set DATABASE_PASSWORD first}" \
  -e REDIS_HOST=redis.example.internal \
  -v /srv/imageshow/data:/app/data \
  wozsun/imageshow:latest
```

应用只需挂载 `/app/data`，其中保存 `config.json`、本地存储对象和日志。PostgreSQL、
Redis 凭据只来自环境变量或 Secret，不写入 `config.json`。首次创建 super 管理员后，
`ADMIN_USERNAME` / `ADMIN_PASSWORD` 不再覆盖已有账号。

应用容器的停止宽限必须至少为 50 秒。进程先停止接收请求，再协调 Worker、在途 HTTP、
存储 driver 和数据库连接池；不要用短于该边界的外层编排超时提前强杀。

## PostgreSQL 与 Redis

`schema.sql` 是上一个已确认版本的干净安装基线；只跨一个发布周期的
`schema-additions.sql` 保存当前经审查的行为中性字段、必要索引与稳定系统种子。空数据库依次
执行两者，非空数据库只执行 additions 后做只读 readiness；整个过程受同一启动锁和事务保护。
全部受控数据库确认应用版本 N 的 additions 后，N+1 才能把定义移入 `schema.sql` 并清空
additions。部署不能跳过 N；恢复更早备份时也应先以 N 应用增量。应用不提供编号迁移、通用
schema diff、版本 ledger、破坏性 DDL 或清库；精确白名单与拒绝条件以
[数据库结构](./database.md#启动与结构契约)为准。

当前 `v4.8.12` 的 additions 没有待执行 SQL，只保留注释占位；全部受控生产数据库已经确认
当前 `schema.sql` 形状，镜像不再携带一次性旧结构清理入口。

Redis 只保存会话、限流、统一就绪图片投影和可重建派生缓存。连接必须支持 Redis 8
以及 `INCREX`、`ARRING`、`ARLASTITEMS`；应用会用带 5 秒 TTL 的自有探针键实际验证
命令和 ACL 权限。Redis 不是真相源，不能通过清理 PostgreSQL 来修复 Redis 状态，也不
需要为了普通 ImageShow 升级手工清空 Redis。

内置 Compose 使用 `redis:8`、AOF、私有网络且不设置密码；只有外部 Redis 启用了认证时
才传 `REDIS_PASSWORD`。Redis 的内存限制、淘汰策略和容器硬限制由部署方配置，应用只
观测实例资源，不据此自动改写部署配置。

## 健康检查与停机

- `/livez` 只表示进程存活。
- `/readyz` 检查 PostgreSQL、结构契约、Redis 连接和必需命令；容器切换必须以它和
  Docker `healthy` 为准。
- 冷启动首次通过 Redis 能力检查前，业务路由和 Worker 都不开放。
- 运行期 Redis 故障会让 `/readyz` 非就绪；后台返回 `503 redis_unavailable`，公开
  只读路径在工作量上限内回源 PostgreSQL。
- Redis 重连后会重新验证连接 epoch、命令能力和图片投影完整性，再恢复 Redis-first。

建议直接使用镜像自带的 Docker HEALTHCHECK，不要用 `/livez` 替代就绪门禁：

```bash
docker inspect --format '{{.State.Health.Status}} {{.Image}}' imageshow
```

## 管理员密码恢复

优先在后台账号页修改密码。无法登录时，在交互式终端执行：

```bash
docker exec -it imageshow imageshow reset-password <username>
```

命令隐藏读取并二次确认新密码，不接受明文密码参数。密码先更新 PostgreSQL 真值；Redis
可用时再清理管理员会话。Redis 故障不会回滚已提交的新密码，旧会话会在后续认证时因
密码代际不匹配而失效。源码环境可执行：

```bash
npm run admin:reset-password -- <username>
```

## 反向代理与 HTTPS

生产环境必须由可信反向代理终止 TLS，使用通配证书覆盖主域及子域，并把应用端口只绑定
到回环或私有网络。代理必须覆盖而不是追加访客传入的 `Host`、`X-Real-IP`、
`X-Forwarded-For` 和 `X-Forwarded-Proto`。

以下配置按 Nginx 1.30 stable 线编写；2026-08-10 对照
[Nginx 官方下载页](https://nginx.org/en/download.html)核验的 stable 补丁为 1.30.4。
部署时应跟随 1.30.x 的最新安全补丁，不把这里的核验补丁号当成永久锁定版本。

ImageShow 已负责 ETag、304、Range、压缩、静态预压缩和缓存头。Nginx 不需要再配置
`proxy_cache`，CDN 也应遵循应用返回的 `Cache-Control` 与 `Vary`。

### 最少配置

```nginx
server {
  listen 80;
  server_name img.example.com *.img.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  http2 on;
  server_name img.example.com *.img.example.com;

  ssl_certificate /etc/nginx/cert/fullchain.pem;
  ssl_certificate_key /etc/nginx/cert/privkey.pem;

  # 覆盖 200 MiB 单图上限，并为代理层保留余量。
  client_max_body_size 256m;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;

  location / {
    proxy_pass http://127.0.0.1:5518;
  }
}
```

不要使用会拼接访客输入的 `$proxy_add_x_forwarded_for`。前置 CDN 必须先通过 Nginx
`real_ip` 模块和受信任节点网段恢复 `$remote_addr`，或由 CDN 删除访客同名头后写入
可信来源；传给应用的两个来源 IP 头仍须同时覆盖。

若 `X-Forwarded-Proto` 缺失或错误，Secure Cookie、同源校验和跳转 URL 都会出错。
反向代理的请求体上限不得低于应用对应配置；默认单图上限为 200 MiB，JSONL 使用独立
128 MiB 请求档，因此示例取 256m。Compose 网络内应把上游改为 `imageshow:5518`。

### 长操作配置

需要为导入和存储检查提供更长上游等待时，可在最少配置上增加：

```nginx
location /api/admin/imports/ {
  proxy_pass http://127.0.0.1:5518;
  proxy_request_buffering off;
  proxy_read_timeout 300s;
}

location /api/admin/check/ {
  proxy_pass http://127.0.0.1:5518;
  proxy_read_timeout 300s;
}
```

应用不发送 HSTS。只有确认 TLS、证书续期及全部相关子域都由同一部署边界掌握时，才在
最外层代理或 CDN 配置 HSTS。若启用 `/embed/*`，代理不得重新注入 `X-Frame-Options`
或覆盖应用生成的 CSP `frame-ancestors`；完整安全边界见[安全说明](./security.md)。

## 本地发布门禁与镜像清理

源码发版前必须在本地执行 `npm run verify:release`，并把该次验收的同一不可变 image ID
标记为 `imageshow:local`。之后才推送 `dev`、等待该提交 Action、快进 `main`、创建同名
版本标签并等待 Release Action。上传后的 Actions 只做基础校验、容器构建和发布，不代替
本地类型、Knip、最终测试、数据库、存储或浏览器验收。

清理镜像时只使用已核对且无容器引用的精确 ImageShow image ID：

```bash
docker image ls --digests --no-trunc wozsun/imageshow
docker ps -a --no-trunc --filter ancestor=<sha256:image-id>
docker image rm <sha256:image-id>
```

不要使用 `docker image prune`、仓库通配符或构建缓存全量清理。`latest`、当前版本和仍用于
回滚的标签不得随手删除。
