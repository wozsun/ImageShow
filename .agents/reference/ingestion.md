# 图片接入（Ingestion）

修改 Upload / Import、接入队列、提交、取消、恢复或接入页面时读取。存储写入协议见 [存储](storage.md#正式写入guard-与删除租约)。

## 所有权与完成判据

- 本地文件、URL、JSONL、微博进入同一领域。浏览器只拥有尚未被服务端接受的占位、文件与草稿；一旦接受，即由 Redis canonical 与单实例 worker 接管。路由卸载可中止浏览器仍持有的 raw 传输，但不在 effect cleanup 中隐式取消已接管的任务。
- `metadata WHERE id = image_id` 是唯一完成判据。Redis completed 回执缺少 PG 行即视为陈旧并清除，查询失败时 fail closed。批量 status 先固定 Redis 读取再查 PG（completed 只在 PG 提交后发布，这一顺序避免拼出不存在的状态）。Web 只有拿到 PG 投影后才把任务置为完成并失效图库查询。
- 运行态全部位于专用 Redis logical database 的 `imageshow:ingestion:*`；Lua 原子维护 canonical 与全部派生索引，Redis 不可用或结构不一致时 fail closed。canonical 不使用 Redis 原生过期事件，由 expires scanner 读取 `discard_at` 后经 Lua 复核 version、token 与截止时间再移除。
- 资源准入各有唯一 owner：浏览器页面 lane（预览、凭据、raw PUT）、Server raw 接收、preparation owner（Upload 与 Import 合计，由 `normalize.concurrency` 派生）、Normalize（全部 Sharp 重工作的唯一准入，含维护入口）与 commit（数量许可 + 字节许可）。页面窗口只限制单端工作，不替代服务端边界；原图大小与长边在浏览器预检后，由 Server 在取得完整事实的边界再次权威校验。

## 身份与幂等

- 任务以大小写敏感的 `(session_id, image_id)` pair 定位：UUID 可以规范化大小写，session ID 不得改写。`image_id` 是按独立 `image_time` 生成的 UUIDv7；一次选择共享 batch key，batch position 写入 UUIDv7 的 `rand_a`，使并发完成顺序不改变同批排序。
- 浏览器 `attemptKey` 是幂等键：同一规范化意图的重试复用原 session、候选 ID、`image_time` 与 request hash；只有 intent 已过期且 canonical 也不存在时才形成新 incarnation。接管请求冻结完整输入，响应未知的重放不读取之后变化的窗口默认值。服务端派生的 accepted order、执行 token 与 generation 不进入 request hash。
- 本地来源按相对路径 / 文件名、大小、修改时间去重，远端按规范化 HTTPS URL 去重。prepare 后的 MD5 重复只是 PG 快照提示，commit 在同 MD5 advisory lock 内再次判定。
- Upload 固定为一次 intent POST 加每项至多一次 raw PUT，凭据只放受限 header；canonical 形成前失败时以原 `attemptKey` 为同一 pair 重签凭据，不创建第二项任务。Import accept 在 storage read lock 内创建 canonical，请求断开不撤销已接受项；取消结果未知的项以冻结输入发送 `cancel_if_missing`，缺失项原子登记 discarded 回执，迟到的 accept 复用该回执。
- 控制请求超时保留未知结果供幂等核对，不视为服务端失败或已取消。

## 执行与提交

- worker 在 heartbeat、progress 与阶段发布的 CAS 冲突后重读 canonical：状态与 execution token 仍属同一次执行时接力新的草稿 version 并以最新草稿完成阶段；否则立即围栏，迟到执行者不能覆盖新 generation。raw 与处理结果使用 attempt / generation 唯一键，当前 token 匹配才能发布。
- commit 请求只受理不可变意图（pair、expected version、prepared MD5、request ID、重复决定、完整 metadata），冻结 intent hash、prepared generation、正式对象键与当前认证 username，返回 accepted 后不等待写入。相同 request ID 与 hash 可安全重试；同 ID 不同 hash 或换 ID 覆盖已冻结意图被拒绝；PG 事务开始前失败可把同一冻结意图重新排入，但不能借重试修改 actor、metadata 或对象键。
- `metadata.created_by` 只取冻结的 server actor，不接受客户端输入，不进入 browser DTO。
- worker 锁顺序为 storage → 图片 → 词表 → 同 MD5 advisory lock；进入不可逆协调器临界区后做最后一次 token 复验，再启动单个 PG 事务。
- 正式入库行已汇集通过校验的身份、尺寸、摘要、位置与 metadata；后续流程复用这份 PG 事实，不为“再确认”重新下载、解码或计算摘要。只有新输入、显式要求重算、迁移 / 维修或存储协议要求时才重读字节。
- `import.keep_original_link` 与 `weibo.source_enabled` 由 Server 在接管时按 `source_type` 权威应用，首次冻结提交意图时按当前配置再投影一次，冻结后不受热加载影响；客户端旧值不能写入正式图片。
- 微博：全进程固定串行调度器与单个共享访客身份，明确拒绝后只在下一项重建；取得图片链接后立即离开调度器。作者只按媒体实际所属账号的严格 UID 批量查 PG，无法确定归属时留空；UID 不写入 canonical 或 Redis，不回写历史图片。不得并发请求或探测反爬阈值。
- 标签合并：来源标签在前、默认标签在后去重；省略 `tags` 与 `tags: []` 都带入默认标签；单值字段清单优先，显式 `auto` 仍是有效选择。
- completed 回执只保留卡片展示所需的紧凑字段（来源类型、位置、原始尺寸与体积、三档最终质量），不保留下载 URL、完整 manifest、图片投影或草稿；回执失效后不反推质量或用当前配置代替。
- 明暗自动判断只分析 small 档成品：Ingestion 的 prepare-session 用编码后的 small 缓冲，后台分类编辑选「自动」时从存储读取同一份 small 对象，两处输入一致；透明按白底合成后计算 Lab 亮度直方图，不再另行缩放，small 长边配置变化会改变新判断的输入，已有图片不重算。判断参数（阈值、权重与硬暗规则）的来源已不可考，重调须先取得标注集或真实误判样本，不凭推算修改。

## 取消、恢复与清理

- 显式取消、worker 与恢复共享 pair 级进程内不可逆协调器：PG 事务开始前可用 pair / version CAS 收缩为 discarded；已开始则返回 resolving，不撤销或伪报取消，settle 后按 PG 结果收敛。Web 只有收到 discarded 才报告已取消；瞬时 missing 或无法确认时保留为可重试的取消失败。
- 重连与启动走同一个有界恢复入口，committing 状态先批量核对 PG。Redis 不可用时 worker 停止领取新任务并中止仍可安全中止的阶段。
- 原始文件、处理结果与正式候选的物理回收须复验当前 canonical / generation 及 PG 正式引用，结果未知时保留；正式候选交给持久 `move.cleanup`。过期、取消与 clear 只决定业务 tombstone，不以物理删除成败反推取消结果。

## 队列协议（Web ↔ Server）

- upload 与 import 是两个完全独立的浏览器 owner（资源、页码、订阅、清空范围、single-flight、busy），互不读取、重置或取消；响应只回写原队列。
- 已入队的 Blob 由队列资源所有者统一采用、替换和回收，模型转换保持纯投影；入队前的预览构建失败仍由生产者清理。接管状态按精确 pair 集中持有，但快照覆盖、重试推进和完成回执有不同寿命，局部推进不能等同于整项退休。
- 每个 owner 用单一入口按 pair 对 snapshot、SSE、各类 HTTP 响应与 status 去重，同一批首次完成只合并一次图片列表、概览、统计与词表失效。pair / version / progress sequence 与终态围栏保证任何迟到消息都不能回退卡片或计数；summary 只负责计数，不能推断卡片成功。
- 当前文档创建的批次是稳定展示前缀，按 batch / position 排序；接管后业务权威交给 Server，但展示顺序在窗口生命周期内保持。组合分页只从 Server 页过滤这些 pair 并补足剩余槽位，总数不重复计算。当前文档保序任务有硬上限，越界在创建 Server 任务前拒绝。
- 只为当前显示的队列建立一个 SSE。收到 `ready` 即废止旧 revision、pair 进度与 watermark，再请求当前组合页；不挂载非当前页的 canonical 卡片，不轮询。SSE 心跳只验权、不续期会话。
- revision 证明只在捕获它的 connection generation 内有效；跨代的响应须先经批量 status 重新核对。
- 读取 owner 唯一：同 scope、同页的触发复用当前请求，只有未覆盖的要求才发后继请求；只有 offset 真实改变或 SSE generation / scope 换代才中止旧读取。读取失败保留卡片但降级为纯展示并撤销 watermark 的执行权威，进入有界恢复；不清空卡片，也不显示瞬时“恢复中”提示。
- 全队列动作（应用到全部、提交全部、状态清理、清空）只用点击时已签发的 `action_watermark`：从 accepted order 1 起有界扫描至冻结的 `max_accepted_order`，绝不纳入点击后的新任务，也不退化为当前页循环。没有有效 watermark 且仍有精确集合外的 Server 目标时，整次点击只触发权威重取，不执行一半，也不让未来快照扩大旧点击。
- continuation 签名绑定动作 ID、动作、规范化参数、watermark、owner、queue、scope 与 cursor；相同 action ID 的并发或重试由 scope 内结果槽精确重放，scope 拒绝同 ID 换动作、水位或 payload。
- 同一 owner 的动作严格串行，全部结束后只做一次收敛快照。
- 提交与状态清理还要求任务 `last_semantic_revision` 不晚于点击时 revision 且执行时仍满足原谓词；“应用到全部”与整队列清空只按 accepted-order 水位选成员。纯 progress 与 TTL 续期不推进 semantic revision。
- “应用到全部”是稀疏 patch：`auto` 交给 Server 按检测结果解析，空主题 / 作者 / 标签不发送也不清空已有值，标签追加去重；每次 CAS 冲突都在最新 canonical 上重算。显式清空（`tags: []`、`author: null`、`theme: null`）是单独动作，不删除图片、任务或词条。
- 草稿：未冻结 commit 的 active canonical 卡片编辑以 pair / version CAS 写回。文本字段在一次焦点会话内只改本地临时值，失焦时只发布实际变化一次，不做 unload 补发或本地持久化。提交前必须排空有可写目标的草稿 fence，写回失败阻止提交；任务在防抖期间变为不可编辑时写回明确失败并恢复权威草稿。只有 Lua 确认 canonical 已等于目标语义时，旧 expected version 的重试才可返回 unchanged。
- 按钮可用性只取决于是否存在归属任务；草稿写回、接管交接与已有动作只决定执行顺序，不把按钮切成 disabled。
- 清除 completed 回执或清空队列时，Server 先核对 PG 并捕获完整 DTO 再释放回执，随逐项结果返回；`commit_ready` 重试若 PG 已完成也必须返回该 DTO，不能降为无完成事实的 no-op。
- 关闭窗口不等待清理、不中止任务，只异步清除点击时已完成的卡片与回执；子弹窗关闭不重置主窗口默认值。

## 模块分层

`images/ingestion/` 内的依赖方向：

- `sessions/` 是协议底层（canonical / intent 模型、key、codec、Lua），不依赖其他 ingestion 子域。
- `raw/` 基于 sessions 实现接入文件与上传接管；`execution/` 组合 session fencing 与 repository facade；`sources/` 使用 sessions、raw、execution；`commit/` 组合 sessions、execution、cleanup、storage、database 与 vocab；`cancel/` 组合 sessions、execution、commit、cleanup 与 raw。
- `queue/` 的 snapshot、SSE、watermark、展示投影只使用 session / repository 边界；action handler 负责协调 cancel、commit 与 execution。
- `workers/` 与唯一生产装配入口 `runtime.ts` 可以编排以上全部模块；除它们自身外，任何模块都不能反向依赖 `workers/` 或 `runtime.ts`。
- Routes 只依赖 runtime 公开的 service、repository facade、窄执行控制接口与 DTO，不导入 Lua、执行协调器或私有 Worker。Web 只通过公开队列协议交接，不导入 Server 内部实现。
