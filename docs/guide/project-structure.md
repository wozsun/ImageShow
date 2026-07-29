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
- `scripts/build/` 只生成 Web 图标并汇集服务端迁移与 SPA 静态资产。
- `scripts/runtime/` 只放容器内的命令包装；容器启动由 `docker-entrypoint.sh` 负责权限
  收敛后直接执行传入命令。
- `Dockerfile` 先安装完整依赖并构建三个 workspace，再单独安装 server/shared 的生产依赖，
  运行镜像只携带生产依赖、编译产物和运维入口。
- `compose.yaml` 提供单实例 ImageShow、PostgreSQL 与 Redis 的标准部署。
- `docs/guide/` 保存架构、配置、数据库、流程、部署和 API 说明，使用相对 Markdown
  链接，可直接在仓库中阅读。

本地测试统一位于根目录 `tests/`，由 Git 忽略且不进入 Docker build context、生产镜像或
GitHub Actions。测试从外部启动与生产镜像相同的服务入口；测试数据库、Redis、Compose、
fixture、网络模拟和清理编排均留在 `tests/`。

## packages/shared

共享包是前后端唯一共同依赖，只承载稳定的配置默认值、类型、校验常量和 DTO。

- 默认入口包含服务端完整配置与共享类型。
- `@imageshow/shared/browser` 是浏览器安全子入口，只暴露可进入 Web bundle 的内容。
- 数据库、Redis、Node.js 文件系统或服务端密钥不得进入共享包。

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

- `src/index.ts` 只装配中间件和路由，执行迁移与管理员初始化，启动 Worker 和 HTTP 服务，
  并处理优雅退出。
- `src/admin-password-cli.ts` 是管理员密码恢复入口。
- `src/healthcheck-cli.ts` 是容器 readiness 检查入口。

两个 CLI 都直接依赖所需基础设施，不导入 HTTP 应用，也不会触发主服务启动。

### 稳定领域边界

| 目录 | 职责与允许依赖 |
| --- | --- |
| `core/` | PostgreSQL、Redis、安全抓取、日志、密码、UUID、并发和通用校验；不依赖业务领域或路由。 |
| `core/http/` | HTTP 响应与响应头、请求来源和请求体限制、压缩阈值、条件请求、静态响应与 Range 解析。 |
| `config/` | 部署环境、首次播种、运行时配置 schema、`config.json` 存储和配置包。 |
| `routes/` | HTTP 方法、鉴权、CSRF、输入解析和响应投影；业务工作委托给领域模块。 |
| `images/` | 图片读写、展示投影、缓存、分类与元数据变更、回收站、缩略图与回收站任务；`imports/` 拥有完整导入会话生命周期及清理任务，`read-models/` 只读 PostgreSQL。 |
| `storage/` | local、S3、WebDAV driver 及无环工厂；注册表缓存与 driver、管理读模型、配置变更、探测和占用统计分开维护，并拥有对象访问、强摘要传输、位置锁、迁移及 `move.cleanup` 仓储与 handler。 |
| `random/` | 随机筛选、Redis generation、增量同步、全量重建、去重和随机出口读模型；缓存键、策略、Lua、序列化模型与批量写入分别维护。 |
| `jobs/` | 仅拥有通用 `background_job` 生命周期、小型类型分派与公平调度 Worker；各领域拥有自己的 handler、payload 和结果语义。 |
| `checks/` | 数据库、Redis 与存储一致性检查，以及显式触发的存储维护。 |
| `authors/`、`tags/`、`themes/`、`vocab/` | 词表查询、变更、关联锁与派生缓存。 |
| `users/` | 管理员初始化、账号变更、登录会话、角色与操作授权、密码恢复、偏好和会话失效。 |
| `types/` | 仅放缺失的编译期声明，不承载运行时代码。 |

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
- 图片读取入口由 `serving.ts` 编排；`stored-object-response.ts` 集中流式、HEAD、
  Range 与缓存响应，`thumbnail-serving-lifecycle.ts` 集中缩略图可用性检查、并发
  补建、失败上下文和原图回退的 404 映射，使 local、S3 与 WebDAV 共用同一生命周期。

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
  共用 `usePageScrollMovement.ts` 管理 RAF 合并、页面锁定和有界滚动位移采样。
- `lib/` 保存无界面代码；HTTP 客户端、query key 和共享查询 Hook 集中在 `lib/api/`。
  首页与画廊的主导航滚动阈值由 `lib/ui/public-navigation.ts` 统一定义。
- `pages/` 保存路由页面与页面级编排，页面专属组件、状态机和 Hook 就近维护。
- `pages/home/HomePage.tsx` 只编排查询、筛选状态和页面生命周期；首屏、筛选摘要栏
  与候选目录由同目录组件分别维护，避免路由组件同时掌握全部首页交互。
- `pages/gallery/` 就近拥有瀑布流位置模型、虚拟窗口、共享可见性观察器、三级导航
  状态机与开发统计；跨页面可复用的 DOM 图片加载、解码和并发调度留在
  `components/image/`，页面层只设置画廊任务的优先级、暂停和驻留边界。无界面的
  页面滚动边界归一化放在 `lib/ui/`，由共享采样 Hook 提供给各页面交互状态机。
- `pages/admin/uploader/` 管理统一 prepared import 队列；其中 `link-import/` 负责 URL、
  JSONL 与微博输入。
- `styles/` 按 base、home、gallery、admin 和 responsive 组织全局样式；首页进一步
  将页面 / 首屏基础、候选目录基础及共享响应式交互分文件，并按该顺序引入。公开页
  不参与动画的 fixed 导航外壳、主次导航共用的位移栈和根滚动回弹边界集中在
  `base.css`，页面样式只负责各自第二导航栏的尺寸与独立显隐位移。

`lib/`、`hooks/` 和通用组件不得反向导入具体页面。只有形成稳定跨页面职责的代码才上移，
页面内部的小组件无需为目录对称而拆分。

## docs/guide

这里保存普通 Markdown 仓库文档，描述当前架构、配置、数据库、流程、部署和 API。
文档只陈述当前可用行为，不承担版本更新记录，也不生成或提供在线站点。
