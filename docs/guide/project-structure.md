# 项目结构详细说明

ImageShow 使用 npm workspaces 管理三个包。依赖方向固定为：

```text
packages/server ──► packages/shared
packages/web ─────► packages/shared
```

`server` 与 `web` 不能互相导入；`shared` 不能依赖其他 workspace。Web 构建产物最终
由服务端镜像提供；根目录 `docs/guide/` 只是普通仓库文档，不参与 workspace 或生产构建。

本文面向项目开发与运维，详细描述现行源码、构建产物、状态所有者和依赖边界，是当前实现
结构的权威说明。

## 根目录职责

- `package.json` 只编排 workspace 构建、类型检查、死代码检查和运维入口。
- `scripts/build/` 只保存生产构建所需的清理、进程编排、Web 图标生成和服务端 schema / SPA
  资产装配；Web 构建直接输出通用产物图报告，报告不装配进运行镜像。
- `scripts/runtime/` 只放容器内的命令包装；容器启动由
  `scripts/runtime/docker-entrypoint.sh` 负责权限
  收敛后直接执行传入命令。
- `Dockerfile` 只安装三个 workspace 的构建依赖（不安装根目录本地门禁工具）并完成编译，
  再单独安装 server/shared 的生产依赖；运行镜像只携带生产依赖、编译产物和运维入口。
- `compose.yaml` 提供单实例 ImageShow、PostgreSQL 与 Redis 的标准部署，只把 `.env` 用作
  显式最小白名单的插值来源；ImageShow 环境前部固定为数据库名、用户名、密码和首次管理员
  用户名、密码五项。数据库名、数据库用户名和管理员用户名有默认值，两个密码必须显式设置；
  `.env.example` 另行承担部署变量与全部首次 seed 的完整目录。
- `docs/guide/` 保存当前架构、配置、数据库、流程、部署和 API 说明，使用相对 Markdown
  链接，可直接在仓库中阅读。

本地测试、源码 / 构建 / 隔离镜像门禁脚本及 benchmarks 统一位于根目录 `tests/`，由 Git
忽略且不进入 Docker build context、生产镜像或 GitHub Actions。测试从外部启动与生产镜像
相同的服务入口；测试数据库、Redis、Compose、fixture、网络模拟和清理编排均留在
`tests/`。Web 最终测试使用根目录仅供本地门禁的 `linkedom` 真实挂载 React 组件；生产构建
和运行镜像不安装该依赖。

## 本地门禁与发布职责

四个门禁可以单独重跑，总入口按 source → build → runtime 顺序失败即停，不通过子命令
互相嵌套：

| 命令 | 内容 | 副作用 |
| --- | --- | --- |
| `npm run verify:source` | workspace 类型、Knip、语义颜色、TypeScript AST 依赖方向 / 环、配置 schema / 环境目录 / 文档 / Compose 白名单、图标、Markdown 链接与 selector inventory | 只读源码，不生成 `dist`、容器或浏览器会话 |
| `npm run verify:build` | 清理必要输出，先构建 shared，再并行构建 Web / Server，装配服务端资产并按真实产物图检查 Web 分块边界 | 只重建三个 workspace 的 `dist` |
| `npm run verify:runtime` | baseline / Server / Web 三个最终入口，以及生产镜像冷启动、HTTP、schema 和重启 | 建立随机命名的 tmpfs PostgreSQL、Redis、应用容器、网络和临时镜像；无论成功、失败或中断均在结束前删除，不访问现有数据库、容器或浏览器 |
| `npm run verify:release` | 依次执行以上三层 | 合并上述本地副作用 |

`npm run icons:generate` 是维护图标生成源码的显式写命令；日常门禁只运行只读的
`npm run icons:check`。`npm run check` 直接检查 shared / Server / Web 源码，不先构建
shared，也不写生产产物。

本地 source 门禁核对根包、三个 workspace 与 lockfile 版本。GitHub Dev Action 只接受 `dev`
分支，显式只构建 `linux/amd64`、关闭默认 provenance 证明清单，并把同一次生产构建推送到
Docker Hub、腾讯云 TCR 与阿里云杭州 ACR；Release Action 核对 release tag、根包版本、`main`
祖先关系及三仓同提交 `:dev` digest，只把各仓已验证的单平台 manifest 原样添加版本与 `latest`
标签，任一校验失败即退出且不重新构建。公开 Action 使用稳定主版本标签，job 不设置项目自定义
总运行时限。Actions 不运行
`verify:*`、Knip、最终测试、数据库、存储、浏览器或性能验收；Action 成功不能替代本地
`verify:release`。

## packages/shared

共享包是前后端唯一共同依赖，只承载稳定的配置默认值、类型、校验常量、DTO 与浏览器安全纯规则。

- 默认入口只导出服务端与构建配置使用的完整 `appConfig`；Web 运行时代码不得导入。
- `@imageshow/shared/browser` 是图片、分类、内容接入、存储和管理设置等双端 HTTP/SSE
  契约的唯一来源，并按 `browser/` 下的真实领域拆分后由 `browser.ts` 汇总。
- 浏览器入口只含可进入 Web bundle 的 DTO、枚举、纯函数和输入限制，不得反向引入
  完整运行时默认值、Node.js、数据库或 Redis。
- 服务端数据库行型、执行所有权和存储凭据留在所属领域；存储读取 DTO 只描述已经
  脱敏的配置，含密码或密钥的编辑表单与写入请求不作为共享浏览器契约。

## packages/server

服务端是唯一业务入口。依赖通常从路由向领域、再向基础设施流动：

```text
index / routes
      │
      ▼
images / ingestion / storage / random / jobs / vocab / users / checks
      │
      ▼
core / config
```

### 应用装配与特殊入口

- `src/http-app.ts` 只构造 Hono 应用、装配中间件和路由；导入模块不会初始化配置、
  创建目录或启动服务。
- `src/index.ts` 先向 PostgreSQL pool 显式注入部署配置，再初始化运行时配置和日志来源，
  创建 HTTP 应用，初始化 / 校验 schema，再完成管理员初始化、启动 Worker 和 HTTP 服务，
  并处理优雅退出。
- `src/admin-password-cli.ts` 是管理员密码恢复入口。
- `src/healthcheck-cli.ts` 是容器 readiness 检查入口。
- `images/mutation-sync-policy.ts` 只定义图片变更总量的纯决策与结果契约；
  `images/mutation-sync.ts` 持有写栅栏并执行精准发布或安排全量重建，领域 SQL 只负责在
  自己的事务边界 COUNT、推进 revision 和按决策读取有限 ID。
- `images/ready-cache/coordinator-machine.ts` 是单进程图片投影状态机的唯一所有者；
  `coordinator.ts` 只装配该进程唯一实例。四态、单一活动校验 / 重建任务、revision 与
  planned mutation fence 共同位于状态机边界内。

两个 CLI 都直接依赖所需基础设施，不导入 HTTP 应用，也不会触发主服务启动；
healthcheck 只读现有配置快照，密码恢复不初始化运行时配置。

### 稳定领域边界

| 目录 | 职责与允许依赖 |
| --- | --- |
| `core/` | 领域无关的运行可用性、安全抓取、日志、密码、UUID、并发和精确基础原语；不持有图片、词表、存储或 Ingestion 请求 schema，也不依赖业务领域或路由。只有未形成稳定三文件族的横切模块留在根层。 |
| `core/database/` | PostgreSQL pool、事务、advisory lock、公开 fallback 准入、schema 装配和 readiness；`readiness/` 只承载数据库基线断言的内部职责。 |
| `core/redis/` | 唯一 Redis client、连接与能力探测、JSON、pipeline、条件字符串、窗口限流命令及其通用 Lua；不持有 ready-cache 等业务命令，也不导入其他业务领域。 |
| `core/http/` | HTTP 响应与响应头、请求来源和请求体限制、压缩阈值、条件请求、静态响应与 Range 解析。 |
| `config/` | 部署环境、首次播种、运行时配置 schema、无导入副作用的文件读写与显式进程内 store，以及配置包；普通保存与磁盘重载共用 FIFO 写租约内“持久化后发布”入口，配置包在同一租约内把候选文件持久化与数据库结果核对及收敛决定后的单次内存发布分离。配置包由目标版本以当前默认配置为基线逐项投影，存储后端逐条识别，不维护来源版本迁移链；`runtime-config-environment.ts` 是全部 RuntimeConfig 叶子到首次 seed 变量的唯一映射。启动、热加载和配置包都只读取当前结构，未知字段统一投影删除。 |
| `routes/` | HTTP 方法、鉴权、CSRF、输入解析和响应投影；`validation/` 按图片、Ingestion、存储、用户和词表职责拥有请求 schema，并集中保留通用 HTTP 原语与 `validation_error` 映射；业务工作委托给领域模块。 |
| `images/` | 图片读写、展示投影、分类与元数据变更、回收站和缩略图；`metadata-tags.ts` 拥有 HTTP 与 JSONL 共用的标签归一化契约，`page-window.ts` 唯一计算安全数字页窗口，`storage-location/` 拥有正式图片后端位置 CAS、revision、mutation fence 和 cache handoff，`ready-cache/` 拥有统一 Redis rich 投影、筛选、统计、精确同步与重建，`ingestion/` 拥有 Upload / Import 的完整接入会话生命周期及清理任务，`read-models/` 承载 PostgreSQL cursor / offset 读模型及其领域查询类型。 |
| `storage/` | 只在根层保留横切 `maintenance-lock.ts`；`backends/`、`drivers/`、`objects/` 与 `cleanup/` 分别拥有注册表及 Endpoint 重绑定证明、驱动、对象原语及跨图片传输准入、持久清理。`storage/` 不修改正式图片位置或相应 revision，也不交接 ready-cache。`backends/config.ts` 保留 S3 配置 schema、归一化和存储领域输入类型，HTTP create / update / test schema 位于路由边界。 |
| `random/` | 随机查询校验、规范 `auto` / `all` 到候选设备轴的选择、Redis 8 Array 最近历史、定向 id 与有界 pivot 普通随机 PG 降级查询及随机出口编排；纯 User-Agent 设备识别由 `@imageshow/shared/browser` 提供给 Server 与 Web，Redis 候选投影、筛选与重建统一由 `images/ready-cache/` 提供。 |
| `jobs/` | 仅拥有通用 `background_job` 生命周期、小型类型分派、公平调度 Worker，以及集中管理任务中止、期限、续租和有界排空的执行协调器；各领域拥有自己的 handler、payload 和结果语义。 |
| `checks/` | PostgreSQL / Redis 独立轻量状态、数据库 / Redis / 存储手动深度检查、“全部”中的回收站一致性结果，以及显式触发的存储维护；状态页自动 Redis 深检与手动 Redis 检查复用同一有界扫描和 pipeline，只返回当前汇总。 |
| `authors/`、`tags/`、`themes/`、`vocab/` | 词表查询、变更、关联锁与派生缓存；`authors/identity.ts` 唯一拥有作者链接到平台身份的当前解析和管理投影，微博导入按身份批量查询 PostgreSQL，不保留旧配置迁移 owner。 |
| `users/` | 管理员初始化、账号变更、Redis 登录会话、逐请求 PostgreSQL 角色与密码代际核对、操作授权、密码恢复、偏好和会话失效；不维护管理员凭据 Redis 投影。 |
| `types/` | 仅放缺失的编译期声明，不承载运行时代码。 |

`config/runtime-config-store.ts` 唯一拥有进程内 RuntimeConfig、listener 与 FIFO 写租约。普通设置、
高级配置和磁盘重载都先完成所需原子文件写入，再替换内存并逐个通知 listener；同步 listener
异常只记录结构化错误，不中断后续 listener 或反转已持久化结果。`config/config-package.ts` 在同一
租约内先通过 store 的专用阶段持久化候选文件，再等待 PostgreSQL 事务结果；只有正常提交、确认
已提交或结果 unknown 时才发布候选，确认回滚只恢复旧文件且不发布中间快照。

`config/site-host.ts` 是资源根 URL、路径前缀和 Host 判断的共同入口：空 `static_subdomain`
默认选择主站 `/static`，非空选择资源子域。`http-app.ts` 在公共资源、OPTIONS 与 SPA 之前执行
模式与 Host 隔离；`routes/public.ts` 的两组路径共用相同资源处理器，热加载只切换当前出口。
不按版本添加转发或迁移。公开资源不读取管理员会话，S3 已配置公开 URL 的对象仍使用直链。

`storage/drivers/local.ts` 在缓冲写、复制和流式写入创建候选前及 link 发布前检查取消，
缓冲写同时向文件写入传递 signal。不可中断的本地复制等待当前 I/O 完成后检查取消并清理候选。
每次自检使用独立随机 key，读写受请求 signal 控制，清理使用独立 10 秒准入预算并等待已开始
的文件 I/O 收口；失败或取消仅删除本次探针对象。

`routes/` 当前保留 18 个直属文件。`admin-vocabulary.ts` 在一个 HTTP 能力边界中声明 tags、
themes 与 authors 三组同构 CRUD，通用 registrar 为文件内私有实现；每组仍分别注入自己的
schema、查询、变更和删除权限，不把领域业务搬进路由。`public.ts` 私有持有 Hono 请求到
`StoredResponseRequest` 的 header / signal 投影，共同服务该文件内 `full` 与 thumbnail 入口。
其余短 registrar 即使只有一个导出，也分别拥有独立 URL、鉴权 / 权限、中间件顺序、Host
或缓存契约；不按行数与相邻文件合并。`http-app.ts` 仍显式展示公开路由、管理员 session、
CSRF、请求体限制和各管理能力的装配顺序。

`routes/validation/` 不提供 `index.ts` 或旧路径转发：`parse.ts` 唯一把 Zod 问题映射为稳定的
HTTP `validation_error`，`primitives.ts` 只复用 UUID、slug、HTTPS 和安全整数等无业务语义原语，
其余文件分别拥有对应请求 schema。公开列表、后台列表与画廊统计的领域查询类型由各自
`images/read-models/` 模块导出，路由 schema 以 `z.ZodType` 对其作编译期约束；图片更新直接使用
`@imageshow/shared/browser` 的 `ImageUpdateItemInputDto`。JSONL 与 HTTP 共用
`images/metadata-tags.ts` 的标签归一化 schema，cursor 复用 `core/uuid.ts` 的规范 UUID 原语，
因此非路由模块无需也不得反向依赖请求校验目录。

`core/database/` 按 PostgreSQL 生命周期边界拆分：`pools.ts` 只接收显式配置并拥有主查询与
advisory lock 两个连接池；`transactions.ts`、`advisory-locks.ts` 和 `schema.ts` 分别拥有
事务、锁与干净安装编排。advisory lock 调度信号只取消连接取得与锁等待；锁内回调收到独立的
父锁 / 当前连接失效信号，由具体领域决定是否再合并请求、lease 或 deadline。`readiness.ts`
是唯一总入口，按固定顺序调用
`readiness/relations.ts`、`privileges.ts`、`indexes.ts`、`checks.ts`、`foreign-keys.ts` 与 `seeds.ts`；
`readiness/contract.ts` 是最小表、列、权限、主键、索引与外键 contract 的唯一数据来源；
`checks.ts` 只核对当前作者身份读写依赖的三项长期 CHECK、`metadata` purge 任务归属 CHECK
和受支持 provider 数据集合，在调用者提供的同一连接上顺序读取约束；
`readiness/seeds.ts` 是稳定种子断言的唯一来源，其他检查模块不得复制两者。
后台数字页使用 `database/transactions.ts` 的 read-only repeatable-read 事务，让 COUNT、
越界判断、metadata 与 tags 共享一个 client 和快照；事务后 formatter 不得借默认 pool。
schema 初始化和管理员播种直接使用主查询池，不为不受支持的第二应用进程取得启动锁；图片、
词表、内容接入、存储位置等运行期领域锁仍使用独立 advisory lock 池。
公开降级读取由 `database/public-admission.ts` 统一管理一个 FIFO 容量与等待队列，
`database/public-fallback.ts` 负责请求级惰性 reader scope、单连接 SQL 顺序、执行期限和 client
释放 / 淘汰。Redis 缓存读取先行并保留外层并行，首次真实回源才借 client，同一 scope 内的领域模块
显式接收并复用 reader；查询失败、请求取消或 scope 结束后不再启动排队 SQL。
底层 `pool.query` 保持显式调用与原始连接语义。

固定窗口限流的单条通用 Lua、命令定义、注册、参数布局和返回解析由
`core/redis/window-limit.ts` 就近拥有；`core/redis/client.ts` 只构造唯一 client 并维护连接与
能力状态。ready-cache 的六条领域 Lua 位于 `images/ready-cache/redis/scripts.ts`，相邻
`client.ts` 拥有窄 client 类型和 ioredis 命令定义 / 注册，`commands.ts` 拥有参数布局、返回
解析和类型化调用。两组命令都在首次调用前显式幂等注册；注册会保留 client 上已有脚本选项，
使后续 `duplicate()` 继续继承命令，但不依赖全局类型扩充、模块导入副作用或 `core/` 对图片
领域的反向导入。其中两条 ready-cache 只读抽样命令分别接收四个 core key 和六个 derived key，把已解析索引后的
校验、候选数计算、随机成员与 rich item 读取收敛为一次 Redis 调用；脚本不拼接隐藏 key，
也不接收 client ID 或近期去重集合。ioredis 负责按物理连接在首次调用发送 `EVAL`、后续
发送 `EVALSHA`，并在 `NOSCRIPT` 后重发脚本；应用不维护 SHA、启动时预加载清单或 Redis
Functions。检查页按键动态测量的低频 Lua 仍留在 `checks/`，不并入业务注册表。

`storage/` 的稳定目录为：

```text
storage/
├─ backends/   # 配置、记录、注册表、探测、Endpoint 重绑定、读模型、更新、删除和占用
├─ drivers/    # driver 契约、无环工厂、实例生命周期、local 与 S3
├─ objects/    # 对象 key、namespace、访问、传输、校验、列表、图片传输 / 删除准入和公开 URL
├─ cleanup/    # 持久 move.cleanup 类型、仓储、handler 与 service
└─ maintenance-lock.ts
```

图片存储位置变更集中在 `images/storage-location/`。`image-migration.ts` 的单图原语在同一条可读控制流中
完成锁内真相重读、候选发布与校验、PostgreSQL CAS，以及提交结果不确定时的补偿判断；
不为只传递同一记录的 prepare / switch / settlement 阶段拆分文件和中间契约。
`selected-images-migration.ts` 只负责管理接口的 1..N 保序结果，
`storage-backend-migration.ts` 只负责整后端计数和流式分页，两者都直接调用同一个单图原语。
分类 metadata 与正式对象位置相互独立：`image-update-item.ts` 直接提交分类 metadata，根层
`images/theme-reassignment.ts` 持有主题删除时的图片 SQL、revision 和 cache handoff，主题领域仍
拥有词表删除、重试与最终词表同步。`storage/objects/image-transfer-admission.ts` 是所选图片与
整后端迁移共用的活动逐图搬迁许可 owner，两个生产者直接复用同一个代码内固定 5 项容量。
Endpoint 重绑定的完整 `_uploads` 键集合证明位于 `storage/backends/endpoint-rebind.ts`；键按
不透明完整值比较，不解析或重复证明 Ingestion session 分组。
`storage/objects/removal-admission.ts` 是 durable cleanup、orphan / retired、检查维护和回收站删除的
唯一活动存储清理许可 owner，固定只允许一个 provider 中性 `removeObjects(1…N)` 调用；同一调用
涉及多个 driver group 时逐组向该 FIFO 交接，不预占多个排队位置。持久 `move.cleanup` 同时只领取
一个任务，回收站永久删除也逐图取得清理许可后才处理下一项，避免在共享许可前堆积持锁连接。
显式维护按主要资源分流：repair 由 Normalize 容量调度，但替换未采用缩略图时仍取得唯一 cleanup
许可；remove 直接由 cleanup 容量调度。两个资源池并行推进，取消或失败时先在独占位置锁内全部
收口，正常输出再按原候选顺序合并；Ingestion raw / staging 清理重试每次只向清理入口交接一个 attempt，
失败退避期间释放该 worker，让后续候选先行。
Ingestion staging 孤儿按代码内固定 100 项渐进删除。
`checks/storage-check.ts` 只生成无写入权限的存储预览；显式写维护按稳定职责拆分：
`checks/storage-maintenance-plan.ts` 重读 PostgreSQL、Ingestion 引用和完整存储快照并生成候选，
`checks/storage-thumbnail-repair.ts` 负责缩略图写入与校验，`checks/storage-orphan-cleanup.ts`
负责确认删除和空目录修剪，`checks/storage-maintenance.ts` 保留独占位置锁、执行顺序，并把对象
维护与持久彻底删除任务维护汇总为单一检查页操作。
缩略图维修只为数据库已采用的缩略图执行生成前对象探测；未采用状态统一在生成后复核位置与
对象再发布。这组写维护只从显式维护入口调用，不接入普通请求热路径或通用后台任务。
回收站的移入 / 恢复集中于
`images/trash-mutations.ts`；`images/trash-purge.ts` 拥有任务原子绑定与按 job 逐图执行，
`images/trash-purge-job.ts` 只把领域批次结果映射为通用任务结果，
`images/trash-purge-maintenance.ts` 集中维护入口触发的全部耗尽任务重试与异常引用修复；数据库
启动由当前 additions 与 readiness 组成。深度诊断仍属于
`checks/database-check.ts`，正常图片请求不探测任务完整性。`images/image-update.ts` 只拥有 1..N 图片锁、保序并发、逐项结果和
请求级派生计数失效；`images/image-update-item.ts` 是单图 metadata、author / theme / tag
创建、完整标签替换与分类 metadata 更新的 PostgreSQL 事务所有者；主题删除的图片重分配由
`images/theme-reassignment.ts` 拥有。两者都保持 `object_key` 不变，并在同一图片事务中推进
revision、交接同一 mutation sync。

`images/ingestion/` 是 Upload 与 Import 共用的统一内容接入领域，稳定子目录表达允许依赖方向：

```text
ingestion/
├─ sessions/    # 最低层 canonical / intent model、key、codec、命令与 Lua
│  └─ scripts/  # projection、canonical、intents、queue、discovery
├─ queue/       # snapshot、SSE、action、watermark、草稿 CAS 与展示投影
├─ raw/         # 路径、lease、流式接收、Server 准入、generation 与孤儿扫描
├─ sources/     # 安全远端下载、JSONL 与微博适配
├─ execution/   # heartbeat、version fencing 与不可取消边界
├─ commit/      # intent、最终准入、校验、持久化、完成发布、补偿与 coordinator
├─ cancel/      # 取消协调、批量结果和退休资源清理
├─ cleanup/     # 可重发现资源的保守扫描与重试队列
├─ workers/     # download / prepare / commit stage 编排与恢复
├─ repository.ts
├─ runtime-repository.ts
├─ runtime.ts
├─ session-service.ts
└─ staging-keys.ts
```

`sessions` 是不依赖其他 ingestion 子域的协议底层。`raw` 在其上实现 raw 文件与上传接管；
`execution` 组合 session fencing 与 repository facade；`sources` 使用 `sessions`、`raw` 和
`execution` 完成远端接收；`commit` 组合 `sessions`、`execution`、`cleanup`、storage、database
与 vocab；`cancel` 组合 `sessions`、`execution`、`commit`、`cleanup` 与 `raw`。`queue` 内部的
snapshot、SSE、watermark 和展示投影只使用 session / repository 边界，action handler 则负责
协调 `cancel`、`commit` 与 `execution`，因此整个 `queue/` 不是单一底层。`workers` 可以编排
所有这些模块，`runtime.ts` 是唯一生产装配入口；除这两层自身外，ingestion 内任何模块都不能
反向依赖 `workers/` 或 `runtime.ts`。Routes 只依赖 runtime 公开的 service、repository facade、
窄执行控制接口与 DTO，不能导入 Lua、执行协调器或私有 Worker。

- `runtime-repository.ts` 构造进程唯一 repository；`runtime.ts` 是唯一生产装配入口，导入该
  实例后创建 token service、service、`IngestionSessionWorker` 与 orphan cleanup Worker，并只向
  HTTP 层公开 queue action / cancel 所需的窄执行控制接口。Routes 不接触 Worker 实例、stage
  pool、tick、drain 或不可取消边界协调器；HTTP、Worker 和恢复流程仍复用核心 Redis client 上
  的同一 command runner 与 listener hub。
- `sessions/projection.ts` 只拥有稳定哈希与实际使用的 metadata 汇总展示；单项汇总变化的 Server
  权威位于 Redis Lua，不再维护测试专用 TypeScript 投影镜像。
- `images/processing.ts` 在编码轮次前后检查执行取消；已启动的转换与并行缩略图全部收口后才归还，
  Worker 继续持有现有 Normalize、buffer 和 raw 租约，取消不启动下一轮降质或质量回补。
- `repository.ts` 保留命令调用边界、错误翻译与事件发布 facade；实际职责分别由
  `sessions/command-runner.ts`、`replies.ts`、`intent-store.ts`、`listener-hub.ts` 和
  `queue/store.ts` 承接。facade 与内部模块不复制 key 推导、严格解析或业务校验。
- `sessions/import-metadata.ts` 统一投影 Import 接管与首次提交冻结时受 RuntimeConfig 控制的
  `original` 和微博 `source`，只接收配置快照与纯 DTO；session service 与 commit intent 复用
  同一规则，提交意图冻结后的重试继续使用已冻结值。
- `sessions/scripts/` 的五个文件生成十段完整 Lua。`projection.ts` 只保存共享 Lua
  片段，不执行命令；每个业务操作由一段完整脚本和一次 `EVAL` / `EVALSHA` 原子完成，明确声明
  `numberOfKeys`、KEYS / ARGV、返回数组和错误 marker。TypeScript 与 Redis 持久运行时协议
  均以 Ingestion 为父领域：key 固定使用 `imageshow:ingestion:*`，queue 只允许 `upload` /
  `import`；Import canonical 以 `import_download` 保存下载 URL，Upload canonical 不含该字段。共享
  marker 使用 `INGESTION_CANONICAL` / `INGESTION_QUEUE_STRUCTURE`，Upload intent 使用
  `UPLOAD_INTENT`；签名 purpose 固定使用无版本后缀的 `imageshow/ingestion/...` 名称。
  canonical 的 `version`、revision、generation 与 execution token 只承担当前 CAS、顺序、
  对象所有权和执行 fencing。snapshot 在 `sessions/scripts/queue.ts` 内收集有界的缺失 canonical
  排除 session，并以一次 display 扫描区分正常 stale 与孤儿投影；不新增反向索引或迁移职责。
- `queue/events.ts`、`snapshot.ts`、`action-scope.ts` 与 `store.ts` 共同负责 owner + queue 单
  SSE、稳定分页、动作作用域和最近动作批次的有界重放；`action.ts` 编排有界全队列动作，
  `action-protocol.ts` 校验 watermark / continuation，并让冻结最大 accepted order 后的扫描游标
  从 1 单调向上推进；`action-handlers.ts` 执行逐项动作，
  `session-update.ts` 负责 active canonical 草稿和 ready duplicate decision 的 CAS。
- `raw/lease-registry.ts` 是 `active`、`deleting`、`scanning`、`pruning` 可变状态的唯一 owner；
  `paths.ts` 只处理身份与路径，`files.ts` 处理 generation 精确对象操作，`orphan-scanner.ts`
  处理游标扫描和目录修剪，`upload.ts` 收口 credential claim、流式写入与 canonical 转换。
- `commit/worker.ts` 继续唯一拥有 execution fencing、storage / advisory lock 顺序、prepared
  对象采用、事务开始后的不可取消边界和完成发布时机；`target-validation.ts`、
  `persistence.ts`、`staging-cleanup.ts`、`completion.ts` 只承接可独立命名的阶段。
- `cancel/coordinator.ts` 保留 resolving / irreversible boundary、abort 顺序、mutation limiter
  单例和响应丢失后的真相核对；`items.ts` 与 `retired-cleanup.ts` 不建立第二状态 owner。
- `workers/ingestion-worker.ts` 只编排 download、prepare、commit 与恢复扫描；
  `workers/import-prefetch.ts` 按 Normalize 容量维护 FIFO 后继窗口，许可覆盖 Import 远程素材化到
  实际取得图片处理许可。`workers/preparation-admission.ts` 是 Upload / Import 共用的唯一进程级
  prepare / staging publication owner，容量同样由 Normalize 配置派生，覆盖等待图片处理到两个
  `_uploads` 对象及 ready canonical 发布。`raw/upload-admission.ts`、`images/normalization-admission.ts` 和
  `commit/admission.ts` 分别是 raw PUT、全部 Sharp 重工作与最终入库的进程级唯一资源 owner；
  Worker 从 `normalize.concurrency=N` 派生 Import 与 Upload 各自的 pre-commit dispatch slot；Import 在取得
  Normalize 许可时交还，Upload 在本项 prepare 完成时交还，两类补位各使用独立 frozen-tail 游标。
  Import queued 与恢复后的 received 共用一个跨扫描页 FIFO。commit 由
  `ingestion.commit_concurrency=N` 派生大小为 `N + ceil(N / 2)` 的 dispatch window，等待数量或字节许可的
  任务继续占用候补，并以独立 frozen-tail 游标完成事件补位。Sharp 每图线程固定为 1，
  最终入库同时使用代码内 256 MiB prepared 字节预算；
  `workers/session-recovery.ts` 复用同一 repository 做启动、Redis 重连和 expiry 收敛；
  `execution/session.ts` 只拥有同一执行 token 下 heartbeat、progress、阶段发布和失败落盘。
- `cleanup/storage-references.ts` 有界读取 active canonical 的对象引用；`retention.ts`、
  `orphans.ts` 与 `orphan-worker.ts` 负责 60 秒保守周期、完整存储列表、namespace 复核和
  停机排空；`retry-queue.ts` 只清理可由年龄扫描重新发现的 raw / staging。正式 full / thumbs
  仍在复制前由持久 `move.cleanup` guard 接管。

Server 队列模块与 Web 队列 owner 的连接关系保持不变：

- Web 的 `useUploadQueueOwner` / `useImportQueueOwner` 分别组合浏览器来源与 Redis canonical，
  并各自持有重复确认与单卡提交的 single-flight controller；
  `useServerIngestionQueue.ts` 只拥有当前显示队列的连接生命周期与唯一 retained display
  baseline；`useIngestionQueue.ts` 以 `session_id + image_id` 把 SSE、status 和动作中的逐项事实
  投影到所有已保留的当前文档卡片 owner（包括离页项），但不挂载未知 pair 或保存全队列 DTO；
  `model/server-ingestion-job.ts` 在 bounded snapshot 覆盖 handoff revision 前同时保留卡片的临时
  展示页与 summary 占位，来源无关的逐项 active 事件只推进卡片状态，不提前撤销计数或展示租约；
  `useIngestionQueue.ts` 同时用动作逐项结果移除组合投影中同 pair 的已确认清理卡片，包括纯
  Server DTO 与已把显示权交回浏览器的 completed handoff；
  `useIngestionQueueActions.ts` 在每个 continuation 响应后立即把该批结果交还工作流，逐批投影与
  最终权威恢复分离，后续批延迟或失败不会延迟、撤销此前成功 pair；
  raw owner 保留未受影响的有界基线、只作废动作成功前 snapshot 的证明资格，并复用一次权威
  snapshot，失败项和关闭后才完成的任务仍由组合 owner 保留；
  `useIngestionQueueWorkflowActions.ts` 冻结关闭时的 completed 清理边界，并把动作连接保留到上述
  收敛完成，弹窗关闭本身不等待该流程；
  pre-action snapshot 不能证明清理结果，快速重开、普通 refresh 和并发 recovery 复用该 owner
  的 post-action single-flight。
  `model/server-ingestion-queue-state.ts` 负责 revision / version / progress 单调合并，并让当前
  revision 的页内或离页 progress 同步 canonical summary、拒绝旧 revision 回退计数，
  `useStoredIngestionDraftSync.ts` 按硬上限批量排空草稿写入并在 version 冲突时有界回读，
  `useIngestionAuthorityHandoffs.ts` 持有独立于当前页 DTO 和连接代际的 HTTP 接管围栏，
  `cards/useIngestionJobDraftEditing.ts` 在失焦发布前复用 `@imageshow/shared/browser` 的 Ingestion
  草稿 URL 纯格式解析，不接入远端图片请求能力；`useIngestionQueue.ts` 是单队列 controller
  的公开组合入口。
- `useCompletedIngestionInvalidation.ts` 是 completed pair 去重与 PostgreSQL 图片查询失效 owner；
  `model/server-ingestion-job.ts` 集中完成 active / completed DTO 到卡片的单调映射，并以终态围栏
  阻止迟到 snapshot、SSE、status 或 HTTP 结果回退；
  `useIngestionStatusHydration.ts` 以同一个有界 status 请求 owner 处理未知交接与 compact completed
  回执的 PostgreSQL DTO 水合（未知 compact pair 只用于失效而不挂载卡片），每个 effect 只发出一个
  上限内的 status chunk，成功原子落实后才由下一任 owner 消费尾部，保证不发生中止后重发；完成
  去重 owner 同时过滤未知 pair 的 SSE 重放，且后续失败只留下可重试尾部。该 Hook 拥有唯一
  AbortController；SSE view / protocol 纯投影位于
  `model/server-ingestion-queue-view.ts`，不创建第二条连接。
- `model/stored-ingestion-draft-model.ts` 保存 target / authoritative projection 与 CAS 纯决策；
  pending / dirty map、250 ms timer、batch tail、flush 和 revision 等待仍只由
  `useStoredIngestionDraftSync.ts` 持有。
- 两套 owner 不共享页码、SSE、
  busy、清空范围或 action connection hold。内容接入队列不做固定 pair 轮询，只有响应未知的
  已知 pair 才使用一次有界 status 查询。
- `sources/weibo.ts` 只编排批次、去重 UID 的单次作者身份查询和 JSONL 清单；
  `weibo-request-scheduler.ts` 唯一拥有全进程固定
  串行、批次轮转、随机间隔和单一访客身份。链接 / 时间 / 响应提取、受限上游协议、未知响应值
  归一化及公开类型分别位于同目录 `weibo-parser.ts`、`weibo-client.ts`、`weibo-values.ts`、
  `weibo-types.ts`；parser 逐媒体携带实际所属 status 的 UID，不读取 RuntimeConfig 作者映射。
- 图片读取先由 `image-serving-record.ts` 将 Redis 命中与 PostgreSQL fallback 归一为
  同一 serving record；公开正式媒体的 ready-cache 明确空命中仍会在有界数据库读取中查找
  ready 或 deleted 行，入口在缓存和数据库读取前统一拒绝非规范或过长对象键。
  `stored-image-serving.ts` 只编排存储对象与缩略图，
  `external-original-serving.ts` 只处理外部原图探测、跳转和代理。
  `stored-object-response.ts` 集中流式、HEAD、Range 与缓存响应；缩略图缺失在只读 serving
  边界直接映射为 404，显式维修只属于 `checks/storage-thumbnail-repair.ts`，并由
  `checks/storage-maintenance.ts` 在独占维护编排中调用。

`images/ready-cache/` 以真实变化原因分为 `indexes/`、`derived/`、`counts/`、`sync/`、
`integrity/` 与 `redis/`；其中 `redis/` 就近拥有 ready-cache 的 Lua、显式命令注册、窄 client
类型、参数布局和返回解析。`keys.ts`、`model.ts`、`revision.ts`、`source.ts`、`query.ts`、
`ordered-window.ts`、`random-sampler.ts`、`rebuild.ts`、状态观测和 coordinator 等横切模块
继续留在根层。`coordinator-machine.ts` 仍独占 phase、pending refresh、active task / abort、
mutation hold 与 rebuild requirement；归组没有增加第二个状态机或装配实例。

`images/ready-cache/query.ts` 编排筛选索引解析与 cursor / page 定位适配，
`ready-cache/ordered-window.ts` 独占 ZCARD、精确 ZSET 范围、HMGET、水合及前后有效性校验；
公开适配器生成下一 cursor，后台适配器只消费 `PageWindow.start`。
`images/read-models/pagination.ts` 以同一行读取框架承载 PostgreSQL cursor 与 offset，但保留
公开卡片和后台管理字段各自的最小 projection；公开 presenter 保留主题 / 标签稳定 slug 和
高重复的亮度及详情首帧使用的 `image_time`；显示名由 Web 复用
独立 facets 响应投影，后台先截取窗口，再只为最终行投影编辑所需 tags。

领域模块可以依赖 `core/` 和 `config/`，但基础设施不能反向导入具体路由。跨领域调用直接
指向对方表达职责的模块，不通过泛化 `service`、`storage` 或 barrel 隐藏真实依赖，也不能
通过路由或测试工具绕行。PostgreSQL 始终是业务真相源；Redis 模块只实现可重建读模型与
运行时状态。

## packages/web

Web 以路由页面为编排边界，依赖方向为：

```text
pages ──► components / hooks / lib
components ──► hooks / lib
hooks ──► lib
```

- `components/` 按稳定 UI 职责保存跨页面组件；`components/image/editor/` 的数量中性
  `1..N` 编辑器把重复图片卡片与 shell 编排分开，trash 模型和 Hook 集中拥有逐项响应
  对账、权威回读、会话成员修剪及查询失效，不把 mutation 收口重新分散到入口页面。
  `components/feedback/AdminSettingsBoundary.tsx` 复用 `useAdminSettings` 的唯一查询，
  只在取得真实配置后挂载后台图库、词表与设置表单；初次失败提供重试，后台刷新失败时
  保留已有配置和页面状态。图库将该快照经 `IngestionLauncher` 传给 `Ingestion`，
  接入页不再重新订阅设置或写死分页、数量、体积、长边、并发和导入策略的回退值。
  `components/form/TagInput.tsx` 统一拥有按需覆盖、由父框圆角裁切的 22px 边缘按钮与单行标签
  viewport；相邻 `tag-input-scroll.ts` 纯模型计算逐项边界、两端状态与滚轮像素，不把 Upload /
  Import 的默认值和逐图入口拆成四套交互。`TagInput` 本身只把 DOM 几何接到纯模型，并在非交互
  表面的轻点结束时提升编辑器焦点；它不重复决定主轴、消费触摸滚动或提交按钮激活。
  禁用期间保留标签间距、padding 和删除按钮尺寸与符号，仅降低控件透明度并阻止编辑，避免保存时标签宽度跳动。
  `components/data-display/FacetSelector.tsx` 是公开图库与后台图片主题、标签和作者筛选的唯一
  交互 owner；筛选栏不重复显示上方字段标题，收起按钮与展开搜索框保持同一控件 ID 和无障碍名称，候选、已选和
  包含 / 排除仍位于共享 Portal 非模态区域。组件内部显式衔接页面控件与 Portal 的键盘及读屏
  状态，并在直接激活事件内同步提交按钮到输入框的替换及输入焦点；共享样式移除浏览器原生
  search 清除入口，不让页面或视口建立第二套状态。`components/feedback/AnchoredPopup.tsx` 与
  `lib/ui/menu-position.ts` 共同统一页面 fixed、可见边界与弹窗局部坐标映射，并以实际 fixed
  绘制原点吸收软键盘造成的页面平移。
  `components/layout/OverlayScrollbar.tsx` 统一拥有页面与局部容器滚动条：React 只提交可见性、
  几何和拖拽状态，逐帧位置以同一手柄 ref 的 transform 更新，不把连续滚动提升为根渲染。
  `components/layout/PublicStarfield.tsx` 与随组件加载的 `styles/public-starfield.css` 统一提供
  展映、画廊及其嵌入页的固定非平铺星点；SVG 按视口等比裁切，点径保持屏幕像素大小。
  页面仅拥有背景层位置、透明度、遮罩与底色，不再另行绘制平铺星点。
  `components/feedback/DialogLayerPortal.tsx` 是顶层动态视口和嵌套弹窗坐标系的唯一 owner；
  移动图片详情的根层关闭控件继续复用共享 `DirectActivationButton`，不在页面入口复制触控
  关闭分支。
- `hooks/` 保存跨页面且主要管理 React 生命周期或交互行为的 Hook；首页、画廊与展映的导航
  共用 `usePageScrollMovement.ts` 管理 RAF 合并、页面锁定和有界滚动位移采样，
  `usePublicNavigationEntrance.ts` 保证公开主导航在 SPA 会话内只入场一次，
  `usePublicNavigationTopEdgeReveal.ts` 统一识别鼠标移入视口顶部 36 CSS px；首页由独立
  `AppHeader` 接收，画廊与展映由导航阶段 owner 接收，每次移入只唤出一次，区内移动不重置计时。
  只处理可信鼠标事件，`pointerover` 仅接收从文档外进入的情况，Pixi 合成移动和内部悬停目标切换不唤出导航。
  `usePublicImageViewportControls.ts` 统一拥有画廊与展映的导航阶段，并在页面挂载期间拥有
  `viewport-fit=cover`，卸载时恢复原有 viewport meta，根路径别名与嵌入页
  复用同一生命周期。`gallery.css` 为导航、内容与回顶按钮提供安全区布局，导航整体收起包含顶部
  安全区；回顶按钮的固定外层与 `show.css` 的展映外壳使用 `100dvh`，底部操作继续在各自外层内
  按安全区定位。展映尺寸变化由既有 ResizeObserver 传递给画布，不另建 JS 视口状态。
  展映只在自动播放期间启用三秒无点击隐藏，计时器、`click` 监听、整组导航的鼠标进出与焦点转移、
  菜单展开观察均由该 owner 管理。
  `lib/ui/public-navigation.ts` 统一判定导航内的悬停或焦点；精细悬停设备保护导航内的悬停与焦点，
  触控设备只保护 `:focus-visible`，忽略触摸残留的悬停与筛选关闭后的普通按钮焦点。交互期间取消计时并暂停滚动收起，
  首页独立 `AppHeader` 复用该判定保护滚动收起；焦点移出在同一次焦点转移完成后重新读取。
  导航以外的鼠标移动不重置计时；菜单、移动筛选面板或详情展开时同样暂停，所有保护条件解除后
  且展映仍在自动播放时重新计满三秒，隐藏仍写入同一导航阶段。计时 Effect 在布局阶段清理，过期回调核对释放状态、
  当前导航阶段、文档可见性和交互保护；页面隐藏时取消等待，返回后重新计时。展映手动位移携带指针类型；共享 owner 在桌面禁止鼠标拖动及其惯性
  唤出导航，但保留上拖收起、滚轮显隐与移动端拖动显隐，手动位置采样仍连续更新。
  `ShowPixiPage` 将该 owner 的导航可见性映射到页面属性；`show.css` 据此统一控制两种展映模式的
  底部按钮 30% 不透明度与操作提示 20% 不透明度；提示在次级文字色中混入 30% 白色，
  配以 70% 不透明度的深灰描边，导航收起时文字与描边整体淡化，不再隐藏。
  按钮组外扩 24px 的 hover 区域或键盘可见焦点可同步恢复
  两侧控件和提示，不新增导航状态或计时器。
  画廊直接调用共享导航 Hook，不传入自动隐藏时长，只保留滚动显隐；共享 owner 只测量滚动阶段所需的筛选栏高度，
  不维护已移除的画廊计时保护区。展映计时时长由 `lib/ui/public-navigation.ts` 的统一常量提供。
  `useOneShotAnimation.ts` 在动画结束或减少动态效果中断后永久移除本次入口状态，
  `useDocumentMotionPause.ts` 统一把文档隐藏状态交给首页加载 / 刷新反馈和画廊尚未结束的
  有限入场动效。共享
  `usePageScrollLock.ts` 计数化冻结应用根、安装弹窗触摸边界并在最后释放时恢复页面滚动；
  `useDialogFocus.ts` 在相同层级归还 opener，页面和角色模块不得建立第二套 body 锁；
  `useAnimatedClose.ts` 在退场动画完成回调返回前同步提交表面卸载与调用方交互解锁，使首个
  无弹窗或菜单的绘制帧不再保留背景禁用状态。
  `useDismissiblePanel.ts` 还允许把外置的相邻操作登记为同一交互表面，并单独广播子菜单收起；
  移动画廊与后台图片筛选据此让清空关闭 Select / Facet，却不改变外层面板状态。
- `lib/` 保存无界面代码；HTTP 客户端、query key 和共享查询 Hook 集中在 `lib/api/`。
  首页、画廊与展映的主导航滚动阈值和鼠标顶部唤出高度由 `lib/ui/public-navigation.ts` 统一定义；共享公开端
  入场缓动与首页导航淡入时长由 `styles/base.css` 的 motion token 提供，页面样式
  只保留自身阶段和区块时长。`lib/ui/preload-intent.ts` 将普通交互元素的鼠标悬浮、
  键盘聚焦和指针按下统一映射到同一被动预加载动作；接管指针激活生命周期的控件
  仍就近使用捕获阶段事件，公共能力不改变模块、查询或业务激活的所有权。该极小
  跨页面机制归入 `app-foundation`，不产生独立微型请求，也不反向引入后台实现。
  `lib/public-route-modules.ts` 单独拥有 Home / Show / Gallery 的可重试动态导入及 hover / focus
  导航意图，`AppRoutes` 的 `React.lazy`、主导航和首页次级入口复用同一 Promise；它不绑定
  pointerdown，因而不会改变触摸或直接导航路径。`lib/gallery/card-display.ts` 是画廊卡片与
  详情首帧共用的 slug 显示投影，各消费者按会话级 facets 快照复用映射并保留缺失时的 slug
  fallback；`lib/image-url.ts` 只保存详情与画廊权威快照共同需要的原图 URL 判定，不让页面层
  复制同一字段投影。
  `lib/ui/movement-intent.ts` 是触控与指针共用的 5px 移动意图和主轴分类唯一来源；
  `dialog-scroll-boundary.ts` 保存纵向 owner、显式登记的标签横向 owner 与方向纯模型，
  `dialog-touch-boundary.ts` 只管理 capture 触摸生命周期并将已分类意图映射给 owner；共享
  `DirectActivationButton` 另以局部 pointer 生命周期决定直接激活是否仍成立，不选择或移动滚动
  owner，并且只用于会同步关闭、移除、禁用、重绘或重排触控表面及相邻命中目标的动作。移动
  工作流的“应用到全部”会同步重绘面板内容，折叠开关会同步移动面板边界，二者分别使用该直接
  激活边界。共享按钮只在触控 / 笔的 `pointerup` 已按原布局确认后才为默认策略转移目标焦点，
  因而选择菜单与“应用到全部”仍保持原有聚焦语义，却不会因按下即关闭软键盘而在同一手势中移动
  视觉视口和命中区域；目标聚焦引起的编辑器失焦更新同步提交后，动作再读取重渲染后的最新回调。
  需要连续编辑的控件保持输入焦点，折叠开关则保持至收起提交后再释放。三种焦点策略由共享按钮
  集中表达，工作流不建立额外焦点状态或命中位置补丁。
  文档级短期守卫只消费一次直接激活后迟到的兼容序列，并由下一主 pointer 或有界最终清理退休，
  不推断 `touchstart`、多点或页面入口。各层共享纯判定但不共享滚动与激活的可变手势状态，也不
  互相承担入口后置补救；它们只认识坐标、当前顶层 dialog frame 与 DOM 滚动能力，不依赖页面、
  角色或路由。
- `pages/` 保存路由页面与页面级编排，页面专属组件、状态机和 Hook 就近维护。
- `pages/admin/images/useImageAdminPageNavigation.ts` 是后台图库、无主题与回收站数字页的唯一查询
  owner，只保存规范化 scope、目标 page 与最近成功的 scope total 快照，并让 React Query
  处理取消、键隔离、90 秒新鲜缓存和重试；筛选整体清空通过该 owner 显式归一到第一页，因此
  无主题视图中仅删除隐藏主题值时也保留相同分页收敛。同目录 `images/image-admin-list-query.ts` 只构造规范化
  scope、query key、数字页 URL 与纯 total 仲裁模型；页面状态只消费这两个所有者提供的结果。
  `images/ImageAdminFilters.tsx` 以自身容器宽度同步 CSS 的 `947px` 单双行边界，并实际切换筛选项
  DOM 分组，保证单行、双行与移动布局的视觉顺序和键盘顺序一致；设备 / 亮度与三类 Facet 分别
  以 `120px`、`150px` 为弹性基准和下限，五类筛选与清空按钮均不显示额外上方标题。
  图片成员 mutation 通过显式的后台列表失效入口等待该 owner 的刷新错误，其余相关投影仍尽力
  失效，通用图片失效函数不接收页面专用的 query-key 特判参数。
- `AppRoutes.tsx` 将普通与嵌入路径映射到同一 `HomePage` / `GalleryPage`，并把 `/show` 与 `/embed/show` 懒加载到
  同一 `ShowRoutePage`，由它挂载 `ShowPixiPage`。shared 纯目标解析器统一处理三页启停、根路径与首页入口回退，
  普通与嵌入首页共用目标配置，嵌入入口保留 `/embed` 前缀。三页全关时服务端根路径
  和已加载 SPA 都收敛到 404，随机 API 与后台不参与公开页回退。页面参数只决定是否挂载主导航，
  不能复制公开页实现或以 CSS 隐藏导航。服务端仍独立决定嵌入
  文档是否存在并输出父页面白名单，前端开关只负责已加载 SPA 内的路由收敛。
  公开配置就绪后才挂载路由，后台刷新失败时保留已有快照和路由，并把真实站点名传入后台入口；导航和 `SiteHead` 不复制
  运行时默认值。`siteConfigPayload()` 唯一投影描述为空时的站点名回退，服务端 SPA
  文档与浏览器标题、描述、图标消费同一公开配置；HTML 构建模板只保留待注入占位。
- `pages/home/HomePage.tsx` 只编排查询、筛选状态和页面生命周期；首屏、筛选摘要栏
  与候选目录由同目录组件分别维护，首屏控制器只拥有背景与顶层阶段，目录区块单次
  揭示 Hook 就近维护，避免路由组件同时掌握全部首页交互。
- `pages/gallery/` 就近拥有 cursor / ID 数据窗口、typed-array 瀑布流索引、半屏滞回虚拟窗口、
  共享可见性观察器、查询级揭示 high-water 与开发统计；导航状态机由
  `hooks/usePublicImageViewportControls.ts` 统一提供给画廊与展映；跨页面可复用的 DOM
  图片加载、解码和并发调度留在
  `components/image/`，页面层只设置画廊任务的优先级、暂停和驻留边界。无界面的
  页面滚动边界归一化放在 `lib/ui/`，由共享采样 Hook 提供给各页面交互状态机。图片编辑
  保存时，数据窗口用权威快照原位更新唯一命中卡片并保持其他卡片对象，再以同一 cursor
  后台水合该页；筛选成员、几何和游标变化继续由数据窗口原子提交。`LazyGalleryImage` 在资源地址
  变化时清除旧地址的完成与失败状态，旧任务由既有任务清理和结果围栏隔离；共享调度、可见性与
  驻留边界不重建。共享图片详情的标题在展示图地址未就绪时保留纯文本布局，不产生空链接或
  额外 Tab 停靠点；有效地址就绪后才提供直链。共享图片详情弹窗只在
  完整展示 frame 就绪后恢复真实 `<img>` 命中，加载期透明 frame 与详情以外的
  `ProgressiveImage` 消费者继续沿用不可命中的共享默认值。
  `lib/gallery/gallery-query.ts` 保留完整语义的画廊路由状态，并在公开列表 query key 建立前把
  `device=auto` 通过 shared User-Agent 纯函数投影为具体设备或无条件；随机链接则把缺省全部设备
  投影为 `device=all`，并为自动设备省略该参数。画廊整体清空只进行一次空筛选路由写入，让列表
  查询和随机链接从同一 URL 状态同步更新。共用 `PublicImageToolbar` 移除筛选及操作控件上方标题，
  并把“随机API”作为链接框内前部的固定文字；随机链接显示层测量剩余宽度的真实溢出，只在裁切时于复制按钮
  保留区前追加贴合基线的 ASCII `...`。标题和省略号不可选，链接提供只读文本框语义；首次点击或
  键盘聚焦时通过原生 Selection 全选实际 URL 节点，焦点内后续点击保留局部选择，失焦后重置。
  复制按钮不使用截断后的显示文本。
- `pages/show/` 就近拥有公开展映编排、真实图片查询与 `pixi/` 生产运行时；不保留旧实现对照入口。
  乱序池使用随机 JSON 批次，最新 / 最旧池保持公开列表 cursor 顺序；最多保留 800 个唯一 DTO，
  删除成功后取消并隔离较早的读取响应；编辑成功或编辑快照需要刷新时，由同一数据流重新查询
  当前筛选成员，替换失败可显式重试，普通补图失败不会被逐帧信号重复触发。
  先无重复领取全部候选，只有有限筛选结果不足以填满活动槽时才循环复用。`mode=waterfall|float`
  是正式 URL 状态，省略或无效时回退 `site.show.mode`，读取默认值不改写 URL。
  `ShowPixiPage` 从同一公开配置中的 `site.show.autoplay` 初始化播放状态，访客启停只属于当前挂载。
  该字段默认值由 Shared 唯一提供，首次播种通过 `SITE_SHOW_AUTOPLAY`；普通设置 DTO 不包含
  `site.show`、`site.home.browse_target` 或 `site.gallery.enabled`，这些新增项由配置文件或高级配置维护。
  `ShowPixiPage` 根据当前查询构造明确目标模式的链接，`ShowControls` 以 React Router `Link` 渲染；
  手动切换始终保留显式 `mode`，筛选与顺序更新保留模式参数的显式或缺省状态，模式切换不重建图片查询。
  `pixi/show-pixi-runtime.ts` 唯一持有 Pixi Application、ticker、ResizeObserver、页面可见性、
  reduced-motion、context lost / restored、场景租约和共享纹理 LRU；纹理入口直接读取真实
  `thumb_url`，按屏幕尺寸选择 LOD、限制并发与像素预算，并在 WebGL2 生成 mipmap。
  原图比例参与解码裁剪，缓存共享同规格引用；容量不足的卡片持有可取消等待，在引用释放后
  重新领取纹理，不重新布局。网络传输失败暂停该 URL，同源连续失败暂停该来源；浏览器恢复
  联网或用户恢复播放时统一允许传输重试。运行时还捕获文档内真实图片的 `load` 事件：详情成功加载
  同一缩略图 URL 后，清除该 URL 的传输 / HTTP / 解码失败记录，并解除同源传输暂停；资源键、等待与
  成功信号统一使用浏览器 URL 解析后的形式，避免域名大小写或默认端口造成匹配失败。其他失败 URL
  保持原记录。所有失败卡片沿用可取消的缓存可用性等待，重领纹理不重新布局；若仍失败则再次暂停，
  不逐帧重试、不重建画布、不清空健康纹理，卸载时移除成功事件监听。
  运行时在有效自动播放状态变化时上报 `onMotionActiveChange`，同一状态供调试快照使用；`ShowPixiPage`
  结合播放开关与数据就绪状态启停导航计时，初始化完成前、无图、加载、错误、减少动态效果、详情、后台或 WebGL 中断期间均不启用。
  生产默认不创建统计 output、帧样本或长任务 observer；开发模式自动开启，生产排查时可在进入展映前
  设置 `window.__imageShowPixiDiagnostics = true`，再通过 SPA 导航进入展映。此挂载期间会暴露
  `window.__imageShowPixiDebug`，可读取快照、重置指标和验证 WebGL 恢复；关闭标记后重新进入即可停用，
  整页刷新也会清除标记。采样沿用同一个 ticker，统计最多每 250ms 输出一次；float 的覆盖与重叠率仅
  在读取快照时计算。诊断不参与运动、导航或加载控制，不增加查询参数和持久配置；卸载释放采样 observer。
  运行时统一记录原生指针是否位于画布内；离开画布、窗口失焦或页面隐藏后关闭场景指针命中并
  清除卡片悬停，不清除键盘焦点。Pixi 的 document 合成移动不能重新激活过期坐标。
  卡片以整段指针移动记录点击意图，超过拖动阈值后即使回到起点也不打开详情；原生指针取消
  或第二个触点按下会在运行时清理全场意图，跨卡片双指操作也不会误触详情。
  `waterfall` 通过 ImageShow 自有窄相机处理坐标换算、drag、wheel、pinch、惯性、中心锚定缩放与
  可视区域，独立竖列只保留视口缓冲内 Sprite。相机只从拖动、普通滚轮和惯性平移分支上报导航纵向位移；
  `show-pixi-layout.ts` 定义 `3G` 提示阈值与 `8G` 上限；`ShowPixiPage` 唯一持有本次挂载的确认状态及待应用密度比例。
  按钮与相机共用列数请求入口，wheel / pinch 在跨过 `3G` 前同步取得允许的缩放值，普通缩放帧仍留在相机内。
  未确认时停在 `3G`，确认后应用请求；比例按当前视口换算。提示复用 `DialogFrame` 的焦点、页面锁和退场回调，
  只加载展映自身样式；运行时通过同一个 `dialogOpen` 状态暂停详情或提示背后的画布输入与动画。
  相机与 float 控制器都在拖动和松手惯性中保留指针类型，普通滚轮不继承前次拖动的输入类型。
  场景不再用相机顶部坐标差推断手动位移，按钮缩放、Ctrl + 滚轮、双指缩放、锚点修正、resize 与自动巡航均不触发导航显隐。
  自动巡航在手动运动结束后立即恢复，不使用固定等待或按时间猜测手动位移。
  `ShowPixiFloatScene` 直接拥有屏幕坐标、生命周期空档、混合尺寸面积密度、路径预测与速度间距反馈，
  以同一速度计算推进图片和预测遮挡；50%–130% 的宽度序列同时用于实际卡片和纹理预取。
  自动漂浮开关只控制自动位移与相位推进；手动拖动、滚轮和惯性按有界空间步长推进卡片流，每段统一处理
  上下两端越界回收，在相反进入端补图，暂停时继续工作，不把现有卡片边缘当作滚动终点，也不保存历史区域。
  反向清除旧方向的滚轮余量或拖动惯性，仅调配完全屏外的卡片平衡上下储备，优先使用已解码纹理；
  入场位置与外侧回收边界保留余量，回收高度覆盖当前尺寸与目标尺寸。手动移动清除旧布局的纵向追赶目标，
  自动漂浮与路径预测在手动运动期间让位，运动结束后立即按暂停开关恢复。
  初始摆放和运行中的局部避让共用位置评分，路径调整在既有 ticker 中逐张错开执行；横移保持
  平滑速度，每张卡片独立持有漂移与 ±3° 旋转相位。鼠标悬停在约 240ms 内摆正平面角度，
  释放后在原相位上从当前角度继续，不跳回旧倾角；键盘焦点只保持运动。尺寸改变时超额卡片
  渐退，保留卡片平滑重新分布；目标卡片总数包含屏外卡片，窄屏为 6–96 张、宽屏为 8–180 张。
  float 最多使用 500 张候选，不足 96 张请求补充；waterfall 在可用候选不足 96 张或布局缺图时
  请求补充。float 随机池增量更新保留已有候选顺序，只对新增候选洗牌，避免重排屏内卡片；
  两者均保留总数小于 800 的条件。上下缓冲分别拥有稳定的后续图片与尺寸计划队列，
  合计预取窄屏 6–18 张、宽屏 12–36 张，平分预算，奇数时下方多一张；反向保留另一端队列。
  卡片先接管同一纹理引用再释放已消费计划，补图批次结束后补足队列，尺寸变化时更新纹理尺寸；
  两端回收按进入端的生命周期空档安排入场，共用既有缓存、像素和并发上限。
  两个场景复用同一圆角纹理几何、1 屏幕像素边框、命中与交互桥接；每张卡片持有唯一命中矩形，
  稳定尺寸且现有绘制签名有效时跳过几何计算，尺寸、纹理、交互层级和渲染比例改变沿原有失效入口更新。React 只
  渲染控制、详情及有界键盘 / 读屏代理；初始化时停用 Pixi 自动无障碍系统，避免移动端多出
  独立激活按钮或第二套焦点入口。键盘焦点沿 Stage、runtime 和 scene 使用卡片 key，只影响该槽位，
  同图副本保持独立；指针打开详情返回画布宿主，键盘打开详情返回实际代理，详情数据使用图片 ID。
  原生指针重新操作画布时将真实 DOM 焦点从代理交还宿主，避免定期可见列表更新重新激活旧卡片。
  详情期间暂停导航阶段变化和代理焦点同步；关闭后保持先前导航显隐，指针命中等待新的原生画布事件。
  代理列表提交后从实际 DOM 聚焦元素同步卡片状态，代理移除时
  不依赖浏览器发出 blur；卡片复用新身份清理旧焦点，同一身份的尺寸或纹理更新保留焦点。
  场景切换先销毁旧控制器及输入对象但保留预算内纹理，
  路由卸载再统一释放 Canvas、ticker、事件、observer、Bitmap 与纹理引用。
- `pages/admin/` 按稳定页面职责分为 `shell/`、`account/`、`images/`、`check/`、`storage/`
  与 `advanced-config/`；只有 `LogPage.tsx`、`Overview.tsx`、`SettingsPage.tsx`、
  `UserAdmin.tsx`、`VocabularyAdmin.tsx` 及其单个卡片等没有形成三文件族的页面留在根层。
  每个页面专属查询、操作 Hook、对话框和状态机都留在同一目录，不上移为虚假的跨页面公共层。
- `pages/admin/ingestion/` 管理统一 prepared ingestion 队列，稳定分为 `queue/`、`workflow/`、
  `upload/` 和动态 `import/`。统一内容接入是上位领域，`upload` / `import` 分别表示浏览器
  Upload 与 Server Import，内部 mode 也使用 `upload` / `import`。
  `Ingestion.tsx` 装配两个 owner、当前 mode、激活意图、
  来源弹窗加载与工作流窗口；`queue/` 保存 queue controller、API、状态回读、SSE、草稿同步及 `model/`、
  `cards/`；`upload/` 保存本地文件模型、raw XHR lane 和上传 owner；`import/` 保存 URL、JSONL、
  微博来源模型、弹窗与 Import 接收 owner；`workflow/` 保存窗口、稳定 DOM 区域、清理和动作状态机。
  来源弹窗由 `import/` 独立动态加载。配置段使用同一领域词汇：Import 来源使用
  `import.*`，Upload 专属入口使用 `upload.*`，共用原图准入、队列分页与提交使用
  `ingestion.*`。`data/config.json` 只按当前默认结构投影、校验并原子
  写回；当前结构之外的字段直接删除。
- `queue/model/ingestion-status-summary.ts` 是单项服务端状态桶纯函数，快照移除与取消释放分别
  解析输入后复用；不保存队列状态，也不替代 Redis 汇总权威。
- `import/ImportSplitButton.tsx` 复用共享 anchored menu 的焦点外关闭及按来源决定 Escape 归焦；
  键盘打开与悬停打开分开处理焦点。来源标签页维护 roving tabindex 和关联 tabpanel，保留指针输入流程。
- `LogPage.tsx` 保存等级成功后取消旧日志读取，将已确认等级写入所有现有日志文件查询，
  只刷新当前活动文件一次；刷新失败保留确认值，不新增等级查询或延时同步。
- `SettingsPage.tsx` 仅拥有当前未保存表单，后台回读只在 clean 状态更新；保存与重载禁用整个表单，
  使用 15 秒请求期限，成功由 POST 返回值直接更新唯一 settings 查询，失败保留提交内容。
- `VocabularyAdminCard.tsx` 按字段对照上一权威基线维护 clean / dirty，同 slug 回读只同步 clean 字段，
  成功保存立即采用规范化值，切换词条身份重新初始化。
- `lib/api/client.ts` 集中 JSON 解析失败、凭据和 401；`apiResponse` 为配置包提供原始文件响应。
  元数据与接入完成复用词表成员比较，仅新词条超出已有缓存时失效一次 `ingestionVocabulary`。
- `IngestionLauncher.tsx` 只拥有入口按需加载与激活意图：启动阶段复用页面根 `inert` 锁而不禁用
  图片页按钮，`Ingestion.tsx` 在最外层 `DialogFrame` 挂载后以同一引用计数锁完成无缝交接；
  关闭只退休仍活动的意图，加载失败则在根锁清理后归焦仍连接的启动入口。来源菜单在自身退场前
  同步提交启动意图，不持有动画结束后的延迟激活。模态生命周期的焦点、滚动和背景命中仍只属于
  共享弹窗边界。
- `workflow/IngestionWorkflowWindow.tsx` 拥有 DialogFrame、焦点捕获 / 恢复、滚动容器、
  关闭 / 隐藏、详情 / preview target、cleanup confirmation scope、mode 和 owner 选择；
  `IngestionWorkflowRegions.tsx` 只渲染 header、defaults、queue body、summary 与 footer，DOM 顺序、
  class、ARIA 和 focusable 顺序不变。queue body 在首份服务端快照前直接绘制非权威的默认选择入口，
  并让它跨过汇总到卡片的水合间隙；未完成任务仍只由现有有界 `visibleJobs` 投影替换为真实卡片。
- `queue/cards/useIngestionJobDraftEditing.ts` 是任务卡片文本焦点会话的唯一 owner：标题、主题 /
  作者键入、原图 URL、来源 URL 和详情描述只在有效 attempt 内保留临时值，并在失焦时向 queue
  controller 至多发布一次实际字段变化。共享 `ImageDraftFields` 与 `SlugComboInput` 只提供可选的焦点 / 发布
  边界，图片编辑器、工作流默认值和其他组合框仍使用原即时语义；250 ms 批处理、CAS、重试、
  revision 围栏与页外持有仍只属于 `useStoredIngestionDraftSync.ts`。
- `upload/useUpload.ts` 仍唯一拥有 Blob URL、active XHR、AbortController、in-flight
  Promise 与 effect cleanup；`upload-jobs.ts` 只处理文件准入和 intent 输入，
  `browser-upload-lane.ts` 以页面级 FIFO owner 统一约束预览解码、短凭据请求和 raw PUT，
  并以不占容量的批次顺序器保证一次选择完成 preview→credential→raw 交接后才允许后一次选择
  入队预览；`raw-upload-batch.ts` 负责把 raw XHR 绑定到这个 owner，并让上传 owner 分批签发短凭据。
- `pages/admin/shell/admin-route-modules.ts` 集中拥有后台路由页面的生命周期级动态加载器；
  `AuthenticatedAdminShell` 的 `React.lazy` 与桌面 / 移动导航意图共用这些 Promise。
  `AdminNavigation` 只为角色过滤后可见的内部页面绑定模块键，外部“首页”出口不猜测
  根路由目标。键盘 focus 与 pointerdown 立即预加载；普通后台页的鼠标 hover 立即加载，
  高成本高级配置页只有持续 150 ms 的细指针 hover 才加载，离开或取消会清除 dwell。
  预加载只能取得页面 JS、CSS 与静态依赖，不能挂载页面或提前执行查询；正式导航复用
  同一个页面生命周期 Promise。
  冷启动资源所有权分为公开、后台登录、图片管理员与超级管理员四层；直接访问无权 URL
  仍先完成角色过滤，不执行超级管理员页面加载器。`CheckPage` 保留两种管理员共用的只读
  状态与检查，`CheckMaintenanceCapability` 才拥有整后端迁移、合并对象与持久彻底删除任务的
  存储维护、缓存重建及其样式。
- `styles/` 按 base、home、gallery、admin 和 responsive 组织全局样式；首页进一步
  将页面 / 首屏基础、候选目录基础及共享响应式交互分文件，并按该顺序引入。公开页
  不参与动画的 fixed 导航外壳与主次导航共用的位移栈由 `public-layout.css` 维护，根滚动回弹边界位于
  `base.css`；展映和画廊共用 `public-layout.css` 中按整组导航高度计算的位移，主导航、筛选栏和背景同步滑出，
  不叠加筛选栏独立位移或背景裁切动画。首页保留自身第二导航栏的显隐方式。
  `styles/semantic-colors.css` 拥有启动暗色、公开页源颜色及共享组件的公开上下文映射；
  启动画布的普通文字、成功、危险与错误反馈文字都由颜色门禁验证至少 4.5:1 对比度；
  `styles/admin/semantic-colors.css` 独立拥有后台源颜色和后台上下文映射，并只随后台
  路由或公开详情中经授权加载的管理能力懒加载。公开可达的管理详情和编辑器必须让
  后台色契约跟随自身能力块，不能依赖用户曾访问后台；嵌套管理弹窗会在局部重映射
  共享控件别名并继承当前文档的亮暗分支，不改变外层公开页颜色域。token 按视觉职责
  和状态命名，不把当前色相写进契约；页面和组件样式只能消费语义 token 或上下文
  别名，原始颜色只在语义契约源中声明。后台颜色契约同时为后台路由、管理弹窗及公开详情中按需
  加载的管理动作提供同一套单像素焦点环，避免各入口回退到浏览器黑白粗框；
  后台成功、警告、危险和处理中状态只保留文字、表面、边框、动作、进度及必要强弱
  层级，导入阶段、登录、校验或具体页面直接映射这些角色，不另建流程专用色板；相邻
  生命周期确实需要一眼区分时使用通用的 `soft` / `subtle` / `strong` 强度，而不是
  再以页面名或阶段名创建颜色。检查卡、瞬时反馈和完成任务也按这一原则保留必要层级；
  后台亮色分支让侧栏、移动导航和内容区共享白色表面、黑灰文字与浅边框；暗色分支
  使用独立的暗色表面、亮色文字与满足交互边界辨识的控件边框。两个分支都只让蓝色
  承担当前项、选中态和主要动作，并通过同一组职责 token 的 `light-dark()` 值切换；
  暗色大面积交互蓝和带色透明层不能机械复用亮色 RGB，应按暗底重新提高可见度并适度
  降低饱和度，但仍须一眼可辨主色相；实色主操作蓝保留明确色度，不参与表面层的
  去饱和策略。
  只有白色强调文字、纯黑阴影及代码、日志、图片舞台等固定暗底内容可按其内容契约共色，
  不重复声明或在组件中覆盖颜色；控件、卡片、弹窗及页面排布采用各自的当前几何，
  后台卡片集合的网格间距统一为 6px。
  只有整张表面承担点击职责的概览卡、最近图片、图片主卡和新增存储卡使用轻微抬升、
  蓝色边框及焦点环，含表单或独立动作的配置卡保持静止，且减少动态效果时取消位移。
  后台外观模式提供显式亮色、暗色与自动；自动模式跟随浏览器或操作系统并实时响应
  变化。公开页面和启动底色仍拥有独立颜色上下文；未认证登录页与公开页面中的管理弹窗
  都继承公开暗色分支，不读取后台保存的外观偏好，只有认证后的完整后台应用账号偏好；
  `tests/verify/check-semantic-colors.mjs` 校验传统与现代颜色语法、完整 CSS 命名色、
  SVG 资产白名单、定义/引用完整性、无用 token、按色相命名及公开/后台依赖边界，
  并拒绝超出规范集合的后台状态角色；
  当前品牌 favicon 是唯一允许保留原始色值的 SVG。

`lib/`、`hooks/` 和通用组件不得反向导入具体页面。只有形成稳定跨页面职责的代码才上移，
页面内部的小组件无需为目录对称而拆分。

### Web 构建资源边界

Web 继续使用 entries-aware 的入口根集合分块，`minShareCount: 2` 表示模块至少被两个真实
动态根共同引用才形成共享块。资源边界的判断顺序固定为权限、路由 / 能力意图、请求经济性：
只有权限可见性、最早懒加载祖先和全部受测闭包都相同的资产才可以合并。交叉入口小块若并入
任一调用方会造成未访问能力预载或复制，就保留为可解释的独立共享成本。

生产 JS 与 CSS 使用从 Vite / Rolldown 构建图推导的简短语义 `[name]-[hash]` 文件名。动态
入口沿用真实 facade 的职责别名，共享块名称来自实际入口根和能力关系；不按字符数截断，
也不使用序号命名或构建后 import 重写。内容哈希仍是缓存身份，名称只负责解释职责。每次生产构建都生成
`.vite/web-build-report.json`，记录 facade、dynamic importer、入口类型、静态 / 动态依赖、
模块根和 CSS owner；服务端装配明确过滤 `.vite`，因此报告不进入最终镜像。

内容接入 facade 与样式使用 `ingestion-[hash].js` / `ingestion-[hash].css`，来源弹窗使用
`import-source-[hash].js`，facade 与来源弹窗共享的 URL 来源解析能力按实际职责命名为
`import-job-source-[hash].js`。`upload` 与 `import` 分别作为浏览器文件和 Import 来源子模式，
父领域资源统一使用 `ingestion` 命名。

本地 `check-web-chunks` 从真实输出计算原始、gzip 9、Brotli 11 和实际有效响应体字节；
gzip 与 Brotli 各自只要结果严格小于原始响应体就采用，不设置最低原始体积或最低节省量。
这组参数由 `scripts/build/` 中的生产装配 helper 与本地 checker 共用，不在 Vite 阶段额外落盘
整套 `.gz` / `.br`。门禁验证匿名公开入口、后台登录、图片管理员和超级管理员路由的权限及
懒加载闭包；公开闭包出现后台专有资源、图片管理员闭包出现超级管理员专有资源、哈希失效或
重复内容都会直接失败。

本地报告列出未压缩小于 8 KiB，或生产有效响应体小于 4 KiB 的 emitted JS 与 CSS，并统计
512 B、1 KiB、2 KiB、4 KiB、8 KiB 原始体积档位及有效体积档位；这只用于发现可合并资源，
不是页面请求数或响应体积预算。只有与目标页面必然同行且不扩大权限、路由或能力懒加载边界的
资产才合并；资源门禁以真实构建图、权限闭包、同行关系和重复内容为准，总文件数本身不是目标。
报告保留全部入口必达的 Rolldown runtime，该虚拟 runtime 不进入模块 ownership 分组，也不在
构建后改写 import 或内容 hash。正文压缩采用规则与分块采用规则彼此独立。报告还会发现主构建
图之外的 Worker 入口，并把它们纳入体积、命名和重复内容审计；
ALTCHA PBKDF2 Worker 必须由浏览器通过独立 URL 创建，且只在实际出现登录挑战时加载，不能并入
登录页首屏脚本。门禁同时拒绝具有完全相同入口根的重复 emitted JS、具有完全相同 owner 的重复
CSS，以及内容完全重复的资产。

当前镜像的运行时传输、浏览器 profile 和 450 图 Upload 工作负载只属于本地发布验收，保存在被
Git 忽略的 `tests/benchmarks/`。它们不进入 `scripts/`、npm
package scripts、Actions 或生产镜像；`scripts/` 继续只保存构建和容器运行所需命令。权威的
固定媒体身份和验收边界见[架构总览](./architecture.md#浏览器传输验收)。

## docs

`docs/guide/` 保存普通 Markdown 现行文档。`roles/` 按普通用户、图片管理员、超级管理员和
实例维护者提供任务入口；同级主题文档维护架构、配置、数据库、流程、部署和 API 的唯一完整
契约。角色页只链接技术参考，不复制容易漂移的底层细节。
这些文档不生成或提供在线站点。
