# 功能与流程

本页只描述跨领域的端到端交接，不重复领域内部实现。需要精确字段、阈值或运维步骤时，
使用下列权威文档：

| 主题 | 权威来源 |
| --- | --- |
| 数据表、结构契约、任务状态 | [数据库结构](./database.md) |
| 运行配置、环境变量、配置包 | [配置说明](./configuration.md) |
| local / S3、迁移与对象清理 | [存储](./storage.md) |
| Redis、Worker、锁与进程生命周期 | [架构总览](./architecture.md) |
| 随机图查询参数与返回方式 | [随机图 API](./random-api.md) |
| 鉴权、请求限制、代理和响应头 | [安全](./security.md) |
| 部署、健康检查与 Nginx | [生产部署](./deployment.md) |

## 图片接入

后台提供本地文件、URL 列表、JSONL 清单和公开微博四种入口。浏览器维护当前窗口的本地
占位；素材一旦被服务端接受，就由 Redis canonical 和单实例 worker 接管。运行中的接入会话
只存在于 Redis；只有最终 `metadata` 行是完成事实，Redis 的 completed 回执不能单独证明图片
已经提交。

服务端队列按来源分为 `upload` 和 `import`。每个任务都以大小写敏感的
`(session_id, image_id)` pair 定位；`session_id` 是 owner、队列和幂等键的稳定摘要，
`image_id` 是按独立 `image_time` 生成并校验的 UUIDv7。一次选择共享 `batch_time`，存在
`batch_position` 时还写入 UUIDv7 的 12 位 `rand_a`，因此并发完成顺序不会改变同批排序。

```text
本地：  upload intent ─► raw PUT ─► received ─► preparing ─► ready
Import： accept ─► queued ─► downloading ─► received ─► preparing ─► ready
                                                                      │
                                                   async commit intent│
                                                                      ▼
                                      committing ─► completed / failed
                                           │ PG 事务已开始但结果待核对
                                           └────────► resolving
```

### 输入与队列

- 图片管理页把“导入图片”主按钮和右侧下拉按钮作为一个意图区域：细指针进入、键盘
  focus 或 pointerdown 任一点时，同时预载内容接入工作流与来源输入模块；独立的“上传图片”
  按钮只预载内容接入工作流，来源菜单项在自身交互点预载来源模块。预载只读取静态资源，不挂载
  窗口或发出 API 请求。
- 任一入口开始启动时，launcher 取得唯一页面交互锁。工作流或来源窗口成功打开后，该锁由
  整个工作流的关闭路径统一释放；加载失败、入口撤回或未能打开时才提前释放。因此链接、
  JSONL 和微博共用的异步来源模块不会在弹窗出现后把背景控件从禁用态短暂恢复，页面也
  不会产生一次明暗闪烁。正常退场在遮罩动画完成回调内同步提交弹窗卸载与页面解锁，确保
  首个不再显示遮罩的绘制帧已经恢复页签、筛选、选择、卡片动作和分页；减少动态效果仍在
  关闭请求内直接完成同一组状态，不复制动画时长或增加延时器。
- URL 列表把每个非空行作为一个候选；JSONL 每行一个对象，未知字段严格拒绝并保留行号；
  微博入口先提取公开帖子中的原图、发布时间、来源与可选作者映射，再交给同一 JSONL
  解析器。微博访客握手与帖子元数据由全进程固定串行调度器执行，并行批次逐项轮转；全进程
  共享一个访客身份及其创建中的 single-flight，相邻帖子请求按当前配置区间（默认 2–5 秒）随机等待，
   明确拒绝的身份只在下一项重建。取得图片链接后
   立即离开微博调度器，图片进入通用 Import 后继窗口。
- 本地来源按目录相对路径或文件名、大小、修改时间去重；远端来源按规范化 HTTPS URL
  去重。prepare 得到最终 MD5 后，以 PostgreSQL 快照提示重复；commit 在相同 MD5 的
  advisory lock 内再次读取，前一份提示不替代最终写入授权。Redis canonical 只保存 MD5、
  重复数量和用户决定；当前页需要展示明细时按 MD5 用一次有界 POST 批量读取 PostgreSQL，
  图库图片移入回收站后只失效涉及该 MD5 的查询，不保留浏览器墓碑；用户决定写回时 Server
  用一次 PostgreSQL 批量计数同步 canonical `duplicate_count`，零匹配不会在翻页后复活。
- 浏览器 `attemptKey` 是 UUIDv7 幂等键。相同规范化意图的重试复用原 session、候选 ID、
  `resolved_image_time` 和 request hash；只有 intent 已过期且 canonical 也不存在时才形成新
  incarnation。每次选择 / 导入批次还冻结 UUIDv7 batch key 与从 0 开始的 batch position；
  两者进入 request hash 并派生持久展示键。接管请求发出时同时冻结其完整输入；响应未知的重放
  不读取后来变化的窗口默认值。服务端派生的 accepted order、执行 token 和 generation 不进入
  request hash。
- 状态读取使用固定 `POST /api/admin/ingestion/status` 批量提交 pair，不把 session、metadata
  或数组放进 URL，也不按卡片建立独立请求。Web 只接受 pair 匹配且
  `(version, progress_seq)` 单调向前的状态；UUID 可以规范化大小写，session ID 不得改写大小写。
- 关闭或按 Escape 不会等待清理，也不会中止请求或未完成任务；关闭路径按点击时冻结的队列水位，
  异步删除当时已经完成的卡片与 Redis completed 回执，正式图片不受影响。动作尚未成功时快速
  重开，允许继续看到尚未清理完成的旧卡片；动作每个分页响应一旦返回，组合队列就按该批逐项
  结果同步移除已确认清理的卡片，不等待后续 continuation，后续批失败也不会撤销此前成功 pair；
  若续页因动作凭证失效而失败，先恢复共享登录态，再由本动作结束时的同一 owner recovery 收敛，
  不会在它之前另发一条普通 snapshot；
  失败项与关闭后才完成的任务继续保留，并以精确 pair 的临时释放投影过滤 retained baseline。
  raw owner 继续保留未受影响的有界展示基线，但会作废动作成功前在途 snapshot 的证明
  资格，并在后台连接仍被持有时用一次权威 snapshot 收敛，因此已经成功清理的卡片不能再由任何
  旧投影闪回。
  清理成功前已经启动的 snapshot 会失效；快速重开、普通 refresh 与并发
  authority recovery 复用队列 owner 的同一 post-action single-flight，只有选择覆盖范围变化或
  失败后的既有有界重试才追加读取。没有 `changed` / `unchanged` 逐项结果时不建立释放投影；动作
  失败仍保留可能有效的旧 baseline。若关闭瞬间正在重连，则以
  关闭前最后一份权威 semantic revision 为上限重新签发动作；关闭后才完成或仍未完成的任务继续
  保留。真正离开图片路由、使上传 owner 卸载时，仍由浏览器持有的 raw 传输可以中止；已经转换
  或 Import accept 的 canonical 继续由 worker 执行，不在 effect cleanup 中隐式批量取消。JSONL
  行级解析错误也由 import owner 保留；切到
  upload owner 时不展示或清除，重开 import 窗口后仍可复制或显式清除。尚未接管的占位草稿
  只由对应浏览器 owner 持有；尚未冻结 commit 的 active canonical 卡片编辑以 pair/version
  CAS 写回 Redis。任务卡片的标题、主题 / 作者连续键入、原图 URL、来源 URL 与详情描述在一次
  焦点会话内只更新卡片临时值，标题栏同步显示临时标题；同 incarnation 的 snapshot、SSE、迟到
  响应和普通重渲染不能覆盖该值。失焦时先确认 attempt 与可编辑资格仍有效，再以焦点开始值和
  最新任务草稿为基线，只把用户实际改变且尚未等于最新值的字段向队列 owner 发布一次；无变化
  不发布。主题 / 作者候选选择、设备、亮度、标签增删等离散操作仍立即发布。提交点击先接收浏览器
  自然失焦产生的发布，再由既有 `flushPendingUpdates` 围栏排空；写回失败仍阻止提交。任务冻结、
  取消、attempt 换代或卡片卸载后丢弃旧焦点会话，关闭、Escape、路由卸载或浏览器崩溃发生在失焦
  前也允许丢失临时值，不做 unload 补发或本地持久化。
  占位转为 canonical 时还会立即把接管前已经发布的草稿补写到任何尚未冻结 commit 的 active
  状态。防抖同步项自身冻结并持有 pair、attempt、version 和最新草稿，翻页或隐藏窗口不会使它
  依赖已卸载的卡片；同一轮
  多张草稿按接口硬上限聚合写回，不建立逐卡并发请求。worker 先推进 version 时，Web 先用
  有界 status 批读取得当前 version，再重放同一草稿；草稿更新 HTTP 已推进 version / semantic
  revision 而旧 snapshot 先到时，卡片继续保留较大水位和本地草稿，直到状态通道覆盖。任务在
  防抖期间进入 committing、completed 或其他不可编辑状态时，本次写回明确失败并把卡片恢复为
  已有 Server DTO 或批量 status 返回的权威草稿，不会把尚未提交的本地编辑静默当成成功。只有
  Redis Lua 原子边界确认当前 canonical 已等于目标语义时，旧 expected version 的响应丢失重试
  才能返回 unchanged；并发编辑已经写入其他语义时仍返回 version conflict。
  原图 URL 与来源 URL 失焦时，Web 和草稿更新接口复用浏览器安全的纯格式解析：去除首尾空白、
  限制输入长度、为无 scheme 输入补 `https://`，并拒绝非 HTTPS、空 hostname 与带账号凭据的
  URL；原图 URL 还拒绝 IP hostname。该边界不执行 DNS、连通性、HEAD、下载或图片内容探测。
  无效临时值不发布给队列 owner，不产生草稿请求、界面提示或错误样式，只在控制台记录不含
  URL 内容的简短格式信息。Import 素材下载与外链原图代理继续使用各自的 Server 网络安全校验
  及既有拒绝提示，不复用这条失焦路径。
  Upload / Import 的默认标签与逐图标签复用同一个固定单行可视窗口。前后 22px 边缘按钮仅在对应
  方向有遮挡时覆盖于内容窗口之上，不占常驻布局列；父框裁切按钮背景，按钮外侧 5px 圆角匹配
  输入框内边界，箭头各自朝实色外缘偏移 4px 形成渐变视觉中心；每次以最小位移将一个相邻被遮挡
  标签完整移出按钮包含半透明渐变在内的实际覆盖区，并预留 1px 抗滚动位置量化间隙，超宽项则
  逐屏连续移动。chip 移除键与翻页键复用直接激活边界，指针按下不会夺取输入焦点或
  结算未完成文本；触控 / 笔只有在共享 5px 移动意图阈值内松手才激活，达到阈值后即使隐式指针
  捕获让松手仍命中原按钮，也只保留滚动而不移除标签。非交互标签表面、viewport 空白及隐藏按钮
  原位置的鼠标 / 笔按下由复合控件根层保留编辑器焦点。触控按下仍交给横向手势；未达到共享
  5px 移动意图阈值的轻点由复合控件在原生、非 passive 的 `touchend` 阶段聚焦并露出末尾输入
  位，同时取消该轻点的兼容焦点与 click。这样浏览器不会在内容移动后、click 之前先把焦点
  重定向到移动批量浮层外；更晚的
  pointerup 或 click 不承担补救职责。达到阈值后只执行横向或纵向滚动，不取消原生结束路径，也
  不与原生滑动竞争。键盘激活恰好到达首尾时，按钮在失效前把焦点归还输入框；整个标签框已
  禁用时，编辑器使用 `readOnly`、`aria-disabled` 与 `tabIndex=-1` 组成不接受编辑且不参与顺序
  Tab 导航的稳定焦点落点，而不使用会让 Chromium 把焦点清空的原生 disabled。
  禁用转换在同一生命周期结束 IME 会话，恢复编辑且焦点仍在输入框时重新开始会话。因此方向
  按钮失效前仍能把焦点留在复合控件内，且不会残留组合态或错误触发草稿结算。细指针的纯纵向
  滚轮在标签框内统一归属横向浏览，即使到达左右边界也不交还页面纵向滚动；带水平分量的
  触控板事件继续走原生路径。新增标签把输入末端带回视野；增删和 ResizeObserver 重新计算两端
  状态，原生滚动跨越首尾边界时只在方向状态变化处同步提交按钮可用性，避免按钮落后一帧闪现。
  标签可以经过按钮下方；按钮不可用时退出命中测试，原位置仍属于标签内容窗口。
  已经由 Server 接管且确有可写 sync target 的草稿 fence 必须在提交动作真正执行前排空；
  未接管占位上的默认值不会妨碍同一 owner 内其他 ready canonical 提交。可重试写回错误由草稿
  owner 独立保留，SSE 重连只清状态通道错误，不会让重试入口消失。清理、提交和取消按钮是否
  可用只取决于是否存在归属任务；草稿写回、接管交接和已有队列动作只决定冻结动作的执行顺序，
  不把这些按钮反复切成 disabled。点击时已有 watermark 冻结其覆盖的 Server 集合，同时把尚未
  进入该水位的 placeholder、pair 与 attempt 作为精确浏览器集合冻结并走既有逐项写回、提交或
  取消路径；两者并行收敛且都不纳入点击后新任务。只有尚未取得有效 watermark、摘要未知且还
  存在不能由这份精确集合代表的 Server 目标时，整次动作才只触发权威重取，不能静默执行一半或
  等待未来水位自动扩大旧点击。

JSONL 可设置 `original`、`source`、`image_time`、`author`、`tags`、`title`、
`description`、`theme`、`device`、`brightness` 与 `storage_slug`。行内字段优先于窗口
默认值；显式空标签和 `auto` 分类也是有效选择。完整数量、并发、文件大小和处理参数以
[配置说明](./configuration.md#runtimeconfig-参数目录)为准。

`import.keep_original_link` 按 `url`、`jsonl`、`weibo` 来源决定是否把实际下载 URL 写入
正式图片的 `original`；未列出的来源仍完成同一下载、校验和入库流程，只把该公开链接留空。
微博帖子页面由独立的 `weibo.source_enabled` 控制是否写入 `source`，不改变图片下载地址，
也不受原图链接白名单影响。Server 在 Import 接管时按 `source_type` 权威应用两项策略，直接
调用接管 API 与后台页面使用同一结果；首次提交意图冻结时还会按当前配置重新投影这两个字段，
因此草稿更新、应用到全部或直接提交都不能把客户端旧值写入正式图片。提交意图冻结后重试复用
已经冻结的投影，不受随后热加载影响。微博来源页在关闭配置时不会进入新解析清单；重新开启会让
新解析清单恢复携带来源，也允许仍持有来源值的未冻结任务提交，但不会重建此前已经省略的值。
图片正式入库后的管理员人工编辑仍遵循普通图片编辑语义。

微博解析器为每张媒体保留实际所属 status 的账号 UID：转发链中的内层媒体使用内层账号，无法
可靠确定归属时不自动填写作者。批次提取结束后，Server 对去重 UID 以
`identity_provider = 'weibo'` 一次查询 PostgreSQL，把命中的作者 slug 写入 JSONL manifest；
未命中项保持作者为空并继续允许管理员使用窗口默认值或逐项编辑。UID、主页链接和身份查询结果
不写入 Ingestion canonical 或 Redis，也不回写已经入库的历史图片。

### 接管、prepare 与 commit

资源准入按职责只有一个 owner：活动浏览器页面管理预览、凭据和 raw PUT 窗口，Server raw
接收管理所有客户端的上传流，Upload / Import 共用的 preparation owner 管理从等待 Normalize 到
`_uploads` 与 ready 发布的全部接入处理，normalize 管理全部 Sharp 重工作，commit 管理两类来源
的最终入库。preparation owner 和 Import 一批远端后继窗口都由 Normalize 容量派生。直接调用
API 仍进入对应的 Server 准入；页面窗口只限制单端工作，不替代服务端资源边界。
`ingestion.max_file_size_mb` 与
`ingestion.max_long_edge` 是所有来源共用的原图准入，浏览器预检只提供即时反馈；Upload raw、
Import 下载与 prepare 会在各自取得完整事实的 Server 边界再次权威校验。

1. **Upload 接管**先对不超过页面 lane 当前容量的一组文件发送一次固定
   `POST /api/admin/ingestion/upload/intents`。正文含完整草稿、目标 storage、大小与素材约束；
   响应为每项返回短期 credential。随后单次接管尝试对每个 intent 最多发送一次固定
   `PUT /api/admin/ingestion/upload/raw`，credential 只放受限 header，正文只有图片字节。
   Server 在读取正文前 claim intent，流式写 attempt 专属 `.part`，完成大小、格式和尺寸校验
   后原子发布 raw，并在同一请求中把 intent 转换为 `upload/received` canonical。不存在第三次
   takeover 或 receipt 请求。一次已签发的 N 项固定为一次 intent POST 加至多 N 次 raw PUT。
   请求取消同时覆盖 Server raw 许可等待、正文接收和发布后的 storage read lock 取得；取消锁等待
   会立即释放 raw 许可，不会让已断开的请求占住唯一上传槽位。锁取得后则由当前锁连接失效信号
   保护 canonical 转换边界。
   raw PUT 在 canonical 形成前失败或响应未知时，显式重试复用原 `attemptKey` 再请求同一
   intent：服务端要么返回已经接管的 canonical，要么为同一 pair 重签 credential 后重传，
   不通过新幂等身份创建第二项任务。
2. **Import 接管**把 URL、JSONL 和微博确认项合并到固定
   `POST /api/admin/ingestion/import/accept`。Server 在 storage read lock 内重新校验并创建
   `import/queued` canonical；请求断开不撤销已接受项。worker 使用现有安全抓取完成 HTTPS、
   SSRF、DNS、逐跳重定向、正文大小、超时和图片魔数校验，并以 attempt `.part` 原子发布 raw。
   `normalize.concurrency=N` 时，全进程最多有 `N` 项 Import 正在下载或持有完整 raw 等待图片处理；
   某项取得实际 Normalize 许可后即让出后继名额，使下载稳定预取下一批。
3. **prepare**只处理完整 raw：Upload / Import 先取得同一个由 `normalize.concurrency=N` 派生的
   preparation 许可，两种来源合计最多有 `N` 项进入本阶段。此时 canonical 使用内部
   `preparing` 状态和 `prepare-waiting` phase，表示 raw 已完整但仍在等待 Normalize 许可；它在
   页面显示“待处理”并计入“等待中”。只有真正进入全局 Normalize 许可回调后，Server 才发布
   `normalizing` phase，页面随之进入“处理中”。Sharp 校验格式、尺寸和 EXIF 展示方向，
   按配置生成 processed image 与 thumbnail，计算 MD5/SHA-256、设备和明暗，再在 storage location
   shared advisory lock 内写入 `_uploads`；两个对象及 ready canonical 发布完成后才释放 preparation
   许可。图片重工作结束即释放 Normalize 许可，因此慢存储不会占用其他图片处理入口。下载 /
   prepare 期间的草稿编辑可以推进 semantic version；worker
   在 heartbeat、progress 和阶段发布的 CAS 冲突后重读 canonical，只在状态和 execution token
   仍属于同一次执行时接力新版 version，并以最新草稿完成阶段。状态、图片身份或 token 已变化时
   仍立即围栏，迟到执行者不能覆盖新 generation。
4. **commit**请求只受理不可变意图。每项携带 pair、expected version、prepared MD5、稳定
   UUIDv7 request ID、重复决定和完整 metadata；Server 冻结 intent hash、prepared generation、
   正式对象键及当前认证 username。API 返回 `accepted` 后立即结束，不等待对象复制或数据库。
   worker 在 storage、图片、词表和同 MD5 advisory lock 内，先为两个确定正式键写入持久
   `move.cleanup` candidate guard，再复制候选，并在不可逆协调器的临界区完成最后一次 token
   复验后启动单个 PostgreSQL 事务。guard 登记前会拒绝强摘要不匹配的预存正式对象；本次
   attempt 只旁路自身唯一 guard token，旧删除租约继续阻断采用。guard 与提交共用单图存储
   变更锁：复制或事务失败时由 handler 删除未引用候选，PostgreSQL 正式引用成立时则保留对象。
   所有新 INSERT 显式写入
   `metadata.created_by`；该字段只取冻结的 server actor，不接受客户端输入，也不进入 browser DTO。

最终入库同时取得 `ingestion.commit_concurrency=N` 的数量许可和代码内 `256 MiB` prepared 字节
许可；两者都覆盖正式对象复制、PostgreSQL 事务、暂存清理与缓存发布。提交 intent 的批量建模
使用代码内固定 10 个 worker，只建立不可变意图，不占用最终入库许可。Ingestion Worker 以同一个
进程级 preparation owner 限制 Upload / Import 合计最多 `N` 个 prepare / staging publication；
该值与两类 pre-commit dispatch slot 均由 `normalize.concurrency=N` 派生。Import 在真正取得
Normalize 许可时立即交还 slot，因而正在下载或持有磁盘 raw 的后继始终最多为 `N`；尚未取得
preparation 许可的后继不生成 Prepared Buffer。Upload 在本项 prepare 完成时交还 slot，中央 Normalize
许可仍是全部来源与维护入口唯一的图片处理准入。两类补位各使用独立
frozen-tail 游标，
Import 的 queued 与恢复后的 received 仍共用 Redis runnable FIFO。commit dispatch window 由数量
许可派生为 `N + ceil(N / 2)`，等待数量或字节许可的任务也占用该窗口；commit 完成后的
事件补位继续使用自己的 frozen-tail 游标。提交成功后的 prepared image 与 thumbnail 由同一个
N=2 删除调用收口，逐项失败只重试未确认的键。

`metadata WHERE id=image_id` 是唯一完成判据。相同 commit request ID 与相同 hash 可安全重试；
worker 在 PostgreSQL 事务前失败时，当前 version 可把同一冻结意图重新排入 committing，
不能借重试修改 actor、metadata 或正式对象键。同 ID 不同 hash 或换 ID 覆盖已冻结意图会被拒绝。
正式入库行已经汇集接入期间通过校验的图片身份、尺寸、格式、摘要、存储位置、缩略图与业务
metadata；后续流程首先复用这份 PostgreSQL 事实，不为“再确认一次”常规重新下载、解码或计算
图片摘要，也不建立第二套衍生真相。只有新输入尚未入库、管理员显式要求重算衍生字段、存储迁移 /
漂移维修必须核对物理对象，或存储协议本身要求请求体完整性时，才重新读取或计算对应字节。
PostgreSQL 已存在时，status、accept 和
commit 重试通过同一个 `WHERE id = ANY(...)` 只读模型批量水合完整管理端图片；正常实时完成则
直接把本次提交事务已经生成的完整管理投影随 SSE semantic 事件交给当前 owner，由 owner 消费
该投影收敛同页状态。只有拿到 PostgreSQL 投影后 Web 才把任务置为完成并失效图库查询。每个
队列 owner 以单一入口按 pair 对 snapshot、SSE、提交、
取消响应、所有旁路 status、全队列动作与重连水合去重，并把同一批首次完成项合并成一次图片
列表、概览、图库统计与词表失效。Redis completed
回执缺少 PostgreSQL 行时会被视为陈旧并清除，查询失败则 fail closed。批量 status 必须先固定
Redis 会话读取，再发起 PostgreSQL
查询：completed 只会在 PG 事务提交后发布，这一顺序避免把提交前 PG 快照与提交后 Redis
回执拼成不存在的陈旧状态。completed 回执只额外保留卡片展示所需的来源类型、批次位置 / 清单行号、
原始尺寸 / 大小和处理参数，不保留下载 URL、完整 prepared manifest、完整图片投影或草稿；完整
图片投影只在实时 SSE 写出期间短暂复用，Redis 仍保持紧凑。因此任务实时完成、
窗口隐藏后完成及窗口重开恢复都会沿用已就绪时的“微博第 N 张”和处理前后尺寸，详情明确显示
“图片已入库”，且不需要额外状态请求。

每个 canonical 锁定 `storage_slug`。默认后端后续变化只影响新任务；ready 任务不能临时
换后端。原始字节只进入 `data/tmp/upload|import`，浏览器不直传 S3；远端 `_uploads` 只保存
processed image 与 prepared thumbnail。

### 队列分页与状态同步

Upload 与 Import 复用同一套 Server DTO 和 repository，但浏览器分别拥有 upload 与 import
owner；两边分别持有本地资源、页码、显示状态、订阅和清空范围，隐藏或打开一边不会读取、
重置或取消另一边。重复确认与单卡提交的 single-flight、busy 和迟到响应也由各自 owner 独立
持有；隐藏 upload 后打开 import，不会被仍在途的 upload 请求锁住，响应只回写原队列。每个
owner 把当前浏览器文档创建的批次作为稳定展示前缀，并按 batch / position 顺序排列；逐项
接管后业务权威立即转交 Server，但当前文档仍在整个窗口生命周期内保留该批的来源顺序，
不会在整批接管时切换展示所有者或改变快照参数。窗口重新进入则从一开始完全使用 Server
display，因此协议切换只体现为任务仍然存在，不增加恢复提示或卡片状态。当前文档保序任务
受 3600 项硬上限约束，新增任务越界时在创建 Server 任务前明确拒绝；关闭窗口后该浏览器
预算随文档释放。组合分页只从 Server 页候选中过滤当前文档保序批次的 pair，并补足当前页剩余
槽位；总数和摘要仍只把未接管任务与 Server metadata 相加，已接管展示项不会重复计数，当前
组合页之外也不挂载 canonical 卡片。因此新批次始终在上、同批来源始终保持 1→N，不因逐项
下载或 raw 转换的完成顺序重排。另一窗口已经退休的排除 pair 会作为 stale 原序返回；对
canonical 与 owner 均已缺失的有界 session 集合，Server 只扫描一次 display ZSET，仍把任何
匹配成员视为孤儿投影错误，不能用正常 stale 清理掩盖结构损坏。accept 成功就是业务所有权
边界：响应同时返回 canonical 的
精确 `accepted_order`、version 与 semantic revision，占位把焦点、预览和可见反馈原位交给
同一张 handoff 卡片。打开的图片预览与重复详情使用 pair/attempt 身份而非一次性 DOM
引用；event-first canonical 合并进 HTTP placeholder，或同一 session 切换 image incarnation
时，预览内容、当前编辑字段和关闭后的回焦目标会同步转交给新卡片。同一 session 重建为不同
image incarnation 时，绑定在一次 reducer
更新中移除旧 canonical，且不继承旧 version、preview 或错误状态；owner 同时按旧 pair 终止
status fence、coverage gate、detached 计数投影与草稿同步，并释放旧 Blob URL，不等待后续
snapshot 才去重或清理资源。任务进入重复待确认后立即按当前页 MD5 查询重复详情，不等待同批
其它图片完成准备；查询不主动中止，同一时刻只运行一个请求。已返回的结果按 MD5 立即写回
对应卡片并在当前查询 revision 内缓存，期间新增的 MD5 只合并为一份尚未解析项的后继请求，
避免已有卡片等待整批完成，也避免取消请求、重复查询已解析项与并发请求。

SSE semantic mutation 与批量 status 的完整逐项 DTO 都由队列 owner 按
`session_id + image_id` 投影到已经保留的精确浏览器卡片，包括当前文档保序前缀中暂时离页的
卡片；事件不会挂载未知 pair，也不会建立全队列 DTO 缓存。completed 事件携带本次 PostgreSQL
事务形成的完整图片投影，因而离页卡片在翻页前已经成为最终状态。若恢复路径或完成投影失败只
能发送 compact completed 回执，owner 也会先按精确 pair 建立不可回退的“已完成”围栏，再把该
有界 pair 放入既有 status 水合 owner 补齐 PostgreSQL DTO；没有 retained card 的 compact pair
也只在这里水合以触发图库失效，不会挂载新卡片。超过单次 status 上限时，由每任 effect 只读取
一个有界 chunk；成功原子落实卡片、引用和待失效事实并消费对应 pair 后，下一任 owner 才读取
尾部，避免旧 owner 中止尾部后重复发起请求。完成去重 owner 会直接过滤已水合未知 pair 的 SSE
重放；后续批失败只留下尚未
处理的尾部，等待明确重试或后续状态事件，已经落实的完成事实与尾部最终仍合并为一次图库失效。
它不为当前页追加 snapshot，Blob 在完整 DTO 替换预览后才回收。顶部 summary 只负责计数，绝不用于推断所有卡片成功。较旧或同版本
较旧 progress 的 snapshot、SSE、status 和迟到 HTTP 响应都受 pair / version / progress sequence
及终态围栏约束，不能把已完成卡片回退到 `committing`、`finalized` 或其他 active 状态。重复完成
观察仍由同一个 pair 去重入口合并一次图库失效，且不会改变当前文档批次顺序。
HTTP 接管响应先于 bounded snapshot 时，浏览器只为尚未被 Server summary 覆盖的 accepted pair
保留临时计数与原展示页租约；URL、JSONL、微博和 Upload 共用的逐项 SSE / status 映射可以推进
等待、处理、失败或完成状态，但不能提前撤掉这两个租约。只有覆盖到对应 handoff revision 的
snapshot 才一次性交还临时计数给 Server summary，因此 25 项开始并发处理时只会从“等待中”
逐项迁移到“处理中”，总数不会先降到个位数再恢复，也不会双计数或扩大当前 DTO 页。

单张任务的取消确认已经得到 `discarded` 结果时，队列 owner 立即按精确 session / attempt
移除卡片。取消结果同时携带该次语义变更的精确 queue revision；在随后一次权威快照完成前，
owner 临时过滤旧基线中的同一任务，并从旧摘要扣除该任务当前状态对应的计数。目标不在当前
有界 DTO 页时，只在 retained summary 的 revision 早于取消 revision 时扣除取消前冻结的单项
投影；新摘要追平后不再重复扣减。取消成功只触发这一次快照恢复；恢复完成后临时过滤随即
释放。若扣减后的总数使当前页越界，owner 会在同一次状态提交中先按新总数夹紧页码，再从
新页参数启动唯一证明快照，不会先向已经消失的旧页发请求；同一连接代次内会以最近稳定摘要
维持已扣减统计，页参数切换不会先闪回 0。因此旧 snapshot 不能把已移除卡片重新插到列表
尾部，列表顺序、页码与总数也只变化一次。
取消失败或仍未进入可释放终态的任务继续保留在列表中。证明读取最终失败时，临时过滤只随
当前 retained 错误基线保留，后续权威读取成功或窗口关闭即释放；不使用持久 tombstone、延时器
或轮询制造第二状态源。

upload 与 import 窗口共用同一两行摘要，桌面和移动端都保持：第一行显示总数、等待中与
处理中，第二行显示待提交、提交中与已完成。其中等待 worker 准入的 `queued` / `received`、
已下载完整 raw 但处于 `preparing + prepare-waiting` 的任务，以及等待提交准入或提交结果的任务
计入“等待中”；实际下载、上传、已取得 Normalize 许可的准备或取消中的任务才计入“处理中”。
重复图片卡片的状态标签显示黄色“待确认”，
颜色直接复用重复提示标题的亮 / 暗语义色；协议恢复、读取和重连状态不在卡片列表上方另加
提示。桌面标题栏下方 padding 为 12px；摘要两行本身提供稳定内容高度，因此右侧动作从一排
切换到两排时不改变标题栏总高度。移动端标题栏始终保持两行：标题位于第一行清理与关闭
按钮左侧，摘要位于第二行来源 / 上传按钮左侧；使用 10px 下方 padding 和自适应高度。极窄
视口优先保留右侧操作，左侧标题和摘要可在自身网格列内裁切，但不会增加第三行或产生横向
滚动。

卡片状态文案继续如实区分“已就绪”“提交排队”和“提交中”，但 `ready`、
`commit-queued` 与 `committing` 共用已就绪的边框、背景和状态文字配色；快速提交不会先闪回
处理中配色，只有进入 `finalized` / `done` 后才切换成功色。该投影不延迟请求、不暂存假状态，
也不引入防闪烁计时器；失败仍立即进入既有失败色与错误反馈。

当前快照同时给出 `last_accepted_order`；只有响应 order 晚于该
基线时才临时把 Server total 增加一次，因此首次响应不会漏计，响应丢失后的幂等重放也不会
重复计数。owner 随即发起一次有界当前页重取；当前文档卡片继续按原 batch / position 顺序
展示，Server 页只补足剩余槽位。已经离开当前组合页的 accepted / completed handoff 只保留
不含 File、Blob、object URL 或 intent 正文的计数投影。跨连接响应经 status fence 接管时，该
投影归属当前 owner generation，并在其 `last_accepted_order` 覆盖后移除；coverage gate 主动重取
期间沿用上一份稳定 Server summary，因此占位退出本地计数后不会临时少计或少一页。它不会被
强行挂回当前页，也不会因翻页漏计。整页展示前缀不会因
等待 snapshot 而把 Server 请求 limit 永久压成 0，也不会出现双卡或瞬时消失。接管请求在发出
前记录 SSE connection generation；响应
跨越连接换代或发出时通道尚未稳定时，不能拿旧响应 revision 与新连接水位直接比较，必须先
通过批量 status 核对；active 结果合并当前权威 Server DTO，PG completed 且 Redis missing 时
直接水合完成卡片。该 HTTP 围栏独立于页内 Server DTO，即使响应到达时客户端已有带
accepted order 的旧 DTO，也要保留到状态通道覆盖。
PG 已完成重放只有在 Redis 本身已是 completed 时才携带精确 revision；否则 Web
保持未知围栏并立即请求一次有界快照，再用现有批量 status 明确 canonical 是 active、completed
还是 missing。围栏由 queue owner 按 pair 持有，不随当前页卡片卸载，也不会因 SSE 连接换代
或新连接仍返回 active 而清除；所有重试与覆盖门槛都绑定创建它的 connection generation，换代
后必须重新核对，不能用旧代高 revision 阻塞冷启动的新代。active 只在同代后续 revision 到达后
补查一次；status 返回的 active DTO 或 Redis completed 回执若带有高于当前基线的精确 semantic
revision，owner 会立即发起一次有界当前页快照，而不是依赖可能丢失的后续 SSE。pair 在稳定
snapshot 覆盖该 revision 后才解除；确认它不属于当前页时不要求再等一次事件，missing 也可
安全解除。围栏解除以前，任务尚未确定进入当前签名 watermark，但仍由点击时精确 pair / attempt
集合参与本地逐项动作；卡片若已进入可编辑状态，草稿继续由上述 pair/version CAS 围栏串行
写回。此时已有按钮保持稳定，已有 watermark 只处理其原水位，精确集合只处理点击时已知目标；
没有现成签名 watermark 且仍有集合外 Server 目标时，整次点击只触发权威重取，也不得在未来
快照到达后扩大旧点击范围。Server 成员保持原卡片并可在连接恢复后重新操作。
批量 status 失败时保留安全状态并在窗口内提供显式
重试，不因一次网络错误永久锁死 owner。只有当前显示的队列建立一个
`GET /api/admin/ingestion/events?queue=...` SSE；Server
先注册 listener，再发送只含 revision 与 action scope 的 `ready`。客户端收到 `ready` 后立即
废止旧 revision、pair 进度和 watermark，使旧页只可展示、不可驱动全局操作，再用非负
offset 与有上限的 limit 请求当前组合页；不保留非当前页卡片，也没有固定 2 秒轮询。
读取 owner 会在当前 offset 保留最多一页普通 Server DTO 作为有界替补，页面 reducer 仍只挂载
当前组合页剩余槽位和当前文档已接管 pair；替补不创建卡片、Blob URL 或草稿 owner。这样当前
文档 pair 逐项进入排除集合时，可以用已有 revision 从替补补齐展示槽位，不必为了同一批任务
再读取一次。
同一 scope、同一组合页内由动作收口、交接覆盖或真实成员变化触发的后台快照会保留当前
稳定展示及原签名 watermark；旧水位止于原 accepted-order 与 revision，读取尚未失败时仍可
冻结点击且绝不会纳入触发重读的新任务。单一读取 owner 聚合同一 action scope / connection
generation、组合页选择、最低 semantic revision、未知结果所需的触发后权威读取，以及普通成功
同页快照等尚未覆盖要求；同页重复触发复用当前请求，不中止同 scope、同页读取。响应与期间可
合并 SSE 逐项证明覆盖后不再尾读，只有仍未覆盖的要求才启动一个后继请求。成功后再原位替换；
当前文档新建批次在接管期间保持固定展示前缀，
因此逐项或整批 handoff 始终使用一页读取窗口，不会生成 `limit=N → limit=20` 的参数尾请求。
只有翻页、清除任务等真实改变组合页范围的操作才会更新 offset 或精确 pair 选择；若参数在
当前读取完成前恢复到已覆盖范围，
纯参数尾随会撤销；同筛选、同 offset 的 limit 收缩或恢复到已有稳定页覆盖范围时直接在客户端
裁切。SSE 新会话已被当前读取捕获后，若随后加入的排除 / 可见 pair 均在该基线中，且基线仍
足以填满 Server 槽位或已经读到队尾，也直接复用该 revision，不为同一批 handoff 再发参数快照；
HTTP 接管围栏只声明必须覆盖的 semantic revision：若当前或在途 snapshot 已达到该水位就直接
消费，只有仍低于水位时才补读；显式 refresh、语义 reload 与新连接 ready 不会被参数回退误删。
成功动作和已知写入优先由同一 SSE 语义事件或最低 revision 证明收敛；revision 证明只在捕获
该响应的 connection generation 内有效，跨代草稿响应改用触发后快照，跨代 handoff 先由当前代
status 取得新 revision。动作 / 草稿失败、未知或格式错误响应、认证恢复、缺少完整完成投影，
以及 revision 缺口仍要求触发后的有界权威快照，workflow 不叠加第二个读取 owner。
单次同 scope 读取失败仍保留卡片和摘要，但立即把旧 canonical 基线降级为纯展示并撤销
watermark 执行权威；limit 扩大、显式 refresh 与语义 reload 均进入同一 100 / 500 / 1500 ms
有界恢复，读取期间到达的 reload 合并进该预算，不形成连续请求链。依赖 Server 且点击时没有
水位的动作不会改用未来快照补冻，按钮本身不随读取状态闪烁，只触发权威重取。页面不会清空
卡片或显示“恢复队列”类瞬时提示。只有组合页 offset 真实改变或 SSE generation / scope 确实
换代时才中止对应旧读取；同 scope、同页刷新继续单飞。
短暂断线与重连同样保留已成功读取的当前页稳定展示，新连接快照成功后原位替换；只有
首次连接或组合页 offset 改变才进入无基线加载。底部存储位置仅显示选择控件。队列动作没有
真实失败时，因目标状态已经变化而跳过
的项目直接留在卡片中，不额外显示“已处理 / 已保留”的协议汇总提示。

快照请求把固定的 queue、offset、limit 留在短 query，并在有界 POST JSON 中携带当前文档
保序批次的 Server pair 及当前组合页中的可见子集。快照 Lua 在同一 Redis 原子边界完整校验全部
排除 pair，以其 `ZREVRANK` 把过滤 offset 换算成原始起始 rank，再读取有界窗口并补入可见
canonical；因此当前文档前缀不会与 Server 页面重复，巨大 offset 不扫描 rank 0，其他会话后来
创建的更靠前批次也不会使组合页错位。旧 incarnation 缺失、discard 或被替换时，响应明确返回
stale pair 供 owner 原子清退，不用闪现额外提示。它同时
读取 queue metadata 与 `last_accepted_order`。当前页 completed 回执只用一次 PostgreSQL
`WHERE id = ANY(...)` 批量水合；
确认失去正式图片的陈旧回执按固定预算原子删除后整页重读，查询未知时 fail closed。最终稳定
页面才签发绑定当前进程 scope、Redis connection epoch、owner、queue、captured revision 与
accepted-order 水位的动作 watermark。owner rank 只供该水位下的有界动作扫描，不参与展示分页。
SSE semantic 事件可更新 summary 或令当前页有界重读；同一 semantic revision 内，
`prepare-waiting → normalizing` 的 progress 事件也携带新的 canonical summary，Web 对页内和离页
事件都更新这份全局计数；同 revision 的绝对 summary 只允许 waiting 等量转入 running，因而
较早离页帧也不能覆盖较新快照，旧 revision 同样不得回退计数。同一 pair/version 的
`progress_seq` 只要求单调增加，允许节流造成跳号，旧 sequence 不能回退卡片或 summary。

SSE 每 30 秒串行重新使用普通 HTTP 的 Redis + PostgreSQL 会话校验，但该长连接心跳不续期；
只有显式 `/auth/me` 探针承担滑动续期。logout、密码重置和账号
删除会通过本进程连接登记立即关闭旧连接；自然 TTL、Redis session key 丢失、账号/角色/凭据
变化或 Redis unavailable 最晚在下一次心跳关闭，失败后不再发送 ping。重新连接总是从空
Server 基线和新 scope 开始，读取状态不会延长 Ingestion canonical 的 `discard_at`。

“应用到全部”、提交全部 ready、三类顶部清理和右下角清空都使用点击时已有的签名
`action_watermark`，不退化为当前页循环。Server 冻结 watermark 中的
`max_accepted_order` 后，从 order 1 开始按 `accepted_order` 递增有界扫描候选，响应返回
逐项结果和签名 continuation；continuation 以上一页最后 order + 1 单调向上推进，并绑定
action ID、动作、规范化参数、完整 watermark、
owner、queue、scope 和 cursor。首批响应丢失时浏览器用相同 action ID 从头重试，已经成立的
commit intent、语义 no-op 或已移除成员不会再次推进 version、TTL 或 revision。当前进程的
action scope 只保留这个动作最近一个请求批次的完整 Promise / 结果；完全相同的并发请求或
响应丢失重试直接重放原逐项结果，包括删除 completed 回执前捕获的图片 DTO。客户端提交上批
签发的 continuation，才证明它已经观察到上批响应并允许 replay 槽替换为下一批，因此内存始终
有界；scope 内另以固定上限的近期 ID→请求指纹拒绝同 ID 换动作、水位或 payload。进程重启、
Redis operational 周期变化或 scope 废止后旧 token 本来就不能继续。全局属性动作不在 canonical
保存 action marker 或结果；相同请求的响应丢失由上述作用域结果槽精确重放，不会再次写任务。
跨客户端 UUIDv7 大小不作为操作先后关系，实际成功的 CAS 顺序才是因果顺序。浏览器可以在
前一动作执行期间继续冻结后续点击，每个动作使用独立 ID 与点击时 watermark，并在同一 owner
内严格串行；全部排队动作结束后才触发一次收敛快照。
该顺序只改变整体候选遍历方向：逐项 handler 仍使用现有并发窗口和执行时谓词复核，不增加
批次 barrier，也不保证在途窗口内的开始、入队或完成严格 FIFO。冻结后新接受且
`accepted_order > max_accepted_order` 的任务不会进入本轮。
提交点击若包含当前浏览器持有且草稿尚待写回的 ready owner，会先冻结点击时的本地 ID / attempt，
以及已取得 pair 但尚未进入当前 watermark 的精确交接 owner，按既有逐项草稿围栏完成写回与
提交受理，再继续执行原点击 watermark 的全队列动作。已逐项受理
的任务会因状态推进被全队列动作跳过，后来接管的任务又晚于原 accepted-order 水位，因此不会
重复提交或扩大点击范围；若 watermark 不可用且仍有精确集合之外的 Server ready 目标，整次
提交只触发权威重取并等待用户重试。
“应用到全部”的 Server payload 与 ready 卡片属性策略使用同一稀疏语义：device / brightness
保留 `auto` 供 Server 按检测结果解析，未选择的空 theme、空 author 和空 tags 不发送，也不清空
canonical 已有值；尚未接管的本地前缀仍按其阶段和清单显式字段规则应用同一组窗口默认值。
“应用到全部”只按 accepted-order 水位选择成员，不按点击时状态或 semantic revision 筛选；
每次 CAS 冲突都重读最新 active canonical，在其上重新计算稀疏 patch，因此保留未被 patch
覆盖的并发编辑，而同一字段以实际后成功的动作结果为准。整队列清空同样只按 accepted-order
水位选成员，并继续执行取消协调器与 PostgreSQL 复核。提交及三类状态清理才要求任务的
`last_semantic_revision` 不晚于点击时 revision，且在执行时仍满足原谓词；点击后才 ready、
改过草稿 / 重复决定或形成的新 incarnation 会保留并显示在汇总中。纯 progress 与 TTL
续期不推进 semantic revision，因此不会误排除原本符合条件的任务。
清除 completed 回执或清空队列时，Server 先批量读取并核对 PostgreSQL owner，捕获完整图片
DTO 后再释放 Redis 回执，并把该 DTO 放入逐项动作响应；当前页外任务也因此进入同一个 Web
完成态观察入口。`commit_ready` 重试若在 Redis 仍为 committing / resolving 时已经从
PostgreSQL 确认完成，也必须把相同 DTO 放入逐项响应，不能降格为不带完成事实的 no-op。
动作响应、在途 status 和后续 snapshot 无论按何种顺序到达，都只观察同一 pair 一次。完成 DTO
先由 queue owner 汇总；一次提交或队列动作只发布一批，异步提交在 committing / resolving 归零
或窗口关闭时统一失效图片列表、概览与图库投影，不按图片逐项重取同一个活动查询。

需要确认的顶部清理在打开对话框时冻结 watermark、规范化动作、本地任务集合与显示数量；
随后加入或变化的任务不会关闭对话框，也不会扩大旧确认的清理范围。只有连接 generation /
scope 真正变化、窗口关闭或用户主动取消才终止这份确认；其他队列动作、草稿或接管交接不会
禁用确认，确认后的动作按 owner 顺序执行。执行时还会按当前卡片重验打开弹窗时的原状态
谓词，已经推进为其他状态的任务跳过且
留在卡片上；Server 已返回的 failed / skipped 也直接由卡片及详情表达并关闭确认。只有网络
结果未知或本地对账尚未收敛时保留弹窗，并以相同 action ID、水位和冻结集合直接重试。其他
无需二次确认的顶部动作在单击时直接冻结同一组边界。

右下角“取消”固定表示清空当前 owner 队列。没有未完成任务时单击执行；仍有执行中、结果
未知或可重试任务时，同一危险色按钮必须再次点击确认。第一次点击同时冻结 Server watermark
与本地占位集合，按钮文案从“取消”变为“清空”；失焦、外部 pointerdown 或 SSE
generation / scope 变化会解除确认，没有计时器。普通 revision、计数、本地集合变化和随后
加入的任务不重置确认，水位后新建的 canonical 永远不属于旧清空动作。取消、PG 核对或 CAS
结果未知的卡片继续保留。
确认时捕获的浏览器占位由来源 owner 批量收敛：同一 Import accept / Upload intent 只等待一次，
已返回但因组合分页离页的 pair 以无 Blob 的冻结 target 继续取消；未知 version 先按 status 上限
批读，再按 cancel 硬上限串行提交，不产生每卡一个请求的并发风暴。正在 cancelling 的占位仍
属于该 intent fence，不能当作普通可移除卡片。raw PUT 取消与 accepted 响应交叉时，本地 owner
用原 upload intent 幂等重放区分尚未形成 canonical 的短凭证与已经成立的 pair；后者继续显式
取消，只有明确 discarded 或确认仍只是 intent 才移除本地卡片，并同步释放该 pair 的页外投影、
重试门槛与状态围栏。取消只确认任务已 completed 时，右下角整队列 `clear_queue` 可按第一次
点击时独立冻结的本地 pair 与 attempt 释放同一终态 owner；即使响应丢失后的 Server 重放没有
逐项返回该 pair，也不会把后来加入的 attempt 纳入。筛选清理则必须由同一 Server 动作以
`changed` 或 `unchanged` 返回完全相同的 pair 才能释放重叠卡片；即使并行 cancel/status 得到
missing，也以该逐项结果收敛。逐项 `skipped` / `failed` 或本地 owner 已推进出原筛选谓词时保留
当前卡片并结束确认；仍匹配但没有 exact 结果、resolving 或结果未知时才继续保留冻结意图，
不能让普通本地清理越过 commit owner。单卡重试同样先取消并精确释放旧 owner，
只有 discarded 才创建新 attempt；completed 或 resolving 保留原 attempt 并显示终态。

### 取消、恢复与清理

显式取消、worker 和恢复共享 `(session_id, image_id)` 的进程内不可逆协调器。数据库事务
开始前可用 pair/version CAS 收缩为 discarded；事务已经开始时返回 resolving，不撤销或伪报
取消，settle 后再按 PostgreSQL 结果收敛。Web 只有收到 discarded 才报告 canonical 已取消；
接收响应未知时，Import 任务以原幂等键重放 accept 找回 pair，Upload 任务先等待当前 raw 请求
settle，再核对状态。瞬时 missing 或仍无法确认的结果保留为可重试取消失败。Redis 不可用时
worker 停止取得新任务并中止仍可
安全中止的阶段，不回退到 PostgreSQL 旧会话表或内存队列。重连和启动使用同一个有界恢复
入口，committing 状态始终先批量核对 PostgreSQL。

raw、`.part`、prepared staging 和正式候选的物理回收必须复验当前 canonical / generation
及 PostgreSQL 正式引用；结果未知时保留，不从文件路径反建业务状态。正式候选仍交给持久
`move.cleanup` 重试。canonical 不使用 Redis 原生过期事件：expires scanner 按 queue 分页读取
服务端 `discard_at`，Lua 再复核 version、execution token 与截止时间并原子移除 canonical、
owner / runnable / expires 索引、计数和 revision；committing 仍先经过不可逆协调器。过期、
显式取消和 clear 只决定业务 tombstone，不以物理删除是否成功反推取消结果。
延迟快速清理只携带取消时冻结的精确 raw generation；同一 pair 在 tombstone 过期后形成的新
incarnation 不会被旧清理递归删除，其他遗留项仍由保守年龄扫描收口。

独立的单实例孤儿清理 worker 每 60 秒运行。它只在 Redis operational 且 canonical 引用形成
稳定有界快照时处理本地 raw 与存储暂存：当前进程仍在接收、下载、Sharp prepare 或发布的
raw / `.part` 由
活跃租约保护；`_uploads` 必须完整列举，并在删除前取得 storage location write lock、重新
确认物理 namespace 未变以及枚举前后精确 prepared key。local 原子发布崩溃遗留的精确
`.candidate-<UUID>` 只沿其基础 attempt key 判定引用与年龄；无法解析的非协议键、近期 generation、
Redis 异常和不完整列表全部保留。详细 age gate 与维护边界见[存储](./storage.md)。

## 公开浏览与图片出口

### 首页、画廊与嵌入页

首页读取图库统计并以一次随机图请求取得背景；设备、明暗、主题、标签和作者选择只更新
本地状态，进入画廊时以 `device`、`brightness`、`theme`、`tag`、`author` 完整名称写入
URL 查询参数。移动端目录的主题滚动区显示约 8 行半，标签显示
约 7 行半，作者显示约 6 行半，以露出的下一行提示还可继续滚动；更多内容保留在对应卡片内。
该高度只在 `760px` 及以下生效，不改变桌面目录尺寸。`/embed/home` 与 `/embed/gallery`
复用相同组件和查询，只不挂载主导航；是否允许嵌入及父页面范围由服务端配置和 CSP 决定。

画廊 URL 是筛选状态的唯一来源。“全部设备”是缺省状态，列表不附加设备条件，并让生成的
随机图链接显式使用 `device=all`；“自动设备”稳定保存为路由状态 `device=auto`。Web 使用与
Server 随机出口相同的纯 User-Agent 规则，在列表请求和 query key 建立前把自动状态投影为
`device=pc`、`device=mb` 或无设备条件，未知 User-Agent 安全展示全部设备；自动状态生成的
随机图链接省略 `device`，由 `/random` 请求边界归一为规范 `auto`。刷新、前进 / 后退和
`/embed/gallery` 都保留这个路由状态，公开缓存响应不依赖隐含 User-Agent。

画廊工具栏的“清空筛选”只把设备、亮度、主题、标签和作者五项一次写回缺省路由状态；列表
查询与生成的随机图片链接由同一次 URL 更新共同收敛，不改变站点配置的画廊排序。移动端把
筛选开关与“清空”呈现为两个相邻操作；清空会收起已打开的 Select / Facet 子菜单，但保持外层
筛选面板原有的展开或收起状态。随机图片链接按真实内容宽度判断溢出；过长时在复制按钮的
保留区域前单行裁切，并以随文字基线靠近底部的三个 ASCII 句号 `...` 标记，不使用居中的
`U+2026`。短链接不显示标记，复制动作仍使用完整 URL。`/gallery` 与 `/embed/gallery` 使用
同一个页面实现和清空语义。

列表按 `image_time DESC, id DESC` 使用 keyset cursor；
cursor 是客户端只能透传的 32 字符 Base64URL 值，服务端严格校验编码、时间与 UUID 边界。
公开列表查询是严格对象，只接受公开筛选、`cursor`、`limit`
和 `shuffle`；`page`、`offset` 或未知字段均返回 `400 validation_error`。`shuffle=1` 只
打乱当前返回批次，不改变 cursor 链。
卡片标题只使用去除首尾空白后的 `title`；没有标题时固定显示 `#` 加 UUID 最后 12 位。列表 DTO
只返回稳定的 `theme` 与 `tags` slug，不重复返回显示名或 `subtitle`。`brightness` 继续随列表
返回：它只有两个高重复值，gzip 后移除收益不足以抵消一次详情补传与等待态。`image_time` 也继续
留在列表作为详情首帧字段：同一接入批次通常每 4–7 张共享一个时间，组间大多处于同月，gzip 后
边际体积很小；公开访问每十张至少打开一张不同图片详情且很少重开时，后移并不能稳定节省正文。
画廊挂载时无条件并发请求
`gallery-facets`；该查询以同一 query key 在会话内长期复用，并由词表或图片成员变化显式失效。
Web 通过同一纯投影把 facets 建成 slug 显示映射，卡片与详情首帧共同消费：标签以 `/` 连接，
主题与标签同时存在时以 ` · ` 分隔，主题 `none` 不进入卡片副标题。列表先到或 facets 失败时
显示 slug，facets 成功后原位更新显示名；图片列表不等待该辅助查询，也不因其失败而不可用。

长时间滚动使用数据窗口而不是无限 React Query pages：

- cursor 目录只长期保存页边界、顺序 ID 和 typed-array 紧凑布局；
- 完整 DTO 只保留视口附近最多 480 张，以及当前被详情固定的一页；
- DOM 与物化位置对象只覆盖前后缓冲区，最多 180 张卡片；
- 渲染窗口只在视口累计移动半屏或视口高度变化时重定位；三屏 overscan 在边界前仍覆盖至少
  两屏半，继续包住共享图片加载器的两屏驻留区；
- 远页回到视口时按保存的 cursor 重新获取，临时 Query 结算后立即从 cache 移除；
- 页集合或下一边界变化时从该页截断旧链，迟到响应由请求 token 丢弃；
- 远页获取失败时，重试操作固定显示在当前视口。

画廊缩略图由共享可见性观察器和解码调度器决定何时设置 `src`。真实视口、近端缓冲和
详情原图使用不同优先级；离开驻留范围会移除地址和引用。列表已知宽高用于预先计算瀑布
流位置，列数变化或图片比例更新时以可见卡片为锚保持滚动稳定。地址加载失败时只显示统一
损坏图标，不在组件内部切换备用地址或追加 cache-busting 重试。

### 详情、原图与移入回收站后的收敛

列表 DTO 提供详情首帧所需字段；详情请求只补充展示图、描述和来源。本地会话提示只触发
`/auth/me` 探测；服务端确认已认证后才按需加载管理信息与编辑能力。未登录、过期提示、
401 与 403 路径都不会下载管理 JS 或 CSS。详情标题固定在新标签页打开该图片的直链，
不提供运行时开关或条件分支。

画廊卡片保留有界布尔值 `diff_original`，结合全局 `static_url` 与图片 ID 即可在详情首帧判定
并构造“原图”动作；“来源”则是每张图片最多 2048 字符、不可由 ID 推导的任意 HTTPS URL，
只随既有详情响应返回。因此详情请求尚未完成时“来源”如实保持不可用，“原图”可以先行可用。
`image_time` 已由列表首帧提供，不随详情请求重复传输。列表与详情的 ETag / 304 继续减少未变化的
后续正文，但不以 304 掩盖首次 200 的字段成本。

共享图片详情弹窗的高清 frame 在未就绪且透明时继续不可命中；进入就绪态后才恢复真实
`<img>` 的原生命中，因此公开画廊、后台概览、后台图片列表和内容接入窗口中的桌面右键或
触摸系统长按始终命中当前展示的 `object_url` 标准化图片。缩略图淡出前后不会成为保存目标；
详情以外的图片预览等 `ProgressiveImage` 消费者继续沿用不可命中的共享默认值。

未登录访客的公开“原图”按钮还受 `site.gallery.public_original_button` 控制；关闭时不渲染按钮
或可聚焦占位，不影响当前展示图的原生保存。服务端确认已登录的管理员复用同一份管理详情
认证结果，在公开与后台详情中始终渲染该入口，不增加第二套会话判别或原图接口。只有
`original` 是另一个 HTTPS URL 时按钮才可用；动作的 DOM、键盘焦点与视觉顺序固定为“来源”
在左、“原图”在右，按钮直接请求 `static.` 资源域的
`/link/original/<id>`；服务端在一次图片解析中复用按原图 URL 与 User-Agent 家族缓存的
直连探测结果，可直连时返回不可缓存的 302，否则在同一请求内使用受限请求代理，并保留
HEAD、条件请求与代理响应缓存语义。公开出口在静态资源域的一次图片查询内完成，只读取
`ready` 图片；回收站图片仍由已鉴权的管理入口处理。应用存储的正式图片和缩略图则
使用稳定公开地址。

公共详情中的移入回收站成功后，画廊窗口取消相关在途页并局部移除 ID；编辑成功后，从该 ID
所在页的 cursor 重新取得权威 DTO。筛选成员或页边界变化时截断后续目录，避免弹窗内部
快照与外部列表形成两个数据所有者。

公共画廊、后台概览、图片列表和内容接入窗口共用同一个图片详情弹窗。最外层
`DialogLayerPortal` 与应用根节点并列，并独占当前 `100dvh` 动态视口；移动详情 article
继承该高度并作为唯一纵向滚动 owner。首个共享页面锁固定
`#root` 并临时设置 `inert` / `aria-hidden`，嵌套弹窗只增加同一计数；最后一个锁释放时先恢复
根节点交互属性与原样式，再恢复精确页面位置和各层 opener 焦点。

触控弹窗打开期间，共享锁在 capture 阶段识别顶层弹窗内真正溢出的纵向 owner，以及显式登记的
标签横向 owner。单指越过意图阈值后按累计位移锁定主轴：纵向仍由最近可滚动 owner 原生消费，
横向则由同一个标签 viewport 显式消费，所以从 chip、空白或输入区起手都不会选到不同 owner；
到达对应边界时锁住滚动链，没有横向溢出时不认领输入框的原生光标与选择手势。纵向输入手势、
双指缩放与弹窗文本选择继续走原生路径。监听和临时 overscroll 样式只在锁计数非零时存在。
移动详情关闭按钮属于根弹窗层、安全区内命中面不小于 44px，并在
pointerup 直接提交关闭；桌面标题栏、键盘、Escape 和背景路径均可关闭。移动详情
关闭 article 的位移动画、图片 paint containment 和完整图 opacity 合成动画，公开 Gallery
卡片的全局图片优化不受影响。

发布前的移动 Chromium 与桌面 WebKit 手机尺寸验证只证明 DOM、CSS、事件、动态 resize、
滚动和焦点契约。它不具备物理 iPhone 的 Safari 浏览器栏与合成器环境，不能替代发布后的
工具栏展开 / 收起、地址栏位置、0–200ms 立即手势、横竖屏和减少动态效果真机验收。

随机图的查询、去重、`proxy` / `redirect` / `json` 返回方式和 PostgreSQL 降级见
[随机图 API](./random-api.md)。

## 后台管理

### 权限

图片管理员可以管理图片、上传 / 导入、常规元数据、主题、标签、作者和检查；超级管理员额外
拥有用户、存储、配置、永久删除、词表删除、整后端迁移和缓存重建等能力。
前端先按角色过滤路由发现与导航预加载，再按能力矩阵隐藏或禁用页面内入口；图片管理员
直接访问超级管理员 URL 也不会先下载对应页面。服务端仍在每个接口独立校验，不能通过
直接请求绕过。

管理员会话保存在 Redis，但每次认证都会按用户名读取 PostgreSQL 账号并校验角色和密码
代际。数据库不可用时保留会话并返回 503；只有真值明确失配时才删除会话并返回 401。
`session_ttl_seconds` 是空闲超时：仅已认证的 `/auth/me` 在完成响应依赖读取后原子刷新当前
Redis payload 的 TTL 并续发 Cookie。普通管理请求不 touch，会话也没有定时探针；首次直达后台
或公开页已有本地提示时产生的既有 `/auth/me` 请求就是续期点，页面间切换不追加请求。

### 作者主页与导入身份

作者管理仍只有一个 HTTPS 主页链接输入。Server 在作者新建或资料更新的独占变更锁与同一
PostgreSQL 事务内，从严格的 `https://weibo.com/u/<UID>` 链接派生微博身份；清空链接、改为其他
合法 HTTPS 地址或换绑 UID 时同步清空或替换身份。客户端不能提交内部 provider / ID。新建与更新
成功均返回已提交的权威作者项；同一微博 UID 已属于其他作者时返回 409，链接与身份都不发生变化。

管理作者列表额外得到只读 `derived_identity` 投影，前端仅用它给现有链接输入设置原生 `title`，
格式固定为 `平台: <provider>; UID: <id>`，直接显示 Server 返回的 provider，不维护平台中文名；
前端不自行解析 URL。保存成功后直接以响应项替换作者查询缓存，并只失效受显示名 / 链接影响的图库
facet、统计与 Ingestion 词表投影，不追加作者列表 GET，也不改变卡片布局。公共图片 API 继续只
返回作者公开链接；历史图片的作者关联不会因主页身份换绑而改写。

### 图片列表与分页

公开图库与后台图片页的主题、标签和作者筛选共用同一个 `FacetSelector`。收起时页面布局显示
带当前包含 / 排除数量摘要的筛选按钮；展开时同一位置直接换为搜索框和显式收起动作，搜索框不
进入按钮；直接触摸、鼠标或键盘激活会在该次事件返回前同步挂载并聚焦搜索框，让 iOS 软件键盘
由第一次触摸直接进入输入态。字段标题始终显式关联当前显示的按钮或搜索框。锚定 Portal 弹层以受搜索框控制的非模态
区域承载待选项、已选项、分隔区与包含 / 排除切换，保持既有顺序、滚动和向上 / 向下展开规则；
页面根 Portal 以当前实际 fixed 绘制原点统一锚点、可见边界与弹层样式坐标，软键盘平移视觉
视口时仍保留与内联搜索框的间隔。页面内搜索框与 Portal 内按钮按一个连续键盘顺序衔接，并以读屏状态报告搜索
结果。关闭、页眉自动收起或移动筛选面板隐藏时清空搜索词，但 URL、词条顺序、显示名、未知值与
筛选结果语义不变。

Facet 内联搜索框显式隐藏浏览器为 `type="search"` 提供的原生搜索词清除按钮；筛选项只能通过
候选与已选操作修改，本版本不另设输入框内清除入口。画廊和后台图片页另有针对五项已提交筛选的
整体清空按钮；五项均为空时仅禁用该按钮，筛选入口仍可使用。

后台图片筛选在桌面单行按设备、亮度、主题、标签、作者排列；容器进入双行时改为第一行设备、
亮度、作者，第二行主题、标签、操作。组件在同一个 `947px` 容器边界实际切换 DOM 分组，使视觉、
键盘与读屏顺序一致；移动端继续采用设备、亮度、主题、标签、作者顺序。设备和亮度以 `120px`、
其余三项以 `150px` 同时作为弹性基准与下限，行内剩余宽度按项等量增加，因此前两项可以稳定
短于三类 Facet，而不会挤压其六字符筛选摘要。

后台图片列表提供图库、无主题和回收站三个视图，以及设备、明暗、主题、标签和作者
筛选。当前页可以普通选择、全选或用 Shift 建立连续区间；翻页、换视图、换筛选或项目
离开列表时清理失效选择，不跨页保留。

“清空”以一次筛选状态替换同时移除这五项，不循环触发单项变化。它不改变图库 / 无主题 /
回收站视图，并沿用普通筛选变化的收敛：清除当前选择与瞬时反馈、返回第一页并把列表滚动到
顶部；无主题视图中暂时不参与查询的主题值也会删除。最终只建立一次无额外筛选的查询键，并
继续服从 90 秒查询缓存。后台忙碌时筛选和清空都不可用；移动面板中的清空只关闭内部下拉或
Facet，不改变外层面板开合。

移动端宽度与高度同时不足时，筛选面板继续使用有界纵向滚动，但不在面板内部重复提供“收起筛选”
按钮；用户仍通过始终可见的顶部筛选主段收起面板，滚动区域直接从筛选项开始。

图片列表使用服务端权威数字页。后台查询是严格对象，只接受共同筛选、正安全整数 `page`
与 `limit`；`cursor`、`offset` 或未知字段均返回 `400 validation_error`。服务端集中计算
`PageWindow { page, limit, start, endExclusive }`，响应只包含 `{ items, total }`，任意有效
目标页直接读取而不建立前序边界。合法页的 `start >= total` 时返回
`200 { items: [], total }` 并跳过目标窗口读取，不在服务端静默改查最后一页。

ready 与无主题页先解析一次规范化筛选计划，再按“索引句柄 → 页码位置适配器 → Redis 有序
窗口 → 当前页水合”读取；窗口最多读取 `limit` 个成员，total 与成员来自同一已验证 revision。
coordinator 正在重建、revision 改变或派生索引暂不可读时，允许使用同一个筛选计划回源
PostgreSQL；Redis transport、连接或命令失败则标记运行时不可用并返回稳定
`503 redis_unavailable`，不会伪装成成功回源页。筛选计划读取或补写主题、标签和作者的
Redis JSON 词表也使用同一 required-read 失败合同；回收站只走 PostgreSQL OFFSET。

PostgreSQL 回源在同一连接的 `REPEATABLE READ READ ONLY` 事务中依次读取 total、判断越界，
再取得当前页 metadata 与随窗口投影的 tags；事务提交后才做 URL 和 DTO 格式化。浏览器端
`useImageAdminPageNavigation` 是唯一查询 owner，查询键包含规范化 scope、page 和 page size，
目标缓存 90 秒内可零网络复用。同一 scope 跳页时继续使用最近成功且最新的 total 快照展示
总项数与总页数，但不把上一页 items 伪装成目标页内容；已有成功快照时，目标页尚未返回或
请求失败都不会把未知数据解释成 `0`，也不会用目标页码反推总页数。请求进行中时，副标题
保留稳定的页码、总页数与总项数，只显示“加载中”，不展示尚未确定的当前页项数；成功后
才显示“本页 x 项”。目标页失败且没有缓存数据时也不把缺失 items 显示为 0，而由错误区域
提供重试；已有缓存的后台刷新失败后仍可显示该页实际项数。scope 改变时当次渲染立即使用
第 1 页并清除旧 scope 的 total；成功结果使总页数收缩时只直接夹紧一次，目标页失败则保留
该页与错误并在原页重试。主题、标签、作者和上传队列等普通分页页面继续使用各自的本地
分页，不接入图片列表协议。

### 编辑、迁移与删除

公开详情、后台详情、概览和图片列表共用同一详情与属性编辑能力。
共享响应按真实消费者分成独立形状：公开列表只返回画廊卡片与详情首帧所需字段及稳定主题 / 标签
slug，公开详情只补充描述、来源和展示图地址；后台图片列表返回卡片操作所需的完整状态、对象、
大小和时间字段，概览最近图片使用不含删除状态与编辑字段的紧凑详情，编辑快照只返回恢复草稿
与画廊权威回写所需字段。三个后台形状互不继承可选字段，也不会用缺列补零来伪装同一投影。
公开画廊卡片与登录后按需读取的编辑快照都不返回副标题或显示名；Web 使用会话级 facets 从
slug 生成本地展示值。登录用户保存主题或标签后，画廊先用权威快照即时回写稳定 slug，相关
facets 同时失效并重取显示名，再由命中页 cursor 回读核对成员和分页边界；不从副标题反向解析，
也不让列表服务端为每个 cursor 页重复读取和投影同一份词表。
概览紧凑详情在读取最近图片的同一 PostgreSQL 语句中解析存储显示名，只返回详情直接消费的
`storage_label`；`storage_slug` 仅在服务端定位对象。因此概览打开后台详情时首帧
直接使用权威显示名，也不会为了已随概览返回的 MD5、时间与存储标签再请求 `admin-info`；
后台图片列表仍以自身已缓存的存储选项解析显示名，公开详情按认证状态保留独立管理信息查询。
编辑器始终建立一个 `items` 会话；单图只是其中只有一个成员。成员数量只决定标题、
副标题、文案、分页、
批量默认值和移出按钮，编辑器 shell、列表、卡片、动作和公共属性实现均使用数量中性命名；
快照、草稿、保存、移入回收站、迁移、权威回读与卡片结果使用同一实现。
移动端的批量默认属性使用共享折叠面板。“应用到全部”会同步重算草稿或任务卡片，折叠开关会
同步隐藏、设为 inert 并重定位面板内容；两者都使用共享 `DirectActivationButton`。触控 / 笔在
移动量未超过统一 5px 阈值的 `pointerup` 直接提交各自动作，鼠标、键盘与辅助技术继续走原生
click；迟到且可能在重绘后重新命中的同手势兼容事件由已有守卫消费。下一次物理 `pointerdown`
先释放旧手势守卫，再由新目标建立自己的激活事务，因此相邻两次真实触控不会互相吞掉，也不依赖
WebKit 一定把延迟 click 派发给原触点元素。共享按钮的触控 / 笔目标聚焦统一延后到手势已经按
原始布局通过 `pointerup` 校验之后，因此选择菜单、“应用到全部”等默认按钮仍会正常接管焦点并
收起软键盘，但不会让视觉视口在同一次物理按压尚未提交时复位并改变命中目标。目标聚焦触发的
编辑器失焦结算在动作读取前同步提交，动作使用该次重渲染后的最新回调，因而“应用到全部”不会
漏掉刚由失焦接收的标签。需要继续编辑的复合标签候选与移除控件保持原输入焦点；折叠触控同样
保留输入焦点直至提交收起，再释放被隐藏的编辑焦点，键盘、辅助技术及程序化 `detail=0` 激活则
继续把焦点留在披露按钮上。三种焦点策略集中在共享按钮，不由工作流页面补定时器或坐标特判。
折叠面板自己的捕获阶段 `touchstart` 只负责外部触控关闭，不建立页面入口特判、额外延时器或
第二套展开状态。

编辑读取、保存和存储迁移分别使用数量中性的 `/api/admin/images/snapshot`、
`/api/admin/images/update` 与 `/api/admin/images/migrate-storage`；三者都接收 1–200 张图片，
单张操作就是数组中只有一个成员。编辑窗口只提交真实变化字段，服务端规范化并稳定排序整批
图片 ID 锁后，以固定低并发逐图处理并按输入顺序返回结果。每张图片的 metadata、词表创建、
完整标签替换和必要清理回执在一个 PostgreSQL 事务内提交；一张失败只回滚该张，实际变化只
推进一次 `ready_image_revision` 并交接一次投影，纯 no-op 仍返回 `updated` 但不推进 revision。
分类对象在事务外准备和校验、事务内切换位置并写清理回执，不能把对象存储与 PostgreSQL
描述成一个全局事务。

编辑明确采用 last-write-wins，不存在逐图编辑 revision、预期版本、冲突响应或三方合并；
陈旧窗口最后提交时可以覆盖较新结果。同一图片的在途请求由锁串行，锁不证明窗口最初读取的
快照仍为最新。响应丢失或部分失败后，前端只沿同一请求锁边界读取 PostgreSQL 权威快照收敛，
不会自动重放 mutation。PostgreSQL 已提交即视为成功；Redis 投影、词表或计数缓存修复失败
只记录并失效或安排重建，不能把已提交结果改成可安全重试的普通失败。
Redis 冷启动、上游 502 / 503 / 504 或短暂网络错误会触发有限的快照回读重试，不会重放
写请求。卡片直接显示绿色“保存成功”、红色“保存失败”或黄色“待确认”；待确认状态
保留草稿，再次点击只重试权威确认。检查页随后恢复为 Redis 正常并不能反推较早请求未
经历短暂故障，保存结果仍以对应批次的 PostgreSQL 快照为准。
保存收口只把服务端结果确认已经更新的成员及其真实变化字段交给查询失效所有者。公开
Gallery 先用同一次权威快照原位替换命中卡片，再后台重读唯一命中页；该页不会在等待期间
退化为占位符，未变化卡片继续复用原对象和图片 DOM。后台结果确认筛选成员、缩略图比例、
游标或顺序改变时，数据窗口才原子调整对应成员、几何与锚点。列表、详情、facet、stats、
overview 和词表分别只在自身字段受影响时刷新；公开编辑与后台编辑共用同一 mutation、
快照和编辑会话能力，不建立第二个公开查询所有者。
分类变化、单图迁移、批量迁移、整后端迁移与主题重分配都调用
`images/storage-location/` 的图片位置能力；该边界拥有 metadata CAS、图片 revision、mutation
fence、状态判断和提交后 cache handoff，并复用 storage 域提供的单图锁、对象验证、持久清理与
共享传输准入。主题删除仍由主题领域编排词表删除、重试和最终同步，不直接持有图片位置 SQL。
管理端以同一个保序列表编排器报告逐项迁移、跳过与失败，单图只是列表中只有
一个成员。迁移响应同时返回服务端解析的目标显示名；后台与公开登录详情都优先复用或按需
执行同轮管理信息回读，并在处理编辑快照结果前保留其成功值。相邻回读失败时采用迁移响应值；
管理信息回读成功后，其显示名始终优先于同轮其他响应。
整后端迁移的流式分页也直接调用同一单图原语，精确语义见[存储](./storage.md)。

移入回收站、恢复和永久删除分别只使用 `/api/admin/images/trash`、`restore` 与 `purge`，
前两者接收显式 `1..200` 个唯一 `ids` 并按请求顺序返回逐项结果；trash 响应计数为
`trashed`，逐项状态为 `trashed` 或 `ignored`；单图只是数组中只有一个
成员。`purge` 的正文只能是 `{ scope: "selected", ids: [...] }` 或
`{ scope: "all" }`，空数组、缺省字段和数量哨兵都不能表示全部。所有永久删除都需要
`image.trash.purge`。移入回收站和恢复与
编辑快照共用稳定排序的单图锁；写响应未知时先等待同一锁边界读取权威快照，再刷新页面
查询，不重放 mutation。编辑窗口内的 trash 同样提交当前活动的 `1..N` 个成员，并只把响应
中的逐项 `trashed` 作为直接成功依据，不从聚合计数推断成员结果；传输失败只让结果保持
未知，随后以权威编辑快照确认。编辑器就近的同一领域单元依次拥有 mutation、回读、会话成员
修剪、公开窗口成员交接和查询失效。部分成功时只移除已确认移入回收站的成员，仍可编辑或
结果未知的成员留在原会话等待重试或刷新。

图片卡片的单图移入回收站使用同一个图标按钮内的两次点击确认；图库 / 无主题的批量入口同样在
文字按钮内按“批量删除”→“确认删除”两次点击，第一次点击冻结精确 IDs。两者失焦或点击按钮外
都会取消确认。提交后两者都禁用并使用 `delete-bin-5-line`；单图按钮保持“删除中”，批量按钮
显示“正在删除”。移入回收站与恢复取得服务端已知结果后，先满足最短进行态并在卡片仍位于当前
标签页时呈现结果，再刷新权威列表成员；刷新失败会把同一反馈升级为错误并保留重新加载提示。
全部成功时反馈只显示实际移入或恢复数量；只有服务端返回未处理项时才追加对应数量，不展示
“0 张未处理”。
图片列表 mutation 使用专门的失效入口，把当前后台列表作为必须确认的刷新，其余公开列表、详情、
统计、词表和概览投影保持尽力失效；不会在通用失效循环中按调用方布尔参数特判某个 query key。
未知写结果仍先沿单图锁边界回读和刷新，不把卡片是否消失反推为成功。
单图永久删除、删除已选图片和清空回收站统一使用范围确认弹窗；弹窗中的危险按钮先显示
“永久删除”并使用 `delete-bin-7-line`，第一次点击后变为使用 `delete-bin-2-line` 的“确认删除”，
第二次点击才提交。永久删除结果在列表刷新收口后再交给页面反馈并关闭弹窗，不会在页面仍被
弹窗设为 inert 时于背后开始倒计时。永久删除请求结果未知时，确认弹窗保持打开并在自身错误区
持续展示对账结果，禁用再次确认以阻止盲目重放；用户只能关闭弹窗并按提示重新加载，不会在
不可交互的页面后方启动短时反馈。
三个永久删除入口只对具有 `image.trash.purge` 权限的超级管理员可见，服务端仍独立强制该权限。
提交后弹窗锁定，以 `delete-bin-5-line` 显示“正在删除”，并在正常情况下等待确认范围完全删除，
再关闭并只刷新一次列表。连接中断、有限
等待结束或任务异常不撤销持久删除意图；此时刷新后仍存在的 `purge_pending` 卡片显示“待彻底删除”，
禁用选择、恢复和重复删除。页面不建立轮询，失败原因与重试只在检查页显示。

桌面编辑页脚左侧放置迁移存储与删除，右侧放置取消与保存；存在多页时分页放在中间。
移动端分页独占动作行上方一行，资源动作在左、取消与保存在右；只有一页时不渲染分页行。
单成员内容保持垂直居中，窄屏仍保留不小于 44px 的触控目标。

回收站生命周期为：

1. 移入回收站只把图片标为 `deleted` 并从 ready 投影和全部公开发现入口移除，对象与
   `object_url`、`thumb_url` 留在原位；已知正式媒体直链继续使用 immutable 缓存并可读取。
2. 恢复把可恢复行写回 ready 投影，不搬对象，也不改变正式媒体 URL。
3. 彻底删除请求先把精确成员与 `trash.purge` 任务在一个事务中绑定，再等待该精确 `1..N` 集合。
   Worker 在单图锁内删除并确认原图、缩略图均不存在，最后按任务归属与对象位置条件删除
   metadata。任务调度取消可以退出锁与共享清理许可的等待；driver 调用已经开始后，
   当前项只再响应锁连接失效，并继续完成确认与 metadata 收尾。
4. `scope: "selected"` 与 `scope: "all"` 都和移入回收站、恢复共享短时成员锁；同一事务只为
   实际新绑定且 `purge_job_id IS NULL` 的 deleted 行创建任务。`all` 只负责把事务快照中的现有成员解析为精确 ID 集合，随后与
   单图和选中范围进入同一绑定、等待与删除路径；之后新进入回收站的图片不属于本次确认范围。
   已经绑定的行只计为 `already_queued`，不会创建重复任务。

移入回收站不是访问撤销：既有直链仍可访问。彻底删除会删除源对象，使后续源站请求无法
回源。

### 检查、反馈与外观

后台概览沿用 `queryKeys.overview` 这一个查询 owner，在同一服务端请求中并行读取 PostgreSQL
统计和 Redis 当前核心图片投影占用。Redis 测量只遍历固定核心键、准确使用
`MEMORY USAGE ... SAMPLES 0`，不扫描键空间；并发概览请求单飞合并。卡片可见副标题只显示
“占用大小 · 同步状态”；当前测量、最近完整重建回退及其测量时间保留在 hover 详情中，完全
未知时以“—”占位。活动重建的状态轮询不重复测量，完成后的既有概览刷新只测量一次。

检查页默认用一次轻量请求独立展示 PostgreSQL、Redis 和图片投影状态，同时在后台自动执行
一次有界 Redis 占用检测；轻量结果不等待检测，完整检测结果原地填充核心投影与派生缓存双卡。
核心卡仍以“图片成员”展示当前轻量状态中的投影图片数，不把同一图片在 rich item、全局索引
和反查键中的多个 Redis 成员相加；深检只补充该卡的键数与内存。派生卡继续展示深检得到的
键数、结果成员数量与内存。
自动检测进行中禁用 Redis 和“全部”入口，手动 Redis 检查继续复用同一查询，不产生并发扫描。
数据库、Redis、存储和“全部”按钮触发各自深度检查，“全部”包含回收站一致性结果。各资源
错误独立收口，一个失败不会抹掉其他结果。图片投影
区域的角色公共部分呈现当前状态、PostgreSQL / Redis revision 指纹、最近错误、刷新和准确
占用；手动重建、存储维护和整后端迁移在服务端确认超级管理员权限后才加载独立能力模块。
存储维护弹窗使用当前只读检查结果预览缺图、可修复缩略图、孤儿对象和活动 Ingestion，
但必须由超级管理员再次确认。执行端在独占存储位置锁内重新读取 PostgreSQL 和三个完整
命名空间；预览同时包含缺失缩略图与数据库标记为尚未最终采用的缩略图，并按物理命名空间
去重受阻情况，不把不完整组或不可读逻辑后端的相关项算作
可执行维修 / 删除。Redis 中仍活动的 canonical 继续持有自己的暂存对象。不完整列举不会生成
修复或删除候选。维修直接写回并校验当前 local / S3 对象，
不创建后台缩略图任务；孤儿删除进入固定单调用的 provider 中性 1…N 契约，并逐项返回
`removed`、`missing`、`failed` 或 `unknown`。请求中止后不再启动后续 driver 调用；直接被中断的
调用保持可重试，不把未确认对象计为成功。数据库已记录有效缩略图时保留生成前对象探测；
记录为未采用时直接校验原图并生成，再统一复核当前位置与缩略图。维修与删除按主要资源分别
调度；维修替换未采用的缩略图时同样取得共享清理许可。已开始的短调用改由维护锁信号完成
确认，调用方取消只停止后续调度；执行端等待两个资源池全部收口后才释放独占锁，因此旧预览和
断开的响应都不会被当作写入真相。

后台查询和 mutation 只由所属页面或共享 Hook 拥有。路由返回、Strict Mode、窗口聚焦、
弹窗开关和写操作结束都不能为同一资源制造第二个查询所有者；写操作只做一次必要失效。

后台外观可选亮色、暗色或自动，并以 PostgreSQL 偏好为真相源。站点配置或后台认证初始
读取完成前使用固定启动暗色；初始读取失败也保留该画布及满足普通文字 4.5:1 的反馈色，
认证完成后才在后台内容首帧前应用偏好。图片页冷入口的筛选控件、非选中子标签和次级导入
按钮直接消费后台语义表面；选中标签与主上传按钮才使用主操作色，不依赖迟到页面样式
把白色控件覆盖为暗色。公开页面及其中的管理弹窗始终使用公开暗色上下文。后台偏好复用
认证首帧或最近五分钟内的查询快照；认证首帧同时携带同一偏好 GET 表示的 ETag，更久后
回到窗口或网络恢复时才显式携带它条件重验证，未变化的 PostgreSQL 投影返回 304。

## 配置、缓存与 Worker 的交接

应用设置写 `data/config.json`，存储后端与凭据写 PostgreSQL。完整配置编辑器只管理当前
实例运行策略；带来源版本提示的配置包可以携带可移植运行配置和自定义存储注册项，目标
版本按自身当前能力逐项识别，但不搬运数据库业务数据、Redis、图片对象或部署连接。配置来源、归一化和跨资源提交边界见
[配置说明](./configuration.md)。

配置包导入在单一 FIFO 写租约内先原子持久化候选 `config.json`，此时普通请求和运行配置
listener 仍只观察旧内存快照；PostgreSQL 正常提交或 xid8 确认已提交后才发布候选一次。确认
回滚时只原子恢复旧文件，结果 unknown 时保留并发布候选后返回明确 503，交由检查页和管理员
核对存储后端注册表。listener 的同步异常逐个隔离记录，不改变已经稳定的文件或数据库结果。

图片写事务只提交 PostgreSQL 真相并推进投影 revision；精确 Redis 同步或全量重建发生在
提交后，失败不倒退业务结果。`move.cleanup`、`trash.purge` 与 `cache.rebuild` 的领取、
租约、重试和停机语义，以及 Redis Ingestion worker 的单实例恢复边界，由
[架构总览](./architecture.md#后台-worker)统一说明，流程页面不复制任务状态机。

## HTTP 缓存与按需加载

- hash 静态资源、稳定的 `/media/*` 与可证明存在的 `/thumbs/*` 使用 immutable；非 hash
  品牌资源使用短浏览器缓存。动态公共 JSON 立即重验证，随机接口与管理写请求不缓存。
- 公共与管理 DTO 只包含一个缩略图地址。配置公开 URL 的 S3 直接指向最终对象；local 与
  无公开 URL 的 S3 使用应用 `static.` 入口。ready 与 deleted 管理项复用同一稳定公开媒体
  URL；回收站状态只控制发现面，不增加后台 `raw` / `thumb` 字节入口。
- 应用缩略图读取不做存在性探测、repair receipt 查询、同步补建或原图降级。正式对象缺失
  返回 404，其他存储错误保持真实状态；修复必须由检查页“存储维护”显式执行。
- Home 与 Gallery 的 `React.lazy` 路由和导航意图共用同一模块 Promise。首次位于 Home 时，
  主导航“画廊”和次级“进入画廊”的细指针 hover 或键盘 focus 只预取 Gallery 必需的
  JS / CSS 静态闭包；首次位于 Gallery 时，主导航“首页”以相同方式预取 Home 闭包。
  同一路由的多个入口和重复意图不会创建第二次请求，管理入口不预载；触摸、直接点击和
  地址栏导航仍走普通导航路径。预取不会挂载目标页面，因此不发送 API、facet、统计或图片
  请求。预取失败后，后续导航使用新文档取得新的原生模块映射，不复用当前文档已缓存的
  失败动态导入。
- 公开首页和画廊不加载后台壳。后台路由按页面拆包；上传、详情、管理信息、编辑器和存储
  迁移只在权限确认或明确 hover、focus、pointerdown、click 意图后加载。预加载只取得
  JS、CSS 与静态依赖，不挂载组件或发起页面查询。图片管理页的“导入图片”组合按钮是
  一个统一意图边界，会同时取得内容接入工作流和来源输入两个按需块；独立上传按钮不扩大到
  来源输入块。
- 页面专属 CSS 跟随同一动态模块；共享语义颜色属于公开域或后台域基础块。内容接入与编辑器
  共用的图片工作流样式由两种能力各自携带，不依赖访问顺序。

完整缓存头、CSP、压缩、条件请求和 Range 约束见[安全](./security.md)及相关 API 文档；
反向代理不重复实现应用缓存，见[生产部署](./deployment.md#反向代理与-https)。
