# 生产单实例部署与反向代理

本文只说明部署边界、健康检查、停机和反向代理。数据库结构以
[数据库结构](./database.md)为准，运行时配置以[配置说明](./configuration.md)为准，
存储生命周期以[存储](./storage.md)为准。

## 支持的生产拓扑

当前生产边界是一台主机上的一个 ImageShow 应用容器。PostgreSQL 与 Redis 可以来自独立的
基础设施 Compose，但都必须是该应用唯一明确配置的连接目标。升级时先停止当前应用容器，
等待有界排空完成，再原位启动新容器。Server 与内置静态 Web 必须来自同一个镜像，不支持
滚动升级、版本协商或跨版本混用。恢复访问前先确认容器 `healthy` 与 `/readyz`；升级前已
打开的后台标签页应关闭并重新打开。

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

`schema.sql` 直接定义当前干净安装基线；`schema-additions.sql` 保存当前发布周期经明确
审查的受限增量或一次性数据变化。空数据库依次
执行两者，非空数据库只执行 additions 后做只读 readiness；整个过程受同一事务保护。
单应用进程合同不为第二个重叠启动者取得 bootstrap lock；首次启动、停止后的顺序重启、
已有数据启动，以及事务回滚后的顺序恢复仍使用同一初始化路径。
5.0.0 additions 在同一事务中新增、回填并收紧 `metadata.created_by`；旧行精确写为
`wozsun`，最终列为 `TEXT NOT NULL` 且无默认值，重复执行幂等。应用不提供编号迁移、通用
schema diff、版本 ledger、破坏性 DDL 或清库。additions 只承载一个发布周期；全部受控数据库
确认应用后，下一发布才把同一定义并入 `schema.sql`，部署与旧备份恢复不得跳过承载 additions 的发布。精确白名单与拒绝条件以
[数据库结构](./database.md#启动与结构契约)为准。

Redis 只保存会话、限流、统一就绪图片投影和可重建派生缓存。连接必须支持 Redis 8
以及 `INCREX`、`ARRING`、`ARLASTITEMS`、`SET ... IFEQ ... KEEPTTL` 与
`DELEX ... IFEQ`；应用会用带 5 秒 TTL 的隔离探针键实际验证成功、条件失败、缺失、
TTL 语义和 ACL 权限。Redis 不是真相源，不能通过清理 PostgreSQL 来修复 Redis 状态，也不
保存不可重建的业务数据。在应用停止时把其专用 Redis DB 替换为空库是安全的冷启动操作，
但会使管理员会话、限流状态和全部派生投影失效；启动后必须等待投影重建并重新登录。
Redis unavailable 时导入 worker 停止领取，孤儿素材周期也跳过 raw 与 `_uploads` 删除；恢复后
重新从稳定 canonical 引用开始，不把断线期间的 Redis 缺失当成对象删除证据。

Redis ACL 还必须允许业务原子脚本使用的 `EVAL` 与 `EVALSHA`。应用在 client 构造时注册
七个高频业务命令（五个写命令与两个只读随机抽样命令），但不执行启动期 `SCRIPT LOAD`：
每条物理连接首次使用时可以发送完整 Lua，随后改用 SHA；Redis 重启、故障转移或脚本缓存
清空产生的 `NOSCRIPT` 由 ioredis 重发脚本恢复。部署方不需要维护脚本 SHA 或 Functions
清单，也不应把一次完整脚本传输误判为未启用缓存。检查页深度扫描的低频动态脚本仍可能
直接使用 `EVAL`。

内置 Compose 使用 `redis:8`、AOF、私有网络且不设置密码；只有外部 Redis 启用了认证时
才传 `REDIS_PASSWORD`。Redis 的内存限制、淘汰策略和容器硬限制由部署方配置，应用只
观测实例资源，不据此自动改写部署配置。

后台概览在既有 `/overview` 请求中与 PostgreSQL 统计并行，只对固定核心图片投影键执行一组
准确的 `MEMORY USAGE ... SAMPLES 0`，不 `SCAN` ImageShow 键空间，也不读取派生、会话或
限流键；并发概览请求在进程内单飞合并这组测量。当前测量失败不会使概览整体失败：界面明确
显示未知，或把可用的 meta 历史值标为“最近完整重建”，不会冒充当前容量。重建进度轮询不做
内存测量，重建完成后的既有概览刷新才重新测量一次。

检查页轻量状态使用固定命令读取连接、revision、图片数量、最后更新时间、完整重建时间和
最近一次成功完整重建的核心内存快照，不会扫描键空间或执行 `MEMORY USAGE`。检查页先用这份
结果立即渲染，再由唯一查询 owner 在后台自动执行一次 Redis 深检；检测不阻塞轻量状态，
进行中会禁用 Redis 和“全部”两个可能重复扫描的入口。深检以 10 秒总期限、最多 100,000 个
唯一键和每批最多 128 条测量命令扫描 `imageshow:*`，汇总当前核心 / 派生投影的键数、成员数
和内存；完整结果原地更新两张卡，之后手动 Redis 检查继续复用同一查询。超过期限或键上限会
返回 `complete: false` 与明确原因，不得把部分汇总当成总量或覆盖此前完整快照；请求真正断开
时服务端仍通过 `AbortSignal` 停止继续安排扫描或测量批次。界面只把深检的核心键数与内存
填入核心卡；“图片成员”显示值继续使用轻量状态中的 `item_count`，不显示各核心键成员数之和。
派生卡展示深检的键数、结果成员数与内存。`INFO MEMORY` 卡片只描述整个 Redis 实例。

## 4.16.5 → 5.0.0 一次性停机升级

> 【5.0.1 删除升级说明与专项演练】本节只服务已发布 `4.16.5` 到 `5.0.0` 的个人实例
> 单向升级。它不是通用迁移器，也不授权清理其他版本、其他应用或共享 Redis 数据。

5.0.0 把未完成导入从 PostgreSQL 旧 `import_session` 切换为可丢弃的 Redis canonical，
不会迁移、双读或自动删除旧会话。维护前先完成 PostgreSQL 与存储备份，并在部署记录中确认
目标 `REDIS_HOST` / `REDIS_PORT` / `REDIS_DB` 对应的 logical database 只供 ImageShow 使用；
不要打印或记录 Redis 密码。内置 Compose 的 `redis` 服务与默认 DB 0 只属于当前项目；外部
Redis 必须由维护者从基础设施配置证明专用。无法证明专用时不要开始维护窗口。

在旧应用仍运行时，只记录不含密码的实际目标；结果必须与基础设施登记一致：

```bash
docker compose exec -T imageshow sh -lc 'printf "REDIS_HOST=%s\nREDIS_PORT=%s\nREDIS_DB=%s\n" "$REDIS_HOST" "$REDIS_PORT" "$REDIS_DB"'
```

### 1. 在 4.16.5 下停止新增导入并等待排空

关闭所有后台导入页面，阻止其他管理员进入上传 / URL / JSONL / 微博入口，但保持当前
4.16.5 应用运行，让既有任务和旧 `import.cleanup` worker 自然收敛。重复执行下面的只读 SQL；
两个阻塞计数都为 0 才进入下一步，同时记录 `metadata_rows_before`。Compose 内置 PostgreSQL
可直接使用所示命令；外部数据库在自己的受控 `psql` 会话执行同一 SQL。

```bash
docker compose exec -T postgresql sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT count(*) AS legacy_import_session_rows
FROM import_session;

SELECT count(*) AS blocking_import_cleanup_jobs
FROM background_job
WHERE type = 'import.cleanup'
  AND (
    status IN ('pending', 'running')
    OR (status = 'failed' AND next_retry_at IS NOT NULL)
  );

SELECT count(*) AS metadata_rows_before
FROM metadata;
COMMIT;
"
```

不要把已经耗尽重试且 `next_retry_at IS NULL` 的历史 failed 行误当成仍会执行的任务；它不阻塞
升级，也不需要删除。

### 2. 停止且只停止应用，并执行唯一中止检查

```bash
docker compose stop imageshow
```

再次执行上面的完整只读 SQL，排除最后一刻进入的会话或 job。这是升级的唯一中止点：任一
阻塞计数不为 0 时，不执行任何 Redis 命令、不启动 5.0.0，直接运行
`docker compose start imageshow` 恢复原 4.16.5 容器，处理剩余任务后重新安排维护。不要执行
`docker compose down`、`down -v`，不要删除 `data/`，也不要重建 PostgreSQL / Redis volume。

两个阻塞计数均为 0 后，维护进入单向阶段；保持应用停止，后续异常只在 5.0.x 上
fix-forward，不再启动 4.16.5。

### 3. 只清空已确认的 ImageShow logical database

下面三条命令只演示内置 Compose 默认 DB 0；若前面记录的 `REDIS_DB` 不是 0，必须先把三处
`0` 全部替换为那个已确认的精确编号。外部 Redis 使用其受控客户端连接同一个已确认 logical
database，不把凭据写入命令历史。

```bash
docker compose exec -T redis redis-cli -n 0 DBSIZE
docker compose exec -T redis redis-cli -n 0 FLUSHDB
docker compose exec -T redis redis-cli -n 0 DBSIZE
```

`FLUSHDB` 必须返回 `OK`，最后一次 `DBSIZE` 必须返回 `0`。严禁 `FLUSHALL`，严禁对共享或未
确认的 DB 执行清空，也不得删除 PostgreSQL 行、正式 media / thumbs 或存储对象。应用运行期间
单独删除 key 或执行 `FLUSHDB` 不受支持。

### 4. 原位启动 5.0.0 并只允许 fix-forward

生产部署先把 Compose 中的镜像精确切换为 5.0.0，再原位启动一个应用实例；本地源码候选使用
第二条命令。两条命令只能选择其一。

```bash
docker compose up -d imageshow
# 本地源码候选：docker compose up -d --build imageshow
```

首次启动会在同一数据库事务中应用当前 `schema-additions.sql`，为旧图片回填
`metadata.created_by='wozsun'`，设为 `NOT NULL` 并删除默认值。不要并行启动第二个应用。
依次核对：

```bash
docker compose ps
docker inspect --format '{{.State.Health.Status}} {{.Image}}' imageshow
curl --fail --show-error --header 'Host: img.example.com' \
  http://127.0.0.1:5518/readyz
```

随后在还未恢复导入入口时执行：

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT count(*) AS metadata_rows_after,
       count(*) FILTER (WHERE created_by = 'wozsun') AS legacy_actor_rows,
       count(*) FILTER (WHERE created_by IS NULL) AS null_actor_rows
FROM metadata;

SELECT is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'metadata'
  AND column_name = 'created_by';
COMMIT;
```

`metadata_rows_after` 必须等于维护前记录值，`legacy_actor_rows` 必须等于该值，
`null_actor_rows` 必须为 0，列必须返回 `is_nullable='NO'` 与 `column_default IS NULL`。再登录后台
检查页，确认 PostgreSQL、Redis、存储与应用均正常；管理员需要重新登录，旧浏览器导入队列和
其他 Redis 运行态允许消失，随机池与派生索引会冷重建或按既有契约暂时返回 503。

一旦 5.0.0 已首次启动或 additions 已执行，任何失败都不得通过旧镜像或旧数据库备份直接降级。
保留当前 PostgreSQL 和存储，记录无 Secret 的镜像、行数、DB 编号与健康结果，在 5.0.x 上
修复并重新执行受影响检查。恢复旧备份时也必须先用承载当前 additions 的 v5 版本应用增量。

## 健康检查与停机

- `/livez` 只表示进程存活。
- `/readyz` 检查 PostgreSQL、结构契约、Redis 连接和必需命令；容器切换必须以它和
  Docker `healthy` 为准。
- 冷启动首次通过 Redis 能力检查前，业务路由和 Worker 都不开放。
- 运行期 Redis 故障会让 `/readyz` 非就绪；后台返回 `503 redis_unavailable`，公开
  只读路径在工作量上限内回源 PostgreSQL。
- Redis 重连后会由同一活动任务重新验证当前连接、命令能力、PostgreSQL / Redis revision
  和图片投影完整性，再恢复 Redis-first；协调器不维护跨实例 owner 或第二套 epoch。

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

生产环境必须由可信反向代理终止 TLS，证书覆盖主站与配置的 `static` 资源域，并把应用
端口只绑定到回环或明确的同机私有网络；不需要通配 DNS 或通配证书。仓库 Compose 默认把 `5518`
映射到 `127.0.0.1`。代理必须覆盖
而不是追加访客传入的 `Host`、`X-Real-IP`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。
应用只使用 `Host`、单值 `X-Forwarded-Proto` 和单值客户端 IP 头，不解析
`X-Forwarded-Host` 或多级 `X-Forwarded-For`。容器化代理可把上游改到同机私有 Docker 网络，
但仍不得让不可信客户端绕过代理直连应用端口。

以下先列出代理产品无关的必要行为：

- TLS 证书覆盖主站与 `static` 资源域，并把 HTTP 重定向到 HTTPS。
- 覆盖上述四个请求头；客户端 IP 必须是单跳、单值地址，不传访客提供的代理链。
- 请求体上限覆盖 200 MiB 单图和 128 MiB JSONL；长导入和存储检查允许至少 300 秒。
- 上传流按部署需要关闭请求缓冲；导入控制 JSON 和 raw 上传都使用固定短路由，代理不得按
  session 或 metadata 生成 location。
- 不覆盖应用的 `Cache-Control`、`Vary`、CSP 或其他安全响应头，不另设应用响应缓存。

随后只给出一份可替换的 Nginx 最简示例；ImageShow 不检测代理品牌，也不依赖 Nginx。

ImageShow 已负责 ETag、304、Range、压缩、静态预压缩和缓存头。Nginx 不需要再配置
`proxy_cache`，CDN 也应遵循应用返回的 `Cache-Control` 与 `Vary`。

### 最少配置

```nginx
server {
  listen 80;
  server_name img.example.com static.img.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  http2 on;
  server_name img.example.com static.img.example.com;

  ssl_certificate /etc/nginx/cert/fullchain.pem;
  ssl_certificate_key /etc/nginx/cert/privkey.pem;

  # 覆盖 200 MiB 单图上限，并为代理层保留余量。
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

不要使用会拼接访客输入的 `$proxy_add_x_forwarded_for`；可信代理必须把两个来源 IP 头
都覆盖为同一个单值客户端地址。

若 `X-Forwarded-Proto` 缺失或错误，Secure Cookie 和同源校验都会出错。
反向代理的请求体上限不得低于应用对应配置；默认单图上限为 200 MiB，JSONL 使用独立
128 MiB 请求档，因此示例取 256m。Compose 网络内应把上游改为 `imageshow:5518`。

上传流如需边收边传，可在同一 server 中增加：

```nginx
location /api/admin/imports/ {
  proxy_pass http://127.0.0.1:5518;
  proxy_request_buffering off;
  proxy_read_timeout 300s;
}
```

应用不发送 HSTS。只有确认 TLS、证书续期及主站与资源域都由同一部署边界掌握时，才在
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
