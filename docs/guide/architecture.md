# 架构总览

ImageShow 是一个 npm workspaces 单仓多包项目：自托管图库 + 随机图 API。后端用 Hono（Node.js `>=26.3.0 <27`），前端用 React + Vite；三个 workspace 随应用一起构建、部署。服务端开发入口由 Node.js 26 直接执行可擦除类型的 TypeScript 源码，生产镜像仍运行 TypeScript 编译后的 JavaScript。

数据分两层：PostgreSQL 是唯一业务真相源，Redis 只承载可重建缓存和运行时状态；图片字节存在可插拔的存储后端（本地磁盘 / S3 兼容对象存储 / WebDAV）。管理员界面偏好与账号同行保存在 PostgreSQL，浏览器 `localStorage` 只做首帧、离线 pending 和多标签同步。本地上传与链接下载先在请求内完成素材化，再独立完成限流、标准化和 prepared 暂存；缩略图补建、移动清理、上传清理、缓存重建等持久任务交给后台 Worker 异步处理。

## 整体结构

![ImageShow 架构图：客户端经反向代理按 Host 分流到 Hono 应用，应用读写 PostgreSQL、Redis 与存储后端，后台 Worker 消费 background_job 队列](./assets/architecture.svg)

## 多主机分流

同一个应用按请求的 `Host` 头切成几个互相隔离的“虚拟站点”（在
`http-app.ts` 装配的中间件中完成）。详见[子域名](./subdomains.md)。

| 主机 | 作用 |
| --- | --- |
| `<域名>`（主站） | SPA 前端 + 后台 + 公共 API |
| `random.<域名>` | 只有随机图 API（`/` 的 GET/HEAD），其余一律 404 |
| `static.<域名>` | 只提供对象字节 `/media/*`、`/thumbs/*`（cookie 隔离，主站从不直接吐字节） |
| `link.<域名>` | 外部原图安全代理：仅开放 `/original/*`，且只代理与展示图不同的 HTTPS `original` 字段 |

所有普通请求在最终响应上统一附带安全响应头：`Content-Security-Policy: frame-ancestors 'none'`、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 等；直接构造的错误、静态和 API `Response` 也不会绕过。唯一例外是已启用的 `/embed/home` 与 `/embed/gallery` 文档：它们移除 `X-Frame-Options`，把当前站点自身 HTTPS origin、其子域通配符以及规范化的额外精确 origin 或受限子域通配符写入 CSP `frame-ancestors`。SPA 文档以 report-only 模式观测 Trusted Types，并通过 `Reporting-Endpoints` 与 CSP `report-to` 把报告投递到同源 `/api/security/csp-report`。接收端只返回 204，不读取正文、不解析 JSON、也不写日志。

## 分层

- `packages/shared`：服务端完整配置常量（`appConfig`）与前后端共享类型；浏览器安全常量、稳定 API DTO 和错误响应结构通过 `@imageshow/shared/browser` 独立子入口提供，避免把数据库、Redis 等运行时默认值打入 Web 产物。
- `packages/server`：业务全部在此，按领域分层 —— `core/`（DB / Redis 客户端 / HTTP 基础设施 / 校验）、`config/`、`storage/`、`images/`、`random/`、`tags/`、`themes/`、`authors/`、`users/`、`checks/`、`jobs/`、`routes/`。`core/` 不反向依赖业务领域，账号初始化、Redis 巡检和对象读取等能力分别由 `users/`、`checks/`、`storage/` 承担；`routes/` 只是 HTTP 薄层，真正逻辑在各领域模块。
- `packages/web`：React SPA，含公共页（首页 / 画廊）与后台（图片 / 上传 / 标签 / 主题 / 作者 / 用户 / 设置 / 存储 / 检查 / 日志）。

普通仓库文档位于根目录 `docs/guide/`，不属于 workspace、构建产物或运行时入口。
领域边界和依赖方向见[项目结构](./project-structure.md)。

## 数据与缓存

- PostgreSQL 是唯一真相源，承载图片元数据、标签 / 主题 / 作者（含 `image_tag` 关联表）、统一导入会话、后台任务、存储后端注册表、管理员账号及 `ready_image_revision`，共 10 张业务表（见[数据库结构](./database.md)）。
- Redis 8 只保存可重建投影与运行时状态。所有 `ready` 图片共用固定的 `imageshow:cache:images:*` 命名空间：rich item hash 保存公开画廊、详情、随机输出、资源反查和后台就绪列表真正需要的字段；按时间排序的全量、设备/亮度轴、主题、标签和作者 ZSET 支撑分页、筛选与随机抽样；对象键、缩略图键和 UUID 末 12 位提供 O(1) 或索引化反查；统计 hash 支撑首页与画廊计数。常见单轴筛选直接读长期索引，组合或排除筛选按规范签名生成 6 小时派生 ZSET，筛选统计结果缓存 24 小时；构建前核对源索引完整性，基数为零的排除项直接忽略，不复制全量 ZSET。派生筛选按访问时间最多保留 32 项，总成员数最多为核心图片数的 8 倍且小图库保留 10000 项下限；同时最多构建 4 个不同签名，活跃临时键只由对应构建者释放并带 5 分钟安全 TTL。统计结果最多保留 128 项，单项序列化结果超过 512 KiB 时不写缓存。Redis `maxmemory` 正式默认 `500mb`，本机实验为 `2gb`，策略固定为 `noeviction`；达到 80% 时应用取得写栅栏、等待现有缓存读者结束，再删除最久未访问的一半派生项，仍有压力才清空派生查询结果，不自动淘汰画廊核心键、会话或限流状态。核心投影不设 TTL，不使用 generation 或带 `v2` / `v3` 的 key 代际；meta 中只保存结构 schema、PostgreSQL revision、构建进度、基数和完整性信息。全量重建先关闭读门，`SCAN + UNLINK` 仅清理本命名空间，在 PostgreSQL repeatable-read 快照中分批构建并验证，确认 revision 未变化后才开放。图片事务在提交前推进单行 `ready_image_revision`；提交后仍持进程内写栅栏，每 200 张一批比较旧 Redis 投影和新 PostgreSQL 投影，逐批精确更新 item、反查、索引、统计与完整性字段，最后只发布一次 revision。Redis 连接断开时立即关闭读门；每个读租约结束还会复核连接 epoch，跨断线结果一律丢弃并回源。每次连接重新就绪先重新检查命令和内存策略、清除组合筛选和筛选统计等可再生查询结果，再核对 PostgreSQL revision、meta 和核心完整性，只有同一连接周期内全部一致才重新开放。Redis 临时不可用或能力不满足时 HTTP 进程仍启动，`/readyz` 保持非就绪。Redis 命令最长等待 5 秒且不离线排队；OOM 复杂查询清理派生缓存并回源，不把核心缓存误判为损坏。画廊、详情和后台列表在连接不可用时回源 PostgreSQL，普通随机请求返回 503。核心画廊投影本身超出上限时必须停机提高 Redis 与 Docker 上限。定向 `id` 查询仍可直接命中 PostgreSQL 主键或末 12 位索引。随机最近历史使用 Redis Array 的 `ARRING`，登录与 ALTCHA 固定窗口使用 `INCREX`。启动及每次重连都检查正数 `maxmemory`、`noeviction` 及命令能力，不固定 Redis 次版本。词表、实体计数、原图直连探测和会话继续按各自 TTL 管理。
- 存储后端按图片记录的 `storage_slug`（外键 → `storage_backend` 注册表）决定：本地磁盘、S3 兼容对象存储或 WebDAV。注册表同时拥有配置快照、driver 生命周期和统一读写解析入口；图片 serving 只消费已解析的可读对象，不自行拼装第二套后端访问逻辑。详见[存储](./storage.md)。

import commit、分类移动、主题重分配、单图 / 整后端迁移、彻底删除等会改变图片对象位置的操作共用单图 advisory lock。涉及主题、作者或标签关联的分类更新与 commit 按“存储位置共享锁 → 排序后的词表共享关联租约 → 会话 / 单图锁”在同一专用连接上组合取得；已持有位置锁后追加的 advisory lock 复用该连接并在当前作用域 FIFO 串行，不再向锁池借第二条连接，带附加锁的作用域禁止继续嵌套组合锁。同 slug 关联可并行，并可在租约内幂等确保词表项存在，显式词表管理和删除仍用独占锁等待全部关联退出。标签关联写入与 import commit 都对最终解析后的 tag slug 组合取得共享锁，批量标签删除则对排序、去重后的 slug 组合取得独占锁，锁和事务复用同一份最终列表。主题删除以共享主题锁重分配每张图片，最后用独占主题锁确认已无引用再删除，避免锁池嵌套自饿。锁内重新读取数据库真值，源对象与候选对象通过流式强摘要统一验证，media 同时核对数据库 MD5，再用旧位置和分类条件更新翻转引用。两个 slug 的物理命名空间 identity 集合相交时先用目标凭据回读校验共享对象，再只切换数据库归属，不复制也不删除。跨命名空间迁移把 metadata 位置 CAS 与源对象清理凭据放在同一事务；SQL 或 COMMIT 结果不确定时仍持锁重读 PostgreSQL，按目标已采用、源仍权威或真值未知分别收口，未知时保留两端对象并记录结构化运维错误。候选和旧对象的不可逆删除延迟到 `move.cleanup`：任务固化原 identity、重新取得单图锁，并在实际删除边界重读当前位置；driver DELETE 返回后还必须确认对象不存在。未解决任务同时充当物理对象的持久删除租约，所有正式对象写入 / 采用路径会拒绝复用相同命名空间和对象键，直至任务成功；失败与耗尽记录继续保护对象并阻止后端改址或删除，可由超级管理员按后端重新排队核验。S3 Endpoint 可在独占位置锁内通过完整 `_uploads` 快照、既有对象的有界 Range 读取和双向随机挑战证明为同一访问别名，成功后把全部相交后端的 identity 集合合并为同一连通分量；COMMIT 回包丢失时再按事务 ID 查询确定结果。导入创建使用全局共享位置锁；materialize、prepare、commit、取消和暂存清理还按会话锁串行。锁连接丢失时 AbortSignal 传播到工作路径，锁 helper 等待回调完成协作式收口后销毁连接；导入的 execution token、raw token 与尝试级 staging key 再阻止失锁执行者迟到发布。物理位置变更、全盘清理和任何会更换 driver 的访问配置变更使用独占位置锁；显示名、启停、默认项和排序只刷新注册表快照。后端物理配置事务使用持有位置锁的同一 PostgreSQL 会话，旧的异步注册表加载也不能跨缓存 generation 重新发布。长生命周期 advisory lock 由独立连接池承载，不占用主查询池。

生产基线固定为一台主机上的一个 ImageShow 应用容器；PostgreSQL 与 Redis 由另一基础设施 Compose 各运行一个单容器。应用缓存栅栏、coordinator、存储注册表和 driver 都是进程内状态；升级先停止对应容器，再原位更新并启动。短期不增加多实例能力，未来边界只记录在[多实例待办](./todo-multi-instance.md)。

## 后台 Worker

`background_job` 表是一个持久化后台任务队列。Worker 每 5 秒一拍，先执行到期的僵尸恢复、导入清理调度和历史裁剪，再统计所有可运行任务类型并并行处理各自的有界时间片。每种类型单次 tick 最多领取 50 项或运行 2 秒，仍保留各自并发上限与 `SELECT … FOR UPDATE SKIP LOCKED`，因此持续堆积的慢队列不会饿死定时维护或其他任务类型。每次领取生成新的持久化 UUID `execution_token`；续租与退出 `running` 的状态写入必须匹配该 token，僵尸恢复和终态会将其清空，因此失去租约的旧执行者无法覆盖后继结果。

领取完成后、handler 启动前，Worker 会先登记活动 Promise、`AbortController`、15 分钟执行期限和续租链。超时、续租失败或停机共用同一中止信号；缩略图、移动清理、导入清理、回收站清理和图片缓存重建会在等待、批次及不可逆边界检查它。停机先禁止新领取并中止全部活动 controller，领取请求已发出但尚未返回的任务仍会登记后立即中止；停机中止使用当前 token 立即重新排队且不消耗失败重试，超时、租约丢失和真实执行错误才进入失败退避。随后用一个 10 秒总期限同时等待领取、handler、终态写入和当前 tick，拒绝协作中止的底层调用不会无限阻塞进程退出。每个时间片记录 backlog、最老等待时间、处理数、耗时和预算耗尽状态。失败任务使用指数退避；任务类型包括缩略图生成、移动清理、导入清理、回收站分批清理和缓存重建。终态确定性幂等记录可重置后再次入队，执行中与可重试任务仍保持去重。完整流程见[功能与流程](./flows.md)。
