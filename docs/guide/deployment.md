# 生产单实例部署与反向代理

## 单应用容器 + 基础设施 Compose

当前生产部署固定在一台主机：只运行一个 ImageShow 应用容器，并连接另一套基础设施
Compose 中各一个 PostgreSQL 与 Redis 容器。升级时先停止对应当前容器，更新后原位启动。
应用容器可按下例连接基础设施服务：

```bash
docker run -d --name imageshow --restart unless-stopped --stop-timeout 50 -p 5518:5518 \
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
`INCREX`、`ARRING` 与 `ARLASTITEMS`。能力检查会在 ImageShow 自有的固定探针键上实际
执行三项命令：写键带 5 秒 TTL，检查结束尝试立即 `UNLINK`，权限不允许时由 TTL 收口；
命令存在但当前 ACL 用户无权执行仍视为不可用。内置服务使用不固定次版本的 `redis:8` 主版本
标签并开启 AOF；Compose 不设置 Redis 内存上限、淘汰策略或容器硬限制。外部 Redis
同样必须提供三项必需命令；应用不读取内存限制或淘汰策略，只观测整个实例的 used、
RSS 与 fragmentation，且不以这些指标改变应用状态。

从 3.15.2 升级 v4 时，先停止应用，再清空该 ImageShow 实例通过 `REDIS_DB` 指定的逻辑
库，随后启动新版本；登录会话会失效，统一就绪图片投影与派生查询会按 PostgreSQL 真相
源重建。v4 不读取旧随机 generation、图片 revision 缓存，也不使用带 `v2` / `v3` 后缀
的兼容 key。Redis 与其他业务共享时不得执行 `FLUSHALL`，操作前必须核对目标逻辑库只由
当前 ImageShow 实例使用。

正式发布前必须在本地执行 `npm run verify:release`，并把该次验收产生的同一
`imageshow:<version>-verify` image ID 标记为 `imageshow:local`。随后才推送 dev 并等待
dev 镜像 Action，通过后合并 main、创建版本标签，再等待双 registry 镜像与 GitHub
Release Action。上传后的 Actions 只做版本 / 分支 / 标签基础校验、容器构建与发布；不会
重复本地类型、Knip、最终测试、数据库、存储或浏览器验收。任一步失败都停止后续发布，
不得用 Action 成功推断本地门禁已通过。

## 健康检查与镜像清理

容器健康检查只调用 `/readyz`。该端点检查 PostgreSQL 连通性与核心 schema、必要初始化、
Redis 连通性及 Redis 必需能力，但不把图片投影重建、内存、AOF、版本或淘汰策略作为
就绪条件；空库 schema 初始化或非空库 contract 只读校验仍在 HTTP 监听前完成。Redis 首次校验失败时进程只开放健康端点，
全部业务 503 且 worker 不启动；首次成功后即永久打开当前进程的冷启动业务门。运行期
Redis 故障使 `/readyz` 非 2xx，但进程不退出、不重启、不停止 worker 或公开读取。
Redis 每次重新连接后必须重新通过连接 epoch 与命令能力；图片协调器再校验 schema、
revision、meta、最后内容更新时间与核心完整性，才能开放缓存读取。当前镜像只携带
唯一 `schema.sql` 完整基线，全新安装一次建立包括 `ready_image_revision` 在内的全部 10 张
业务表，不创建 schema 版本表。非空数据库必须满足当前应用侧只读结构契约；额外旧表可
保留，必需表接受 v4.6 精确定义的 `metadata.extra` / `background_job.result` 和仍含
`thumb.generate` 的 job type CHECK，但不恢复该任务实现。其他额外列或约束、触发器、规则及
唯一 / 普通索引等会改变写语义的对象拒绝启动；只读会话、FK 执行被绕过或角色缺少运行所需
DML 权限同样拒绝就绪。应用不再读写两个白名单字段，不提供编号迁移或升级路径，也不会对
非空库执行 DDL 或写入契约标记。
任一运行依赖不可用都会返回非 2xx，Docker 随即
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
密码直接更新 PostgreSQL 真值；Redis 可用时随后清除全部管理员会话，旧密码立即失效，
所有管理员需要重新登录。
源码环境可使用：

```bash
npm run admin:reset-password -- <username>
```

命令使用与主服务相同的 `DATABASE_*` / `REDIS_*` 部署环境。Redis 故障不会阻止密码
更新：后台此时保持不可用；目标账号旧会话在 Redis 恢复后的下一次认证中会因 PostgreSQL
密码代际不匹配而失效。命令只警告其他管理员会话未按
恢复流程清除。恢复 Redis 后可重新运行相同命令完成全量会话清理。用户不存在、密码不符合规则或 PostgreSQL 更新
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
启动。应用在 schema 初始化或 contract 校验后、清理与业务启动前，用独立 PostgreSQL session 非阻塞取得
固定生命周期 advisory lock；连接同一数据库的第二个应用容器会以
`application_instance_already_running` 明确拒绝启动。锁 session 意外断开时，旧进程
无论发生在启动还是正常停机途中，都立即关闭 HTTP 接收、停止 Worker，并按既有期限排空
及关闭全部 PostgreSQL 连接池后以失败状态退出；Compose 可以随后重启并重新取锁。正常
滚动仍应先停止旧容器并等待其退出，不能把这条锁当作多实例切换、
缓存 fencing 或零停机协议。短期多实例边界继续只记录在
[多实例待办](./todo-multi-instance.md)。

基础设施侧 Redis 容器应启用 AOF 和自动重启。Redis 的内存限制、淘汰策略及容器硬内存
上限均由部署方决定；ImageShow 不读取这些限制，只在状态检查中观测整个实例的 used、
RSS 与 fragmentation，且不以这些值阻止启动、就绪、重建或业务写入。属性索引、公开组合
筛选和统计结果共用
LRU registry，按 6 小时滑动 TTL、256 个结果、128 个活跃签名、单 ZSET 25 万成员、
总成员 `max(10000, 核心图片数 × 8)` 及单统计结果 512 KiB 约束结构规模。派生 Redis
集合命令还按物化命令 20 万源成员、`ZINTERCARD` 20 万源成员、10 万预期结果、
8 个操作数、单筛选累计 30 万源成员及动态统计 64 个维度 / 200 万累计源成员 /
50 万预期交集成员限制 CPU 工作量；统计在构建属性或组合结果前先按核心 stats 上界
预检，并持有并发槽直到全部 Redis 命令结束；公开属性索引首次缺失时，当前请求直接回源，
本次所需的全部缺失属性进入最多 256 项的进程内串行构建队列；独立后台构建与该回源共同
计入统一公开 PG 总并发、分类并发、队列和执行超时。大型筛选
和大型统计各自最多同时运行 1 个。错误或超限只放弃当前结果，核心投影错误才关闭读门。
图片变更的精准缓存同步另有独立总量边界：最多 500 张，Redis 的 200 张批次只用于
pipeline 分块。可预先计数的大范围业务应在 PostgreSQL 事务内先 COUNT；超过边界时不为
缓存加载 ID，提交后关闭核心读门、清理派生结果并 single-flight 请求后台重建。检查页的
手动 Redis 深检在 `image_projection.mutation_sync_policy.exact_sync_max_items` 暴露当前
边界。标签 / 作者删除已经
按事务内 ready 关联数应用该规则；主题重分配和大型批量分类这类多事务操作会在首尾
短暂取得缓存写栅栏，期间以 `mutation_in_progress` 保持投影不可读，每个业务事务仍只
bump 一次 revision，最终只请求一次重建。事务或对象移动在任何提交前失败时不会误重建；
已有部分提交或 Redis 同步失败时，PostgreSQL 结果保持不变并以最终重建收敛；主题删除
部分失败还会立即推进管理员主题计数缓存的本地 revision，使下一次列表读取回源真值。
Redis 写入失败按真实失败记录，不触发全局内存清理。连接若被终止，应用立即关闭投影
读门并在 5 秒内结束在途命令；运行期公开画廊、详情、facets、统计、对象反查及定向和
普通随机统一走 PostgreSQL fallback，后台入口在读取会话前返回
`503 redis_unavailable`，不会伪装成 401 或清除浏览器登录状态。连接及会话可用而只有图片
投影不一致时，后台保持可用，管理员 ready 列表与公开读取暂时回源。

后台检查页默认调用一次 `GET /api/admin/check/status`。PostgreSQL 与 Redis 状态在服务端
并行、独立收口；前者只执行带 2.5 秒 statement timeout 的单条汇总查询，后者只执行
`PING`、`INFO server`、`INFO memory`、图片 meta 和进程内最多 256 项的 registry 占用镜像。
默认路径不执行 `SCAN`、逐键 `MEMORY USAGE` 或完整一致性验证；核心占用是投影发布时的
记录值，派生占用是 registry 汇总的已登记物理键、结果成员，以及结果、meta、registry 的
记录字节，不含临时构建键；registry 五个键跟随最晚活跃结果使用同一滑动 TTL。断线或清理
开始先把镜像置为未知，完整清理后才确认为空；命中续期同步延长结果、registry 与镜像期限，
读取会剔除到期项。合法零成员结果只观测实际存在的 meta；观测失败为未知且不得影响缓存
写入。只有管理员手动触发 Redis 或全部
深检时才扫描 ImageShow 键并采集逐键实际类型长度与内存；深检的核心成员数只计图片，派生
成员数只计索引和筛选结果。前端不因 Strict Mode 重挂、聚焦或路由返回重复请求，只在手动
刷新或核心投影 rebuilding 时继续轮询；已确认重建后，即使单次轻量响应只报告 Redis 资源
错误也会保留重建态并退避重试，直到后续 Redis 成功响应明确结束。面板中的“完整重建
开始时间”和“完整重建完成时间”只描述最近一轮全量核心投影；“最后更新时间”表示核心
增量、完整重建批次写入 / 发布，或派生结果生成、淘汰、清理造成的最近一次缓存内容变化，不把普通
命中和 TTL 续期算作内容更新。重建进行中时“本次耗时”与“完整重建完成时间”都显示 `—`；
服务端内部观测耗时仍从进程记录的本轮开始点计算，不会误用上轮开始时间，界面只在本轮
结束后显示最终耗时。重建失败也保留失败结束时间和本次耗时。

公开回源最多占 12 个数据库连接，并按 lookup 6、list 4、random 3、aggregate 2 设置可
重叠的子并发上限；非轻量类别合计最多占 9 个槽，因此对象键 / 主键反查不会被重型请求
完全挤占。队列最多 64 项、等待 1.5 秒；各类执行上限分别为 2.5、4、4.5、7.5 秒。
队列满返回 429，等待、PostgreSQL 或执行失败返回 503，均带 `Retry-After: 1`。HTTP 中止
只发起 `pg_cancel_backend`；许可在 PostgreSQL 确认目标 PID 已停止原 SQL、查询正常结束，
或专用连接确已销毁后才释放。列表继续使用 keyset 与 200 最大页；普通随机最多读取 512
个候选并使用 UUIDv7 时间 pivot、向后读取和头部 wrap，绝不使用 `ORDER BY random()` 或大
OFFSET；定向 UUID / 末 12 位查询最多接受 256 个匹配
候选，超过即返回工作量上限 503；公开词表结果最多 10000 行，公开资源回源加载的存储
后端注册表最多读取 256 项。

应用进程冷启动和每个新 Redis 连接周期都重新校验连接 epoch 与必需命令；图片协调器再
清理正式派生结果与 registry，并校验图片 schema、revision、meta、最后内容更新时间与
核心完整性，通过后才重新开放 Redis-first 公开读取。后台会话 key 仍在 Redis，但每次
认证都按用户名查询一次 PostgreSQL `admin_account`；数据库故障返回 503 并保留会话，
权威角色或密码代际明确不匹配才返回 401。

浏览器同源 PUT 的原始图片先写入容器 `data/tmp`，服务端 prepare 完成后才向选定后端写入候选文件；请求依赖管理员会话 Cookie 与 `X-CSRF-Token`，浏览器不直连对象存储，因此存储桶无需配置 CORS。
