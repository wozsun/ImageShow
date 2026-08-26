# 架构总览

ImageShow 是一个 npm workspaces 单仓项目：服务端使用 Hono 与 Node.js 26，前端使用
React 与 Vite，共享 HTTP 契约和稳定常量位于 `packages/shared`。生产镜像只运行编译后的
JavaScript，并由同一个 Hono 应用按主机名提供 SPA、公共 API、管理 API 和图片出口。

## 整体结构

![ImageShow 架构图：客户端经反向代理按 Host 分流到 Hono 应用，应用读写 PostgreSQL、Redis 与存储后端，后台 Worker 分别消费 PostgreSQL jobs 与 Redis 内容接入状态](./assets/architecture.svg)

```text
浏览器 / API 客户端
        │ HTTPS
        ▼
可信反向代理 ──► Host 分流与安全响应头
        │
        ▼
Hono HTTP 应用 ──► PostgreSQL（业务真相）
        │        ├─► Redis（派生投影与运行时状态）
        │        └─► StorageDriver（local / S3）
        │
        └─► Worker ──► background_job
```

生产部署只支持一个应用进程，不检测或协调第二个实例。PostgreSQL 与 Redis 可以由独立
基础设施 Compose 提供，但都必须是该应用实例明确配置的单一连接目标。部署与停机边界见
[生产部署](./deployment.md)。

## 请求与主机边界

应用在 `http-app.ts` 中按规范化后的 `Host` 分流：

| 主机 | 职责 |
| --- | --- |
| `<站点域名>` | SPA、公共 API、管理 API、健康检查与 `/random` |
| `static.<站点域名>` | `/media/*`、`/thumbs/*` 对象字节与 `/link/original/<id>` 外部 HTTPS 原图直连决策 / 代理 |

随机、外链和主题都不拥有专用子域；未注册子域返回 404。嵌入页只在配置开启时提供，
并由文档响应的 CSP
`frame-ancestors` 限定父页面；它不会扩大 API 的跨源权限。完整路由见
[主机与资源子域](./subdomains.md)，请求来源、鉴权与响应头见[安全](./security.md)。
应用只接受最外层可信代理覆盖后的 `Host`、单值协议和单值客户端 IP，不解析
`X-Forwarded-Host` 或多级 `X-Forwarded-For`；应用端口必须只对该代理可达。

## 代码分层

```text
packages/server ──► packages/shared
packages/web ─────► packages/shared
```

- `shared` 只保存稳定 DTO、配置默认值、枚举和纯函数，不依赖其他 workspace。
- `server` 是唯一业务入口。路由只处理 HTTP、权限和输入输出，领域模块拥有事务、锁、
  存储与缓存语义，`core` 不反向依赖路由或具体业务。
- `web` 由页面编排跨页面组件、Hook 和无界面库；`components`、`hooks`、`lib` 不反向
  导入页面。

具体目录、依赖方向和本地门禁见[项目结构](./project-structure.md)。

## 数据所有权

### PostgreSQL

PostgreSQL 是图片、词表、后台任务、存储注册表和管理员账号的唯一持久业务真相源。
当前 schema 共 9 张表，其中 `ready_image_revision` 是图片投影 revision 单行表。schema
不保存迁移账本或应用版本号。

`schema.sql` 完整定义当前干净安装的单一基线；空库依次执行它与
`schema-additions.sql`，非空库只执行 additions 后做只读 readiness。当前 additions 是纯注释
占位；`metadata.created_by TEXT NOT NULL` 和后台任务的三种当前类型约束都直接属于基线。
additions 只为以后一个发布周期内经审查的受限增量保留固定入口；全部受控非空数据库确认增量
后，下一发布把定义并入 `schema.sql` 并恢复注释占位。自动结构职责由干净初始化、单周期
additions 和最小 readiness 构成；其他结构整理必须显式停机、备份并验证恢复。允许的 additions
和 readiness 契约以
[数据库结构](./database.md)为唯一说明。

### Redis

Redis 8 承载可以从 PostgreSQL 重建的图片读模型，以及管理员会话、限流、近期随机历史、
词表缓存、短期探测结果和可丢弃的未完成内容接入队列。它不替代账号、权限或最终图片状态；
导入 canonical 是当前单实例 worker 的运行时真相，专用 logical database 冷启动时允许整体
丢弃，不能把它回退到 PostgreSQL 或进程内队列。

upload 与 import 分别维护 accepted-order owner 动作 ZSET、batch / manifest display 展示 ZSET、
metadata 计数 / revision 和一个显示时 SSE。display 的倒序 rank 保持新批次在上、同批来源顺序
1→N；owner 的单调 accepted order 只服务动作水位与有界扫描。稳定 snapshot 从 metadata 直接
签发绑定当前 Redis connection epoch 与进程内
action scope 的 watermark；全队列写入口再按该水位有界扫描，并用绑定完整请求的签名
continuation 续传。scope 只在进程内存中存在，Redis unavailable 或重新连接会立即废止，
不构成 Redis 数据代际、key namespace 或 session identity。每个 scope 还只保留当前动作最近
一个请求批次的 Promise / 逐项结果，并以固定上限的小型 ID→请求指纹表拒绝近期 action ID 被
换动作、水位或 payload 复用；相同请求并发或响应丢失时原样重放，只有携带上批已签发
continuation 的下一批才能替换结果槽。它让删除 Redis completed 回执的动作仍可重放 PG 水合
DTO，同时不会形成随队列长度增长的内存结果表或新的 Redis 回执。
全局属性动作不向 canonical 写 action marker 或持久结果。“应用到全部”和整队列清空只按
accepted-order 水位选成员；属性动作在最新 canonical 上 CAS 合并稀疏 patch，整队列清空继续
经过取消协调器和 PostgreSQL 复核。提交和三类状态清理才以点击时 semantic revision 与执行时
谓词过滤；关闭瞬间恰逢重连时，完成态清理还可携带更小的旧权威 revision 上限，新的签名水位
只恢复执行权而不能扩大关闭时集合。progress / TTL 等非语义推进不影响选择。跨客户端 UUIDv7
大小不承担因果顺序。

全部 `ready` 图片共享一个固定命名空间：

- 核心投影无 TTL，包含 rich item、时间索引、对象反查、全局统计、完整性和已应用
  revision；
- 设备、明暗、主题、标签、作者索引以及组合筛选和动态统计是带生命周期的派生结果；
- 派生结果按需构建，受数量、成员数、工作量、并发和 TTL 上限约束；缺失、过期、损坏
  或超限只让当前读取回源 PostgreSQL，不会把派生结果当成真相；
- 核心投影损坏、revision 不一致或当前 Redis 连接更换会立即关闭 Redis 读门。协调器只
  保留 `unavailable` / `rebuilding` / `ready` / `stopped` 四态和一个活动任务：先在同一
  写栅栏内核对 PostgreSQL revision 与 Redis 已应用 revision，只有失配或完整性失败才
  single-flight 重建；重连期间变化的连接由同一任务重新校验，不维护第二套 epoch 状态。

限流、派生结果 touch、统计结果 touch、筛选集合生成和属性索引发布这五类原子写操作，以及
core / derived ready index 的两类只读随机抽样，以 ioredis 自定义命令集中注册。已解析索引的
随机读取在一次原子调用内核对 core meta / integrity、revision、派生 token / TTL 和 cardinality，
完成有界 `ZRANDMEMBER` 与 rich item 读取；显式状态让核心损坏进入重建、派生失效进入丢弃与
PostgreSQL fallback。近期图片集合、fresh / fallback 排序和最终 limit 仍由 TypeScript 负责。
调用方不保存 Lua 或 `EVAL` 参数布局；同一物理连接首次执行可发送完整脚本，后续使用 SHA，
Redis 重启或脚本缓存清空后的 `NOSCRIPT` 由客户端透明恢复。应用不在启动时 `SCRIPT LOAD`，
也不把这些脚本部署为 Redis Functions。深度检查中按当前批次键动态测量的低频脚本仍直接
执行，不属于高频业务命令。

图片事务先在 PostgreSQL 推进 `ready_image_revision`；同一张图片的一次原子编辑即使同时
改变 metadata 与标签也至多推进一次，纯 no-op 不推进。影响不超过 500 张时，提交后在
进程内写栅栏中精确更新核心投影；更大操作不加载完整 ID 列表，而是保持读门关闭并只
安排一次全量重建。Redis 失败不回滚已经提交的 PostgreSQL 结果。

核心 meta 的 `item_count` 随完整重建批次和精确增量发布保持真实；`processed / total`
只表示活动完整重建进度，非重建期归零且管理 DTO 返回空。`last_updated_at` 只在完整重建
批次或精确增量发布时推进，不受派生缓存命中、注册、淘汰或 TTL 影响。完整重建起止时间
只描述当前或最近一次完整重建；成功重建另保存
`last_full_rebuild_core_memory_bytes` 与测量时间，后续精确增量不会把该历史快照冒充为
当前占用。新一轮重建或失败会保留上一份可靠的成功快照，新的成功重建才替换它；测量失败
则明确回到未知。

后台概览在 `/overview` 查询中与 PostgreSQL 统计并行，对固定
`READY_IMAGE_CORE_KEYS` 发出一个 pipeline 的准确 `MEMORY USAGE ... SAMPLES 0`，得到
`current_core_memory_bytes` 与独立测量时间。它不执行 `SCAN`、不读取派生缓存，也不把当前值
写入核心 meta。并发概览请求复用同一个进程内测量 Promise；测量失败只让当前值未知，完整
重建字段继续表示最近一次成功重建。准确测量的成本会随这些核心容器的成员数增长，因此只在概览读取
和重建完成后的既有概览 refetch 中执行，不随重建进度轮询重复测量。

Redis 运行期不可用时，后台在会话读取前统一返回 `503 redis_unavailable`；公共图片、
列表、统计、资源反查和随机图进入统一的有界 PostgreSQL 回源。单实例只使用一个 FIFO
准入门，统一限制总并发、排队长度、等待时间、执行期限和 SQL 工作量；队列满返回 429，
等待或执行超时返回 503。每个公开请求持有一个显式的惰性 reader scope：Redis 全命中时
不占准入名额，首次真实 PostgreSQL 查询才借用一个 client，后续词表、筛选和主体查询复用
它并在请求读阶段结束时统一释放。超时或连接故障直接淘汰该 client，为管理事务和 Worker
保留主连接池余量。

随机筛选和返回契约见[随机图 API](./random-api.md)。检查页的管理轻量状态只执行固定数量的
PostgreSQL / Redis 命令，不扫描键空间或逐键读取内存；Redis 图片投影的核心卡先显示当前
图片数和最近完整重建内存快照，键数保持未知。检查页同时由唯一查询 owner 在后台自动启动
一次有界 Redis 深检，轻量状态不等待它；完整结果原地更新核心投影的键数与
`MEMORY USAGE`，以及派生投影的键数、结果成员数与 `MEMORY USAGE`。核心卡的“图片成员”
数始终使用轻量状态中的 `item_count`，不展示各核心键基数之和。自动检测进行中不会再启动
Redis 或“全部”检查的第二次扫描，之后手动运行 Redis 检查仍复用同一查询。未完成的部分
汇总不会替换已有快照。Redis `INFO MEMORY` 始终只表示整个实例，不会与 ImageShow 投影
汇总相加或替代。

### 浏览器传输验收

浏览器验收覆盖匿名 Home / Gallery / 公开详情、后台 9 图上传、图片编辑、已登录 Home /
Gallery 和其他后台页面。每个公开路由分别测量全新持久 profile 冷访问、同一 SPA 连续访问，
以及关闭后重开同一 profile 的磁盘缓存；上传和编辑另测写后状态。采样保留浏览器请求、真实
网络请求、缓存命中、状态码、header、body、编码、媒体清单、失败 / 取消和页面可用时间，
不同缓存状态不混算 percentile。媒体身份使用固定源序号与内容 MD5，默认随机首页背景单独
证明一次请求链路。

`tests/benchmarks/runtime-transfer/run-current-workload.ps1` 只运行一个明确的当前镜像，使用
隔离 Compose、全新数据库、Redis 与浏览器 profile；完整工作负载固定执行 50 次 9 图导入并
要求最终 450 张图片全部 ready、容器零重启且没有非预期失败。脚本输出每轮原始事实，报告
字段只描述本次镜像、工作负载和运行环境。生产构建由 `check-web-chunks` 验证权限闭包、
懒加载边界、资源 owner、内容哈希与重复产物，并用实际有效字节发现资源合并候选；资源治理
以真实构建图和同行关系为依据，不把按页面冻结的请求数或响应体积作为绝对预算。

### 图片字节

图片字节通过命名 `StorageDriver` 实例访问。每张图片记录自己的 `storage_slug`，同一
类型可以注册多个后端；领域代码不按类型拼接第二套对象路径。驱动、对象完整性、位置
迁移、远端请求期限、流 lease 与退役规则以[存储](./storage.md)为唯一说明。

本地上传和远端下载的 raw 素材先进入 `data/tmp`。服务端完成校验、标准化、缩略图和
摘要后，才把 processed image 与 prepared thumbnail 写入选定后端的 `_uploads`；导入
流程不让浏览器向对象存储直传原始或处理后字节。

## 一致性边界

会改变图片对象位置的导入提交、分类修改、主题重分配、单图或整后端迁移和彻底删除，
共用存储位置维护锁与单图 advisory lock。锁内重新读取 PostgreSQL 真相，候选对象必须
经强摘要回读验证，数据库位置以旧值做 CAS。数据库提交后才处理旧对象；不可逆删除交给
带物理命名空间 identity 的持久 `move.cleanup` 任务。Worker 取得同一单图锁并在删除边界
重读当前引用，已经重新采用的对象会保留，DELETE 结果则必须再次确认。

检查页的显式存储维护取得同一位置锁的独占模式，因此会等待上传、迁移和对象清理的共享
持有者完成，也阻止新持有者越过执行快照。它在锁内直接修复缺失缩略图和删除确认孤儿，
逐项返回结果，不把修复字节或执行结果复制到 `background_job`。只读存储检查不持锁，结果
仅用于预览；写入口始终重新扫描 PostgreSQL 和完整物理命名空间。

内容接入临时素材由另一个单实例周期 worker 保守回收。它在短时 storage location read lock 内
完整列举每个 `_uploads` 物理组，删除阶段再取得 write lock，复核物理 namespace、Redis
operational 状态及枚举前后精确引用；raw 另由进程内活跃路径租约保护。这个 worker
只读取 Redis canonical 引用，不从 PostgreSQL 或文件反建内容接入状态，也不把临时素材逐项复制
成 `background_job`。
正式提交则在复制两个确定候选前创建一条持久 `move.cleanup` guard，使进程崩溃后仍能按
PostgreSQL 最终引用决定删除或保留。

成功提交后，正常缩略图读取严格只读；缺失由 GET 返回 404 并在 Web 显示统一损坏图标，
只有检查页维护可以补建。分类移动和存储迁移不会在业务路径隐式修复。

Redis 导入 canonical 以 pair、version 和 execution token 隔离下载、prepare、commit、取消
与恢复。commit 按 prepared 最终 MD5、pair、图片和词表取得 PostgreSQL advisory lock，只
串行真正冲突的内容；对象复制到 PostgreSQL 事务 settle 全程持有 storage location shared
lock。进程内不可逆协调器只保存 `cancellable -> database_started -> settled`，并让 worker
的最后一次 token 复验、事务启动与取消判断共享一个临界区；它不构成持久队列或多实例协议。
下载或 prepare 持有同一 execution token 时，草稿更新可以合法推进 semantic version；worker
在 heartbeat、progress、成功阶段发布和失败落盘处重读并接力该新版 canonical，以最新草稿
继续执行。只有 downloading / preparing 允许这种 version 接力，状态、pair 或 token 变化仍是
严格围栏，commit 不放宽冻结边界。
任何连接丢失或调用方取消都通过 `AbortSignal` 传播，但已经启动的 PostgreSQL 事务不会因
Redis 断线或停机主动撤销。端到端状态见[功能与流程](./flows.md)。

浏览器状态通道同样只面向单实例：当前管理员的 upload / import 队列各自建立一个 SSE，
listener 建立后才向客户端交付本进程 action scope。分页快照把固定范围放在短 query，并用
有界 POST JSON 声明当前文档保序批次中的 Server pair 与当前页可见子集；单个
Redis Lua 先完整校验这些精确 incarnation，再按其全局 display rank 把过滤后的 offset 换算成
原始起始 rank，只读取 `limit + 有界排除数`，并原子补入可见子集的 canonical、捕获 metadata
与 revision。它不从 rank 0 扫描，也不假定当前文档任务位于全局 ZSET 头部，因此巨大 offset
和其他会话新增的更靠前批次都不会改变组合分页语义。排除 pair 已被删除、discard 或由同
session 新 incarnation 替换时，快照在同一响应返回精确 stale pair；Web 在一次 reducer 更新中
清除旧卡、Blob、状态围栏、detached owner 与草稿 owner，不能让失效排除项永久占位。
completed 回执只保留身份、提交摘要、期限与卡片所需的紧凑来源 / 原始处理信息，随后用一次
PostgreSQL `WHERE id = ANY(...)` 水合。重连、Redis operational 周期变化或服务端停机都会
废止 scope 与旧动作权威，但当前页只读展示保留到新快照原位替换；不保存事件历史，也不以
轮询补偿。HTTP 接管结果携带精确
accepted order，并以 snapshot 的 `last_accepted_order` 判断是否需要临时增加一次 total；这使
首次响应和响应丢失重放都能精确计数。当前文档创建的批次在窗口生命周期内始终由浏览器按
batch / manifest 保留整批展示顺序；业务权威逐项立即转交 Server，整批 handoff 保持
展示前缀、offset 或 limit，也就不会为展示所有者切换追加扩张快照。窗口重新进入后从一开始
完全使用 Server display，协议恢复只体现为任务仍在。浏览器保序任务最多 3600 项；新入队会
在创建 Server 任务前拒绝越过该界限，关闭窗口后该预算随文档释放。同筛选、同 offset 的
较小 Server 展示窗口直接复用已有稳定页，不因浏览器前缀占用更多槽位而重读。读取 owner 在
当前 offset 额外保留最多一页普通 Server DTO 作为有界替补；页面状态只接收实际展示槽位和
当前文档已接管 pair，替补不会生成卡片、Blob 或草稿 owner。新加入的精确 pair 已在稳定页时，
或排除变化仍可由该替补填满 Server 槽位时，同样复用该 revision。离页 handoff
只向队列 owner 声明所需 semantic revision；当前或在途快照覆盖该水位时继续作为唯一刷新 owner。
离页 handoff 的业务计数仍只用
无素材 provisional 投影。跨代 HTTP 结果把该投影重新归属当前 owner generation，并在
accepted-order 基线覆盖后退出。status 返回更高 revision 而触发 coverage 快照时，最近稳定
Server summary 会保留到新快照落地，组合总数不会因 canonical 先退出本地计数而短暂减少。
请求发出时的 connection generation 与结果一起进入围栏判断，跨连接响应必须先经批量 status
核对，不能用旧 revision 快速越过新连接；active DTO 会合并回当前 owner，PG completed 且
Redis missing 时直接水合完成卡片。该结果另持有独立于页内 DTO 的 semantic revision
围栏；旧 DTO 即使已有 accepted order 也不能解除该围栏。未知完成围栏跨 SSE connection
generation 保留；新连接仍观察到 active 时只等待下一次 semantic revision 后补查，不能把重连
本身当成完成证明。待状态通道确认的草稿写入同样保留
已知最大 version / semantic revision，较旧 snapshot 不会令下一次 pair/version CAS 回退。
PG 已完成但 Redis 完成迁移尚不能给出精确 revision 时，Web fail closed 并触发一次有界快照，
同时用现有批量 status 读取区分 canonical 仍为 active、已经 completed 或已经 missing。围栏按
pair 保存在 queue owner 而不是页内卡片；重试门槛绑定 connection generation，换代后重新核对。
active 时继续等待同代后续 revision；批量 status 返回的 active DTO 与 Redis completed 回执都把
精确 semantic revision 登记为 coverage gate。若该 revision 高于当前基线，owner 主动重取一次
有界快照，只有同代稳定 snapshot 覆盖或 missing 被权威确认后才重新开放全队列动作，因此翻页、
状态查询后没有后续 SSE、稳定无事件或冷代低 revision 都不会形成动作缺口或永久门禁。

## 后台 Worker

通用 Worker 只消费三类持久任务：

| 类型 | 所属领域 | 作用 |
| --- | --- | --- |
| `move.cleanup` | storage | 删除确认未引用的捕获候选或旧位置对象 |
| `trash.purge` | images | 续处理大批回收站彻底删除 |
| `cache.rebuild` | images/ready-cache | 重建 ready 图片核心投影 |

通用 `jobs` 层只负责 `FOR UPDATE SKIP LOCKED` 领取、`execution_token` 所有权、续租、
重试、僵尸恢复、公平时间片和历史裁剪；payload 与处理语义仍由所属领域拥有。任务期限、
租约丢失、锁连接丢失和进程停机合并成同一中止信号。停机时不再领取新任务，并在总停机
期限内等待已经登记的 handler 真正结算。

导入另有一个单实例 Redis worker。它用独立的有界 download、prepare、commit pool，commit
同时受任务数和全局字节预算限制；Redis operational gate 关闭时停止领取并中止仍可安全
中止的阶段，恢复后先运行有界 expiry / canonical 恢复入口。同一生命周期还启动独立的
60 秒孤儿素材清理周期，并在停机时中止、排空；Redis unavailable 时该周期不删除任何素材。
导入执行与临时素材周期不进入持久任务表；只有 commit 的两个确定正式候选在复制前写入
既有 `move.cleanup` guard，raw 与 prepared generation 不逐项持久化。

任务表与状态字段见[数据库结构](./database.md)，对象清理协议见[存储](./storage.md)。

## 进程生命周期

启动顺序固定为：读取部署配置与运行配置、初始化空库或核对非空库、重建启动期投影、执行
必要清理与管理员初始化、启动 HTTP 和 Redis 监测；Redis 通过能力校验后再开放业务门并启动
缓存协调器与 Worker。CLI 入口不会因导入 HTTP 应用而触发这些副作用。

正常停机先停止接收新请求，同时中止 Worker、缓存协调器和存储注册表，再在统一硬期限内
排空 HTTP、driver lease、Redis 与 PostgreSQL；重复退出信号复用同一次收口。多应用实例不受
支持，Compose 或部署平台负责只运行一个 ImageShow 应用容器。
