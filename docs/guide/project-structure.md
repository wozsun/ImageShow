# 项目结构

ImageShow 使用 npm workspaces 管理三个包。依赖方向固定为：

```text
packages/server ──► packages/shared
packages/web ─────► packages/shared
```

`server` 与 `web` 不能互相导入；`shared` 不能依赖其他 workspace。Web 构建产物最终
由服务端镜像提供；根目录 `docs/guide/` 只是普通仓库文档，不参与 workspace 或生产构建。

## 根目录职责

- `package.json` 只编排 workspace 构建、类型检查、死代码检查和运维入口。
- `scripts/build/` 只保存生产构建所需的清理、进程编排、Web 图标生成和服务端 schema / SPA
  资产装配；Web 构建直接输出通用产物图报告，报告不装配进运行镜像。
- `scripts/runtime/` 只放容器内的命令包装；容器启动由 `docker-entrypoint.sh` 负责权限
  收敛后直接执行传入命令。
- `Dockerfile` 只安装三个 workspace 的构建依赖（不安装根目录本地门禁工具）并完成编译，
  再单独安装 server/shared 的生产依赖；运行镜像只携带生产依赖、编译产物和运维入口。
- `compose.yaml` 提供单实例 ImageShow、PostgreSQL 与 Redis 的标准部署。
- `docs/guide/` 保存架构、配置、数据库、流程、部署和 API 说明，使用相对 Markdown
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
| `npm run verify:source` | workspace 类型、Knip、语义颜色、依赖方向 / 环、配置示例、图标、Markdown 链接与 selector inventory | 只读源码，不生成 `dist`、容器或浏览器会话 |
| `npm run verify:build` | 清理必要输出，先构建 shared，再并行构建 Web / Server，装配服务端资产并按真实产物图检查 Web 分块边界 | 重建三个 workspace 的 `dist`；根 `dist` 只作为旧残留被删除，不会重新产生 |
| `npm run verify:runtime` | baseline / Server / Web 三个最终入口，以及生产镜像冷启动、HTTP、schema 和重启 | 建立随机命名的 tmpfs PostgreSQL、Redis、应用容器、网络和临时镜像；无论成功、失败或中断均在结束前删除，不访问现有数据库、容器或浏览器 |
| `npm run verify:release` | 依次执行以上三层 | 合并上述本地副作用 |

`npm run icons:generate` 是维护图标生成源码的显式写命令；日常门禁只运行只读的
`npm run icons:check`。`npm run check` 直接检查 shared / Server / Web 源码，不先构建
shared，也不写生产产物。

GitHub Actions 只核对 dev 分支或 release tag、根包 / 三个 workspace / lockfile 版本，
然后通过固定完整 commit SHA 的 Actions 构建和推送生产镜像、创建 Release。它不运行
`verify:*`、Knip、最终测试、数据库、存储、浏览器或性能验收；Action 成功不能替代本地
`verify:release`。

## packages/shared

共享包是前后端唯一共同依赖，只承载稳定的配置默认值、类型、校验常量和 DTO。

- 默认入口只导出服务端与构建配置使用的完整 `appConfig`；Web 运行时代码不得导入。
- `@imageshow/shared/browser` 是图片、分类、导入、存储和管理设置等双端 HTTP/SSE
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
images / imports / storage / random / jobs / vocab / users / checks
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
  planned mutation fence 不再拆成逐函数转发文件。

两个 CLI 都直接依赖所需基础设施，不导入 HTTP 应用，也不会触发主服务启动；
healthcheck 只读现有配置快照，密码恢复不初始化运行时配置。

### 稳定领域边界

| 目录 | 职责与允许依赖 |
| --- | --- |
| `core/` | PostgreSQL、Redis、两阶段运行可用性、公开 PG fallback 准入、安全抓取、日志、密码、UUID、并发和通用校验；不依赖业务领域或路由。 |
| `core/http/` | HTTP 响应与响应头、请求来源和请求体限制、压缩阈值、条件请求、静态响应与 Range 解析。 |
| `config/` | 部署环境、首次播种、运行时配置 schema、无导入副作用的文件读写与显式进程内 store，以及配置包。 |
| `routes/` | HTTP 方法、鉴权、CSRF、输入解析和响应投影；业务工作委托给领域模块。 |
| `images/` | 图片读写、展示投影、分类与元数据变更、回收站和缩略图；`ready-cache/` 拥有统一 Redis rich 投影、筛选、统计、精确同步与重建，`imports/` 拥有完整导入会话生命周期及清理任务，`read-models/` 承载 PostgreSQL 降级读模型。 |
| `storage/` | local、S3 driver 及无环工厂；注册表缓存与 driver、管理读模型、配置变更、探测和占用统计分开维护，并拥有对象访问、强摘要传输、位置锁、迁移及 `move.cleanup` 仓储与 handler。 |
| `random/` | 随机查询校验、设备轴推断、Redis 8 Array 最近历史、定向 id 与有界 pivot 普通随机 PG 降级查询及随机出口编排；Redis 候选投影、筛选与重建统一由 `images/ready-cache/` 提供。 |
| `jobs/` | 仅拥有通用 `background_job` 生命周期、小型类型分派、公平调度 Worker，以及集中管理任务中止、期限、续租和有界排空的执行协调器；各领域拥有自己的 handler、payload 和结果语义。 |
| `checks/` | PostgreSQL / Redis 独立轻量状态、数据库 / Redis / 存储 / 回收站手动深度检查，以及显式触发的存储维护；Redis 深检以有界扫描和 pipeline 只返回当前汇总。 |
| `authors/`、`tags/`、`themes/`、`vocab/` | 词表查询、变更、关联锁与派生缓存。 |
| `users/` | 管理员初始化、账号变更、Redis 登录会话、逐请求 PostgreSQL 角色与密码代际核对、操作授权、密码恢复、偏好和会话失效；不维护管理员凭据 Redis 投影。 |
| `types/` | 仅放缺失的编译期声明，不承载运行时代码。 |

`core/` 内 PostgreSQL 基础设施按生命周期边界拆分：`database-pools.ts` 只接收显式配置并
拥有主查询与 advisory lock 两个连接池；`database-transactions.ts`、
`database-advisory-locks.ts` 和 `database-schema.ts` 分别拥有事务、锁与干净安装编排；
`database-readiness.ts` 只读核对当前 SQL 真正依赖的最小结构、行为约束、权限与稳定种子。
公开降级读取由 `public-db-admission.ts` 统一管理一个 FIFO 容量与等待队列，
`public-db-fallback.ts` 只负责请求级惰性 reader scope、执行期限和 client 释放 / 淘汰。Redis
缓存读取先行，首次真实回源才借 client，同一 scope 内的领域模块显式接收并复用 reader；
底层 `pool.query` 不再由进程上下文改写。

图片存储变更的单图原语集中在 `storage/image-storage-migration.ts`，在同一条可读控制流中
完成锁内真相重读、候选发布与校验、PostgreSQL CAS，以及提交结果不确定时的补偿判断；
不再为只传递同一记录的 prepare / switch / settlement 阶段维护文件和中间契约。
`images/image-storage-migration.ts` 只负责管理接口的 1..N 保序结果，
`storage/backend-migration.ts` 只负责整后端计数和流式分页，两者都直接调用同一个单图原语。
`checks/storage-check.ts` 只生成无写入权限的存储预览；`checks/storage-maintenance.ts` 在独占
位置锁内重新扫描并直接完成缩略图维修与孤儿删除，不调用旧请求热路径 repair 或通用后台任务。
回收站的移入 / 恢复集中于
`images/trash-mutations.ts`，永久对象删除与 claim 状态机集中于 `images/trash-purge.ts`，
两者不共享转发入口。`images/image-update.ts` 只拥有 1..N 图片锁、保序并发、逐项结果和
请求级派生计数失效；`images/image-update-item.ts` 是单图 metadata、author / theme / tag
创建、完整标签替换、分类位置 CAS 与持久清理回执的唯一 PostgreSQL 事务所有者。

`images/imports/` 内部继续保持单一编排入口，但按稳定职责分开：

- `session.ts` 创建、预览和取消会话；`materialize.ts` 只把 upload/download 原始素材
  原子发布到 `data/tmp`。
- `status.ts` 负责进程内 phase、状态投影与 SSE，并以请求信号和响应流共用的幂等
  cleanup 管理监听器、heartbeat、快照与写入失败；`lifecycle.ts` 负责租约、取消
  标记、execution fence 和失败落库。取消标记绑定会话创建代际与发布所有者，并由
  显式取消和 `cleanup-job.ts` 在执行者收口后比较清除；PostgreSQL 状态仍是唯一
  权威来源。
- `prepare.ts` 只编排会话认领、恢复和清理，图片处理与 prepared 结果由
  `prepare-artifacts.ts` 完成。
- `commit.ts` 只编排锁、对象落位与补偿；数据库事务、提交后缓存同步和候选对象所有权
  分别位于 `commit-persistence.ts`、`commit-sync.ts`、`commit-candidates.ts`。
- `weibo.ts` 只编排批次和 JSONL 清单，链接/时间/响应提取、受限上游协议、未知响应值
  归一化及公开类型分别位于 `weibo-parser.ts`、`weibo-client.ts`、
  `weibo-values.ts`、`weibo-types.ts`。
- 图片读取先由 `image-serving-record.ts` 将 Redis 命中与 PostgreSQL fallback 归一为
  同一 serving record；公开正式媒体的 ready-cache 明确空命中仍会在有界数据库读取中查找
  ready 或 deleted 行，入口在缓存和数据库读取前统一拒绝非规范或过长对象键。
  `stored-image-serving.ts` 只编排存储对象与缩略图，
  `external-original-serving.ts` 只处理外部原图探测、跳转和代理。
  `stored-object-response.ts` 集中流式、HEAD、Range 与缓存响应；缩略图缺失在只读 serving
  边界直接映射为 404，显式维修只属于 `checks/storage-maintenance.ts`。

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

- `components/` 按稳定 UI 职责保存跨页面组件。
- `hooks/` 保存跨页面且主要管理 React 生命周期或交互行为的 Hook；首页与画廊的导航
  共用 `usePageScrollMovement.ts` 管理 RAF 合并、页面锁定和有界滚动位移采样，
  `usePublicNavigationEntrance.ts` 保证公开主导航在 SPA 会话内只入场一次，
  `useOneShotAnimation.ts` 在动画结束或减少动态效果中断后永久移除本次入口状态，
  `useDocumentMotionPause.ts` 统一把文档隐藏状态交给持续环境动效。
- `lib/` 保存无界面代码；HTTP 客户端、query key 和共享查询 Hook 集中在 `lib/api/`。
  首页与画廊的主导航滚动阈值由 `lib/ui/public-navigation.ts` 统一定义；共享公开端
  入场缓动与首页导航淡入时长由 `styles/base.css` 的 motion token 提供，页面样式
  只保留自身阶段和区块时长。`lib/ui/preload-intent.ts` 将普通交互元素的鼠标悬浮、
  键盘聚焦和指针按下统一映射到同一被动预加载动作；接管指针激活生命周期的控件
  仍就近使用捕获阶段事件，公共能力不改变模块、查询或业务激活的所有权。该极小
  跨页面机制归入 `app-foundation`，不产生独立微型请求，也不反向引入后台实现。
- `pages/` 保存路由页面与页面级编排，页面专属组件、状态机和 Hook 就近维护。
- `AppRoutes.tsx` 将普通与嵌入路径映射到同一 `HomePage` / `GalleryPage`；页面参数只
  决定是否挂载主导航，不能复制公开页实现或以 CSS 隐藏导航。服务端仍独立决定嵌入
  文档是否存在并输出父页面白名单，前端开关只负责已加载 SPA 内的路由收敛。
- `pages/home/HomePage.tsx` 只编排查询、筛选状态和页面生命周期；首屏、筛选摘要栏
  与候选目录由同目录组件分别维护，首屏控制器只拥有背景与顶层阶段，目录区块单次
  揭示 Hook 就近维护，避免路由组件同时掌握全部首页交互。
- `pages/gallery/` 就近拥有 cursor / ID 数据窗口、typed-array 瀑布流索引、虚拟窗口、
  共享可见性观察器、三级导航状态机、查询级揭示 high-water 与开发统计；跨页面可复用的 DOM
  图片加载、解码和并发调度留在
  `components/image/`，页面层只设置画廊任务的优先级、暂停和驻留边界。无界面的
  页面滚动边界归一化放在 `lib/ui/`，由共享采样 Hook 提供给各页面交互状态机。
- `pages/admin/uploader/` 管理统一 prepared import 队列；`Uploader` 持有任务与来源状态，
  `UploadWorkflowWindow` 直接消费这些状态并就近渲染单消费者的头部、默认值、任务列表与
  页脚，不再复制一套 controller contract；其中 `link-import/` 继续负责 URL、JSONL 与微博
  输入适配。
- `pages/admin/admin-route-modules.ts` 集中拥有后台路由页面的生命周期级动态加载器；
  `AuthenticatedAdminShell` 的 `React.lazy` 与桌面 / 移动导航意图共用这些 Promise。
  `AdminNavigation` 只为角色过滤后可见的内部页面绑定模块键，外部“首页”出口不猜测
  根路由目标。预加载只能取得页面 JS、CSS 与静态依赖，不能挂载页面或提前执行查询。
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
  别名，不再声明原始颜色。后台颜色契约同时为后台路由、管理弹窗及公开详情中按需
  加载的管理动作提供同一套单像素焦点环，避免各入口回退到浏览器黑白粗框；
  后台成功、警告、危险和处理中状态只保留文字、表面、边框、动作、进度及必要强弱
  层级，导入阶段、登录、校验或具体页面直接映射这些角色，不另建流程专用色板；相邻
  生命周期确实需要一眼区分时使用通用的 `soft` / `subtle` / `strong` 强度，而不是
  再以页面名或阶段名创建颜色。检查卡、瞬时反馈和完成任务也按这一原则保留必要层级；
  后台亮色分支让侧栏、移动导航和内容区共享白色表面、黑灰文字与浅边框；暗色分支
  使用独立的暗色表面、亮色文字与满足交互边界辨识的控件边框。两个分支都只让蓝色
  承担当前项、选中态和主要动作，并通过同一组职责 token 的 `light-dark()` 值切换；
  暗色大面积交互蓝和带色透明层不能机械复用亮色 RGB，应按暗底重新提高可见度并适度
  降低饱和度，但仍须一眼可辨原有色相；实色主操作蓝保留明确色度，不参与表面层的
  去饱和策略。
  只有白色强调文字、纯黑阴影及代码、日志、图片舞台等固定暗底内容可按其内容契约共色，
  不重复声明或在组件中覆盖颜色；控件、卡片、弹窗及页面排布继续保留各自既有几何，
  后台卡片集合的网格间距统一为 6px。
  只有整张表面承担点击职责的概览卡、最近图片、图片主卡和新增存储卡使用轻微抬升、
  蓝色边框及焦点环，含表单或独立动作的配置卡保持静止，且减少动态效果时取消位移。
  后台外观模式提供显式亮色、暗色与自动；自动模式跟随浏览器或操作系统并实时响应
  变化。公开页面和启动底色仍拥有独立颜色上下文；未认证登录页与公开页面中的管理弹窗
  都继承公开暗色分支，不读取后台保存的外观偏好，只有认证后的完整后台应用账号偏好；
  `tests/verify/check-semantic-colors.mjs` 校验传统与现代颜色语法、完整 CSS 命名色、
  SVG 资产白名单、定义/引用完整性、无用 token、按色相命名、退役别名及公开/后台
  依赖边界，并拒绝超出规范集合的后台状态角色和页面 / 生命周期专用状态 token；
  当前品牌 favicon 是唯一允许保留原始色值的 SVG。

`lib/`、`hooks/` 和通用组件不得反向导入具体页面。只有形成稳定跨页面职责的代码才上移，
页面内部的小组件无需为目录对称而拆分。

## docs/guide

这里保存普通 Markdown 仓库文档。`roles/` 按普通用户、图片管理员、超级管理员和实例维护者
提供任务入口；同级主题文档维护架构、配置、数据库、流程、部署和 API 的唯一完整契约。
角色页只链接技术参考，不复制容易漂移的底层细节。文档只陈述当前可用行为，不承担版本
更新记录，也不生成或提供在线站点。
