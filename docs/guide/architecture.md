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

- PostgreSQL 是唯一真相源，承载图片元数据、标签 / 主题 / 作者（含 `image_tag` 关联表）、统一导入会话、后台任务、存储后端注册表、管理员账号及图片投影 revision 单行表，共 10 张业务表（见[数据库结构](./database.md)）。
- Redis 只保存管理员会话，不保存管理员账号、角色或密码代际的全局投影。每次后台认证先
  读取会话 key，再按用户名对 PostgreSQL `admin_account` 做一次主键查询，比较权威角色与
  密码哈希的不可逆代际。数据库故障返回 503 并保留会话；只有真值明确不匹配时才删除
  会话并返回 401。自行改密仅在当前会话内短暂同时授权旧、新代际，保证成功提交后当前
  会话可继续使用，不引入跨账号 revision、监听器或恢复重建状态机。
- Redis 8 只保存可重建投影与运行时状态。所有 `ready` 图片共用固定的
  `imageshow:cache:images:*` 命名空间。根层只保存无 TTL 的核心投影：meta、rich item
  hash、按时间排序的 `index:all`、对象键 / 缩略图键 / UUID 末 12 位反查、全局统计、
  最后内容更新时间和
  核心完整性；rich item 覆盖公开画廊、详情、随机输出、资源读取和后台 ready 列表需要
  的完整内部字段，公开 presenter 独立筛除 MD5、存储归属和后台时间等字段。设备 / 明暗
  轴、主题、标签、作者索引以及组合筛选、动态统计结果、临时键和 LRU 注册表全部位于
  `imageshow:cache:images:derived:*`。axis、theme、tag、author 索引在首次筛选时从
  PostgreSQL 现有索引按 keyset 分批构建；公开请求把本次读取所需的全部缺失属性加入有界
  进程内串行队列并立即走 PostgreSQL 回源，后台构建与当前回源各自进入同一个公开 PG
  准入所有者。同一属性进程内单飞，全部属性构建合计最多并发 1。每个索引另有 applied
  revision、count、唯一实例 token 与 built / last-accessed
  时间，索引与 meta
  使用 6 小时滑动 TTL；构建前后 revision、连接 epoch 或发布条件变化时只放弃该派生
  结果。属性索引、组合筛选和统计结果共用一套 LRU registry：最多保留 256 个结果、
  128 个活跃筛选签名，单个 ZSET 最多 25 万成员，ZSET 总成员数最多为
  `max(10000, 核心图片数 × 8)`，单个序列化统计结果最多 512 KiB；所有正式结果统一使用
  6 小时滑动 TTL，临时键使用 5 分钟 TTL。续期前会核对完整 registry 字段集合、种类、
  签名和成员上限，损坏 registry 不会因无关热结果被继续续期。这些限制只约束派生数据结构，不读取或推断
  Redis 全局字节容量。registry 在结果发布时另记录一次逐键 `MEMORY USAGE` 观测；受单实例
  生命周期锁保护的当前进程在登记与淘汰时同步维护最多 256 项的占用镜像，registry 自身
  的五个键也跟随最晚活跃结果使用 6 小时滑动 TTL；默认检查页只读该镜像，不再执行 Redis
  命令。断线或任何破坏性清理开始时镜像先变为未知，完整清理成功后才确认为空；登记和
  命中续期同时推进结果、registry 与镜像期限，读取时剔除已过 6 小时期限的条目，
  因而不会把进程重启、重建前或已过期结果报告为当前占用。镜像汇总已登记物理键数、结果
  成员数以及结果、meta 与 registry 的记录字节，临时构建键不在摘要内；合法零成员结果只
  观测实际存在的 meta。命令失败时记录未知值，不能让派生结果登记
  失败。核心字节同样只使用发布 meta 的记录值，观测失败持久化为未知而不是 `0 B`。需要
  当前逐键实际占用时，
  管理员必须显式运行 Redis 深度检查；`INFO MEMORY` 始终只代表整个 Redis 实例。
  集合运算另有独立 CPU 工作量准入：物化集合命令最多 20 万源成员，
  `ZINTERCARD` 最多 20 万源成员；两类命令均最多 10 万预期结果成员和 8 个操作数。
  单次组合筛选累计最多 30 万源成员、12 次集合命令，
  其中交集 / 差集最多 8 次。组合构建总并发为 4，累计源成员达到 10 万的“大型”构建
  同时只允许 1 个。动态统计最多 64 个 theme / tag / author 维度，全部 `ZINTERCARD`
  累计最多读取 200 万源成员、产生 50 万预期交集成员；统计构建总并发为 2，累计预期
  交集达到 25 万时同时只允许 1 个。统计先用核心 stats 推导筛选基数上界，在构建任何
  属性或组合结果前预检，实际索引解析后再精确复核；槽位持有到全部并行 Redis 命令确认
  结束。超限只放弃当前派生结果，不创建组合临时集合。
  每次物化还在同一次 Redis Lua 原子执行中复核全部来源 cardinality、执行集合命令、设置临时
  TTL 并读取实际结果；来源变化、TTL 未落地或实际结果超过估算都会丢弃当前构建。

  工作量阈值基线使用本地隔离的 Redis 8 容器：以
  `docker run --rm -d --name imageshow-stage8-benchmark -p 127.0.0.1:16379:6379 redis:8`
  启动，运行 `npm run benchmark:ready-image-set-work`，完成后执行
  `docker stop imageshow-stage8-benchmark`。脚本为四个存在 50% 相邻重叠的等基数 ZSET
  分批写入确定性成员，分别测量 `ZUNIONSTORE 4`、`ZINTERSTORE 4`、`ZDIFFSTORE 4`、
  `ZINTERCARD 2`，以及按生产 Lua 脚本复核 cardinality 与设置临时 TTL 的
  union → intersection → difference include / exclude 零结果组合。每源 1,000 与
  25,000 成员各重复 7 次，每源 50,000 成员重复 5 次，每源 100,000 成员重复 3 次；
  对应命令
  p95（union / intersection / difference / 组合 / cardinality）分别为
  `2.971 / 1.300 / 1.250 / 3.393 / 0.698 ms`、
  `25.739 / 6.731 / 11.583 / 24.538 / 2.956 ms`、
  `51.910 / 17.090 / 25.028 / 45.805 / 4.195 ms` 和
  `197.663 / 28.414 / 60.364 / 130.076 / 10.515 ms`。25,000 成员源的 16 / 64 / 128
  维流水线 `ZINTERCARD` p95 为 `20.786 / 65.470 / 133.762 ms`；100,000 成员源的
  8 / 16 / 32 维结果为 `123.712 / 169.452 / 320.792 ms`。另以 100,000 成员核心集
  分别排除 1 / 25,000 / 100,000 个成员，带来源复核和 TTL 的 `ZDIFFSTORE` p95 为
  `25.635 / 34.620 / 14.370 ms`。因此物化命令允许 20 万累计源成员，覆盖十万图库的
  全集排除形态；四个 100,000 成员源的 40 万工作量仍被拒绝。非物化 `ZINTERCARD`
  允许两个 10 万成员源，但再受整次统计累计上限约束；这些本机样本只用于选择 CPU
  工作量边界，不是延迟 SLO，也不推导 Redis 字节预算。

  进程冷启动与 Redis 重连均先清除全部正式派生结果及 registry，
  避免沿用发布中断留下的未注册结果；持久化核心投影仍按 revision 与完整性复用。本次未取得或未构建出可用属性索引时，画廊、统计、后台 ready 列表和随机请求均进入
  PostgreSQL 回源。派生结构
  不作为启动可读条件，清理后可按需重建。正式键名不含 semver、revision、
  generation、构建时间或随机 token。全量重建只生成核心投影，不预建或校验任何属性、
  组合筛选或动态统计结果；这些派生键缺失、过期、损坏、超限或构建失败只放弃当前
  Redis 结果，不调用核心降级入口。只有 meta/schema/revision、rich items、
  `index:all`、lookup、全局统计、核心完整性、连接 epoch 或核心增量发布失败才关闭
  核心读门并安排重建。meta 的结构
  schema 当前为 `4`，旧 schema 不转换，关闭读门并只清理自有
  图片前缀后从 PostgreSQL 重建。全量重建先
  关闭读门，`SCAN + UNLINK` 仅清理本命名空间，在 PostgreSQL repeatable-read 快照中
  分批构建并验证，确认 revision 未变化后才开放；图片事务在提交前推进单行
  `ready_image_revision`。共享 mutation-sync 层把业务影响总量与 Redis pipeline 分块明确
  分离：`READY_IMAGE_EXACT_SYNC_MAX_ITEMS=500` 是单次精准同步上限，200 只表示 Redis
  命令和 ID 读取的分块大小。领域代码可先在同一 PostgreSQL 事务内仅执行 `COUNT` 并调用
  统一决策；0 张不做缓存工作，1–500 张才读取 ID 并在提交后精确同步核心条目、反查、
  全量排序和全局统计，超过 500 张则不得为缓存加载 ID。大规模事务提交后保持核心读门
  关闭，清除派生结果并只请求一次 single-flight 全量重建；重建在后台
  分批运行，PostgreSQL 已成功的业务结果不因 Redis 清理或调度失败而回滚。事务回滚且
  revision 未推进时不会误触发重建。标签和作者删除在独占词表租约及同一数据库事务内
  先统计 ready 关联数；小规模才按 ID 排序读取，大规模删除不返回 ID，整个事务只推进
  一次 revision。主题删除先统计 ready 图片并固定本轮 UUID 上界，再按 keyset 每 100 张
  重分配；小规模路径同时以已提交和在途 ready 数共同占用 500 张累计预算，扫描途中吸收的
  并发关联达到边界后会留下候选并按“累计提交 + 剩余关联”重计数，因此不会沿用旧决策
  无界逐图同步。上界之后或已扫描区间内并发加入的引用由最终独占检查触发下一轮重计数。
  每张图仍持共享主题租约和单图存储锁，沿用候选对象校验、CAS、补偿及逐事务单次 revision。
  大型主题操作在首尾短暂取得缓存写栅栏，操作期间以 `mutation_in_progress` 关闭核心
  读门，逐图提交不刷新 Redis，最后仅按最终 revision 安排一次重建；没有事务提交的失败
  会直接重新开放原核心投影。批量分类服务以本批显式请求的去重图片 ID 数作为保守影响
  上界，避免 COUNT 后图片又由 deleted 恢复为 ready 而低估；超过边界时使用相同的计划
  重建作用域，但不改变逐图锁、对象补偿、部分成功响应或实体计数失效语义。批量元数据、
  删除、恢复和显式存储迁移同样用请求中的去重 ID 数作上界；原子删除 / 恢复超过边界时
  只取 `rowCount`，不 `RETURNING` 全部 UUID。上传器把当前可提交会话合并为一个或多个受
  `importBatchHardLimit` 约束的服务端批次；单批超过 500 项时整个多事务 commit 期间关闭核心
  读门，逐会话仍保留 session / storage / vocabulary 锁、全局并发与字节许可、幂等重放和
  finalized 真值，最终只安排一次重建。整后端迁移先在 PostgreSQL 统计本轮数量并固定最大
  UUID，小规模读取有限列表，大规模按 UUID keyset 每 100 张读取；迁移逐图事务、未知提交
  结果收敛和 `move.cleanup` 不变，Redis 故障不能倒退已提交位置。Redis 连接断开
  时立即关闭投影读门，每个读租约结束复核连接 epoch；重连后在自有 5 秒 TTL 探针键上
  实际执行 `INCREX`、`ARRING`、`ARLASTITEMS`，再检查 revision、meta 与核心完整性；
  `COMMAND INFO` 元数据不能替代 ACL 执行能力。`INFO MEMORY` 只观测整个实例的
  used、RSS 与 fragmentation，不读取内存上限或淘汰策略，也不参与启动、重建或
  `/readyz` 判定。Redis 不可用或缺少必需命令
  时 HTTP 进程仍监听；首次成功校验前只开放 `/livez` 与非就绪的 `/readyz`，之后的运行
  期故障则让公开画廊、详情、统计、资源与普通 / 定向随机进入统一有界 PostgreSQL
  fallback，后台在会话读取前统一 503。随机近期
  历史使用 Redis Array 的 `ARRING`，登录与 ALTCHA 固定窗口使用 `INCREX`；词表、实体
  计数、原图直连探测和会话继续按各自 TTL 管理。

  阈值使用本地测试 `tests/server/ready-image-cache-100k.test.ts` 测得；PowerShell 复测
  命令为
  `$env:IMAGESHOW_TEST_MODULES_ONLY='1'; node --test --test-global-setup=tests/server/global-setup.ts tests/server/ready-image-cache-100k.test.ts`。
  global setup 为每次运行创建并清理独立 PostgreSQL / Redis Compose project，测试构建
  10 万 ready 图片投影。无业务字段变化但
  完整执行旧值读取、PostgreSQL 新值读取、核心 Redis 发布与完整性校验时，50 / 200 /
  500 / 1,000 / 2,000 张精准同步各重复 3 次，中位耗时约
  49 / 117 / 323 / 581 / 1,107 ms，同数据集全量重建约 10.20 秒。该次全量重建产生
  102 个单调进度样本、204 次 pipeline，单次最多 160 条命令，期间事件循环继续运行
  4,909 次；发布后核心 24 项列表及两个十万级大型筛选均验证 `cached=true`，作为
  Redis-first 命中证据。500 张边界用于把请求内同步控制在约 0.3 秒量级；它不是全量
  重建的耗时交叉点，也不改变 200 张 pipeline 分块。
- 存储后端按图片记录的 `storage_slug`（外键 → `storage_backend` 注册表）决定：本地磁盘、S3 兼容对象存储或 WebDAV。注册表同时拥有配置快照、driver 生命周期和统一读写解析入口；图片 serving 只消费已解析的可读对象，不自行拼装第二套后端访问逻辑。详见[存储](./storage.md)。

import commit、分类移动、主题重分配、单图 / 整后端迁移、彻底删除等会改变图片对象位置的操作共用单图 advisory lock。涉及主题、作者或标签关联的分类更新与 commit 按“存储位置共享锁 → 排序后的词表共享关联租约 → 会话 / 单图锁”在同一专用连接上组合取得；已持有位置锁后追加的 advisory lock 复用该连接并在当前作用域 FIFO 串行，不再向锁池借第二条连接，带附加锁的作用域禁止继续嵌套组合锁。同 slug 关联可并行，并可在租约内幂等确保词表项存在，显式词表管理和删除仍用独占锁等待全部关联退出。标签关联写入与 import commit 都对最终解析后的 tag slug 组合取得共享锁，批量标签删除则对排序、去重后的 slug 组合取得独占锁，锁和事务复用同一份最终列表。主题删除以共享主题锁重分配每张图片，最后用独占主题锁确认已无引用再删除，避免锁池嵌套自饿。锁内重新读取数据库真值，源对象与候选对象通过流式强摘要统一验证，media 同时核对数据库 MD5，再用旧位置和分类条件更新翻转引用。两个 slug 的物理命名空间 identity 集合相交时先用目标凭据回读校验共享对象，再只切换数据库归属，不复制也不删除。跨命名空间迁移把 metadata 位置 CAS 与源对象清理凭据放在同一事务；SQL 或 COMMIT 结果不确定时仍持锁重读 PostgreSQL，按目标已采用、源仍权威或真值未知分别收口，未知时保留两端对象并记录结构化运维错误。候选和旧对象的不可逆删除延迟到 `move.cleanup`：任务固化原 identity、重新取得单图锁，并在实际删除边界重读当前位置；driver DELETE 返回后还必须确认对象不存在。未解决任务同时充当物理对象的持久删除租约，所有正式对象写入 / 采用路径会拒绝复用相同命名空间和对象键，直至任务成功；失败与耗尽记录继续保护对象并阻止后端改址或删除，可由超级管理员按后端重新排队核验。S3 Endpoint 可在独占位置锁内通过完整 `_uploads` 快照、既有对象的有界 Range 读取和双向随机挑战证明为同一访问别名，成功后把全部相交后端的 identity 集合合并为同一连通分量；COMMIT 回包丢失时再按事务 ID 查询确定结果。导入创建使用全局共享位置锁；materialize、prepare、commit、取消和暂存清理还按会话锁串行。锁连接丢失时 AbortSignal 传播到工作路径，锁 helper 等待回调完成协作式收口后销毁连接；导入的 execution token、raw token 与尝试级 staging key 再阻止失锁执行者迟到发布。物理位置变更、全盘清理和任何会更换 driver 的访问配置变更使用独占位置锁；显示名、启停、默认项和排序只刷新注册表快照。后端物理配置事务使用持有位置锁的同一 PostgreSQL 会话，旧的异步注册表加载也不能跨缓存 generation 重新发布。长生命周期 advisory lock 由独立连接池承载，不占用主查询池。

生产基线固定为一台主机上的一个 ImageShow 应用容器；PostgreSQL 与 Redis 由另一基础设施 Compose 各运行一个单容器。数据库迁移完成后、任何清理、业务初始化、HTTP 或 Worker 启动前，进程用独立 PostgreSQL session 非阻塞取得固定生命周期 advisory lock；同库第二实例取锁失败会明确拒绝启动。该 session 的 `error` / `end` 表示所有权已经丢失，进程无论仍在启动还是已经进入正常停机，都进入同一个失败退出状态机，立即停止接收新请求并复用 Worker、缓存协调器、存储与 HTTP 的有界停机路径。正常停机在请求和后台工作排空、Redis 连接及全部 PostgreSQL 连接池关闭后才结束 lifecycle session，使接替实例不会与尚未收口的旧进程并发。这个锁只阻止当前不受支持的误部署；应用缓存栅栏、coordinator、存储注册表和 driver 仍是进程内状态，不构成多实例协议。升级先停止对应容器，再原位更新并启动，未来边界只记录在[多实例待办](./todo-multi-instance.md)。

## 后台 Worker

`background_job` 表是一个持久化后台任务队列。Worker 每 5 秒一拍，先执行到期的僵尸恢复、导入清理调度和历史裁剪，再统计所有可运行任务类型并并行处理各自的有界时间片。每种类型单次 tick 最多领取 50 项或运行 2 秒，仍保留各自并发上限与 `SELECT … FOR UPDATE SKIP LOCKED`，因此持续堆积的慢队列不会饿死定时维护或其他任务类型。每次领取生成新的持久化 UUID `execution_token`；续租与退出 `running` 的状态写入必须匹配该 token，僵尸恢复和终态会将其清空，因此失去租约的旧执行者无法覆盖后继结果。

领取完成后、handler 启动前，Worker 会先登记活动 Promise、`AbortController`、15 分钟执行期限和续租链。超时、续租失败或停机共用同一中止信号；缩略图、移动清理、导入清理、回收站清理和图片缓存重建会在等待、批次及不可逆边界检查它。停机先禁止新领取并中止全部活动 controller，领取请求已发出但尚未返回的任务仍会登记后立即中止；停机中止使用当前 token 立即重新排队且不消耗失败重试，超时、租约丢失和真实执行错误才进入失败退避。随后用一个 10 秒总期限同时等待领取、handler、终态写入和当前 tick，拒绝协作中止的底层调用不会无限阻塞进程退出。每个时间片记录 backlog、最老等待时间、处理数、耗时和预算耗尽状态。失败任务使用指数退避；任务类型包括缩略图生成、移动清理、导入清理、回收站分批清理和缓存重建。终态确定性幂等记录可重置后再次入队，执行中与可重试任务仍保持去重。完整流程见[功能与流程](./flows.md)。
