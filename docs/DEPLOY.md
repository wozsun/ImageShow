# 生产单实例部署与反向代理

首次安装见[快速开始](guide/getting-started.md)，配置参数见[配置说明](CONFIG.md)。本文说明当前部署、更新、数据维护和恢复步骤。

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
- 并发须结合当前主机实测与共享数据库总连接容量评估；公共读取准入和连接池上限见
  [数据库说明](guide/database.md#运行期连接与公开回源)，图片处理参数见[配置说明](CONFIG.md)。

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
非空库只做只读就绪检查；结构与数据维护由维护者在停机维护窗口人工处理。
额外表不读取、不要求权限或自动删除，缺失必需结构仍拒绝启动。详见[数据库结构](guide/database.md#启动与结构契约)。

应用连接启用 `client_connection_check_interval=1000`，让取消后关闭的连接在长查询和锁等待中
也能被数据库发现。默认 Linux 容器支持此能力；外部 PostgreSQL 宿主须支持该参数依赖的
内核断连事件，支持范围见 [PostgreSQL TCP 设置](https://www.postgresql.org/docs/18/runtime-config-connection.html#RUNTIME-CONFIG-CONNECTION-TCP)。

Redis 8 保存会话、接入临时状态和派生缓存，使用应用专用逻辑库。内置 Compose 通过私有网络
无密码连接；外部认证使用 `REDIS_PASSWORD`，内存与淘汰策略由部署方管理。
ACL 须允许当前业务命令以及 `EVAL` / `EVALSHA`，启动会自动核对必需能力，详见[安全说明](guide/security.md)。
Redis 数据丢失会使未完成接入和登录状态失效，已提交的 PostgreSQL 数据与正式图片不受影响。

## 更新部署

1. 拉取或构建待部署的应用镜像，核对部署配置与[当前数据库契约](guide/database.md#启动与结构契约)，
   完成需要保留的上传 / 导入，保存未提交草稿，关闭旧后台窗口。
2. 停止应用并等待排空，备份 PostgreSQL、Redis、`data/` 与正式存储对象，保留当前镜像用于恢复。
3. 数据库必须满足当前运行时所需的最小结构；6.4.8 及更早部署须先完成下述 6.4.9 升级，再更新到本版。
4. 使用准备好的镜像原位启动应用，确认容器 `healthy`、图片数量和访问正常，重新打开后台并核查新接入。

公开页面或 API 变化时清理受影响的 CDN 缓存。更新失败时停止应用，按一致的备份与镜像恢复。
变更记录见 [GitHub Releases](https://github.com/wozsun/ImageShow/releases)。

### 6.4.9 数据表示升级

以下为 6.4.9 的历史升级步骤。本版已移除该一次性入口，全新安装可直接使用本版；
6.4.8 及更早部署须先使用 6.4.9 完成升级并核查数量和对象读取，再更新到本版。
升级在停写、无残留上传 / 导入及后台任务的维护窗口执行；不支持新旧实例混跑。
停止旧实例并取得可恢复的 PostgreSQL、Redis、配置及对象备份后，启动 6.4.9 镜像即可自动
删除冗余的 `metadata.object_key` 列及其专属唯一约束，无需开关或人工删列 SQL。
应用账号须有该表的结构修改权限；已升级的数据库只进行最终 readiness。

启动事务最多等待表锁 5 秒，锁内核对全部记录的 UUID、扩展名、旧路径和依赖，只删除已知
旧结构的列与专属约束 / 索引，包括历史部署保留且完整定义匹配的 `idx_metadata_thumb_key`。
异常路径、其他额外依赖、权限不足、锁超时或最终 readiness
失败均回滚并拒绝启动；不搬对象、不改业务值、不使用 CASCADE 或重写表。
升级不保证数据库文件立即变小。其他表、关联和持久清理中的历史物理目标保持原义。

数据库提交后由 ready-cache 现有样本校验和协调器重建切换图片投影，保留登录及其他业务键，
不要求手工清 Redis。即使在数据库提交后、重建前退出，下次启动也从最终数据库恢复；
缓存未就绪时继续使用现有有界回源。旧管理窗口必须重新打开以载入同步更新的 DTO。
升级日志只有事务提交后才报告完成；失败时按启动错误定位，不据缓存状态推断结构升级结果。

回退必须恢复一致备份或先完成另行核验的逆向维护，不能直接启动
仍写旧列的镜像。正式发布不代替部署方的停机、备份和数量 / 对象读取核查。

## 数据维护与恢复

### PostgreSQL 与正式对象

维护者按实际需要处理数据库结构新增、修改、删除和必要数据整理，事先确定停机范围、备份与
隔离恢复方案。应用启动只读核对非空数据库的最小契约，不会自动补表、回填或对齐完整 schema；
应用未消费的额外表、列、索引和约束可以保留。

存储注册表的进程缓存为 24 小时；后台保存、导入、删除和其他存储配置写入会主动失效。
直接手工修改 `storage_backend` 后应重启应用，使新配置立即用于后续源站读取；否则旧快照
可能保留到缓存期限结束后的下一次读取。浏览器和 CDN 缓存仍需按实际变更单独处理，
详见[注册表缓存](guide/storage.md#注册表缓存)。

恢复时核对 PostgreSQL、`data/` 和正式存储对象是否属于同一备份状态。永久删除会移除对象，
仅恢复数据库不能恢复已删除的文件；应在隔离环境确认图片记录和对象可读后再恢复服务。

资源定位使用 UUID 与扩展名，完整图为 `full/<UUID 尾两位>/<UUID>.<ext>`，
缩略图为对应的 `thumbs/<UUID 尾两位>/<UUID>.webp`。恢复时核对正常 / 回收站图片数量、
其他 metadata、标签关联与实际对象内容；发现不一致时保留原数据并按备份制定人工修复方案。

### Redis 冷启动恢复

Redis 使用应用专用逻辑库。需要重置时，先停止应用并备份；确认可以丢弃登录会话、未完成接入
和 completed 临时回执后，再核对 Redis 主机和 `REDIS_DB`，只对该逻辑库执行 `FLUSHDB`。
正式图片和 PostgreSQL 数据保持不变，启动后由协调器重建图片投影。运行中清空或局部删 key
不受支持，清理 Redis 也不能替代数据库结构维护。

`data/temp` 只保存接入临时文件，不是任务恢复来源。孤儿清理 worker 按引用、租约和年龄边界
清理陈旧文件，检查页展示扫描结果，详见[存储说明](guide/storage.md)。

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

### 静态资源压缩

镜像在构建时为可压缩资源生成 Brotli、Zstd 和 gzip 副本，每种副本只有小于原文件时才保留。
应用按 `/assets/*` 请求的 `Accept-Encoding` 权重与实际存在的副本协商，同权优先级为
br → zstd → gzip；没有可接受的压缩副本时，允许 identity 才返回原文件，否则返回 406。
编码名大小写、`q=0` 和 `*` 都参与协商。客户端缺省或发送空编码列表时返回原文件。
Zstd 解码窗口不超过 8 MiB，参数与产物报告见[构建资源边界](guide/project-structure.md#web-构建资源边界)。

反向代理应保留客户端可接受的编码，并将 `Content-Encoding`、`Vary: Accept-Encoding`、
`Content-Length` 和验证器随对应表示一起传递；CDN 若自行转换编码，须同步调整这些响应信息。
同时接受 Brotli 且存在 `.br` 的普通请求仍优先使用 Brotli，新增 Zstd 不代表所有请求自动变小。
根 `index.html` 是动态页面模板，不提供预压缩副本；页面仍经应用注入当前站点配置，
不要把运行镜像中的根模板交给代理直接静态托管。

## 本地发布门禁与镜像清理

源码发布前运行 `npm run verify:release`，前提见[测试说明](../scripts/tests/README.md)。
通过后推送 `dev`，等待三仓镜像分发成功，再同步 `main` 和版本标签；Release 复用同提交镜像，
不重新构建。流程和产物边界见[项目结构](guide/project-structure.md)。

Dev 与 Release 在登录镜像仓库前共同运行 `scripts/tests/verify/version-contract.mjs`，
核对根包、三个 workspace 与 lockfile 全部版本；Dev 同时要求 `dev` 分支，Release 要求
标签与包版本一致。版本不一致时不会进入镜像仓库登录和发布步骤。

只删除已核对、无容器引用且不再用于回滚的精确镜像 ID：

```bash
docker image ls --digests --no-trunc wozsun/imageshow
docker ps -a --no-trunc --filter ancestor=<sha256:image-id>
docker image rm <sha256:image-id>
```

保留当前版本、`latest` 与回滚镜像，不使用全量 prune 或通配清理。
