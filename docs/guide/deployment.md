# 生产单实例部署与反向代理

## 单应用容器 + 基础设施 Compose

当前生产部署固定在一台主机：只运行一个 ImageShow 应用容器，并连接另一套基础设施
Compose 中各一个 PostgreSQL 与 Redis 容器。升级时先停止对应当前容器，更新后原位启动。
应用容器可按下例连接基础设施服务：

```bash
docker run -d --name imageshow --restart unless-stopped -p 5518:5518 \
  -e SITE_DOMAIN=img.example.com -e TZ=UTC \
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?set ADMIN_PASSWORD first}" \
  -e DATABASE_HOST=db.example.internal -e DATABASE_NAME=imageshow \
  -e DATABASE_USER=imageshow -e DATABASE_PASSWORD="${DATABASE_PASSWORD:?set DATABASE_PASSWORD first}" \
  -e REDIS_HOST=redis.example.internal \
  -v /srv/imageshow/data:/app/data \
  wozsun/imageshow:latest
```

应用数据统一落在 `/app/data` 下（`config.json` 应用配置、`storage/` 本地图片、
`log/` 日志），因此只需挂载这一个目录。PostgreSQL / Redis 连接只从容器环境或
Secret 读取，不会写入 `config.json`。
外部 Redis 需要密码时额外传入 `REDIS_PASSWORD`；留空或省略表示使用无密码连接。
服务端以 ioredis 6 连接 Redis 8，不提供旧 Redis 兼容开关；启动时会检查
`INCREX`、`ARRING` 与 `ARLASTITEMS`。内置服务使用不固定次版本的 `redis:8` 主版本
标签并开启 AOF；Compose 不设置
`REDIS_MAXMEMORY` 时使用 `500mb`，淘汰策略固定为 `noeviction`。外部 Redis 同样必须
设置正数 `maxmemory` 和 `noeviction`；应用启动时会拒绝不满足该边界的实例。

从 3.15.2 升级 v4 时，先停止应用，再清空该 ImageShow 实例通过 `REDIS_DB` 指定的逻辑
库，随后启动新版本；登录会话会失效，统一就绪图片投影与派生查询会按 PostgreSQL 真相
源重建。v4 不读取旧随机 generation、图片 revision 缓存，也不使用带 `v2` / `v3` 后缀
的兼容 key。Redis 与其他业务共享时不得执行 `FLUSHALL`，操作前必须核对目标逻辑库只由
当前 ImageShow 实例使用。

## 健康检查与镜像清理

容器健康检查只调用 `/readyz`。该端点检查 PostgreSQL、Redis 连通性及 Redis 必需能力；
数据库迁移在 HTTP 服务开始监听前完成。Redis 临时不可用或能力不满足时，进程仍监听
HTTP，但图片缓存保持降级且 `/readyz` 返回非 2xx；Redis 每次重新连接后必须重新通过
命令、内存策略、revision 与核心完整性检查，才能开放缓存读取。v4 以全新数据库
或已完成 3.15.2 的数据库为升级基线，并新增 `0002_ready_image_revision` 前向迁移；
应用不改写已发布迁移，也不在迁移文件之外猜测旧 schema。任一运行依赖不可用都会返回非 2xx，Docker 随即
把容器标为 unhealthy。`/livez` 只表示进程
仍在运行，适合人工区分“进程退出”和“依赖未就绪”，不作为镜像切换成功的依据。

清理本地镜像必须先确认新容器 healthy，并且只处理 ImageShow 仓库和已经人工确认的
精确 image ID / digest：

```bash
docker inspect --format '{{.State.Health.Status}} {{.Image}}' imageshow
docker image ls --digests --no-trunc wozsun/imageshow
docker image ls --digests --no-trunc ccr.ccs.tencentyun.com/<namespace>/imageshow
docker ps -a --no-trunc --filter ancestor=<sha256:image-id>
docker image rm <sha256:image-id>
```

最后一条只能填写前面核对过、且没有任何容器引用的旧 ImageShow image ID。不要使用
`docker image prune`、仓库名通配符、模糊标签或构建缓存全量清理；这些操作会越过项目
边界。远端仓库中的发布镜像同样先用
`docker buildx imagetools inspect REPOSITORY@SHA256_DIGEST` 核对精确 digest，再在对应
仓库中删除明确废弃的 tag 或 manifest；`latest`、当前版本标签和仍用于回滚的版本不删除。

## 管理员密码恢复

首次安装时，`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在数据库没有 super
管理员时创建首个账号。正常情况下应登录后台修改自己的密码；修改
`.env` 或重启容器不会覆盖数据库中的已有密码。

无法登录后台时，在宿主机执行：

```bash
docker exec -it imageshow imageshow reset-password <username>
```

命令会在交互式终端中隐藏读取并二次确认新密码，不接受明文密码参数。
密码更新只依赖 PostgreSQL；Redis 可用时会清除全部管理员会话，旧密码
立即失效，所有管理员需要重新登录。源码环境可使用：

```bash
npm run admin:reset-password -- <username>
```

命令使用与主服务相同的 `DATABASE_*` / `REDIS_*` 部署环境。Redis 故障
不会阻止密码更新，命令会输出警告；由于旧会话可能在 Redis 恢复后继续
有效，应在 Redis 恢复后清空 `imageshow:session:*`，或使用相同新密码
重新运行密码重置命令。用户不存在、密码不符合规则或 PostgreSQL 更新
失败时会返回非零退出码。

## 反向代理与 HTTPS

生产环境务必在可信反向代理终止 TLS，并**覆盖**而不是透传客户端伪造的转发头。把站点域名与其所有子域名（含 `random` / `static` / `link` / 主题）都转发到应用的 `5518` 端口。

ImageShow 已由 Hono 处理 Redis 数据缓存、HTTP 缓存头、压缩、静态预压缩、ETag、304 和图片 Range；Nginx 无需再配置 `proxy_cache`。如果以后接入 CDN，让 CDN 直接遵循 Hono 返回的 `Cache-Control` 和 `Vary` 即可。

应用不发送 HSTS；只有确认 TLS、证书续期和全部相关子域均由同一 HTTPS 部署边界掌握
时，才在最外层 Nginx/CDN 配置 `Strict-Transport-Security`。不要在无法保证所有子域
HTTPS 的环境中复制 `includeSubDomains`。

### 最少配置

以下示例面向当前 stable Nginx 1.30.3，直接使用其默认 HTTP/1.1 与上游 keepalive。最少配置保留 TLS、HTTP/2、上传大小和必要的转发头；Nginx 使用默认缓冲与超时。

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

  # 覆盖 200 MiB 单图上限，并为代理层保留 56 MiB 余量
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

### 推荐配置

推荐长期使用。它只在最少配置上为上传流、导入处理、SSE 和存储检查调整缓冲或超时，不接管 Hono 的缓存策略。

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
  ssl_protocols TLSv1.2 TLSv1.3;

  # 覆盖 200 MiB 单图上限，并为代理层保留 56 MiB 余量。
  client_max_body_size 256m;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;

  location /api/admin/imports/ {
    proxy_pass http://127.0.0.1:5518;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
  }

  location /api/admin/check/ {
    proxy_pass http://127.0.0.1:5518;
    proxy_read_timeout 300s;
  }

  location / {
    proxy_pass http://127.0.0.1:5518;
  }
}
```

不要把应用 HTTP 端口直接暴露到公网。应用依次读取 Nginx 覆盖后的
`X-Real-IP`、`X-Forwarded-For` 首项，并在两者都缺失时使用 `unknown`；这些头只在
反向代理完整覆盖时可信。示例故意把两个来源头都设置为 `$remote_addr`，不要使用
会把访客自带值拼入链路的 `$proxy_add_x_forwarded_for`。前置 CDN 场景应通过
Nginx `real_ip_header` 与受信任 CDN 节点的 `set_real_ip_from` 恢复真实
`$remote_addr`；也可以使用 CDN 保证删除访客同名头后重新写入的来源 IP 头，但必须
同时覆盖传给应用的 `X-Real-IP` 和 `X-Forwarded-For`。

若 `X-Forwarded-Proto` 缺失或错误，Secure Cookie、同源检查与生成的跳转 URL 都会
不正确。Docker Compose 部署时，把示例中的 `127.0.0.1:5518` 改为 Compose 服务名，
例如 `imageshow:5518`。反向代理的请求体上限不能低于应用内任一对应设置，否则
请求会在到达应用鉴权和校验逻辑前被代理返回 413；修改
`upload.max_file_size_mb` 或其他请求体上限时，应同步调整
`client_max_body_size`。单张输入图片的应用配置上限为 200 MiB，JSONL 使用独立的
128 MiB 请求档；示例取 256m，为代理层保留 56 MiB 余量。导入会话随前端 lane
推进逐项创建，不存在批量会话请求体。

当前生产拓扑固定为一台主机、一个 ImageShow 应用容器；PostgreSQL 与 Redis 在另一
基础设施 Compose 中各运行一个单容器。所有升级都先停止对应容器，再更新当前容器并
启动；短期不实施多实例，未来边界只记录在[多实例待办](./todo-multi-instance.md)。

基础设施侧 Redis 容器应启用 AOF 和自动重启。`maxmemory` 正式默认 `500mb`，本机大图库
实验使用 `2gb`，策略必须为 `noeviction`；Docker 硬内存上限还要为 AOF 缓冲、客户端与
分配器开销留出额外空间。公开组合筛选和统计结果由应用按 LRU、条目数、总成员放大倍数
及单结果大小主动约束；使用量达到 `maxmemory` 的 80% 时先删除最久未访问的一半，再按
需清空全部派生查询结果，画廊核心投影、会话和限流键不参与这条主动淘汰。OOM 写入失败
会执行同一清理并让该次复杂查询回源，Redis 不会自行删除未知键。连接若被终止，应用
立即关闭读门并在 5 秒内结束在途命令；画廊、详情与后台列表回源 PostgreSQL，普通随机
请求返回 503。Redis 恢复后先删除可再生查询结果，再重新校验 revision 与完整性。若核心
投影本身超过 `maxmemory`，必须停机同时提高 Redis 和 Docker 上限。

浏览器同源 PUT 的原始图片先写入容器 `data/tmp`，服务端 prepare 完成后才向选定后端写入候选文件；请求依赖管理员会话 Cookie 与 `X-CSRF-Token`，浏览器不直连对象存储，因此存储桶无需配置 CORS。
