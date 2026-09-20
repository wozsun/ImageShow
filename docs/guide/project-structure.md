# 项目结构详细说明

ImageShow 使用 npm workspaces 管理三个包。依赖方向固定为：

```text
packages/server ──► packages/shared
packages/web ─────► packages/shared
```

`server` 与 `web` 不能互相导入；`shared` 不能依赖其他 workspace。Web 构建产物最终
由服务端镜像提供；根目录 `docs/` 只是普通仓库文档，不参与 workspace 或生产构建。

本文面向项目开发与运维，详细描述现行源码、构建产物、状态所有者和依赖边界，是当前实现
结构的权威说明。

入口：[根目录](#根目录职责)、[Shared](#packagesshared)、[Server](#packagesserver)、
[Web](#packagesweb)、[构建资源](#web-构建资源边界)。用户操作见各角色指南，交互与请求时序见[功能与流程](flows.md)。

## 根目录职责

- `package.json` 编排 workspace 构建、类型检查、长期契约测试、门禁和运维入口。
- `scripts/build/` 只保存生产构建所需的清理、进程编排、Web 图标生成和服务端 schema / SPA
  资产装配；Web 构建直接输出通用产物图报告，报告不装配进运行镜像。
- `scripts/runtime/` 只放容器内的命令包装；容器启动由
  `scripts/runtime/docker-entrypoint.sh` 负责权限
  收敛后直接执行传入命令。
- `scripts/tests/` 保存受 Git 跟踪的长期契约测试、源码 / 构建 / 隔离镜像门禁和固定夹具。
  [测试说明](../../scripts/tests/README.md)维护入口、运行前提和资源范围。
- `Dockerfile` 只安装三个 workspace 的构建依赖（不安装根目录本地门禁工具）并完成编译，
  再单独安装 server/shared 的生产依赖；运行镜像只携带生产依赖、编译产物和运维入口。
  `.dockerignore` 仅放行根包清单、`tsconfig.base.json`、`packages/`、`scripts/build/` 与
  `scripts/runtime/`，并排除本机依赖及生成文件。
- `compose.yaml` 提供单实例 ImageShow、PostgreSQL 与 Redis 的标准部署，把 `.env` 用作
  数据库名、用户名、密码和首次管理员用户名、密码的显式插值来源；可选的 `SITE_DOMAIN`
  仅在配置文件不存在时播种域名，未设置时使用空值。数据库名、数据库用户名和管理员
  用户名有默认值，两个密码必须显式设置；
  `.env.example` 另行承担部署变量与全部首次 seed 的完整目录。
  三个服务分别挂载 `data/`、`postgres/`、`redis/`，对应应用、PostgreSQL 和 Redis 数据。
  这些运行目录均被 Git 和 Docker 构建上下文忽略。
- `docs/CONFIG.md` 与 `docs/DEPLOY.md` 分别维护配置与部署说明；`docs/guide/` 保存当前架构、
  数据库、流程和 API 等指南。文档使用相对 Markdown 链接，可直接在仓库中阅读。

长期行为测试保留只负责编排的 Server 和 Web 两个入口；具体用例按稳定领域位于
`scripts/tests/server/` 与 `scripts/tests/web/`，门禁编排位于 `scripts/tests/verify/`。
颜色识别用例归入源码阶段的语义颜色门禁，正文压缩收益用例归入构建阶段的 Web 产物门禁；
包版本、配置和依赖方向由各自门禁统一核对。
测试专用 `scripts/tests/tsconfig.json` 在 source 阶段无产物检查统一入口、领域套件、支撑与
普通隔离脚本，不扩大生产 workspace 的构建输入。固定夹具采用合成数据；运行时配置、日志与生成夹具通过 `support/` 创建在根目录
`tests/tmp/` 的唯一目录中。Server 入口先设置隔离数据路径，再导入应用模块；数据库、Redis
和生产镜像使用本次创建的一次性资源，结束后清理。

根目录 `tests/` 被 Git 忽略，用于临时测试、真实资源验收、基线测量、日志、截图、浏览器
profile 和额外工作树；长期测试不依赖其中预存的文件、个人凭据或既有业务数据。
`data/` 只保存应用配置、存储、日志和接入临时数据。两处测试目录均不进入 Docker build
context、生产镜像或 GitHub Actions。Web 测试使用根目录开发依赖 `linkedom` 挂载 React
组件并通过公开 DOM 事件验证交互；模拟 DOM 不承担真实 CSS 排版或 GPU 呈现结论。生产构建
和运行镜像不安装该依赖。数据库集成中的 schema、冷 Redis 与 readiness 可独立选择；
配置、身份、图片事务与读模型、Redis 业务命令、接入队列与提交、存储迁移及维护、raw 和
孤儿清理进一步拆为 strict `.mts` 场景，各自使用独立数据库，可单独选择并分别计时。
公共夹具只准备本次资源和故障注入，业务断言留在所属场景；运行环境统一关闭数据库连接、
Redis、存储 driver 和 raw 目录游标。子进程统一由测试进程树所有者收口，
`verify:*` 总入口不继承定向选择器。

## 本地门禁与发布职责

源码开发使用根包 `engines` 要求的 Node.js 26.8 或更高 26.x 版本；HTTP 媒体类型解析使用
稳定的 `MIMEType.parse()`。Dockerfile 固定 Node 26.9.0 / npm 12.0.2，并通过同一
`NPM_VERSION` 控制构建与容器维护环境；本机可用 `npm install --global npm@12.0.2` 对齐。
安装使用提交的 lockfile 与根包 `allowScripts`，新增依赖安装脚本时须审查并更新该清单。
生产应用直接由 Node 启动，npm 依赖安装只发生在构建期。

四个门禁可以单独重跑，总入口按 source → build → runtime 顺序失败即停，不通过子命令
互相嵌套：

| 命令 | 内容 | 副作用 |
| --- | --- | --- |
| `npm run verify:source` | workspace 类型、Knip、语义颜色、TypeScript AST 依赖方向 / 环、实际配置解析 / 环境目录 / 文档 / Compose 同步、图标与 Markdown 链接 | 只读源码，不生成 `dist`、容器或浏览器会话 |
| `npm run verify:build` | 清理必要输出，先构建 shared，再并行构建 Web / Server，装配服务端资产并按真实产物图检查 Web 分块边界 | 只重建三个 workspace 的 `dist` |
| `npm run verify:runtime` | Server / Web 行为测试，以及生产镜像冷启动、HTTP、schema 和重启 | 建立随机命名的 tmpfs PostgreSQL、Redis、应用容器、网络和临时镜像；无论成功、失败或中断均在结束前删除，不访问现有数据库、容器或浏览器 |
| `npm run verify:release` | 依次执行以上三层 | 合并上述本地副作用 |

`npm run icons:generate` 是维护图标生成源码的显式写命令；日常门禁只运行只读的
`npm run icons:check`。`npm run check` 直接检查 shared / Server / Web 源码，不先构建
shared，也不写生产产物。

本地 source 门禁与 GitHub Dev/Release Action 共用 `scripts/tests/verify/version-contract.mjs`，
核对根包、三个 workspace 与 lockfile 版本；两条 Action 在登录仓库前完成检查。
GitHub Dev Action 只接受 `dev`
分支，显式只构建 `linux/amd64`、关闭默认 provenance 证明清单，并把同一次生产构建推送到
Docker Hub、腾讯云 TCR 与阿里云杭州 ACR；Release Action 核对 release tag 与完整包版本、`main`
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
  planned mutation fence 共同位于状态机边界内；恢复任务入库失败时由同一状态机保留意图和
  单个重试计时器，停止时清理，不增加恢复所有者。

这些 CLI 都直接依赖所需基础设施，不导入 HTTP 应用，也不会触发主服务启动；
healthcheck 只读现有配置快照，密码恢复不初始化运行时配置。

### 稳定领域边界

| 目录 | 职责与允许依赖 |
| --- | --- |
| `core/` | 领域无关的运行可用性、安全抓取、日志、密码、UUID、并发和精确基础原语；不持有图片、词表、存储或 Ingestion 请求 schema，也不依赖业务领域或路由。未形成独立稳定职责边界的横切模块留在根层。 |
| `core/database/` | PostgreSQL pool、事务、advisory lock、公开 fallback 准入、schema 装配和 readiness；`readiness/` 只承载数据库基线断言的内部职责。 |
| `core/redis/` | 唯一 Redis client、连接与能力探测、JSON、pipeline、条件字符串、窗口限流命令及其通用 Lua；不持有 ready-cache 等业务命令，也不导入其他业务领域。 |
| `core/http/` | HTTP 响应与响应头、请求来源和请求体限制、压缩阈值、静态编码协商、条件请求与 Range 解析。 |
| `config/` | 部署环境、首次播种、运行时配置 schema、无导入副作用的文件读写与显式进程内 store，以及配置包；普通保存与磁盘重载共用 FIFO 写租约内“持久化后发布”入口，配置包在同一租约内把候选文件持久化与数据库结果核对及收敛决定后的单次内存发布分离。配置包按当前默认配置逐项投影，存储后端按支持的结构与能力逐条识别；`runtime-config-environment.ts` 是全部 RuntimeConfig 叶子到首次 seed 变量的唯一映射。启动、热加载和配置包都只读取当前结构，未知字段统一投影删除。 |
| `routes/` | HTTP 方法、鉴权、CSRF、输入解析和响应投影；`validation/` 按图片、Ingestion、存储、用户和词表职责拥有请求 schema，并集中保留通用 HTTP 原语与 `validation_error` 映射；业务工作委托给领域模块。 |
| `images/` | 图片读写、展示投影、分类与元数据变更；`trash/` 拥有回收站和永久删除，`serving/` 拥有寻址与图片响应；`metadata-tags.ts` 拥有 HTTP 与 JSONL 共用的标签归一化契约，`page-window.ts` 唯一计算安全数字页窗口，`storage-location/` 拥有正式图片后端位置 CAS、revision、mutation fence 和 cache handoff，`ready-cache/` 拥有统一 Redis rich 投影、筛选、统计、精确同步与重建，`ingestion/` 拥有 Upload / Import 的完整接入会话生命周期及清理任务，`read-models/` 承载 PostgreSQL cursor / offset 读模型及其领域查询类型。 |
| `storage/` | 只在根层保留横切 `maintenance-lock.ts`；`backends/`、`drivers/`、`objects/` 与 `cleanup/` 分别拥有注册表及 Endpoint 重绑定证明、驱动、对象原语及跨图片传输准入、持久清理。`storage/` 不修改正式图片位置或相应 revision，也不交接 ready-cache。`backends/config.ts` 保留 S3 配置 schema、归一化和存储领域输入类型，HTTP create / update / test schema 位于路由边界。 |
| `random/` | 随机查询校验、规范 `auto` / `all` 到候选设备轴的选择、Redis 8 Array 最近历史、定向 id、有界 pivot 普通随机 PG 降级查询、固定 seed 的确定性起点与同序 PG 选图及随机出口编排；纯 User-Agent 设备识别由 `@imageshow/shared/browser` 提供给 Server 与 Web，Redis 候选投影、筛选与重建统一由 `images/ready-cache/` 提供。 |
| `jobs/` | 仅拥有通用 `background_job` 生命周期、小型类型分派、公平调度 Worker，以及集中管理任务中止、期限、续租和有界排空的执行协调器；各领域拥有自己的 handler、payload 和结果语义。历史清理在有界候选阶段锁定行并跳过正在更新的任务，避免删除并发重新入队的新意图。 |
| `checks/` | PostgreSQL / Redis 独立轻量状态、数据库 / Redis / 存储手动深度检查、“全部”中的回收站一致性结果，以及显式触发的存储维护；状态页自动 Redis 深检与手动 Redis 检查复用同一有界扫描和 pipeline，只返回当前汇总。 |
| `authors/`、`tags/`、`themes/`、`vocab/` | 词表查询、变更、关联锁与派生缓存；`authors/identity.ts` 唯一拥有作者链接到平台身份的当前解析和管理投影，微博导入按身份批量查询 PostgreSQL。 |
| `users/` | 管理员初始化、账号变更、Redis 登录会话、逐请求 PostgreSQL 角色与密码代际核对、操作授权、密码恢复、偏好和会话失效；不维护管理员凭据 Redis 投影。 |
| `types/` | 仅放缺失的编译期声明，不承载运行时代码。 |

图片选择器规则由 `images/selectors.ts` 持有，词条查询归一化由 `vocab/terms.ts` 持有；
管理员凭据规则与登录限流分别位于 `users/credentials.ts`、`users/login-rate-limit.ts`。
`core/password.ts` 只负责固定 Argon2id 策略的哈希与校验，不持有账号业务规则。

### 配置与资源入口

`config/runtime-config.ts` 持有当前 schema、默认值、严格保存校验与启动归一化。
`config/package/` 组合可移植配置与存储注册表：`format.ts` 负责包结构和预览，
`runtime-projection.ts` 负责宽松导入与目标站点字段保留，`service.ts` 负责写入编排。
配置包依赖运行配置 schema；日常运行配置不反向依赖包导入算法。

`routes/assets.ts` 统一主站与资源 Host 的静态文件、编码协商和条件响应；`routes/spa.ts`
只负责最终 HTML 快照、内联站点配置与嵌入页策略。二者复用 HTTP 层能力，资源响应的公开
CORS 头由 `core/http/headers.ts` 统一设置。

`config/runtime-config-store.ts` 唯一拥有进程内 RuntimeConfig、listener 与 FIFO 写租约。普通设置、
高级配置和磁盘重载都先完成所需原子文件写入，再替换内存并逐个通知 listener；同步 listener
异常只记录结构化错误，不中断后续 listener 或反转已持久化结果。`config/package/service.ts` 在同一
租约内先完成导入后端的存储探测，再通过 store 的专用阶段持久化候选文件并等待 PostgreSQL 事务结果；只有正常提交、确认
已提交或结果 unknown 时才发布候选，确认回滚只恢复旧文件且不发布中间快照。

`config/site-host.ts` 是图片资源根 URL 和 Host 判断的共同入口：域名为空或 `example.com`
时接受格式合法的访问 Host，使用 `/images` 同源路径，不向配置、共享缓存或队列写入请求域名；
显式域名生成 `https://<site.domain>/images` 地址。`routes/resource-host.ts` 在公共资源、OPTIONS 与 SPA 之前
区分主站、本地图片与静态资源公开 Host；`routes/public.ts` 注册主站公开资源
`/images/full/*` 与 `/images/thumbs/*`；`routes/admin-images.ts` 注册 `/images/original/:id`，
显式复用管理员会话中间件。未匹配请求使用通用路由处理。
公开资源不读取管理员会话，local / S3 已配置公开 URL 的对象使用直链；图片 URL 由服务端生成，
公开站点配置只投影页面实际消费的字段。

本地公开 URL 存在 `storage_backend.config`，由存储注册表唯一持有配置缓存。启动加载注册表后开始监听，
Host 准入同步读取注册表最后发布的本地公开地址，不触发数据库查询；失效保留已发布快照供准入使用，
存储读取仍按 TTL / revision 重新加载，local 地址保存完成前加载并发布新快照。普通主站请求不增加存储读取。
`images/serving/stored-image.ts` 的本地公开入口固定 local，跳过图片记录查询，与主站入口共用 driver 和
`stored-object-response.ts` 的条件请求 / 范围 / 取消与资源释放逻辑，不建立 ETag 或正文缓存。
高级配置验证、保存及设置重载复用注册表的主站 Host 冲突校验；保存和重载在 RuntimeConfig 写租约内执行，
访问配置变更不退休 driver。

`images/presenter.ts` 的公开卡片、后台列表 / 编辑快照及 Ingestion completed 投影，
在每个非空批次调用一次 `storage/backends/registry.ts` 的 `getStorageBackendConfigs`。
注册表在同一有效 revision 中按 slug 选择配置，响应内通过只读 Map 同步生成 URL，不建立
长期第二缓存。单图和批次共用 `storage/objects/public-urls.ts` 的同步 URL 编码、缩略图与
S3 直链规则，随机 JSON 也按批次投影。公开列表、详情、资源和随机出口先结束图片读取作用域，
再以请求取消信号读取注册表；注册表冷加载按 revision 合并，并拥有独立的有界数据库作用域。
配置快照缓存 24 小时，应用内配置写入主动失效，具体规则见[存储说明](storage.md#注册表缓存)。

`selection.ts` 将运行时默认尺寸交给 `random/query.ts`，后者校验 `size=thumb|full`，为 proxy /
redirect 补齐默认值，仅 JSON 保留未指定状态；尺寸不加入筛选、固定 seed 或近期去重签名。
`routes/random.ts` 按尺寸选用现有对象读取与 URL
生成能力；`random/json-presentation.ts` 在同一批次投影中按需提供全图、缩略图或两种 URL。
shared 随机 JSON DTO 保证至少包含一种 URL；Web 的 `lib/gallery/random-url.ts` 可按显式输入追加
尺寸参数，未指定时保留 API 的缺省行为。

`core/http/media-type.ts` 统一提取 HTTP 媒体类型首段并归一化外围空白，再由 Node 稳定的
`MIMEType.parse()` 校验语法和规范大小写。JSON 请求体仅接受 `application/json` 或具有非空
前缀的 `application/*+json`；外部图片继续按媒体类型白名单及 `file-type` 内容嗅探判断。
参数不参与这两类策略；媒体头解析不替代文件内容校验。该模块就近补充当前 `@types/node`
尚未提供的原生静态方法签名，不提供运行时实现。

`shared/browser/log-safety.ts` 统一拥有前后端日志纯清洗规则；Server 的 `core/logger.ts` 负责等级、
控制台 / 文件输出及轮转，浏览器错误上报和密码维护 CLI 复用同一内容边界。调用方把异常对象交给
该边界，不先字符串化；需要返回 API 的既有错误详情与日志参数分别处理。`request-security.ts`
惰性生成日志请求 ID，记录最终注册路由模板；`admin-logs.ts` 独立验证结构化错误上报。

`core/http/content-response.ts` 同时维护正文、内容弱 ETag 与 UTF-8 / 已编码字节长度，
`createContentSnapshot` 按调用方发布的对象身份复用最近一份表示，正文相同也复用原表示。
公开站点配置和后台设置 JSON 分别使用独立快照，省去命中请求的投影、序列化与摘要；
鉴权和缓存策略仍在路由中执行，不跨用户或响应类型共用权限相关内容。
应用自生成摘要由 `validators.ts` 使用稳定的原生 `crypto.hash` 单次计算，
截取 SHA-256 的前 96 位并编码为 16 位 Base64URL；
HTML / JSON 的弱 ETag 连同标记与引号共 20 个字符。本地对象的强 ETag 对设备、inode、大小及
纳秒级修改 / 状态时间共同取摘要，连同引号共 18 个字符；静态资源对修改时间、表示长度及编码取摘要，
保留弱标记和不同编码的独立验证器，不在标签内直接携带元数据。外链代理使用 `p.`、来源 URL 摘要与可还原的
上游 ETag，保留来源隔离和上游条件请求。S3 原始 ETag 与静态文件的编码维度仍由各自入口处理。
200 响应携带准确 `Content-Length`，304 不带正文或长度；API 压缩中间件直接使用已知长度，
选用压缩后删除原长度。只有符合压缩条件且长度未知的流才经 `compression-threshold.ts`
按块探测与重放，不将此入口扩展为所有 `c.json` 的响应所有者。

`routes/spa.ts` 用共同快照工具及已发布 RuntimeConfig 的对象身份复用最近一份最终 HTML 表示；相同快照的
后续请求直接复用正文、弱 ETag 与字节长度。保存、导入或重载发布新快照后，下一次文档请求
重新投影公开配置并生成 HTML；若正文未变，继续复用原表示。模板只读取一次，缓存只保留
一个快照引用及其表示，不保存配置历史。`core/http/encoded-content.ts` 拥有最终 HTML 的 Brotli / gzip
缓存，使用原生异步 zlib，一次仅允许一代编码工作，配置快速变化时只保留最新待处理内容；旧工作不得
发布到新代际。输入最多 1 MiB，严格变小才保存，identity 保持可用；构建未完成或失败时选用当前
可接受表示，否则返回 406。失败只记录一次，不在热请求中循环重试，后续正文变化重新构建。
`accept-encoding.ts` 集中维护 HTML 与静态资源共用的权重、排除、通配符及 identity 回退规则。
HTML / API 动态编码由应用负责，反向代理不是压缩依赖。`If-None-Match` 在取得当前表示后判断；匹配时返回
无正文的 304，相同配置快照下的条件请求也跳过 HTML 生成。路由可用性、嵌入父页面策略、CSP、Cache-Control
和条件响应仍在各请求中处理，完整内联公开配置与浏览器启动回退沿用现有契约。

`images/serving/original-link.ts` 为后台图片及回收站统一生成 `/images/original/<id>`；路由先验证
管理员会话，再进入图片读取、直连探测或代理。直连 302 与代理成功响应使用 `private, no-cache`，
不继承源站公开缓存策略；保留 HEAD、条件请求、取消处理与 `Vary: Cookie, User-Agent`，错误及失败回退不缓存。
`/api/images/:id` 按有效管理员会话投影 `original_url`：访客为空，管理员可取得独立原图链接；
详情使用 `private, no-cache` 与 `Vary: Cookie`，共享数据库行后按各请求身份独立投影。
Web 按图片 ID 与认证身份隔离查询，等待已有认证探针完成后读取，管理员携带同源凭据，访客省略凭据。
公开页面与后台详情均向已认证管理员显示非空原图链接，访客不显示原图按钮。
`images/serving/record.ts` 统一资源读取的 Redis 命中与 PostgreSQL 回源：完整图和缩略图
只投影对象键、扩展名与存储后端，原图入口再读取外部原图地址和更新时间。图片状态仅用于
查询可服务的正式 / 回收站记录；分类与展示文字由图片详情和列表的读模型负责。

`storage/drivers/local.ts` 在缓冲写和流式写入创建候选前及 link 发布前检查取消，
缓冲写同时向文件写入传递 signal。取消后等待已开始的文件 I/O 收口并清理候选。
每次自检使用独立随机 key，读写受请求 signal 控制，清理使用独立 10 秒准入预算并等待已开始
的文件 I/O 收口；失败或取消仅删除本次探针对象。

`storage/objects/transfer.ts` 拥有接入正式目标预检与本地文件写入。`verifyStorageTarget`
返回绑定存储访问、对象键、冻结摘要和存在状态的只读结果，仅在同一存储位置与图片修改锁内复用；
`writeVerifiedFileToStorage` 消费该结果并校验本地源文件，已确认能力的 S3 使用预计算
Content-MD5 校验上传，其余 S3 与 local 使用写后回读。跨后端流式搬迁同样按目标能力与
现有 MD5 选择上传校验或 S3 回读；回读共用大小与 SHA-256 核对。清理保护归属、远端结果
不确定窗口和流资源收口仍由传输边界处理。

`storage/backends/config.ts` 分别定义可编辑的 S3 设置与服务端维护的能力结果；`record.ts`
在同一 `storage_backend.config` JSONB 中解析和保存两者。`drivers/s3.ts` 使用同一流式 PUT
路径探测正确与错误 Content-MD5，SDK 仅添加协议要求的自动校验。`backends/probe.ts`
统一完成候选验证和临时 driver 收口；创建、连接参数变更及配置包导入先探测再持久化。
`self-test.ts` 只在探测连接与当前连接仍相同时回写结果，后台输入及配置包只传递可编辑设置。
`backends/read-model.ts` 将结果投影为管理员 DTO 的 `content_md5: boolean | null`，
`StorageBackendCard.tsx` 通过同一网格列将默认按钮与其下方的能力文字居中对齐；`StorageSettings.tsx` 通过已有列表查询
刷新状态，连接测试结束只失效该查询。
`StorageBackendModal.tsx` 的新建与编辑表单在 760px 及以下填满共享弹窗层，复用其动态视口高度；
标题和操作区不收缩，字段区独立滚动，边缘留出安全区，触控按钮保持至少 44px 高。
对应几何由按需加载的 `styles/admin/storage.css` 拥有，桌面端继续使用原有居中表单。
宽屏居中表单也按动态视口和弹窗层可用高度共同限高，避免矮横屏超出外层裁切边界。

`routes/` 当前保留 18 个直属文件。`admin-vocabulary.ts` 在一个 HTTP 能力边界中声明 tags、
themes 与 authors 三组同构 CRUD，通用 registrar 为文件内私有实现；每组仍分别注入自己的
schema、查询、变更和删除权限，不把领域业务搬进路由。`public.ts` 私有持有 Hono 请求到
`StoredResponseRequest` 的 header / signal 投影，共同服务该文件内 `full` 与 thumbnail 入口。
其余短 registrar 即使只有一个导出，也分别拥有独立 URL、鉴权 / 权限、中间件顺序、Host
或缓存契约；不按行数与相邻文件合并。`http-app.ts` 仍显式展示公开路由、管理员 session、
CSRF、请求体限制和各管理能力的装配顺序。

`routes/validation/parse.ts` 唯一把 Zod 问题映射为稳定的
HTTP `validation_error`，`primitives.ts` 只复用 UUID、slug、HTTPS 和安全整数等无业务语义原语，
其余文件分别拥有对应请求 schema。存储创建、测试、迁移、重排和路径参数共用同一 HTTP slug
原语及错误提示，配置包保留独立的领域校验。公开列表、后台列表与画廊统计的领域查询类型由各自
`images/read-models/` 模块导出，路由 schema 以 `z.ZodType` 对其作编译期约束；图片更新直接使用
`@imageshow/shared/browser` 的 `ImageUpdateItemInputDto`。JSONL 与 HTTP 共用
`images/metadata-tags.ts` 的标签归一化 schema，cursor 复用 `core/uuid.ts` 的规范 UUID 原语，
因此非路由模块无需也不得反向依赖请求校验目录。

### 数据库与查询协调

`core/database/` 按 PostgreSQL 生命周期边界拆分：`pools.ts` 只接收显式配置并拥有主查询与
advisory lock 两个连接池，均启用 PostgreSQL 每秒断连检查，使已销毁连接的长查询和锁等待
能够在数据库侧结束；`transactions.ts`、`advisory-locks.ts` 和 `schema.ts` 分别拥有
事务、锁与数据库启动编排；空库在事务内执行当前完整 `schema.sql` 并核对 readiness，非空库
只执行最小只读 readiness，不扫描历史数据或执行 DDL。现行安装契约见[数据库结构](database.md)，停机备份与恢复见[部署说明](../DEPLOY.md)。
`schema.ts` 合并同时使用默认连接池的 readiness 调用，只共享尚未完成的
校验，不缓存成功结果；启动事务或调用者显式提供的 reader 独立执行完整校验。
其他既有结构变更由维护者在启动前处理，额外表不参与数据或权限检查。
advisory lock 调度信号只取消连接取得与锁等待；锁内回调收到独立的
父锁 / 当前连接失效信号，由具体领域决定是否再合并请求、lease 或 deadline。`readiness.ts`
是唯一总入口，按固定顺序调用
`readiness/relations.ts`、`privileges.ts`、`indexes.ts`、`checks.ts`、`foreign-keys.ts` 与 `seeds.ts`；
`readiness/contract.ts` 是最小表、列、权限、主键、索引与外键 contract 的唯一数据来源；
`checks.ts` 只核对当前作者身份读写依赖的三项长期 CHECK
和受支持 provider 数据集合，在调用者提供的同一连接上顺序读取约束；
`readiness/seeds.ts` 是稳定种子断言的唯一来源，其他检查模块不得复制两者。
后台数字页使用 `database/transactions.ts` 的 read-only repeatable-read 事务，让 COUNT、
越界判断、metadata 与 tags 共享一个 client 和快照；事务后 formatter 不得借默认 pool。
schema 初始化和管理员播种直接使用主查询池，不为不受支持的第二应用进程取得启动锁；图片、
词表、内容接入、存储位置等运行期领域锁仍使用独立 advisory lock 池。
公开降级读取由 `database/public-admission.ts` 统一管理一个 FIFO 容量与等待队列，
`database/public-fallback.ts` 负责读取阶段的惰性 reader scope、单连接 SQL 顺序、执行期限和 client
释放 / 淘汰。Redis 缓存读取先行并保留外层并行，首次真实回源才借 client，同一 scope 内的领域模块
显式接收并复用 reader；查询失败、请求取消或 scope 结束后不再启动排队 SQL。
底层 `pool.query` 保持显式调用与原始连接语义。
`database/connection-error.ts` 只识别明确的 PostgreSQL / 网络连接故障及当前 pg 驱动无编码的
连接错误，不以模糊错误文本归类权限、SQL 程序错误或取消。Ingestion completed 读模型仅在
正式记录查询边界将这些故障转换为 `database_unavailable`，保留 cause，并记录不含连接地址、
凭据和 SQL 的原因码；后续存储配置、URL 与 DTO 生成错误沿原错误路径传播。任何补全失败
均中断快照，不进入陈旧 completed 回执清理；查询继续包含回收站正式记录。
`core/coalesce.ts` 合并同键活动任务，调用者各自等待；可取消的工作使用共享信号，在最后一个
调用者离开后中止。`images/read-models/facets.ts` 在建立公共数据库 scope 之前合并整个公共
词表读取，避免共享某个 HTTP 请求的 reader 或在已有连接内嵌套等待另一个准入名额。
`storage/backends/registry.ts` 同样在取得公开数据库作用域前合并同 revision 的配置加载；
调用方先释放图片读取连接，注册表只接收取消信号。公开与内部加载分别合并活动任务，
共同使用唯一配置快照；公开读取在冷、热缓存下均执行后端数量上限。
公开 facets 只计算主题与作者的图片成员关系；标签返回含零图片词条的完整词表，
由词表 reader 对实际返回集合执行数量限制。
`images/read-models/gallery-stats.ts` 的主题、标签和作者目录只返回全局有正常图片的词条，
包括按同一规则处理的“未设置”主题。Redis 投影按统计快照中的全局词条键筛选词表，
PostgreSQL 回源先关联全局正常图片，再以筛选聚合计算候选数量；筛选后的零数量仍保留。
首页沿用唯一统计查询及现有目录数量、排序和禁用规则，不额外请求未筛选统计或保留成员副本。
设备与明暗继续投影完整固定选项，不应用词条隐藏规则。

固定窗口限流的单条通用 Lua、命令定义、注册、参数布局和返回解析由
`core/redis/window-limit.ts` 就近拥有；`core/redis/client.ts` 只构造唯一 client 并维护连接与
能力状态。ready-cache 的六条领域 Lua 位于 `images/ready-cache/redis/scripts.ts`，相邻
`client.ts` 拥有窄 client 类型和 ioredis 命令定义 / 注册，`commands.ts` 拥有参数布局、返回
解析和类型化调用。两组命令都在首次调用前显式幂等注册；注册会保留 client 上已有脚本选项，
使后续 `duplicate()` 继续继承命令，但不依赖全局类型扩充、模块导入副作用或 `core/` 对图片
领域的反向导入。其中两条 ready-cache 只读抽样命令分别接收四个 core key 和六个 derived key，把已解析索引后的
校验、候选数计算、随机成员与 rich item 读取收敛为一次 Redis 调用；脚本不拼接隐藏 key，
也不接收 client ID 或近期去重集合。`random-sampler.ts` 在应用层打乱返回候选后按近期
记录优先选择未见图片，避免全量候选的固定返回顺序导致小集合轮换后反复选择首项。
ioredis 负责按物理连接在首次调用发送 `EVAL`、后续
发送 `EVALSHA`，并在 `NOSCRIPT` 后重发脚本；应用不维护 SHA、启动时预加载清单或 Redis
Functions。检查页按键动态测量的低频 Lua 仍留在 `checks/`，不并入业务注册表。

### 存储、词表与图片变更

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
分类 metadata 与正式对象位置相互独立：`image-update-item.ts` 直接提交分类 metadata。
`tags/mutations.ts` 在调用方事务内以集合 SQL 创建缺失标签并替换关联，去重保留首次出现顺序；
新增标签按该顺序排在已有词条前，revision 和提交后缓存失效仍由调用方汇总。
标签、主题与作者的显式创建及自动建立均在当前最大排序值上递增，并限定在业务范围内，不改写已有词条排序；
重复采用已有词条不移动位置。数值达到 5,000,000 后保留该上限值，同值按 slug 升序。
`vocab/sort-order.ts` 持有词表单项排序写入与缓存同步；后台列表返回真实 `sort_order`，
管理列表、画廊筛选与 Ingestion 词表统一按数值降序、slug 升序排列。
显式创建、编辑、排序和删除通过 `vocab/mutation-sync.ts` 的统一包装器收口：
无论写入成功、失败还是回执丢失，退出前均刷新词条并失效后台计数。集合删除保留外层词表锁、
图片 revision 与 mutation fence；自动建词条仍由所属图片事务汇总同步。
后台计数包含回收站，移入 / 恢复只更新图片投影；永久删除在执行退出时失效三类计数，
即使 DELETE 回执不明或空记录重试也按当前数据库真值重新读取。
`themes/mutations.ts` 在词表排他锁和图片缓存 fence 内，以单事务集合 SQL 解除图片关联并删除
主题，汇总一次 revision 与精确同步 / 重建交接。`storage/objects/image-transfer-admission.ts` 是所选图片与
整后端迁移共用的活动逐图搬迁许可 owner，两个生产者直接复用同一个代码内固定 5 项容量。
Endpoint 重绑定的双向随机挑战与精确探针清理位于 `storage/backends/endpoint-rebind.ts`；
`probe.ts` 同时负责候选地址对既有图片的有界读取。
`storage/objects/removal-admission.ts` 是 durable cleanup、检查维护和回收站删除的
唯一活动存储清理许可 owner，固定只允许一个 provider 中性 `removeObjects(1…N)` 调用；同一调用
涉及多个 driver group 时逐组向该 FIFO 交接，不预占多个排队位置。持久 `move.cleanup` 同时只领取
一个任务，回收站永久删除也逐图取得清理许可后才处理下一项，避免在共享许可前堆积持锁连接。
显式维护按主要资源分流：repair 由 Normalize 容量调度，但替换未采用缩略图时仍取得唯一 cleanup
许可；remove 直接由 cleanup 容量调度。两个资源池并行推进，取消或失败时先在独占位置锁内全部
收口，正常输出再按原候选顺序合并。Ingestion 临时文件使用独立的本地清理队列，
每次执行一个 attempt，失败退避释放许可。
`checks/storage-check.ts` 只生成无写入权限的存储预览；显式写维护按稳定职责拆分：
`checks/storage-maintenance-plan.ts` 重读 PostgreSQL、Ingestion 引用和完整存储快照并生成候选，
`checks/storage-thumbnail-repair.ts` 负责缩略图写入与校验，`checks/storage-orphan-cleanup.ts`
负责确认删除和空目录修剪，`checks/storage-maintenance.ts` 保留独占位置锁、执行顺序，并把对象
维护与持久彻底删除任务维护汇总为单一检查页操作。
缩略图维修只为数据库已采用的缩略图执行生成前对象探测；生成后复用独占锁内的位置及 driver，
保留发布前对象探测、0 标记、写后摘要及数据库未知写结果回读。
本地 driver 在完整列举时按需捕获本次有界目录信息，维护编排将维修 / 删除涉及的对象交给修剪，
由 driver 重读受影响目录及祖先；未变化目录复用捕获事实，原有扫描预算与 rmdir 边界保留。
这组写维护只从显式维护入口调用，不接入普通请求热路径或通用后台任务。
回收站的移入 / 恢复集中于
`images/trash/mutations.ts`；`images/trash/purge.ts` 拥有逐图任务原子入队与执行，`images/trash/purge-state.ts` 统一表达图片的任务存在性，
`images/trash/purge-job.ts` 将逐图处理完成映射为通用任务结果，
`images/trash/purge-maintenance.ts` 集中维护入口触发的全部耗尽任务重试与异常成功任务恢复。深度诊断属于
`checks/database-check.ts`，正常图片请求不探测任务完整性。`images/image-update.ts` 只拥有 1..N 图片锁、保序并发、逐项结果和
请求级派生计数失效。每个请求只借一个锁会话，按并发上限分组取得该组词表及自动亮度所需的单图对象与
存储读取锁，再并行执行逐项事务；辅助锁在组结束后释放，图片更新锁保留至整个请求收口。
`image_update_summary.max_group_duration_ms` 记录最慢分组的准备、等锁与执行总耗时；
存储迁移摘要中的 `max_item_duration_ms` 继续表示最慢单图耗时。
`images/image-update-item.ts` 是单图 metadata、author / theme / tag
创建、完整标签替换与分类 metadata 更新的 PostgreSQL 事务所有者；普通分类只采用锁定行，
自动亮度保留事务外预处理及提交前冲突复核。主题删除由 `themes/mutations.ts` 统一拥有解除
关联和删除词条的单事务。`images/metadata-theme.ts`
拥有共享 HTTP / JSONL nullable slug schema；查询专用
`null` 由 shared browser 契约提供，虚拟统计项由 vocab / read model 构造，不进入主题表。两者都保持正式对象位置不变，并在同一图片事务中推进
revision、交接同一 mutation sync。

### 内容接入

`images/ingestion/` 是 Upload 与 Import 共用的统一内容接入领域，稳定子目录表达允许依赖方向：

```text
ingestion/
├─ sessions/    # 最低层 canonical / intent model、key、codec、命令与 Lua
│  └─ scripts/  # projection、canonical、intents、queue、discovery
├─ queue/       # snapshot、SSE、action、watermark、草稿 CAS 与展示投影
├─ raw/         # 接入文件路径、lease、流式接收、处理结果读写与本地孤儿扫描
├─ sources/     # 安全远端下载、JSONL 与微博适配
├─ execution/   # heartbeat、version fencing 与不可取消边界
├─ commit/      # intent、最终准入、校验、持久化、完成发布、补偿与 coordinator
├─ cancel/      # 取消协调、批量结果和退休资源清理
├─ cleanup/     # 可重发现资源的保守扫描与重试队列
├─ workers/     # download / prepare / commit stage 编排与恢复
├─ repository.ts
├─ runtime-repository.ts
├─ runtime.ts
└─ session-service.ts
```

`sessions` 是不依赖其他 ingestion 子域的协议底层。`raw` 在其上实现本地接入文件与上传接管；
`execution` 组合 session fencing 与 repository facade；`sources` 使用 `sessions`、`raw` 和
`execution` 完成远端接收；`commit` 组合 `sessions`、`execution`、`cleanup`、storage、database
与 vocab；`cancel` 组合 `sessions`、`execution`、`commit`、`cleanup` 与 `raw`。`queue` 内部的
snapshot、SSE、watermark 和展示投影只使用 session / repository 边界，action handler 则负责
协调 `cancel`、`commit` 与 `execution`，因此整个 `queue/` 不是单一底层。`workers` 可以编排
所有这些模块，`runtime.ts` 是唯一生产装配入口；除这两层自身外，ingestion 内任何模块都不能
反向依赖 `workers/` 或 `runtime.ts`。Routes 只依赖 runtime 公开的 service、repository facade、
窄执行控制接口与 DTO，不能导入 Lua、执行协调器或私有 Worker。

具体接管、提交、分页、取消与恢复时序统一见[图片接入](ingestion.md)。本节只列状态所有者与依赖边界：

| 模块 | 所有权与依赖 |
| --- | --- |
| `runtime-repository.ts`、`runtime.ts` | 前者构造唯一 repository；后者装配 token service、session service 和 Worker，对路由公开窄接口。 |
| `repository.ts` | Redis 命令调用、错误翻译与事件发布 facade；命令、回复、intent、listener 与队列存储由所属模块承接。 |
| `sessions/model.ts`、`codec.ts` | canonical、终态回执、Upload intent 和队列 metadata 的严格存储 schema 与解码；不承担 HTTP 补齐。 |
| `sessions/import-metadata.ts` | 以配置快照和 DTO 投影 Import 原图 / 来源；接管与首次提交冻结复用同一规则。 |
| `sessions/scripts/` | Lua 原子操作和协议；共享 projection 片段不执行命令，TypeScript 不复制 Redis 权威状态。 |
| `queue/` | snapshot、SSE、watermark、action scope 与展示投影；action handlers 协调取消、提交和执行，草稿更新使用 canonical CAS。 |
| `raw/lease-registry.ts` | 本地 active、deleting、scanning、pruning 状态的唯一 owner；路径、文件、扫描、prepared 与 upload 各自承接 I/O。 |
| `commit/worker.ts` | execution fencing、锁顺序、prepared 对象采用、事务不可取消边界和完成发布；校验、持久化与完成发布分模块执行。 |
| `cancel/coordinator.ts` | resolving、abort 顺序、mutation limiter 和响应丢失后的核对；items 和 retired-cleanup 不建立第二状态 owner。 |
| `workers/` | download、prepare、commit 调度与恢复；资源准入各有唯一进程 owner，不把并发控制散入路由。 |
| `execution/session.ts` | 同一 execution token 的 heartbeat、progress、阶段发布及失败落盘。 |
| `cleanup/` | 活跃对象引用、保守孤儿扫描、本地重试队列与停机排空；正式对象在写入前交由持久 cleanup guard 接管。 |

Web 的连接、卡片投影、草稿与动作 owner 见下文 Web 章节；它们通过公开队列协议交接，
不导入 Server 内部实现。completed 结果由独立窄 DTO 与 presenter 返回，失效 owner 以 pair 去重；
正式图片始终以 PostgreSQL 为准。并发容量与限制见[配置说明](../CONFIG.md)，存储补偿见[存储](storage.md)。

### 图片投影与分页

`images/ready-cache/` 以真实变化原因分为 `indexes/`、`derived/`、`counts/`、`sync/`、
`integrity/` 与 `redis/`；其中 `redis/` 就近拥有 ready-cache 的 Lua、显式命令注册、窄 client
类型、参数布局和返回解析。`keys.ts`、`model.ts`、`revision.ts`、`source.ts`、`query.ts`、
`ordered-window.ts`、`random-sampler.ts`、`rebuild.ts`、状态观测和 coordinator 等横切模块
继续留在根层。`coordinator-machine.ts` 仍独占 phase、pending refresh、active task / abort、
mutation hold 与 rebuild requirement；归组没有增加第二个状态机或装配实例。

`indexes/` 将完整设备筛选解析为 `device:pc / device:mb` 属性索引，设备加亮度继续使用轴索引；
设备与其他分类组合时复用同一个设备输入。设备索引共用属性的按需 SQL 分批构建、单飞、
revision / 实例校验、TTL 与派生注册表，不进入核心重建或增量投影。属性构建以核心计数
提前拒绝超过单集合容量的任务，并在源读取中再次限制实际成员数；超限不发布截断索引。
`keys.ts` 为设备与轴提供固定后缀集合，`derived/touch.ts` 将同一集合传入领域 Lua 的注册表校验。

`shared/browser/images.ts` 统一派生稳定对象键与成品宽高设备分类，后台编辑 DTO 传递 ext，
编辑器仅在副标题 / tooltip 展示边界派生相同文本；公共卡片不增加字段。prepared 保留亮度检测值，
自动设备由成品宽高派生，手动选择保持独立。`raw/paths.ts` 从冻结的 producer token 和 generation
恢复 prepared 文件引用，预览、提交、取消和孤儿扫描共用该规则。

`shared/browser/tag-filter.ts` 提供公共正向标签表达式、语法、预算、归一化与可读序列化。
`images/filter-plan.ts` 解析词表并拥有各读取入口的共同执行计划，HTTP 层完整提取重复标签并校验
基础 / 混合能力；SQL 标签谓词由 `read-models/image-filter-sql.ts` 唯一生成。
`ready-cache/derived/filter-operations.ts` 给构建器和工作量估算提供同一有限运算序列，
先求标签分支交集、再求并集，最后组合其他属性；缓存与近期去重身份包含完整表达式。

`images/cursor.ts` 独占公开浏览的紧凑二进制边界与每日随机周期；有序 31 字符、随机 26 字符，
保留完整 UUID 和精确时间，筛选与方向由请求决定。精确时间纯转换由 `core/microseconds.ts`
提供；Redis rich item 只编码安全整数微秒 `sort_score`，游标直接编码该值，时间仅在响应边界转换。
`images/ready-cache/query.ts` 在同一 coordinator 读取租约中编排过滤索引与分页；
`ordered-window.ts` 承载 ZSET 时间窗口、HMGET 与有效性校验，`random-window.ts` 在既有
尾段索引按 `suffix,id` 读取两段环形窗口并验证筛选成员，达到扫描预算时回源 PG。
随机分页与 `/random?seed=...` 共用同一窗口读取及投影校验，后者只消费一张，不产生分页
cursor 或 seed 专属缓存；固定起点由 `random/selection.ts` 根据 seed 与实际筛选签名生成，
`random/postgres-selection.ts` 保持相同尾段与 UUID 顺序，且跳过普通随机的 pivot 和洗牌。
`images/read-models/pagination.ts` 分别选择 show 五字段、gallery 卡片及后台编辑投影；
后台使用安全 offset，按图片 / 入库时间与 UUID 同向排序；图片时间的 ready 页复用 Redis
正反序窗口，入库时间及回收站由 PostgreSQL 排序分页。公开使用 cursor。标签与选中行在同一
SQL 快照投影，URL 由共同 presenter 生成。
`read-models/gallery-stats.ts` 编排统计读取，并以共同投影构造缓存与 SQL 路径的 DTO。
`gallery-stats-sql.ts` 在同一只读 repeatable-read 快照中计算纯计数：无筛选执行分类、主题、
标签、作者四条业务 SELECT，由完整分类分组派生总数、设备和亮度；超限分组或非法计数明确失败。
带筛选且已有有效全局统计上下文时，在事务内核对一次 revision；一致则复用全局总数与成员，
执行六条筛选分组，零匹配成员补零。版本不一致时在同一快照完成七条全量统计 SELECT；
无上下文时直接执行这七条查询，不补查 revision。缓存命中不增加 SQL。
全量 SQL 同时携带词条名称、链接和排序；缓存与混合路径复用词表 owner。标签候选沿
`image_tag` 复合主键连接，筛选继续使用共同 SQL 谓词及省略候选自身轴的规则。
SQL 回源结果随请求返回，不另行发布到 Redis；既有 Redis 统计结果生命周期保持不变。
统计 HTTP 请求按完整筛选条件在建立数据库作用域之前合并；共享工作独占 reader 与取消信号，
单个访客取消只结束自身等待，全部访客离开后才取消共享读取。
独立详情提供完整元数据和链接；Web 从列表保留基础项并按 ID 组装，显示名复用 facets。

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

### 共享组件与交互

`hooks/useImageBrowseRoute.ts` 是公开浏览 URL 筛选的动作所有者，统一词表解析、修改、清空与
随机链接投影；`components/navigation/PublicImageNavigation.tsx` 只装配共用 Header / Toolbar。
画廊和展映分别持有视口控制与数据生命周期，共享导航不新增查询或运动状态。
设备与亮度选项直接消费 shared 常量，facets 只返回动态主题、标签和作者词表。

- `components/` 按稳定 UI 职责保存跨页面组件；`components/image/editor/` 的数量中性
  `1..N` 编辑器把重复图片卡片与 shell 编排分开，trash 模型和 Hook 集中拥有逐项响应
  对账、权威回读、会话成员修剪及查询失效，不把 mutation 收口重新分散到入口页面。
  `components/feedback/AdminSettingsBoundary.tsx` 复用 `useAdminSettings` 的唯一查询，
  只在取得真实配置后挂载后台图库、词表与设置表单；初次失败提供重试，后台刷新失败时
  保留已有配置和页面状态。图库将该快照经 `IngestionLauncher` 传给 `Ingestion`，
  接入页复用该设置快照中的分页、数量、体积、长边、并发和导入策略。
  `components/form/TagInput.tsx` 统一拥有按需覆盖、由父框圆角裁切的 22px 边缘按钮与单行标签
  viewport；相邻 `tag-input-scroll.ts` 纯模型计算逐项边界、两端状态与滚轮像素，不把 Upload /
  Import 的默认值和逐图入口拆成四套交互。`TagInput` 本身只把 DOM 几何接到纯模型，并在非交互
  表面的轻点结束时提升编辑器焦点；它不重复决定主轴、消费触摸滚动或提交按钮激活。CSS 统一让
  箭头、键盘和纯纵向鼠标滚轮触发的横移平滑过渡，`TagInput` 累计同向滚轮的未完成目标，
  并在反向或直接操作时让位；原生触摸 / 触控板手势仍保持跟手，减少动态效果时关闭平滑。
  共享弹窗边界消费手指横拖时显式使用即时滚动，避免同一 viewport 的 CSS 平滑延缓手势位移。
  禁用期间保留标签间距、padding 和删除按钮尺寸与符号，仅降低控件透明度并阻止编辑，避免保存时标签宽度跳动。
  `components/data-display/FacetSelector.tsx` 是公开图库与后台图片主题、标签和作者筛选的唯一
  交互 owner；`lib/ui/facet-input.ts` 统一筛选与编辑候选的名称 / slug 搜索，按完整、连续、
  非连续字符匹配分层，同层保留词表顺序，排除已选项后最多返回 50 项。非连续匹配按字符顺序
  前进，每个重复字符占用独立位置；`FacetSuggestionLabel.tsx` 复用匹配区间加粗原文，不另算匹配。
  选择仍返回原词条 slug，输入与新建语义由原表单持有。
  筛选候选添加成功后清空搜索词，菜单保持展开并将焦点送回输入框；添加失败、移除已选项及模式切换保留搜索词。
  筛选栏不重复显示上方字段标题，收起按钮与展开搜索框保持同一控件 ID 和无障碍名称，候选、已选和
  方式切换仍位于共享 Portal 非模态区域；显式 `selectionMode` 区分标签的任一 / 全部与
  主题、作者的包含 / 排除。组件内部显式衔接页面控件与 Portal 的键盘及读屏
  状态，并在直接激活事件内同步提交按钮到输入框的替换及输入焦点；共享样式移除浏览器原生
  search 清除入口，不让页面或视口建立第二套状态。`components/feedback/AnchoredPopup.tsx` 与
  `lib/ui/menu-position.ts` 共同统一页面 fixed、可见边界与弹窗局部坐标映射，并以实际 fixed
  绘制原点吸收软键盘造成的页面平移。
  `components/layout/OverlayScrollbar.tsx` 统一拥有页面与局部容器滚动条：React 只提交可见性、
  几何和拖拽状态，逐帧位置以同一手柄 ref 的 transform 更新，不把连续滚动提升为根渲染。
  `components/layout/PublicStarfield.tsx` 与随组件加载的 `styles/public-starfield.css` 统一提供
  展映、画廊及其嵌入页的固定非平铺星点；SVG 按视口等比裁切，点径保持屏幕像素大小。
  页面仅拥有背景层位置、透明度、遮罩与底色；画廊与展映以深色渐变和星空组成背景。
  `components/feedback/DialogLayerPortal.tsx` 是顶层动态视口和嵌套弹窗坐标系的唯一 owner；
  移动图片详情的根层关闭控件继续复用共享 `DirectActivationButton`，不在页面入口复制触控
  关闭分支。
- `hooks/` 保存跨页面且主要管理 React 生命周期或交互行为的 Hook。
  `useMediaQuery.ts` 以每个消费者独立的 MediaQueryList 提供外部快照订阅；React 直接读取
  浏览器当前匹配值，query 变化时替换订阅，卸载时释放。只把需要改变组件结构或行为的查询
  带入 React，纯视觉响应式差异仍由 CSS 处理。
  菜单与折叠面板的 DOM 监听由各自 Effect 的 AbortController 统一注销，Pixi runtime 的
  DOM 监听由实例独立注销；RAF、观察器、Ticker 与纹理仍由原 owner 分别释放。
  首页、画廊与展映的导航
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
  选区变化监听和菜单展开观察均由该 owner 管理。
  `lib/ui/public-navigation.ts` 统一判定导航内的悬停或焦点；精细悬停设备保护导航内的悬停与焦点，
  触控设备只保护 `:focus-visible`，忽略触摸残留的悬停与筛选关闭后的普通按钮焦点。交互期间取消计时并暂停滚动收起，
  只读文本框的非键盘焦点按其实际文字选区判定保护；选区取消后残留焦点不阻止收起，选区变化由同一计时 owner 重新评估。
  首页独立 `AppHeader` 复用该判定保护滚动收起；焦点移出在同一次焦点转移完成后重新读取。
  导航以外的鼠标移动不重置计时；菜单、移动筛选面板或详情展开时同样暂停，所有保护条件解除后
  且展映仍在自动播放时重新计满三秒，隐藏仍写入同一导航阶段。计时 Effect 在布局阶段清理，过期回调核对释放状态、
  当前导航阶段、文档可见性和交互保护；页面隐藏时取消等待，返回后重新计时。展映手动位移携带指针类型；共享 owner 在桌面禁止鼠标拖动及其惯性
  唤出导航，但保留上拖收起、滚轮显隐与移动端拖动显隐，手动位置采样仍连续更新。
  `ShowPage` 将该 owner 的导航可见性映射到页面属性；`show.css` 据此统一控制两种展映模式的
  底部按钮 30% 不透明度与操作提示 20% 不透明度；提示在次级文字色中混入 30% 白色，
  配以 70% 不透明度的深灰描边，导航收起时文字与描边整体淡化并保持可见。
  按钮组外扩 24px 的 hover 区域或键盘可见焦点可同步恢复
  两侧控件和提示，不新增导航状态或计时器。
  画廊直接调用共享导航 Hook，不传入自动隐藏时长，只保留滚动显隐；共享 owner 只测量滚动阶段所需的筛选栏高度，
  展映计时时长由 `lib/ui/public-navigation.ts` 的统一常量提供。
  画廊回顶按钮按一屏滚动阈值切换可见性，在排列按钮上方固定位置以 `120ms` 淡入或淡出；
  退场开始即退出点击和键盘焦点范围，透明度归零后隐藏表面。CSS 过渡允许中途反转，
  整组透明度仍由共享样式管理，减少动态效果时直接切换显隐。
  `useOneShotAnimation.ts` 在动画结束或减少动态效果中断后永久移除本次入口状态，
  `useDocumentMotionPause.ts` 统一把文档隐藏状态交给首页加载 / 刷新反馈和画廊尚未结束的
  有限入场动效。共享
  `usePageScrollLock.ts` 计数化冻结应用根、安装弹窗触摸边界并在最后释放时恢复页面滚动；
  `useDialogFocus.ts` 只处理当前顶层弹窗的 Escape / Tab，并在相同层级归还有效 opener；
  `lib/ui/dialog-layer.ts` 提供触摸边界和键盘处理共用的顶层判断。页面和角色模块不得建立第二套 body 锁；
  `useAnimatedClose.ts` 在退场动画完成回调返回前同步提交表面卸载与调用方交互解锁，
  使弹窗与菜单全部关闭后的首帧恢复背景交互。
  `useDismissiblePanel.ts` 还允许把外置的相邻操作登记为同一交互表面，并单独广播子菜单收起；
  移动画廊与后台图片筛选据此让清空关闭 Select / Facet，却不改变外层面板状态。
  工作流默认属性面板通过 `lib/ui/interaction-surface.ts` 把 Portal 菜单、清空确认层和返回焦点控件
  登记到当前面板；子菜单优先消费 Escape，确认层关闭后恢复有效触发控件，面板随后才允许收起。
- `lib/` 保存无界面代码；HTTP 客户端、query key 和共享查询 Hook 集中在 `lib/api/`。
  首页、画廊与展映的主导航滚动阈值和鼠标顶部唤出高度由 `lib/ui/public-navigation.ts` 统一定义；共享公开端
  入场缓动与首页导航淡入时长由 `styles/base.css` 的 motion token 提供，页面样式
  只保留自身阶段和区块时长。按钮与卡片通过各自的位移、边框、背景或阴影表达悬浮反馈，
  悬浮时保持图片本身的亮度；共享按压缩放由 `styles/base.css` 管理。
  `lib/ui/preload-intent.ts` 将普通交互元素的鼠标悬浮、
  键盘聚焦和指针按下统一映射到同一被动预加载动作；接管指针激活生命周期的控件
  仍就近使用捕获阶段事件，公共能力不改变模块、查询或业务激活的所有权。该极小
  跨页面机制归入 `app-foundation`，不产生独立微型请求，也不反向引入后台实现。
  `lib/public-route-modules.ts` 单独拥有 Home / Show / Gallery 的可重试动态导入及 hover / focus
  导航意图，`AppRoutes` 的 `React.lazy`、主导航和首页次级入口复用同一 Promise；它不绑定
  pointerdown，因而不会改变触摸或直接导航路径。`lib/gallery/card-display.ts` 是画廊卡片与
  详情首帧共用的 slug 显示投影，各消费者按会话级 facets 快照复用映射并保留缺失时的 slug
  fallback。原图可访问性由 Server 按管理员身份统一判定并返回可空访问链接，Web 不从原始地址、
  展示地址或图片 ID 重复推导。公开与管理图片读取、编辑快照统一输出可空 `source`；数据库
  和编辑 / 接入草稿保留字符串，presenter 与草稿 owner 分别负责两侧空值转换。
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
### 页面与查询所有者

- `pages/` 保存路由页面与页面级编排，页面专属组件、状态机和 Hook 就近维护。
- `pages/admin/images/useImageAdminPageNavigation.ts` 是后台图库、无主题与回收站数字页的唯一查询
  owner，只保存包含排序依据和方向的规范化 scope、目标 page 与最近成功的 scope total 快照，并让 React Query
  处理取消、键隔离、90 秒新鲜缓存和重试；筛选整体清空通过该 owner 显式归一到第一页，因此
  无主题视图中仅删除隐藏主题值时也保留相同分页收敛。同目录 `images/image-admin-list-query.ts` 只构造规范化
  scope、query key、数字页 URL 与纯 total 仲裁模型；页面状态只消费这两个所有者提供的结果。
  `ImageAdmin.tsx` 以账号偏好初始化当前页面的图片 / 入库、最新 / 最旧两维排序，双分区按钮
  独立更新对应维度并经 `useAdminPreferences` 保存。其他窗口更新偏好不改变当前页的排序快照；
  切换时保留筛选，复用分页 owner 返回首屏并清除选择与瞬时反馈。排序类型、可选值、默认值及
  偏好注册由 `shared/browser/common.ts` 统一提供，HTTP schema 拒绝未知字段及非法枚举值。
  `useAdminPreferences` 在实际写出前核对当前账号和待同步选择；其他标签页更新后，迟到的
  PATCH 回执不覆盖浏览器或认证缓存，改由原偏好查询重验证一次，不重放已被替换的旧选择。
  `images/ImageAdminFilters.tsx` 以自身容器宽度同步 CSS 的 `947px` 单双行边界，并实际切换筛选项
  DOM 分组，保证单行、双行与移动布局的视觉顺序和键盘顺序一致；设备 / 亮度与三类 Facet 分别
  以 `120px`、`150px` 为弹性基准和下限，五类筛选与清空按钮均不显示额外上方标题。
  图片成员 mutation 通过显式的后台列表失效入口等待该 owner 的刷新错误，其余相关投影仍尽力
  失效，通用图片失效函数不接收页面专用的 query-key 特判参数。
- `AppRoutes.tsx` 将普通与嵌入路径映射到同一 `HomePage` / `GalleryPage`，并把 `/show` 与 `/embed/show` 懒加载到
  同一懒加载入口 `ShowPage`，页面编排与 `pixi/` 渲染实现分离。shared 纯目标解析器统一处理三页启停、根路径与首页入口回退，
  普通与嵌入首页共用目标配置，嵌入入口保留 `/embed` 前缀。三页全关时服务端根路径
  和已加载 SPA 都收敛到 404，随机 API 与后台不参与公开页回退。页面参数只决定是否挂载主导航，
  不能复制公开页实现或以 CSS 隐藏导航。服务端仍独立决定嵌入
  文档是否存在并输出父页面白名单，前端开关只负责已加载 SPA 内的路由收敛。
  三个嵌入路由共用懒加载的 `components/layout/EmbeddedPageLayout.tsx`，
  `hooks/useEmbeddedCursorBridge.ts` 独占父窗口握手、鼠标转发、动画帧合并及光标接管生命周期；
  `styles/embed-cursor.css` 只在已接管时隐藏原生光标。普通页面不加载该模块，嵌入页间导航
  复用同一实例，退出时恢复光标并释放监听器；具体视觉效果属于宿主，协议见[嵌入光标](embed-cursor.md)。
  公开配置就绪后才挂载路由，后台刷新失败时保留已有快照和路由，并把 `site.header_name` 传入后台入口；导航和 `SiteHead` 不复制
  运行时默认值。网页标题由 `site.title` 提供，导航和后台品牌使用独立的 `site.header_name`。
  `siteConfigPayload()` 唯一投影描述为空时的网页标题回退，服务端 SPA
  文档与浏览器标题、描述、图标消费同一公开配置；HTML 构建模板只保留待注入占位。
  动态文本在完成 HTML / JSON 转义后由替换回调按字面插入，保留配置中的美元符号序列。
- `pages/home/HomePage.tsx` 只编排查询、筛选状态和页面生命周期；首屏、筛选摘要栏、
  候选目录与页脚由同目录组件分别维护。`HomeFooter.tsx` 从现有公开配置消费
  `site.icp`、`site.mps`、`site.footer`，按非空字段展示备案链接与自定义内容，不单独读取配置。
  页脚通过脱离文档的 template 解析受限 HTML，只重建 React 文字、HTTPS 链接与换行节点，
  不附加输入 DOM 或属性；解析结果按内容复用，备案号保持纯文字。
  首屏控制器只拥有背景与顶层阶段，目录区块单次
  揭示 Hook 就近维护，避免路由组件同时掌握全部首页交互。
  设备与明暗按钮按自身内容区宽度隐藏装饰勾：不超过 `96px` 时仅保留居中文字、
  选中底色和边框；选中语义仍由 `aria-pressed` 提供，不依赖整页的移动端断点。
  标签的任一 / 全部切换位于目录标题右侧，以紧凑的双段组合控件复用设备与明暗的按钮及
  选中配色；独立底色块在两段之间以 80ms 平移，减少动态效果时即时切换。标签卡片内容区
  不超过 300px 时，标题与数量保持首行，模式控件独占下一行。标签卡片布局只作用于
  标签选项区，不影响标题操作。筛选摘要以 `/` 连接任一标签、`&` 连接全部标签，
  不重复显示模式名称；模式切换按钮仍保留任一 / 全部文字。
  目录卡片在视口不超过 980px 时改为上下排列，主题标题在同一断点改为英文编号与中文
  左右排布；标签和作者标题继续采用左右排布。
  三类目录卡片的顶部内边距统一为 16px，标题组、标签模式切换和数量徽标在标题栏内
  垂直居中；标题组内部的横排中英文按文字基线对齐，数量徽标不叠加专有顶部偏移。
  标签与作者共用最小 34px 标题内容高度、8px 底部内边距与 14px 下方间距；上下排列时
  主题也采用同一尺寸与字号。窄卡片为模式控件增加独立行，标题与数量仍保持相同垂直位置。
- `pages/gallery/` 就近拥有 cursor / ID 数据窗口、typed-array 瀑布流索引、半屏滞回虚拟窗口、
  共享可见性观察器、查询级揭示 high-water 与开发统计；当视口外下一屏触及已有内容末尾时，
  下一页判断随滚动帧更新，不等待半屏布局滞回，续批仍固定 60 条并由同一数据窗口去重与限并发。
  完整 DTO 驻留候选从可见页中心向两侧按距离领取，同距优先较小页号；预算用尽后停止普通候选搜索，
  超出剩余预算的页可跳过，详情固定页仍单独保留。新增和水合页在同一数据窗口的活动页集合登记，
  驻留释放只遍历该集合；可见页仍按实际几何边界选取。正常状态快照保留加载、错误、历史页数和布局信息，
  DTO / 游标字节估算及驻留统计仅在读取 `debugSnapshot` 时计算，不随每次状态提交扫描全部历史页。
  导航状态机由
  `hooks/usePublicImageViewportControls.ts` 统一提供给画廊与展映；跨页面可复用的 DOM
  图片加载、解码和并发调度留在
  `components/image/`，页面层只设置画廊任务的优先级、暂停和驻留边界。无界面的
  页面滚动边界归一化放在 `lib/ui/`，由共享采样 Hook 提供给各页面交互状态机。图片编辑
  保存时，数据窗口用权威快照原位更新唯一命中卡片并保持其他卡片对象；缺少快照时才以同一
  cursor 条件重验证。筛选成员、几何和游标变化继续由数据窗口原子提交。`LazyGalleryImage` 在资源地址
  变化时清除旧地址的完成与失败状态，旧任务由既有任务清理和结果围栏隔离；DTO 缺失合法宽高时，
  同一就绪结果把真实比例提交给数据窗口，数据窗口按帧合并后只重排唯一 typed-array 布局，并以
  可见首卡 ID 与卡内偏移维持锚点。离开画廊时只保留最近一次历史条目的查询、几何身份、数据窗口和
  锚点；`GalleryPage` 以路由导航类型与条目 key 决定恢复，仅 `POP` 且条目匹配时复用。
  主动导航的 `PUSH` / `REPLACE` 创建新数据窗口并回到顶部，包括已在画廊时再次点击画廊导航。
  首次 CSS 几何实测后才决定历史会话复用，不以忽略系统滚动条或安全区的估值清除会话；后续
  resize 仍由当前窗口重排。`lib/api/image-data-revision.ts` 记录当前页面实例内图片 mutation 失效边界的会话代次；离页期间在同一实例发生
  编辑、删除、接入或资源配置变更时，历史返回先清除保留的旧 DTO、确认编辑及移除标记，再水合
  所需权威页；保留紧凑布局和锚点用于恢复位置，无变更则直接复用。
  不在标签页间广播失效。普通列表读取使用浏览器默认缓存，缺少权威公开快照的活动页才进行
  条件重验证；当前窗口保留已确认编辑及删除标记，较早 HTTP 实体不能覆盖提交结果。
  临时页查询键包含规范筛选、view / order、批量档位、cursor、挂载 owner 和数据代次，
  仅改变单标签任一 / 全部意图或词项顺序的路由编辑复用同一窗口；显式再次点击画廊仍重新读取，
  旧访问的请求与查询清理不接管新访问。历史进度仅作内存复用，丢失或周期过期时可从首批重启。
  紧凑布局保留未变锚点的 ID 与偏移，再由已水合锚点的提交恢复页面位置，不常驻额外 DOM 或
  第二套布局状态。共享调度、可见性与驻留边界不重建。共享图片详情的标题在展示图地址未就绪时
  保留纯文本布局，不产生空链接或
  额外 Tab 停靠点；有效地址就绪后才提供直链。共享图片详情弹窗只在
  完整展示 frame 就绪后恢复真实 `<img>` 命中，加载期透明 frame 与详情以外的
  `ProgressiveImage` 消费者继续沿用不可命中的共享默认值。
  `ProgressiveImage` 同时拥有完整图失败反馈和显式重试，保留可用缩略图；图片身份、资源
  地址和重试轮次共同界定任务，换源、关闭与迟到结果沿既有调度取消边界处理。
  `hooks/useImageBrowseRoute.ts` 复用全局 facets 解析标签词项，阻止非法、未知或混合页面条件
  发出图片请求；公开标签词表包含零图片词条。该 Hook 使用路由 API 写入最终可读查询串，
  页面分享与复制使用相同 slug 条件。`TagFilterErrorState` 提供错误与清空标签入口。
  `lib/gallery/gallery-query.ts` 按用户操作更新画廊 / 展映的路由参数，保留显式选择和省略默认值的区别；
  筛选、排列与展映模式各自只更新所属参数。内部数据源身份使用解析后的状态，并在公开列表 query key 建立前把
  `device=auto` 通过 shared User-Agent 纯函数投影为具体设备或无条件；随机链接则把缺省全部设备
  投影为 `device=all`，并为自动设备省略该参数。画廊整体清空只进行一次空筛选路由写入，让列表
  查询和随机链接从同一 URL 状态同步更新。共用 `PublicImageToolbar` 移除筛选及操作控件上方标题，
  并把“随机API”作为链接框内前部的固定文字；随机链接显示层测量剩余宽度的真实溢出，只在裁切时于复制按钮
  保留区前追加贴合基线的 ASCII `...`。标题和省略号不可选，链接提供只读文本框语义；首次点击或
  键盘聚焦时通过原生 Selection 全选实际 URL 节点，焦点内后续点击保留局部选择，失焦后重置。
  复制按钮不使用截断后的显示文本。
- `pages/show/` 就近拥有公开展映编排、真实图片查询与 `pixi/` 生产运行时。
  三种排序共用 `GET /api/images?view=show`，首次接收的随机批次只在 Web 洗牌。
  `useShowData.ts` 独占请求代次、游标与最多 800 个唯一 DTO；场景反馈已消费及仍引用的 ID，
  数据流退役无引用旧项并持续续取，有限池可循环，近期 ID 集合有界。删除与编辑隔离旧响应，
  权威快照更新基础项并判定筛选成员；保存确认缺少快照时按目标 ID 复用编辑快照读取及有限重试，
  读取失败保留已提交候选，分页位置变化不作为移除依据。
  补图连续四批无新候选时保留已推进的游标并结束本轮扫描；在途期间的补图需求合并为一次，
  成功结束后重新核对并处理，后续候选使用量变化也可续扫。空窗口仍有补图需求且尚未到末页时，
  在任务队列让出后继续下一轮，接收新候选、到达末页、切换来源、停用或卸载时结束该续扫，
  末页若仅有近期已见图片且窗口为空，则复用该页未被本地移除的候选填屏；空页或全部被移除的末页仍停止。
  空候选池重新接纳图片时推进消费轮次，旧使用快照失效；两个场景按新轮次重置消费记录，
  即使 React 合并了退役与补入、没有渲染中间空池，同 ID 的新候选也不会被旧记录再次退役。
  不把驻留 / 近期去重导致的正常重复批次视为加载失败。真实补图错误仍等待显式重试，
  场景逐帧信号不会触发错误重试循环。
  先无重复领取全部候选，只有有限筛选结果不足以填满活动槽时才循环复用。`mode=waterfall|float`
  是正式 URL 状态，省略或无效时回退 `site.show.mode`，读取默认值不改写 URL。
  `ShowPage` 从同一公开配置中的 `site.show.autoplay` 初始化播放状态，访客启停只属于当前挂载。
  该字段默认值由 Shared 唯一提供，首次播种通过 `SITE_SHOW_AUTOPLAY`；普通设置 DTO 不包含
  `site.show`、`site.home.browse_target` 或 `site.gallery.enabled`，这些新增项由配置文件或高级配置维护。
  `ShowPage` 根据当前查询构造明确目标模式的链接，`ShowControls` 以 React Router `Link` 渲染；
  模式提示及读屏状态通过同一显示映射呈现“瀑布 / 漂浮”，URL 和配置枚举保留 `waterfall / float`。
  手动切换始终保留显式 `mode`，筛选与顺序更新保留模式参数的显式或缺省状态，模式切换不重建图片查询。
  `pixi/show-pixi-runtime.ts` 唯一持有 Pixi Application、ticker、ResizeObserver、页面可见性、
  reduced-motion、context lost / restored、场景租约和共享纹理 LRU；纹理入口直接读取真实
  `thumb_url`，按屏幕尺寸选择 LOD、限制并发与像素预算，并在 WebGL2 生成 mipmap。
  `ShowPixiStage` 用 Effect Event 将实例的列数、尺寸、手动位移、运动、补图和打开图片回调
  接到最新已提交的 React props；回调更新不重建实例。异步初始化与卸载仍由创建 Effect
  管理，DOM 键盘代理直接使用 JSX 事件并保留实际返回焦点目标。
  纹理加载并发按运行时创建时的画布宽度确定：不超过 760px 为 12，超过为 16，瀑布与漂浮共用。
  等待纹理使用可删除节点的 FIFO Set；条目淘汰时同步移除等待节点，即使所有下载挂起也受
  缓存条目上限约束。诊断的 queued 直接读取实际等待节点数。
  纹理连接与完整响应体读取复用 `requestWithDeadline` 的 30 秒期限，响应体结束即清理计时器；
  HTTP 错误等提前失败会中止仍未结束的正文传输，保留原始错误分类。
  超时按传输失败暂停并释放下载槽，沿既有显式恢复机制重试，不自动连续请求。
  瀑布在领取纹理前对整个驻留集合按 URL 和解码尺寸去重计费，包含 mipmap；超出像素预算的
  80% 时统一降低解码尺寸，为新旧 LOD 交接留出空间，避免驻留集合超预算后永久等待。
  卡片位置、大小和列数不变，密度降低后重新按当前集合选择尺寸。窄屏仍保留较低像素预算；
  条目上限统一覆盖 800 张驻留图片的新旧 LOD 交接，不因条目数提前阻断像素预算内的补图。
  原图比例参与解码裁剪，缓存共享同规格引用；容量不足的卡片持有可取消等待，在引用释放后
  重新领取纹理，不重新布局。缓存记录真实可用性变化的递增代次；拒绝回调携带当时的代次，
  注册等待时若已发生新变化则补一次唤醒，通知合并与补发本身不推进代次，避免丢唤醒或空转。
  网络传输失败暂停该 URL，同源连续失败暂停该来源；浏览器恢复
  联网或用户恢复播放时统一允许传输重试。运行时还捕获文档内真实图片的 `load` 事件：详情成功加载
  同一缩略图 URL 后，清除该 URL 的传输 / HTTP / 解码失败记录，并解除同源传输暂停；资源键、等待与
  成功信号统一使用浏览器 URL 解析后的形式，避免域名大小写或默认端口造成匹配失败。其他失败 URL
  保持原记录。所有失败卡片沿用可取消的缓存可用性等待，重领纹理不重新布局；若仍失败则再次暂停，
  不逐帧重试、不重建画布、不清空健康纹理，卸载时移除成功事件监听。
  瀑布场景在相机位置和缩放未变化时跳过重复的窗口整理、卡片排序与 LOD 分配；
  图片数据更新及视口 resize 仍强制整理。相机、卡片动画和纹理交接继续沿用原有帧循环，
  不以暂停播放或打开详情直接停掉未结束动画，也不新增按需渲染唤醒状态机。
  运行时在有效自动播放状态变化时上报 `onMotionActiveChange`，同一状态供调试快照使用；`ShowPage`
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
  窗口边缘先判断下一槽位是否进入驻留区域，再领取图片；停在卡片间隙不会消费候选或触发补图。
  `show-pixi-layout.ts` 定义 `3G` 提示阈值与 `8G` 上限；`ShowPage` 唯一持有本次挂载的确认状态及待应用密度比例。
  瀑布 Sprite 驻留上限按当前画布宽度划分：不超过 760px 为 960 张，超过为 2800 张，包含屏内及屏外缓冲。
  按钮与相机共用列数请求入口，wheel / pinch 在跨过 `3G` 前同步取得允许的缩放值，普通缩放帧仍留在相机内。
  未确认时停在 `3G`，确认后应用请求；比例按当前视口换算。提示复用 `DialogFrame` 的焦点、页面锁和退场回调，
  只加载展映自身样式；运行时通过同一个 `dialogOpen` 状态暂停详情或提示背后的画布输入与动画。
  相机与 float 控制器都在拖动和松手惯性中保留指针类型，普通滚轮不继承前次拖动的输入类型。
  导航显隐由手动位移事件驱动；按钮缩放、Ctrl + 滚轮、双指缩放、锚点修正、resize 与自动巡航均不触发导航显隐。
  自动巡航在手动运动结束后立即恢复，不使用固定等待或按时间猜测手动位移。
  `ShowPixiFloatScene` 直接拥有屏幕坐标、生命周期空档、混合尺寸面积密度、路径预测与速度间距反馈，
  以同一速度计算推进图片和预测遮挡；70%–120% 的宽度序列同时用于实际卡片和纹理预取。
  默认宽度与密度随视口连续变化，数量依据真实图片比例和实际显示面积计算；小图下限受驻留预算约束，
  大图按旋转后的视口空间限制宽高，保留图面进入视口的观看时间。每张图片保留独立巡航速度，
  入场评估完整观看路径，运行中只评估当前与近期的遮挡；被覆盖的卡片沿平滑横移逐步离开重叠区，
  速度间距只考虑横向相交的邻居，避免远处图片使重叠卡片长期同速。
  自动漂浮开关只控制自动位移与相位推进；手动拖动、滚轮和惯性按有界空间步长推进卡片流，每段统一处理
  上下两端越界回收，在相反进入端补图，暂停时继续工作，不把现有卡片边缘当作滚动终点，也不保存历史区域。
  反向清除旧方向的滚轮余量或拖动惯性，仅调配完全屏外的卡片平衡上下储备，优先使用已解码纹理；
  入场位置与外侧回收边界保留余量，回收高度覆盖当前尺寸与目标尺寸。手动移动清除旧布局的纵向追赶目标，
  自动漂浮与路径预测在手动运动期间让位，运动结束后立即按暂停开关恢复。
  初始摆放和运行中的局部避让共用位置评分，路径调整在既有 ticker 中逐张错开执行；横移保持
  平滑速度，每张卡片独立持有漂移与 ±3° 旋转相位。鼠标悬停在约 240ms 内摆正平面角度，
  释放后在原相位上从当前角度继续，不跳回旧倾角；键盘焦点只保持运动。尺寸改变时超额卡片
  渐退，保留卡片平滑重新分布；目标卡片总数包含屏外卡片，最少 6 张，驻留上限从 96 张随宽度连续增至 180 张。
  float 最多使用 500 张候选；两个场景在未消费候选少于 100 张或布局缺图时
  请求补充。float 随机池增量更新保留已有候选顺序，只对新增候选洗牌，避免重排屏内卡片；
  接收新批次前退役已消费且无引用的 DTO；当前容量不足时等待。上下缓冲分别拥有稳定的后续图片与尺寸计划队列，
  合计预取窄屏 6–18 张、宽屏 12–36 张，平分预算，奇数时下方多一张；反向保留另一端队列。
  卡片先接管同一纹理引用再释放已消费计划，补图批次结束后补足队列，尺寸变化时更新纹理尺寸；
  两端回收按进入端的生命周期空档安排入场，共用既有缓存、像素和并发上限。
  两个场景复用同一圆角纹理几何、1 屏幕像素边框、命中与交互桥接；每张卡片持有唯一命中矩形，
  稳定尺寸且现有绘制签名有效时跳过几何计算，尺寸、纹理、交互层级和渲染比例改变沿原有失效入口更新。
  悬浮透视快照保存生成时的实际纹理边界与图片内框尺寸，缩放时将该内框映射到当前图片内框，
  与实时边框共用透视投影；保留分档快照复用，不按每个缩放帧重新截图。圆角图片与固定光晕、
  透视快照和悬停边缘光参与卡片批处理，保留原有细分与 UV，减少独立绘制；
  回收时直接释放各自几何和纹理。React 只渲染控制、详情及有界键盘 / 读屏代理；
  初始化时停用 Pixi 自动无障碍系统，避免移动端多出
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
  词表和存储列表共用 `SortOrderInput` 持有数字草稿，聚焦数字框自动全选，减一 / 输入 / 加一属于同一编辑区域，
  区域内切换焦点不保存；Enter 或移出整个区域才调用 `useSortOrderSave` 单项写入并由查询所有者回读。
  保存状态按条目隔离，只禁用提交中的卡片；不同条目的提交依次完成写入与回读，单项失败不阻塞后续提交。
  控件显示真实排序值，业务输入范围为 -5,000,000 至 5,000,000，允许负数和同值；失败保留草稿并通过右上角红色消息反馈。
  `invalidateDataAfterSortOrderSave` 仅失效对应列表和受影响选项，列表刷新失败独立报告。
  `invalidateVocabularyData` 用于词条新建、显示名和作者资料变更，只刷新所属词表、画廊筛选与统计、
  接入词表；已由响应更新的作者列表不再回读。删除词条会改变图片关联，仍失效完整图片查询。
  本地存储固定首位且不显示排序控件；其余存储项按同一数值及 slug 规则排序。
- `pages/admin/ingestion/` 管理统一 prepared ingestion 队列，稳定分为 `queue/`、`workflow/`、
  `upload/` 和动态 `import/`。统一内容接入是上位领域，`upload` / `import` 分别表示浏览器
  Upload 与 Server Import，内部 mode 也使用 `upload` / `import`。
  `Ingestion.tsx` 装配两个 owner、当前 mode、激活意图、
  来源弹窗加载与工作流窗口；`queue/` 保存 queue controller、API、状态回读、SSE、草稿同步及 `model/`、
  `cards/`；`upload/` 保存本地文件模型、raw XHR lane 和上传 owner；`import/` 保存 URL、JSONL、
  微博来源模型、弹窗与 Import 接收 owner；`workflow/` 保存窗口、稳定 DOM 区域、清理和动作状态机。
  `queue/ingestion-http-client.ts` 负责 HTTP 传输，`queue/ingestion-queue-contract.ts` 定义队列协作接口与完成结果投影。
  `queue/model/ingestion-job.ts` 持有页面任务、冻结提交意图和默认属性类型；全站 `lib/types.ts`
  只保留跨页面类型，不依赖接入领域。Upload 与 Import 共用 Shared 的接管结果联合，HTTP 只投影
  当前客户端消费的身份、状态与凭据；请求指纹和凭据有效期由 Server 内部协议持有。
  `model/ingestion-queue-state.ts` 从任务数组准备展示前缀、排除项和接管集合；分页只切取当前页，
  不重复准备整个队列，派生数据仍由同一任务数组决定。
  `model/ingestion-release-projection.ts` 根据冻结的 pair / attempt、服务端水位和已释放摘要计算
  剩余总数；它只消费输入，不持有请求、React 状态或资源。`useIngestionQueue.ts` 继续拥有释放
  目标、恢复 promise 和 Blob 生命周期。
  来源弹窗由 `import/` 独立动态加载。配置段使用同一领域词汇：Import 来源使用
  `import.*`，Upload 专属入口使用 `upload.*`，共用原图准入、队列分页与提交使用
  `ingestion.*`。`data/config.json` 只按当前默认结构投影、校验并原子
  写回；当前结构之外的字段直接删除。
- `queue/model/ingestion-status-summary.ts` 是单项服务端状态桶纯函数，快照移除与取消释放分别
  解析输入后复用；不保存队列状态，也不替代 Redis 汇总权威。
  已接收完整原图且仍待处理的任务只保留总数和未完成数，不进入等待或处理等状态桶；
  Redis 原子投影、浏览器本地摘要和单项取消扣减采用同一口径。
- `components/actions/SplitActionButton.tsx` 与 `styles/admin/split-action-button.css` 统一拥有
  导入入口和默认属性栏的分体按钮、悬停、键盘导航与菜单退场；`import/ImportSplitButton.tsx`
  只装配来源动作和预载意图。键盘打开与悬停打开分开处理焦点，菜单仍复用 anchored menu。
  来源标签页维护 roving tabindex 和关联 tabpanel，保留指针输入流程。
- `components/form/WorkflowAttributeActions.tsx` 只拥有清空主题、标签、作者或三项的确认窗口，
  `lib/image-draft.ts` 提供显式空值 patch。图片编辑器冻结本次活动 ID 并更新原会话草稿；
  `workflow/useIngestionQueueSubmitActions.ts` 冻结队列水位、数量上限与失败重试集合，
  `useIngestionQueue.ts` 在确认存续期间只保留本地 ID / attempt 到首个 canonical pair 的交接身份。
  服务端 `queue/action.ts` 为属性动作接收有界精确 pair，复用原权限、指纹和 metadata CAS，
  草稿、队列状态与持久数据仍由原所有者维护。
- `LogPage.tsx` 保存等级成功后取消旧日志读取，将已确认等级写入所有现有日志文件查询，
  只刷新当前活动文件一次；刷新失败保留确认值，不新增等级查询或延时同步。
- `SettingsPage.tsx` 仅拥有当前未保存表单，后台回读只在 clean 状态更新；保存与重载禁用整个表单，
  使用 15 秒请求期限，成功由 POST 返回值直接更新唯一 settings 查询，失败保留提交内容。
- `VocabularyAdminCard.tsx` 按字段对照上一权威基线维护 clean / dirty，同 slug 回读只同步 clean 字段，
  成功保存立即采用规范化值，切换词条身份重新初始化。
- `lib/api/client.ts` 集中 JSON 解析失败、凭据和 401；`apiResponse` 为配置包提供原始文件响应。
  元数据与接入完成复用词表成员比较，仅新词条超出已有缓存时失效一次 `ingestionVocabulary`。
  `lib/api/request-deadline.ts` 拥有单次请求从连接到完整响应体读取的 30 秒期限和失败中止；
  回调负责完整读取正文，期限封装不重试请求，也不承诺取消服务端写入。
  `lib/api/read-request-retry.ts` 为内容接入词表、存储选项和编辑快照提供只读重试策略：
  读取超时、网络失败或 HTTP 408 / 500 / 502 /
  503 / 504 后按 0.5 / 1 / 2 秒最多重试三次，即一轮读取最多四次请求。每次结束均清理
  计时器；其他错误（包括 429）和外部取消直接结束。词表与存储选项在原共享
  Query owner 上显式采用策略，使 `fetchQuery` 与 `useQuery` 共用重试、去重和缓存。
  编辑快照虽用 POST，但只读取数据，冻结 ID 请求体后独立重试，并让取消信号终止请求与退避。
  Server 将请求取消传入连接取得与图片锁等待，取消后不再继续读取和投影；已开始的图片写入
  仍遵循自身提交边界。
  编辑保存后的权威回读也只使用这一层策略；耗尽后人工确认只重读快照，不重放保存。
  写响应未知时按尝试字段保守失效；后续首次取得权威快照还要交接当前值，避免父页面停留在提交前的数据。
  `auto` 等指令是否成功仍独立判断，不能因无法确认指令而阻止父页面采用已读取的权威当前值。
  已收到写响应的保存已在提交后刷新，人工确认不重复失效。
  权威结果立即交接并结束编辑器保存等待；派生查询在原所有者后台刷新，其挂起或失败不阻塞
  编辑器关闭，保存回调的异步错误仍记录到后台日志。
  编辑保存仅复用单次期限，先深度冻结提交意图；写响应挂起或丢失后进入同一权威确认流程，
  确认结果只收敛本轮字段，不覆盖之后修改的草稿。丢失写回执时，标题和描述按 trim 后的
  目标、来源和原图 URL 按共享 URL 规则与权威值比较；后续草稿是否仍属本次提交继续比较
  原始输入，自动识别指令仍要求写回执。
  公开 `gallery-facets` 同样复用单次读取期限，保留原 Query 重试所有者和手动刷新去重。
  纹理仅复用期限与取消，不采用后台 API 的重试策略。
  各项读取单独恢复，全部耗尽后交给原有失败反馈；模块资源、写操作和队列恢复保留各自策略。
- `IngestionLauncher.tsx` 拥有入口按需加载、共享存储选项就绪与激活意图：启动阶段复用页面根 `inert` 锁而不禁用
  图片页按钮，`Ingestion.tsx` 在最外层 `DialogFrame` 挂载后以同一引用计数锁完成无缝交接；
  关闭只退休仍活动的意图，加载失败则在根锁清理后归焦仍连接的启动入口。来源菜单在自身退场前
  同步提交启动意图，不持有动画结束后的延迟激活。模态生命周期的焦点、滚动和背景命中仍只属于
  共享弹窗边界。
  工作流只在共享存储查询成功后打开，不构造临时本地存储选项；来源弹窗异步解析完成后调用
  最新已提交渲染的提交回调，让新任务采用当前选择和默认属性。
  `Ingestion.tsx` 在主窗口实际关闭时重置默认属性，初始化与关闭复用同一工厂；子弹窗关闭不触发
  重置，队列 owner、已有草稿和已冻结接管请求继续保持各自生命周期。
  `import/useImport.ts` 按当前 `import.max_items` 串行发送解析后图片，保持批次身份与位置；
  取消先退休未发送占位，明确的首次整体拒绝可直接清除，其余未知尝试以冻结输入请求
  `cancel_if_missing`。`session-service.ts` 与 canonical 创建 Lua 在同一幂等身份下返回已接管
  状态或原子写入 discarded 回执，缺失尝试不会因取消被加入下载队列。
  `queue/ingestion-http-client.ts` 对 intent、accept、状态核对和逐项取消统一设置 30 秒传输上限，
  超时不宣称服务端失败或取消；解析、文件传输和后台队列动作不使用这一控制请求上限。
  raw XHR 回执先验证 JSON 对象形状，再解释成功或错误字段；异常回执明确结束 Promise，
  由已有上传 lane 的 `finally` 释放槽位，不自动重放结果不明的上传。
  `import/manifest-jobs.ts` 创建 JSONL / 微博任务时合并来源与默认标签并去重；单值字段仍采用清单
  优先规则。`queue/model/ingestion-attribute-policy.ts` 统一本地 initial / ready 阶段的标签追加，
  与服务端全队列属性动作一致，不让清单字段优先规则阻止多值标签合并。
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
  `public-core.css` 统一画廊与展映底部控件透明度：精细悬停设备的区域悬停或控件组包含
  `:focus-visible` 焦点时为 95%，导航存在时为 80%；指针点击后残留的普通焦点不阻止淡出。
  导航隐藏且无交互保护时控件为 30%、展映提示文字为 20%，保持 5 秒后淡至 10%。
  重新悬停、获得键盘可见焦点或显示导航取消本次淡出；保护解除后重新计时。
  减少动态效果时保留 5 秒等待，直接切换最终透明度。
  `styles/semantic-colors.css` 拥有启动暗色、公开页源颜色及共享组件的公开上下文映射；
  启动画布的普通文字、成功、危险与错误反馈文字都由颜色门禁验证至少 4.5:1 对比度。
  画廊与展映在 `gallery-semantic-colors.css` 中局部降低正文、导航和强调白字的亮度，
  保留高于后台暗色正文的亮度；弹出到页面外的筛选菜单与密度提示使用同一层级，首页继续使用原公开配色。
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
  使用导航、页面底色、卡片和嵌套区域逐级提亮的近黑表面，配合柔和灰白正文、
  分级弱化的标签与说明文字，以及满足交互边界辨识的控件边框；桌面与移动端共用
  各角色的文字、底色、悬停、选中和状态表面。实色主操作按钮保留清晰的白色强调文字。
  后台图片详情在管理弹窗内将详情颜色别名映射到后台配色，公开详情继续使用共享
  默认值；公开详情的正文使用柔和灰白，面板、描述卡片、边框与次操作表面减少蓝色偏向，
  公开与后台的图片区共用固定中性近黑底色。详情图片区规则使用弹窗作用域，
  背景优先于渐进图片的通用占位色，不依赖样式分块加载顺序。来源按钮以描边观感为主，后台暗色和公开详情的可用状态
  在面板上叠加极轻的中性提亮，后台亮色保持透明；边框复用描述卡片与管理信息面板的边界色。
  描述、来源与管理信息的边框及管理分界线共用 `--color-detail-panel-border`，比普通细边界略亮、偏中性。
  可用时的悬停与键盘焦点使用次操作反馈；
  禁用状态保留弱化且不触发按压动画。
  两个分支都只让蓝色
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
  `scripts/tests/verify/check-semantic-colors.mjs` 校验传统与现代颜色语法、完整 CSS 命名色、
  token 定义与引用完整性、无用 token、启动文字对比度及公开/后台依赖边界。
  颜色值集中在语义色表或 CSS token 声明中；品牌资产不属于应用主题源码扫描范围。
  语义命名与视觉设计由审查和页面验收判断，门禁不维护状态词黑名单或文件例外清单。

`lib/`、`hooks/` 和通用组件不得反向导入具体页面。只有形成稳定跨页面职责的代码才上移，
页面内部的小组件无需为目录对称而拆分。

### Web 构建资源边界

主构建和 Worker 均使用 Vite 的 `rolldownOptions` 配置输出，命名与分块规则由各自构建器执行。
构建使用稳定的相对 `base: "./"`，模块、动态预加载及 CSS 内部资源由构建器生成相对引用。
`routes/spa.ts` 在现有 RuntimeConfig 文档快照生成阶段将 HTML 的入口地址定为主站 `/assets/`
或 `site.assets_base_url` 指定的根目录；入口与站点图标共用 `config/site-host.ts` 的静态资源根地址。
配置变化使 HTML / ETag / 编码缓存按原有机制更新。
JS、CSS 和压缩副本保持构建字节，不随 Host 改写，也不需要按部署重建镜像。
SPA 与嵌入页的脚本 CSP 允许所配置资源 origin；ALTCHA Worker 从构建 URL 提取文件名后，
固定使用主站 `/assets/`，保持浏览器同源与独立按需加载要求。

主站与独立 Host 共用 `createAssetHandler()`；资源 Host 边界将公开根目录下的相对路径映射到内部 `/assets/`，
不查询数据库、不跳转主站，也不开放 API 或 SPA。两者共享静态压缩协商、条件请求、缓存头与无凭据 CORS。
资源 URL 是 RuntimeConfig 部署字段，配置包与站点域名一样排除此值，并保留目标实例当前配置。

Web 继续使用 entries-aware 的入口根集合分块，`minShareCount: 2` 表示模块至少被两个真实
动态根共同引用才形成共享块。资源边界的判断顺序固定为权限、路由 / 能力意图、请求经济性：
只有权限可见性、最早懒加载祖先和全部受测闭包都相同的资产才可以合并。交叉入口小块若并入
任一调用方会造成未访问能力预载或复制，就保留为可解释的独立共享成本。

生产 JS 与 CSS 使用从 Vite / Rolldown 构建图推导的简短语义 `[name]-[hash]` 文件名。独立
facade 使用 PascalCase 职责名，例如 `Home`、`Gallery`、`Show`、`ImageAdmin`、`ImageEditor`；
合并与共享块使用 kebab-case 职责名，例如 `public-ui`、`image-view`、`dialog-frame`。名称不按
字符数截断，也不使用序号或构建后 import 重写。内容哈希仍是缓存身份，名称只负责解释职责；
资源 URL 大小写敏感，全部引用由构建器按实际名称生成，不在业务代码中手写。每次生产构建都生成
`.vite/web-build-report.json`，记录 facade、dynamic importer、入口类型、静态 / 动态依赖、
模块根和 CSS owner；服务端装配明确过滤 `.vite`，因此报告不进入最终镜像。
报告生成在同一次同步 `generateBundle` 内复用模块信息查询，入口根遍历保持循环处理及动态根语义；
复用结果不跨越分组命名阶段、重建或 Worker 构建图，完整报告内容保持原契约。

内容接入 facade 与样式使用 `Ingestion-[hash].js` / `Ingestion-[hash].css`，来源弹窗使用
`ImportSource-[hash].js`，facade 与来源弹窗共享的 URL 来源解析能力按实际职责命名为
`import-job-source-[hash].js`。`upload` 与 `import` 分别作为浏览器文件和 Import 来源子模式，
父领域独立 facade 统一使用 `Ingestion` 命名。

`scripts/build/static-asset-compression.mjs` 统一生产压缩参数：Brotli 11、Zstd 22、gzip 9，
使用 Node 内置 `zlib`；Zstd 的 `windowLog=23` 将 HTTP 解码窗口限制为 8 MiB。
每种编码各自只在结果严格小于原始正文时采用，不设置最低原始体积、节省量或跨编码比例门槛。
`copy-server-assets.mjs` 在最终资源装配时生成 `.br` / `.zst` / `.gz`，逐文件串行，单个文件的
三种压缩并行。重复装配替换已有结果，并移除本轮没有节省的对应侧车文件。
根 `public/index.html` 由页面路由读取并动态注入配置，只复制原始模板，跳过预压缩和源目录中的
同名压缩副本；通用压缩器继续支持 HTML，静态资源目录中的 HTML 与子目录 `index.html` 正常压缩。

装配同时在 Web 构建目录生成 `.vite/static-compression-report.json`，记录实际写入产物的
`rawBytes`、`brotliBytes`、`zstdBytes`、`gzipBytes`、策略参数，以及所有可压缩资源的相对路径。
缺少某种压缩副本时，其字节字段记原始长度；`effectiveBytes` 是各表示的理论最小字节，
`defaultEncoding` / `defaultBytes` 则表示客户端等权接受 br、zstd、gzip 时，按 br → zstd → gzip
优先级实际选中的表示及长度。具体请求仍由客户端权重和可用副本决定；理论最小值不等于实际传输量。
这份元数据可与 `.vite/web-build-report.json` 的 JS / Worker / CSS 构建图连接使用，避免分析再次
全量高等级压缩；两份报告均不装配进运行镜像。

`core/http/static-encoding.ts` 负责 `/assets/*` 的编码偏好：解析权重、排除 `q=0`、识别通配符和
编码名大小写，同权时沿用 br → zstd → gzip，允许 identity 时可回原文件，无可接受表示返回 406。
缺省或空 `Accept-Encoding` 选择原文件；显式 identity 权重参与排序，隐式 identity 只作为回退。
文件路径、目录索引、MIME 和流发送继续由 Hono 处理；不同权重组需要时调用其 HEAD 分支查询元数据，
不发出网络 HEAD 或读取正文；普通等权请求只调用一次文件发送。`static-conditional.ts` 仍唯一处理
ETag、304 和单范围请求；协商不改写原请求或另建文件缓存。`/assets/*` 响应保留 `Vary: Accept-Encoding`。

本地 `check-web-chunks` 读取最终装配元数据和实际侧车文件，核对长度与解压往返，
不为分析重新全量压缩。JS、Worker 与 CSS 统计分别列出 raw / Brotli / Zstd / gzip 字节，
并区分默认协商的 `defaultBytes` 与理论最小的 `effectiveBytes`。
门禁验证匿名公开入口、后台登录、图片管理员和超级管理员路由的权限及
懒加载闭包；公开闭包出现后台专有资源、图片管理员闭包出现超级管理员专有资源、哈希失效或
重复内容都会直接失败。

本地报告列出未压缩小于 8 KiB，或默认协商响应体小于 4 KiB 的 emitted JS 与 CSS，并统计
512 B、1 KiB、2 KiB、4 KiB、8 KiB 原始体积档位及默认协商体积档位；这只用于发现可合并资源，
不是页面请求数或响应体积预算。只有与目标页面必然同行且不扩大权限、路由或能力懒加载边界的
资产才合并；资源门禁以真实构建图、权限闭包、同行关系和重复内容为准，总文件数本身不是目标。
报告保留全部入口必达的 Rolldown runtime，该虚拟 runtime 不进入模块 ownership 分组，也不在
构建后改写 import 或内容 hash。正文压缩采用规则与分块采用规则彼此独立。主构建图之外的
辅助 JavaScript 参与通用哈希、压缩与重复内容检查，不固定 Worker 数量，也不推定加载归属。
ALTCHA PBKDF2 Worker 必须由浏览器通过独立 URL 创建，且只在实际出现登录挑战时加载，不能并入
登录页首屏脚本。具有相同入口根的 emitted JS 与相同 owner 的 CSS 分组仅供合并评估，
不单独导致失败；内容完全重复的资产会使门禁失败。

运行时传输、浏览器缓存与接入负载测量使用根目录 `tests/` 下的隔离资源，原始数据保留在
各自测量目录，结论写入 `.agents/report/`。测量范围与工作负载按当次授权确定，不作为受跟踪
测试的前置依赖，也不进入 Actions 或生产镜像。

## docs

`docs/CONFIG.md` 按配置路径维护完整参数说明，`docs/DEPLOY.md` 维护部署说明。
`docs/guide/` 保存其他现行指南；其中 `roles/` 按普通用户、图片管理员、超级管理员和实例维护者
提供任务入口，主题文档维护架构、数据库、流程和 API 等完整契约。角色页只链接技术参考，
不复制容易漂移的底层细节。
`.agents/report/` 保存本地结论、比较决策和验收说明，由 Git 忽略；按报告中的时间与基线解释，
不替代现行指南。
原始日志、截图、浏览器快照和性能采样属于可清理的测试产物，不是报告或现行测试的必需依赖。
这些文档不生成或提供在线站点。
