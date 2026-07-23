# 项目结构

ImageShow 使用 npm workspaces 管理四个包。依赖方向固定为：

```text
packages/server ──► packages/shared
packages/web ─────► packages/shared

packages/docs ──► 独立构建为静态站点
```

`server` 与 `web` 不能互相导入；`shared` 不能依赖其他 workspace。文档构建产物与 Web
构建产物最终由服务端镜像提供，但它们在源码层仍是独立包。

## 根目录职责

- `package.json` 只编排 workspace 构建、类型检查、死代码检查和运维入口。
- `scripts/build/` 只生成 Web 图标并汇集服务端迁移、SPA 与文档静态资产。
- `scripts/runtime/` 只放容器内的命令包装；容器启动由 `docker-entrypoint.sh` 负责权限
  收敛后直接执行传入命令。
- `Dockerfile` 先安装完整依赖并构建四个 workspace，再单独安装 server/shared 的生产依赖，
  运行镜像只携带生产依赖、编译产物和运维入口。
- `compose.yaml` 提供单实例 ImageShow、PostgreSQL 与 Redis 的标准部署。

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
| `core/` | PostgreSQL、Redis、鉴权、安全抓取、日志、密码、UUID、并发和通用校验；不依赖业务路由。 |
| `config/` | 部署环境、首次播种、运行时配置 schema、`config.json` 存储和配置包。 |
| `routes/` | HTTP 方法、鉴权、CSRF、输入解析和响应投影；业务工作委托给领域模块。 |
| `images/` | 图片读写、展示投影、缓存、分类、删除与恢复；`imports/` 拥有完整导入会话生命周期，`read-models/` 只读 PostgreSQL。 |
| `storage/` | local、S3、WebDAV driver，后端注册表，对象键、强摘要传输、位置锁、迁移与补偿删除。 |
| `random/` | 随机筛选、Redis generation、增量同步、全量重建、去重和随机出口读模型。 |
| `jobs/` | `background_job` 仓储、任务 handler 和公平调度 Worker；不拥有导入会话。 |
| `checks/` | 数据库、Redis 与存储一致性检查，以及显式触发的存储维护。 |
| `authors/`、`tags/`、`themes/`、`vocab/` | 词表查询、写服务、关联锁与派生缓存。 |
| `users/` | 管理员初始化、账号、密码恢复、偏好和会话失效。 |
| `types/` | 仅放缺失的编译期声明，不承载运行时代码。 |

领域模块可以依赖 `core/` 和 `config/`，但基础设施不能反向导入具体路由。跨领域调用应使用
对方明确的领域入口，不能通过路由或测试工具绕行。PostgreSQL 始终是业务真相源；Redis
模块只实现可重建读模型与运行时状态。

## packages/web

Web 以路由页面为编排边界，依赖方向为：

```text
pages ──► components / hooks / lib
components ──► hooks / lib
hooks ──► lib
```

- `components/` 按稳定 UI 职责保存跨页面组件。
- `hooks/` 保存跨页面且主要管理 React 生命周期或交互行为的 Hook。
- `lib/` 保存无界面代码；HTTP 客户端、query key 和共享查询 Hook 集中在 `lib/api/`。
- `pages/` 保存路由页面与页面级编排，页面专属组件、状态机和 Hook 就近维护。
- `pages/admin/uploader/` 管理统一 prepared import 队列；其中 `link-import/` 负责 URL、
  JSONL 与微博输入。
- `styles/` 按 base、home、gallery、admin 和 responsive 组织全局样式。

`lib/`、`hooks/` 和通用组件不得反向导入具体页面。只有形成稳定跨页面职责的代码才上移，
页面内部的小组件无需为目录对称而拆分。

## packages/docs

文档包是 VitePress 静态站点。`guide/` 描述当前架构、配置、数据库、流程、部署和 API；
产品文档只陈述当前可用行为，不承担版本更新记录。构建后由服务端的 `docs` 子域路由提供。
