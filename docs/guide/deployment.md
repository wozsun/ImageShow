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
  -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD="${ADMIN_PASSWORD:?}" \
  -e DATABASE_HOST=db.example.internal -e DATABASE_NAME=imageshow \
  -e DATABASE_USER=imageshow -e DATABASE_PASSWORD="${DATABASE_PASSWORD:?}" \
  -e REDIS_HOST=redis.example.internal \
  -v /srv/imageshow/data:/app/data \
  wozsun/imageshow:latest
```

应用只需挂载 `/app/data`，其中保存 `config.json`、本地存储对象和日志。PostgreSQL、
Redis 凭据只来自显式环境变量，不写入 `config.json`。`ADMIN_USERNAME` /
`ADMIN_PASSWORD` 仅在数据库没有 super 管理员时创建首个账号。

仓库 `.env.example` 是变量目录，`.env` 为 Compose 提供插值。默认 Compose 逐项映射最小
白名单：ImageShow 收到数据库名、用户名、密码和首次管理员用户名、密码，PostgreSQL 收到
对应的三个 `POSTGRES_*`。数据库名、数据库用户名和管理员用户名保留默认值；`DATABASE_PASSWORD`
与 `ADMIN_PASSWORD` 没有默认值，必须在 `.env` 或宿主环境中显式设置，缺失或空值会
在 Compose 展开阶段直接失败。需要额外 RuntimeConfig 首次 seed 时，先按
[配置说明](./configuration.md#环境变量)逐项扩展 ImageShow 的 `environment` 映射。

应用容器的停止宽限必须至少为 50 秒。进程先停止接收请求，再协调 Worker、在途 HTTP、
存储 driver 和数据库连接池；不要用短于该边界的外层编排超时提前强杀。

### 单机资源与默认准入

现行默认值面向一台 `2C / 4 GiB` 主机上的单个 ImageShow 应用容器，并与 PostgreSQL、Redis
和反向代理共享资源；约 `2 GiB` swap 只承担突发故障缓冲，不作为稳定吞吐所需内存。这是默认
调优目标，不是通用最低配置。各资源边界的默认值如下：

| 阶段 | 默认准入 | 边界 |
| --- | --- | --- |
| 浏览器 Upload | `upload.browser_concurrency = 2` | 每个活动页面的预览、短凭据与 raw PUT 窗口。 |
| Server raw PUT | `upload.raw_concurrency = 5` | 所有页面和直接 API 共享。 |
| 图片处理、Prepared 发布与 Import 后继窗口 | `normalize.concurrency = 2` | 全部 Sharp 重工作共享；Upload / Import 合计最多有 2 项处于 prepare 或 `_uploads` 发布，Import 另最多预取一批 raw，每图 Sharp 线程固定为 `1`。 |
| 最终入库 | `ingestion.commit_concurrency = 8` | 同时受代码内 `256 MiB` prepared 字节预算约束；Worker 派生 12 个 dispatch slot。 |
| 存储迁移 | 固定 `5` 张图片 | 所选图片、整后端和主题重分配共享同一 Server 准入。 |
| 存储清理 | 固定 `1` 个活动调用 | 业务清理与永久删除生产者共用 provider 中性 `removeObjects(1…N)`。 |

公开配置项可在合法范围内按更强单机实测结果调整；表中各数字分别保护对应资源，不能相乘为一个
总并发值。应用不设置网络带宽上限，远程图片下载与同机 / 内网 S3 的吞吐由后继窗口、存储端
能力和部署网络共同约束。

## PostgreSQL 与 Redis

`schema.sql` 完整定义当前干净安装的单一基线；当前 `schema-additions.sql` 是纯注释占位，
并为以后一个发布周期内经明确审查的受限增量或一次性数据变化保留固定入口。空数据库依次
执行两者，非空数据库只执行 additions 后做只读 readiness；整个过程受同一事务保护。
单应用进程合同不为第二个重叠启动者取得 bootstrap lock；首次启动、停止后的顺序重启、
已有数据启动，以及事务回滚后的顺序恢复仍使用同一初始化路径。
`metadata.created_by TEXT NOT NULL` 与后台任务当前类型约束直接属于基线。应用的自动结构职责
限定为干净初始化、单周期 additions 和最小 readiness；破坏性 DDL 与数据整理由维护者另行执行。
additions 全部受控应用后，下一发布把定义并入基线并恢复注释占位；部署与备份恢复按相邻发布
顺序经过承载 additions 的版本。精确白名单与拒绝条件以
[数据库结构](./database.md#启动与结构契约)为准。

Redis 只保存会话、限流、统一就绪图片投影和可重建派生缓存。连接必须支持 Redis 8
以及 `INCREX`、`ARRING`、`ARLASTITEMS`、`SET ... IFEQ ... KEEPTTL` 与
`DELEX ... IFEQ`；应用会用带 5 秒 TTL 的隔离探针键实际验证成功、条件失败、缺失、
TTL 语义和 ACL 权限。Redis 不是真相源，不能通过清理 PostgreSQL 来修复 Redis 状态，也不
保存不可重建的业务数据。在应用停止时把其专用 Redis DB 替换为空库是安全的冷启动操作，
但会使管理员会话、限流状态和全部派生投影失效；启动后必须等待投影重建并重新登录。
Redis unavailable 时 Ingestion worker 停止领取，孤儿素材周期也跳过 raw 与 `_uploads` 删除；恢复后
重新从稳定 canonical 引用开始，不把断线期间的 Redis 缺失当成对象删除证据。

Redis ACL 还必须允许业务原子脚本使用的 `EVAL` 与 `EVALSHA`。应用在 client 构造时注册
七个高频业务命令（五个写命令与两个只读随机抽样命令），但不执行启动期 `SCRIPT LOAD`：
每条物理连接首次使用时可以发送完整 Lua，随后改用 SHA；Redis 重启、故障转移或脚本缓存
清空产生的 `NOSCRIPT` 由 ioredis 重发脚本恢复。部署方不需要维护脚本 SHA 或 Functions
清单，也不应把一次完整脚本传输误判为未启用缓存。检查页深度扫描的低频动态脚本仍可能
直接使用 `EVAL`。

内置 Compose 直接使用 `redis:8` 的默认启动命令，保留 `/data` volume，并在私有网络内采用
无密码连接。该 volume 提供尽力而为的重启保留；Redis 数据丢失时会话、限流、派生状态和未完全
入库内容允许消失，PostgreSQL 中已正式提交的图片不受影响。外部 Redis 启用认证时传入
`REDIS_PASSWORD`。Redis 的内存限制、淘汰策略和容器硬限制由部署方配置，应用只观测实例资源，
不据此自动改写部署配置。

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
端口只绑定到回环或明确的同机私有网络；不需要通配 DNS 或通配证书。仓库 Compose 固定把 `5518`
映射到 `127.0.0.1`。代理必须覆盖
而不是追加访客传入的 `Host`、`X-Real-IP`、`X-Forwarded-For` 和 `X-Forwarded-Proto`。
应用只使用 `Host`、单值 `X-Forwarded-Proto` 和单值客户端 IP 头，不解析
`X-Forwarded-Host` 或多级 `X-Forwarded-For`。容器化代理可把上游改到同机私有 Docker 网络，
但仍不得让不可信客户端绕过代理直连应用端口。

以下先列出代理产品无关的必要行为：

- TLS 证书覆盖主站与 `static` 资源域，并把 HTTP 重定向到 HTTPS。
- 覆盖上述四个请求头；客户端 IP 必须是单跳、单值地址，不传访客提供的代理链。
- 请求体上限覆盖 200 MiB 单图和 128 MiB JSONL；长时内容接入和存储检查允许至少 300 秒。
- 上传流按部署需要关闭请求缓冲；Ingestion 控制 JSON 和 raw 上传都使用固定短路由，代理不得按
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
反向代理的请求体上限不得低于应用对应配置；默认单图上限为 100 MiB，最高可配置为 200 MiB，
JSONL 使用独立 128 MiB 请求档，因此示例取 256m。Compose 网络内应把上游改为 `imageshow:5518`。

上传流如需边收边传，可在同一 server 中增加：

```nginx
location /api/admin/ingestion/ {
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
