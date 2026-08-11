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
| `<站点域名>` | SPA、公共 API、管理 API、健康检查 |
| `static.<站点域名>` | `/media/*` 与 `/thumbs/*` 对象字节 |
| `random.<站点域名>` | 随机图 API 根入口 |
| `link.<站点域名>` | 与展示图不同的外部 HTTPS 原图代理 |

未注册子域返回 404。嵌入页只在配置开启时提供，并由文档响应的 CSP
`frame-ancestors` 限定父页面；它不会扩大 API 的跨源权限。完整路由见
[子域名](./subdomains.md)，请求来源、鉴权与响应头见[安全](./security.md)。

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

`schema.sql` 是上一个已确认版本的干净安装基线；当前空库依次执行它与只跨一个发布周期的
`schema-additions.sql`，非空库只执行 additions 后做只读 readiness。版本 N 的安全增量在全部
受控数据库确认应用后，由 N+1 移入 `schema.sql` 并从 additions 删除；不支持跳过承载增量的
版本。应用不提供通用结构 diff、编号迁移、破坏性 DDL、契约标记或清库。允许的 additions、
兼容超集和拒绝条件以[数据库结构](./database.md)为唯一说明。
当前 `v4.8.11` 的 additions 是注释占位，不执行 DDL 或数据写入。

### Redis

Redis 8 只承载可以从 PostgreSQL 重建的图片读模型，以及会话、限流、近期随机历史、
词表缓存和短期探测结果。它不替代账号、权限、图片状态或导入状态。

全部 `ready` 图片共享一个固定命名空间：

- 核心投影无 TTL，包含 rich item、时间索引、对象反查、全局统计、完整性和已应用
  revision；
- 设备、明暗、主题、标签、作者索引以及组合筛选和动态统计是带生命周期的派生结果；
- 派生结果按需构建，受数量、成员数、工作量、并发和 TTL 上限约束；缺失、过期、损坏
  或超限只让当前读取回源 PostgreSQL，不会把派生结果当成真相；
- 核心投影损坏、revision 不一致或连接 epoch 改变会关闭 Redis 读门，并由同进程
  single-flight 重建。

图片事务先在 PostgreSQL 推进 `ready_image_revision`。影响不超过 500 张时，提交后在
进程内写栅栏中精确更新核心投影；更大操作不加载完整 ID 列表，而是保持读门关闭并只
安排一次全量重建。Redis 失败不回滚已经提交的 PostgreSQL 结果。

Redis 运行期不可用时，后台在会话读取前统一返回 `503 redis_unavailable`；公共图片、
列表、统计、资源反查和随机图进入统一的有界 PostgreSQL 回源。回源拥有总并发、分类
并发、排队、执行期限和 SQL 工作量上限，不允许各路由自行创建第二套准入。

随机筛选和返回契约见[随机图 API](./random-api.md)，管理检查只展示当前投影与深检结果，
不会把整个 Redis 实例的内存观测解释成 ImageShow 容量承诺。

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
带物理命名空间 identity 的持久 `move.cleanup` 回执，避免迟到 DELETE 删除后来采用的
对象。

导入会话另以 session advisory lock 和 `execution_token` 隔离 materialize、prepare、
commit、取消与过期清理。任何连接丢失或调用方取消都通过 `AbortSignal` 传播；领域模块在
发布状态、写对象和删对象前重新核对所有权。端到端状态见[功能与流程](./flows.md)。

## 后台 Worker

Worker 只消费四类持久任务：

| 类型 | 所属领域 | 作用 |
| --- | --- | --- |
| `move.cleanup` | storage | 收口候选或旧位置对象删除 |
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
