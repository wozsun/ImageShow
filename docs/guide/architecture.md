# 架构总览

ImageShow 是一个 npm workspaces 单仓项目：服务端使用 Hono 与 Node.js 26，前端使用
React 与 Vite，共享 HTTP 契约和稳定常量位于 `packages/shared`。生产镜像只运行编译后的
JavaScript，并由同一个 Hono 应用按主机名提供 SPA、公共 API、管理 API 和图片出口。

## 整体结构

![ImageShow 架构图：客户端经反向代理按 Host 分流到 Hono 应用，应用读写 PostgreSQL、Redis 与存储后端，后台 Worker 消费 background_job 队列](./assets/architecture.svg)

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
| `static.<站点域名>` | `/media/*`、`/thumbs/*` 对象字节与 `/link/original/<id>` 外部 HTTPS 原图代理 |

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

PostgreSQL 是图片、词表、导入会话、后台任务、存储注册表和管理员账号的唯一业务
真相源。当前 schema 共 10 张表，其中 `ready_image_revision` 是图片投影 revision
单行表；schema 不保存迁移账本或应用版本号。

`schema.sql` 直接定义当前干净安装基线；空库依次执行它与可选的
`schema-additions.sql`，非空库只执行 additions 后做只读 readiness。当前 additions 是注释
占位，不执行 DDL 或数据写入。additions 只承载一个发布周期；全部受控非空数据库确认增量后，
下一发布才把同一定义并入 `schema.sql`，部署和旧备份恢复不得跳过承载增量的发布。应用不提供
通用结构 diff、编号迁移、破坏性 DDL、契约标记或清库。允许的 additions、兼容超集和拒绝
条件以[数据库结构](./database.md)为唯一说明。

### Redis

Redis 8 只承载可以从 PostgreSQL 重建的图片读模型，以及会话、限流、近期随机历史、
词表缓存和短期探测结果。它不替代账号、权限、图片状态或导入状态。

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

后台概览在原有 `/overview` 查询中与 PostgreSQL 统计并行，对固定
`READY_IMAGE_CORE_KEYS` 发出一个 pipeline 的准确 `MEMORY USAGE ... SAMPLES 0`，得到
`current_core_memory_bytes` 与独立测量时间。它不执行 `SCAN`、不读取派生缓存，也不把当前值
写入核心 meta。并发概览请求复用同一个进程内测量 Promise；测量失败只让当前值未知，历史
完整重建字段仍保持原语义。准确测量的成本会随这些核心容器的成员数增长，因此只在概览读取
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
懒加载边界、资源 owner、内容哈希与重复产物，并用实际有效字节发现资源合并候选；不再为
各页面维护随版本冻结的请求数或响应体积绝对预算。

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

成功提交后，正常缩略图读取严格只读；缺失由 GET 返回 404 并在 Web 显示统一损坏图标，
只有检查页维护可以补建。分类移动和存储迁移不会在业务路径隐式修复。

导入会话另以 session advisory lock 和 `execution_token` 隔离 materialize、prepare、
commit、取消与过期清理。commit 还按 prepared 最终 MD5 使用同一 PostgreSQL advisory lock
设施建立内容边界：只串行相同内容，在锁内重读 metadata，再由已绑定 session / attempt /
MD5 的显式决策决定是否允许副本。不同内容和同批其他成员不共用该锁；当前单实例部署无需
新增跨实例协调服务。提交取得内容与会话锁后还会核对预解析词表锁对应的已绑定 metadata；
若另一并发请求刚完成绑定，只释放当前项并在同一请求内按权威 payload 重取一次。任何连接
丢失或调用方取消都通过 `AbortSignal` 传播；领域模块在发布状态、写对象和删对象前重新核对
所有权。端到端状态见[功能与流程](./flows.md)。

## 后台 Worker

Worker 只消费四类持久任务：

| 类型 | 所属领域 | 作用 |
| --- | --- | --- |
| `move.cleanup` | storage | 删除确认未引用的捕获候选或旧位置对象 |
| `import.cleanup` | images/imports | 清理过期导入会话和暂存对象 |
| `trash.purge` | images | 续处理大批回收站彻底删除 |
| `cache.rebuild` | images/ready-cache | 重建 ready 图片核心投影 |

通用 `jobs` 层只负责 `FOR UPDATE SKIP LOCKED` 领取、`execution_token` 所有权、续租、
重试、僵尸恢复、公平时间片和历史裁剪；payload 与处理语义仍由所属领域拥有。任务期限、
租约丢失、锁连接丢失和进程停机合并成同一中止信号。停机时不再领取新任务，并在总停机
期限内等待已经登记的 handler 真正结算。

任务表与状态字段见[数据库结构](./database.md)，对象清理协议见[存储](./storage.md)。

## 进程生命周期

启动顺序固定为：读取部署配置与运行配置、初始化空库或核对非空库、重建启动期投影、执行
必要清理与管理员初始化、启动 HTTP 和 Redis 监测；Redis 通过能力校验后再开放业务门并启动
缓存协调器与 Worker。CLI 入口不会因导入 HTTP 应用而触发这些副作用。

正常停机先停止接收新请求，同时中止 Worker、缓存协调器和存储注册表，再在统一硬期限内
排空 HTTP、driver lease、Redis 与 PostgreSQL；重复退出信号复用同一次收口。多应用实例不受
支持，Compose 或部署平台负责只运行一个 ImageShow 应用容器。
