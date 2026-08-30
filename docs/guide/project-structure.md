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

GitHub Actions 只核对 dev 分支或 release tag、根包 / 三个 workspace / lockfile 版本，
然后通过已审查的公开 Action 稳定主版本标签构建和推送生产镜像、创建 Release；job 不设置
项目自定义总运行时限。它不运行
`verify:*`、Knip、最终测试、数据库、存储、浏览器或性能验收；Action 成功不能替代本地
`verify:release`。

## packages/shared

共享包是前后端唯一共同依赖，只承载稳定的配置默认值、类型、校验常量和 DTO。

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
  创建 HTTP 应用，初始化 / 校验 schema 与管理员初始化，启动 Worker 和 HTTP 服务，并处理
  优雅退出。
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
| `core/` | 领域无关的运行可用性、安全抓取、日志、密码、UUID、并发和通用校验；不依赖业务领域或路由。只有未形成稳定三文件族的横切模块留在根层。 |
| `core/database/` | PostgreSQL pool、事务、advisory lock、公开 fallback 准入、schema 装配和 readiness；`readiness/` 只承载数据库基线断言的内部职责。 |
| `core/redis/` | 唯一 Redis client、业务 Lua / 命令注册、JSON、pipeline、条件字符串和窗口限流基础设施；不导入 ready-cache 或其他业务领域。 |
| `core/http/` | HTTP 响应与响应头、请求来源和请求体限制、压缩阈值、条件请求、静态响应与 Range 解析。 |
| `config/` | 部署环境、首次播种、运行时配置 schema、无导入副作用的文件读写与显式进程内 store，以及配置包；`runtime-config-environment.ts` 是全部 RuntimeConfig 叶子到首次 seed 变量的唯一映射。 |
| `routes/` | HTTP 方法、鉴权、CSRF、输入解析和响应投影；业务工作委托给领域模块。 |
| `images/` | 图片读写、展示投影、分类与元数据变更、回收站和缩略图；`page-window.ts` 唯一计算安全数字页窗口，`ready-cache/` 拥有统一 Redis rich 投影、筛选、统计、精确同步与重建，`ingestion/` 拥有 Upload / Import 的完整接入会话生命周期及清理任务，`read-models/` 承载 PostgreSQL cursor / offset 读模型。 |
| `storage/` | 只在根层保留横切 `maintenance-lock.ts`；`backends/`、`drivers/`、`objects/`、`migration/` 与 `cleanup/` 分别拥有注册表、驱动、对象原语、搬迁和持久清理。 |
| `random/` | 随机查询校验、设备轴推断、Redis 8 Array 最近历史、定向 id 与有界 pivot 普通随机 PG 降级查询及随机出口编排；Redis 候选投影、筛选与重建统一由 `images/ready-cache/` 提供。 |
| `jobs/` | 仅拥有通用 `background_job` 生命周期、小型类型分派、公平调度 Worker，以及集中管理任务中止、期限、续租和有界排空的执行协调器；各领域拥有自己的 handler、payload 和结果语义。 |
| `checks/` | PostgreSQL / Redis 独立轻量状态、数据库 / Redis / 存储手动深度检查、“全部”中的回收站一致性结果，以及显式触发的存储维护；状态页自动 Redis 深检与手动 Redis 检查复用同一有界扫描和 pipeline，只返回当前汇总。 |
| `authors/`、`tags/`、`themes/`、`vocab/` | 词表查询、变更、关联锁与派生缓存。 |
| `users/` | 管理员初始化、账号变更、Redis 登录会话、逐请求 PostgreSQL 角色与密码代际核对、操作授权、密码恢复、偏好和会话失效；不维护管理员凭据 Redis 投影。 |
| `types/` | 仅放缺失的编译期声明，不承载运行时代码。 |

`routes/` 当前保留 18 个直属文件。`admin-vocabulary.ts` 在一个 HTTP 能力边界中声明 tags、
themes 与 authors 三组同构 CRUD，通用 registrar 为文件内私有实现；每组仍分别注入自己的
schema、查询、变更和删除权限，不把领域业务搬进路由。`public.ts` 私有持有 Hono 请求到
`StoredResponseRequest` 的 header / signal 投影，共同服务该文件内 media 与 thumbnail 两个入口。
其余短 registrar 即使只有一个导出，也分别拥有独立 URL、鉴权 / 权限、中间件顺序、Host
或缓存契约；不按行数与相邻文件合并。`http-app.ts` 仍显式展示公开路由、管理员 session、
CSRF、请求体限制和各管理能力的装配顺序。

`core/database/` 按 PostgreSQL 生命周期边界拆分：`pools.ts` 只接收显式配置并拥有主查询与
advisory lock 两个连接池；`transactions.ts`、`advisory-locks.ts` 和 `schema.ts` 分别拥有
事务、锁与干净安装编排。advisory lock 调度信号只取消连接取得与锁等待；锁内回调收到独立的
父锁 / 当前连接失效信号，由具体领域决定是否再合并请求、lease 或 deadline。`readiness.ts`
是唯一总入口，按固定顺序调用
`readiness/relations.ts`、`privileges.ts`、`indexes.ts`、`foreign-keys.ts` 与 `seeds.ts`；
`readiness/contract.ts` 是最小表、列、权限、主键、索引与外键 contract 的唯一数据来源；
`readiness/seeds.ts` 是稳定种子断言的唯一来源，其他检查模块不得复制两者。
后台数字页使用 `database/transactions.ts` 的 read-only repeatable-read 事务，让 COUNT、
越界判断、metadata 与 tags 共享一个 client 和快照；事务后 formatter 不得借默认 pool。
schema 初始化和管理员播种直接使用主查询池，不为不受支持的第二应用进程取得启动锁；图片、
词表、内容接入、存储位置等运行期领域锁仍使用独立 advisory lock 池。
公开降级读取由 `database/public-admission.ts` 统一管理一个 FIFO 容量与等待队列，
`database/public-fallback.ts` 只负责请求级惰性 reader scope、执行期限和 client 释放 / 淘汰。Redis
缓存读取先行，首次真实回源才借 client，同一 scope 内的领域模块显式接收并复用 reader；
底层 `pool.query` 保持显式调用与原始连接语义。

高频且必须保持原子性的 Redis Lua 由 `core/redis/business-scripts.ts` 单独持有脚本文本，
`core/redis/business-commands.ts` 统一声明七个 ioredis 自定义命令、key 数量、读写属性、
参数布局和返回值解析，`core/redis/client.ts` 在唯一 client 构造点注册。限流与 ready-cache
领域只调用类型化命令；ready-cache 的键和容量策略作为参数传入，`core/` 不反向依赖图片
领域。其中两条只读抽样命令分别接收四个 core key 和六个 derived key，把已解析索引后的
校验、候选数计算、随机成员与 rich item 读取收敛为一次 Redis 调用；脚本不拼接隐藏 key，
也不接收 client ID 或近期去重集合。ioredis 负责按物理连接在首次调用发送 `EVAL`、后续
发送 `EVALSHA`，并在 `NOSCRIPT` 后重发脚本；应用不维护 SHA、启动时预加载清单或 Redis
Functions。检查页按键动态测量的低频 Lua 仍留在 `checks/`，不并入业务注册表。

`storage/` 的稳定目录为：

```text
storage/
├─ backends/   # 配置、记录、注册表、探测、读模型、更新、删除和占用
├─ drivers/    # driver 契约、无环工厂、实例生命周期、local 与 S3
├─ objects/    # 对象 key、namespace、访问、传输、校验、列表、删除准入和公开 URL
├─ migration/  # 共享准入、单图 CAS、整后端迁移、relocation 与 endpoint rebind
├─ cleanup/    # 持久 move.cleanup 类型、仓储、handler 与 service
└─ maintenance-lock.ts
```

图片存储变更的单图原语集中在 `storage/migration/image.ts`，在同一条可读控制流中
完成锁内真相重读、候选发布与校验、PostgreSQL CAS，以及提交结果不确定时的补偿判断；
不为只传递同一记录的 prepare / switch / settlement 阶段拆分文件和中间契约。
`images/selected-image-storage-migration.ts` 只负责管理接口的 1..N 保序结果，
`storage/migration/backend-images.ts` 只负责整后端计数和流式分页，两者都直接调用同一个单图原语。
`storage/migration/admission.ts` 是所选图片、整后端迁移与主题重分配共用的活动逐图搬迁许可
owner，所有生产者直接复用同一个代码内固定 5 项容量。
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
负责确认删除和空目录修剪，`checks/storage-maintenance.ts` 只保留独占位置锁、执行顺序和结果汇总。
缩略图维修只为数据库已采用的缩略图执行生成前对象探测；未采用状态统一在生成后复核位置与
对象再发布。这组写维护只从显式维护入口调用，不接入普通请求热路径或通用后台任务。
回收站的移入 / 恢复集中于
`images/trash-mutations.ts`，永久对象删除与 claim 状态机集中于 `images/trash-purge.ts`，
两者不共享转发入口。`images/image-update.ts` 只拥有 1..N 图片锁、保序并发、逐项结果和
请求级派生计数失效；`images/image-update-item.ts` 是单图 metadata、author / theme / tag
创建、完整标签替换、分类位置 CAS 与持久清理回执的唯一 PostgreSQL 事务所有者。

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
  `action-protocol.ts` 校验 watermark / continuation，`action-handlers.ts` 执行逐项动作，
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
  停机排空；`retry-queue.ts` 只清理可由年龄扫描重新发现的 raw / staging。正式 media /
  thumbs 仍在复制前由持久 `move.cleanup` guard 接管。

Server 队列模块与 Web 队列 owner 的连接关系保持不变：

- Web 的 `useUploadQueueOwner` / `useImportQueueOwner` 分别组合浏览器来源与 Redis canonical，
  并各自持有重复确认与单卡提交的 single-flight controller；
  `useServerIngestionQueue.ts` 只拥有当前显示队列的连接生命周期，
  `model/server-ingestion-queue-state.ts` 负责 revision / version / progress 单调合并，
  `useStoredIngestionDraftSync.ts` 按硬上限批量排空草稿写入并在 version 冲突时有界回读，
  `useIngestionAuthorityHandoffs.ts` 持有独立于当前页 DTO 和连接代际的 HTTP 接管围栏，
  `cards/useIngestionJobDraftEditing.ts` 在失焦发布前复用 `@imageshow/shared/browser` 的 Ingestion
  草稿 URL 纯格式解析，不接入远端图片请求能力；`useIngestionQueue.ts` 是单队列 controller
  的公开组合入口。
- `useCompletedIngestionInvalidation.ts` 是 completed pair 去重与 PostgreSQL 图片查询失效 owner；
  `useIngestionStatusHydration.ts` 拥有响应未知 pair 的有界 status 回读与 AbortController；SSE
  view / protocol 纯投影位于 `model/server-ingestion-queue-view.ts`，不创建第二条连接。
- `model/stored-ingestion-draft-model.ts` 保存 target / authoritative projection 与 CAS 纯决策；
  pending / dirty map、250 ms timer、batch tail、flush 和 revision 等待仍只由
  `useStoredIngestionDraftSync.ts` 持有。
- 两套 owner 不共享页码、SSE、
  busy、清空范围或 action connection hold。内容接入队列不做固定 pair 轮询，只有响应未知的
  已知 pair 才使用一次有界 status 查询。
- `sources/weibo.ts` 只编排批次和 JSONL 清单；`weibo-request-scheduler.ts` 唯一拥有全进程固定
  串行、批次轮转、随机间隔和单一访客身份。链接 / 时间 / 响应提取、受限上游协议、未知响应值
  归一化及公开类型分别位于同目录 `weibo-parser.ts`、`weibo-client.ts`、`weibo-values.ts`、
  `weibo-types.ts`。
- 图片读取先由 `image-serving-record.ts` 将 Redis 命中与 PostgreSQL fallback 归一为
  同一 serving record；公开正式媒体的 ready-cache 明确空命中仍会在有界数据库读取中查找
  ready 或 deleted 行，入口在缓存和数据库读取前统一拒绝非规范或过长对象键。
  `stored-image-serving.ts` 只编排存储对象与缩略图，
  `external-original-serving.ts` 只处理外部原图探测、跳转和代理。
  `stored-object-response.ts` 集中流式、HEAD、Range 与缓存响应；缩略图缺失在只读 serving
  边界直接映射为 404，显式维修只属于 `checks/storage-thumbnail-repair.ts`，并由
  `checks/storage-maintenance.ts` 在独占维护编排中调用。

`images/ready-cache/` 以真实变化原因分为 `indexes/`、`derived/`、`counts/`、`sync/` 与
`integrity/`；`keys.ts`、`model.ts`、`revision.ts`、`source.ts`、`query.ts`、
`ordered-window.ts`、`random-sampler.ts`、`rebuild.ts`、状态观测和 coordinator 等横切模块
继续留在根层。`coordinator-machine.ts` 仍独占 phase、pending refresh、active task / abort、
mutation hold 与 rebuild requirement；归组没有增加第二个状态机或装配实例。

`images/ready-cache/query.ts` 编排筛选索引解析与 cursor / page 定位适配，
`ready-cache/ordered-window.ts` 独占 ZCARD、精确 ZSET 范围、HMGET、水合及前后有效性校验；
公开适配器生成下一 cursor，后台适配器只消费 `PageWindow.start`。
`images/read-models/pagination.ts` 以同一行读取框架承载 PostgreSQL cursor 与 offset，但保留
公开卡片和后台管理字段各自的最小 projection；后台先截取窗口，再只为最终行投影 tags。

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
  `components/form/TagInput.tsx` 统一拥有按需覆盖、由父框圆角裁切的 22px 边缘按钮与单行标签
  viewport；相邻 `tag-input-scroll.ts` 纯模型计算逐项边界、两端状态与滚轮像素，不把 Upload /
  Import 的默认值和逐图入口拆成四套交互。`TagInput` 本身只把 DOM 几何接到纯模型，并在非交互
  表面的轻点结束时提升编辑器焦点；它不重复决定主轴、消费触摸滚动或提交按钮激活。
  `components/layout/OverlayScrollbar.tsx` 统一拥有页面与局部容器滚动条：React 只提交可见性、
  几何和拖拽状态，逐帧位置以同一手柄 ref 的 transform 更新，不把连续滚动提升为根渲染。
  `components/feedback/DialogLayerPortal.tsx` 是顶层动态视口和嵌套弹窗坐标系的唯一 owner；
  移动图片详情的根层关闭控件继续复用共享 `DirectActivationButton`，不在页面入口复制触控
  关闭分支。
- `hooks/` 保存跨页面且主要管理 React 生命周期或交互行为的 Hook；首页与画廊的导航
  共用 `usePageScrollMovement.ts` 管理 RAF 合并、页面锁定和有界滚动位移采样，
  `usePublicNavigationEntrance.ts` 保证公开主导航在 SPA 会话内只入场一次，
  `useOneShotAnimation.ts` 在动画结束或减少动态效果中断后永久移除本次入口状态，
  `useDocumentMotionPause.ts` 统一把文档隐藏状态交给持续环境动效。共享
  `usePageScrollLock.ts` 计数化冻结应用根、安装弹窗触摸边界并在最后释放时恢复页面滚动；
  `useDialogFocus.ts` 在相同层级归还 opener，页面和角色模块不得建立第二套 body 锁。
- `lib/` 保存无界面代码；HTTP 客户端、query key 和共享查询 Hook 集中在 `lib/api/`。
  首页与画廊的主导航滚动阈值由 `lib/ui/public-navigation.ts` 统一定义；共享公开端
  入场缓动与首页导航淡入时长由 `styles/base.css` 的 motion token 提供，页面样式
  只保留自身阶段和区块时长。`lib/ui/preload-intent.ts` 将普通交互元素的鼠标悬浮、
  键盘聚焦和指针按下统一映射到同一被动预加载动作；接管指针激活生命周期的控件
  仍就近使用捕获阶段事件，公共能力不改变模块、查询或业务激活的所有权。该极小
  跨页面机制归入 `app-foundation`，不产生独立微型请求，也不反向引入后台实现。
  `lib/public-route-modules.ts` 单独拥有 Home / Gallery 的可重试动态导入及 hover / focus
  导航意图，`AppRoutes` 的 `React.lazy`、主导航和首页次级入口复用同一 Promise；它不绑定
  pointerdown，因而不会改变触摸或直接导航路径。`lib/image-url.ts` 只保存详情与画廊权威
  快照共同需要的原图 URL 判定，不让页面层复制同一字段投影。
  `lib/ui/movement-intent.ts` 是触控与指针共用的 5px 移动意图和主轴分类唯一来源；
  `dialog-scroll-boundary.ts` 保存纵向 owner、显式登记的标签横向 owner 与方向纯模型，
  `dialog-touch-boundary.ts` 只管理 capture 触摸生命周期并将已分类意图映射给 owner；共享
  `DirectActivationButton` 另以局部 pointer 生命周期决定直接激活是否仍成立，不选择或移动滚动
  owner。各层共享纯判定但不共享可变手势状态，也不互相承担后置补救；它们只认识坐标、当前顶层
  dialog frame 与 DOM 滚动能力，不依赖页面、角色或路由。
- `pages/` 保存路由页面与页面级编排，页面专属组件、状态机和 Hook 就近维护。
- `pages/admin/images/useImageAdminPageNavigation.ts` 是后台图库、无主题与回收站数字页的唯一查询
  owner，只保存规范化 scope、目标 page 与最近成功的 scope total 快照，并让 React Query
  处理取消、键隔离、90 秒新鲜缓存和重试；同目录 `images/image-admin-list-query.ts` 只构造规范化
  scope、query key、数字页 URL 与纯 total 仲裁模型；页面状态只消费这两个所有者提供的结果。
- `AppRoutes.tsx` 将普通与嵌入路径映射到同一 `HomePage` / `GalleryPage`；页面参数只
  决定是否挂载主导航，不能复制公开页实现或以 CSS 隐藏导航。服务端仍独立决定嵌入
  文档是否存在并输出父页面白名单，前端开关只负责已加载 SPA 内的路由收敛。
- `pages/home/HomePage.tsx` 只编排查询、筛选状态和页面生命周期；首屏、筛选摘要栏
  与候选目录由同目录组件分别维护，首屏控制器只拥有背景与顶层阶段，目录区块单次
  揭示 Hook 就近维护，避免路由组件同时掌握全部首页交互。
- `pages/gallery/` 就近拥有 cursor / ID 数据窗口、typed-array 瀑布流索引、半屏滞回虚拟窗口、
  共享可见性观察器、三级导航状态机、查询级揭示 high-water 与开发统计；跨页面可复用的 DOM
  图片加载、解码和并发调度留在
  `components/image/`，页面层只设置画廊任务的优先级、暂停和驻留边界。无界面的
  页面滚动边界归一化放在 `lib/ui/`，由共享采样 Hook 提供给各页面交互状态机。图片编辑
  保存时，数据窗口用权威快照原位更新唯一命中卡片并保持其他卡片对象，再以同一 cursor
  后台水合该页；筛选成员、几何和游标变化继续由数据窗口原子提交。
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
- `workflow/IngestionWorkflowWindow.tsx` 拥有 DialogFrame、焦点捕获 / 恢复、滚动容器、
  关闭 / 隐藏、详情 / preview target、cleanup confirmation scope、mode 和 owner 选择；
  `IngestionWorkflowRegions.tsx` 只渲染 header、defaults、queue body、summary 与 footer，DOM 顺序、
  class、ARIA 和 focusable 顺序不变。
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
  状态与检查，`CheckMaintenanceCapability` 才拥有整后端迁移、存储维护、缓存重建及其样式。
- `styles/` 按 base、home、gallery、admin 和 responsive 组织全局样式；首页进一步
  将页面 / 首屏基础、候选目录基础及共享响应式交互分文件，并按该顺序引入。公开页
  不参与动画的 fixed 导航外壳、主次导航共用的位移栈和根滚动回弹边界集中在
  `base.css`，页面样式只负责各自第二导航栏的尺寸与独立显隐位移。
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
