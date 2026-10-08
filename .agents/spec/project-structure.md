# ImageShow 简要结构指南

> 本文件的读取时机与范围见 [AGENTS.md 文档导航](../../AGENTS.md#文档导航)。模块约束与跨模块协议见 [reference/](../reference/)；当前文件布局与实现细节直接读取源码。

## 文档边界

- 本文件只保存稳定目录职责、依赖方向和结构治理规则，供代理快速建立工作边界。
- 源码与构建结果是现行事实；文档与代码不一致时先核实原因，再修正漂移的一方。
- 稳定边界变化时更新本文件；模块约束变化时更新 `reference/` 中对应文档。

## Workspace 与根目录

依赖方向固定为：

```text
packages/server ──► packages/shared
packages/web ─────► packages/shared
```

`server` 与 `web` 不互相导入，`shared` 不依赖其他 workspace。

- `scripts/build/` 只承载生产构建、资源生成和产物装配；`scripts/runtime/` 只承载容器运行命令；`scripts/tests/` 承载受 Git 跟踪的长期契约测试、门禁及其固定夹具，位于生产构建上下文之外：顶层入口只编排稳定领域套件，`support/` 只提供窄职责支撑，数据库跨域合同按行为拆为可独立选择的小场景。领域套件、场景和支撑文件的数量保持稳定，新增须符合 [测试准入](test-admission.md)。
- `docs/` 是公开文档目录：`DEPLOY.md` 维护安装部署与恢复，`CONFIG.md` 维护配置，`api/` 说明随机图 API 和嵌入协议；读者范围与写作要求见 [AGENTS.md 文档规则](../../AGENTS.md#文档规则)。根目录 `tests/` 是被 Git 忽略的本地记录与临时产物目录，内容见同一节；受跟踪测试所需的文件都在 `scripts/tests/` 内。
- 默认 Compose 的 `data/` 保存应用配置、存储、运维自定义静态资源（`asset/`）、日志和接入临时数据；本机宿主目录覆盖见本地测试资源 `tests/local-resources.md` 的“本地运行环境”。
- `postgres/` 与 `redis/` 分别保存默认 Compose 的 PostgreSQL、Redis 持久数据，和 `data/` 一同排除于 Git 与 Docker 构建上下文；变更挂载时先停机迁移并保留回退数据。
- `.agents/process/` 保存流程，`.agents/spec/` 保存专项规范，`.agents/reference/` 保存模块约束与设计原因，通用约束留在 `AGENTS.md`；`.agents/plan/` 保存与 `TODO.md` 配套的未完成详细方案，`.agents/skills/` 是第三方技能，两者被 Git 忽略，完成记录留在 Release 或本地报告中。
- 生产镜像只包含生产依赖、编译产物、必要 schema / SPA 资产和运维入口。

## Shared

- `packages/shared` 只保存前后端共同需要的配置默认值、稳定类型、常量、DTO 与浏览器安全纯规则。
- 默认入口可供 Server 与构建配置使用；Web 只通过浏览器安全入口读取可进入 bundle 的契约。
- 数据库行型、执行所有权、Node.js 能力和未脱敏凭据不得进入浏览器入口。
- 浏览器安全契约按鉴权、后台、图片、词表、存储、接入及 API 边界分别维护，入口只汇出这些领域；领域间直接导入所属模块，不通过入口反向汇聚。

## Server

依赖从装配与 HTTP 边界流向领域，再流向基础设施：

```text
index / http-app / routes
          │
          ▼
images / storage / random / jobs / checks / vocab / users
          │
          ▼
core / config
```

- `src/index.ts` 只负责进程装配与生命周期；`http-app.ts` 和独立 CLI 的模块导入不得启动服务或产生初始化副作用。
- `routes/` 只负责 HTTP、Host、鉴权、权限、输入和响应边界，业务工作委托给领域模块；`routes/validation/` 按图片、Ingestion、存储、用户和词表职责拥有请求 schema，并集中保留通用 HTTP 原语，不建立总仓库或 barrel；`validation_error` 的 `details.issues` 映射由 `core/validation-issues.ts` 提供，供请求校验与站点配置保存共用。
- HTTP schema 以领域 DTO / 输入类型作编译期约束；列表、统计、JSONL 和 cursor 等非 HTTP 契约由对应图片或 Ingestion 模块拥有，领域模块不得反向导入 `routes/validation/`。
- `core/` 和运行配置 schema / store 提供基础设施，不依赖业务领域或路由。`config/` 唯一拥有 RuntimeConfig 写入协调、持久化和内存发布；`app-settings.ts` 拥有公开 / 后台投影与完整配置保存，组合存储注册表的 Host 冲突校验，基础配置模块不反向依赖该入口。
- `core/http/` 拥有供路由与审计共用的请求上下文契约；`users/` 实现会话认证及持久化。审计基础设施不得通过会话读取助手反向依赖用户业务。
- 数据库启动负责空库完整初始化与非空库最小只读 readiness；既有结构由维护者处理，额外表不进入数据或权限核对，必需结构不满足时明确失败。
- `core/redis/` 只拥有唯一 client、连接与能力探测和通用 Redis 原语；具体领域拥有自己的 Lua、命令注册、参数布局和返回解析，不以导入副作用反转依赖方向。
- 三档名称、对象目录、资源路径与随机 API 尺寸统一使用 `large/medium/small`；数据库保留 `l_/m_/s_` 列前缀，列映射由图片事实读取模块持有。
- `images/` 拥有图片读写、展示、分类、回收站、缩略图、read model、ready cache 与 Ingestion；分类只更新 metadata 与必要投影，不得依赖或触发对象搬迁。`trash/` 集中回收站与永久删除流程，`serving/` 集中图片寻址、对象响应与外部原图处理。正式展示图与缩略图属于公开资源，外部原图由管理路由先校验会话再交给 `serving/`，访问与投影规则见[安全与主机](../reference/security.md#会话与鉴权)。回收站永久删除的逐图意图由 `background_job.target_id` 与幂等键持有，metadata 不保存任务字段。
- `vocab/` 统一拥有作者、标签、主题的查询与集合修改事务，复用图片领域的 revision 与缓存交接；不取得对象位置或存储传输职责。
- `images/groups/` 拥有图片分组查询和成员事务，与图片修改共用锁及投影同步；分组不进入词表领域。
- `images/storage-location/` 拥有正式图片后端位置事务、并发协调及提交后缓存交接；`storage/` 提供存储 I/O 与清理能力，不取得图片位置事务所有权。正式对象键独立于可编辑分类，只有接入、后端迁移、删除和显式运维迁移可以创建、复制或删除正式对象。
- `images/ingestion/` 统一拥有 Upload / Import 会话、队列、raw、来源、执行、提交、取消、清理和 Worker；`raw/` 拥有 `data/temp` 内的统一文件、租约与清理，来源由任务信息保存。会话状态不得进入通用 `jobs/` 或建立第二套恢复真相。
- `images/variants/` 拥有三档编码、文件核验与事实投影；shared 拥有地址表边界、档位规则和固定 WebP 对象键。
- Ingestion 内部协议、执行与顶层装配按 [模块分层](../reference/ingestion.md#模块分层) 组织；Routes 只依赖公开 service、repository facade、DTO 和窄执行控制接口。
- `storage/` 拥有 backend、driver、对象原语、位置锁、I/O 准入和持久清理；存储配置 schema、记录解析与领域输入类型留在 `storage/backends/`，HTTP 请求 schema 留在路由边界；`random/` 只编排随机出口；`jobs/` 只维护通用后台任务生命周期；`checks/` 负责检查和显式维护入口。
- 存储注册表独立拥有配置缓存与共享加载，不接收请求绑定的 reader；本地公开图片 Host 与静态资源 Host 由统一资源 Host 边界准入，各自固定入口并复用主站的对象与静态响应，不经过每图寻址。`/assets/` 只提供镜像内构建产物（含内置图标），`/asset/` 只在主站提供 `data/asset` 中的运维图片，两者不互相回退。读取顺序与准入规则见[架构不变量](../reference/architecture.md#redis-图片投影)与[安全与主机](../reference/security.md#代理与-host)。
- 可变状态、连接、协调器、Worker、限流器和事务各有唯一所有者；不得因拆文件创建第二实例、第二状态机或第二恢复权威。
- 跨领域调用直接依赖对方表达职责的模块，不经由路由、测试工具、模糊 service 或 barrel 绕行。

## Web

依赖方向固定为：

```text
pages ──► components / hooks / lib
components ──► hooks / lib
hooks ──► lib
```

- `pages/` 负责编排路由页面，页面专属组件、Hook、查询和状态机就近维护。
- `components/` 只保存稳定跨页面 UI；`hooks/` 只保存稳定跨页面生命周期或交互所有者；`lib/` 保存无界面客户端、查询契约和纯能力，三者不得反向依赖具体页面。
- 通用弹窗与 portal 归 `components/dialog/`，锚定菜单归 `components/menu/`，直接激活动作归 `components/actions/`；`components/feedback/` 只拥有操作反馈与加载、错误边界。
- Web 直接消费 shared 的 DTO 与公共常量，不另建总类型别名层；页面表单类型就近维护，公开图片组合类型与画廊预算归 `lib/gallery/`。
- 公开浏览的 URL 筛选动作由同一 Hook 持有，导航组件只组合共同视图；画廊与展映分别拥有页面生命周期。展映入口保留路由懒加载，渲染实现位于页面所属的 `pixi/`。
- 普通公开页面与后台共用会话所有者；嵌入路由始终是访客，不挂载会话所有者，共享详情按可选会话上下文消费身份，不直接读取认证缓存或另建探测入口。
- `pages/admin/groups/` 拥有分组管理与成员操作编排，按 ID 输入及只读核对复用图片工作流；分组不是词表，列表复用词表布局，成员页面复用图片筛选、分页、选择和卡片，查询由分组范围独立标识。
- `pages/admin/ingestion/` 以 Ingestion 为上位领域，以 `upload` / `import` 为来源子模式；queue、workflow、来源 owner 与浏览器资源所有权保持单一。
- 页面和权限专有代码保持懒加载，资源合并不能扩大权限、路由或能力边界；分块规则见 [Web](../reference/web.md#按需加载与分块)。
- 样式按语义职责和页面边界维护；结构重组保持视觉、交互、DOM、ARIA 与分块行为不变。

## 结构治理

- 以职责、状态所有权、变化原因和依赖方向决定拆分或合并，行数与文件数量只作参考。
- 按稳定职责和依赖边界组织目录；单文件或单消费者逻辑通常就近维护，已有约定目录和明确边界按实际内容维护，拆分只因职责或依赖边界。
- 不创建 `common`、`helpers`、`misc` 等模糊收纳区，不用大量 `index.ts` barrel 隐藏真实依赖。
- 移动后直接更新内部 import，旧路径随之删除，公共 API 保持原有范围。
- 先移动和提取既有逻辑，再删除本次重组直接产生的重复；结构调整保持业务行为不变。
- 不允许循环依赖、跨层反向依赖或重复状态所有者。
