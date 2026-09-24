# 图片接入

本文说明 Upload / Import 的接管、队列、提交和资源释放契约。
用户入口见[图片管理员指南](roles/image-admin.md)，目录职责见[项目结构](project-structure.md#内容接入)。

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

## 输入与队列

“更多导入方式”支持 Enter / Space / 上下键打开并聚焦菜单项，上下键与 Home / End 移动，Escape 归还已接管的焦点，Tab 回到页面顺序，焦点移出时关闭；悬停展开不移动输入焦点。来源模式使用单一 Tab 停靠点，左右键与 Home / End 切换并保留标签焦点，Tab 进入关联面板；鼠标和触摸切换仍直接聚焦输入框。解析期间保持禁用。

- 图片管理页把“导入图片”主按钮和右侧下拉按钮作为一个意图区域：细指针进入、键盘
  focus 或 pointerdown 任一点时，同时预载内容接入工作流与来源输入模块；独立的“上传图片”
  按钮只预载内容接入工作流，来源菜单项在自身交互点预载来源模块。预载只读取静态资源，不挂载
  窗口或发出 API 请求。
- 任一入口开始启动时，launcher 直接复用页面根交互锁，防止按需模块尚未挂载窗口时又启动图片
  编辑或写操作，但不把该互斥传播成各按钮的 `disabled` 外观。来源菜单项在同一次激活内先把
  意图交给 launcher，再启动菜单退场；不能等
  退出动画完成后才保留一个可能过时的激活回调，也不能让已变为 pointer-transparent 的菜单覆盖
  仍可操作的页面控件。最外层工作流 `DialogFrame` 提交后，会在同一布局阶段把 `#root` 设为
  `inert` / `aria-hidden` 并接管焦点与滚动；引用计数交接后 launcher 释放自己的根锁，活动意图仍保留到
  工作流关闭。因此模态窗口显示和淡出期间，半透明遮罩后的页签、筛选、选择、卡片动作及分页
  始终保持正常外观，但真实点击仍由模态边界统一阻止；不把“打开一个弹窗”误表示成图片写操作。
  加载失败、入口撤回或未能打开时直接释放根锁并退休意图；仍在文档内且可操作的启动入口会在
  根锁布局清理后恢复焦点。正常退场仍在动画完成回调内同步
  卸载弹窗并解除 `inert`，首个无遮罩画面即可执行单图编辑；减少动态效果在关闭请求内完成，
  不复制动画时长或增加延时器。
- 工作流窗口首帧不等待首份 bounded snapshot 才绘制主体：当前还没有可见任务时，Upload 直接
  显示文件选择 / 拖放入口，Import 直接显示来源选择入口。该入口只是可操作的默认画面，不充当
  服务端队列为空的证明；快照汇总先更新 `totalItems` 时继续保留，直到 `visibleJobs` 水合出未完成
  任务后才在原位换成逐项真实卡片。短暂断连且没有 retained card 时仍保留中性入口，真正读取
  失败则由既有错误提示替代；不增加加载占位、延时器或另一套队列状态。
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
  异步删除当时已经完成的卡片与 Redis completed 回执，正式图片不受影响。主窗口退场完成时，
  默认设备和明暗重置为 `auto`，默认主题、作者和标签清空；已有任务的属性和冻结请求保持原值。
  关闭来源输入、图片预览或详情子弹窗不重置主窗口默认属性。动作尚未成功时快速
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
  箭头、键盘和纯纵向滚轮转横移沿用窗口的平滑滚动；共享弹窗边界消费手指横拖时显式即时滚动，
  不受该 CSS 平滑影响。连续同向滚轮按未抵达的目标累计位移，反向输入从当前可见位置回退；
  直接操作或滚动完成后释放滚轮目标。减少动态效果时窗口关闭平滑。
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
`description`、`theme`、`device`、`brightness` 与 `storage_slug`。设备、明暗、主题和作者等
单值字段优先采用行内值，显式 `auto` 分类仍是有效选择。标签按来源标签在前、窗口默认标签在后
合并去重；省略 `tags` 或提供 `tags: []` 都会带入默认标签，微博自动生成的年份标签也与默认标签
同时保留。合并后仍遵守每张图片最多 50 个标签的边界。完整数量、并发、文件大小和处理参数以
[配置说明](../CONFIG.md#runtimeconfig-参数目录)为准。

JSONL 清单先检查 UTF-8 字节上限，再逐行收集非空记录；遇到第一条超出配额的记录即拒绝，
不为剩余行建立数组或行对象。空行不占配额，非法非空行仍占配额；条数检查完成后才解析 JSON
和字段，错误保留原始物理行号，`batch_position` 按非空记录从零计数。LF、CRLF 及末尾换行
使用相同规则。

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

## 接管、prepare 与 commit

资源准入按职责只有一个 owner：活动浏览器页面管理预览、凭据和 raw PUT 窗口，Server raw
接收管理所有客户端的上传流，Upload / Import 共用的 preparation owner 管理从等待 Normalize 到
本地处理结果与 ready 发布的全部接入处理，normalize 管理全部 Sharp 重工作，commit 管理两类来源
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
   `POST /api/admin/ingestion/import/accept`，按解析后图片数量和 `import.max_items` 顺序分片，
   保持原批次键、位置和幂等身份。Server 在 storage read lock 内重新校验并创建
   `import/queued` canonical；请求断开不撤销已接受项。worker 使用现有安全抓取完成 HTTPS、
   SSRF、DNS、逐跳重定向、正文大小、超时和图片魔数校验，并以 attempt `.part` 原子发布 raw。
   `normalize.concurrency=N` 时，全进程最多有 `N` 项 Import 正在下载或持有完整 raw 等待图片处理；
   某项取得实际 Normalize 许可后即让出后继名额，使下载稳定预取下一批。
   清空时，未发送项及首次请求被整体校验明确拒绝的项直接退休；结果未知的项以冻结输入发送
   `cancel_if_missing: true`。已有 canonical 返回真实状态供正常取消处理；缺失项在同一 Redis
   原子操作中登记紧凑 discarded 回执，不加入展示或执行队列，迟到 accept 复用该回执。
   Upload intent、Import accept、状态核对及逐项取消请求均采用 30 秒客户端超时；超时保留
   未知结果以便幂等核对，不视为服务端已取消。微博解析及文件传输使用各自生命周期。
3. **prepare**只处理完整 raw：Upload / Import 先取得同一个由 `normalize.concurrency=N` 派生的
   preparation 许可，两种来源合计最多有 `N` 项进入本阶段。此时 canonical 使用内部
   `preparing` 状态和 `prepare-waiting` phase，表示 raw 已完整但仍在等待 Normalize 许可；它在
   页面显示“待处理”，只计入总数和未完成数，不计入等待或处理等状态统计。
   只有真正进入全局 Normalize 许可回调后，Server 才发布
   `normalizing` phase，页面随之进入“处理中”。Sharp 校验格式、尺寸和 EXIF 展示方向，
   按配置生成 processed image 与 thumbnail，计算 MD5/SHA-256、设备和明暗，再原子发布到
   本地临时目录；两个文件及 ready canonical 发布完成后清理原始文件并释放 preparation
   许可。图片重工作结束即释放 Normalize 许可。下载 /
   prepare 期间的草稿编辑可以推进 semantic version；worker
   在 heartbeat、progress 和阶段发布的 CAS 冲突后重读 canonical，只在状态和 execution token
   仍属于同一次执行时接力新版 version，并以最新草稿完成阶段。状态、图片身份或 token 已变化时
   仍立即围栏，迟到执行者不能覆盖新 generation。
4. **commit**请求只受理不可变意图。每项携带 pair、expected version、prepared MD5、稳定
   UUIDv7 request ID、重复决定和完整 metadata；Server 冻结 intent hash、prepared generation、
   只由 UUID 尾部两位分片的规范正式对象键及当前认证 username。API 返回 `accepted` 后立即结束，
   不等待正式对象写入或数据库。
   worker 在 storage、图片、词表和同 MD5 advisory lock 内，先核对两个正式目标并保存本次预检结果，
   再为确定正式键登记持久 `move.cleanup` candidate guard。写入阶段复用目标预检，校验本地
   处理结果后流式写入；已确认支持 Content-MD5 的 S3 通过预计算摘要校验展示图和缩略图的
   上传正文，其余 S3 与 local 写入后回读大小与 SHA-256。两份对象完成后，在不可逆协调器的临界区完成最后一次 token
   复验并启动单个 PostgreSQL 事务。guard 登记前会拒绝强摘要不匹配的预存正式对象；本次
   attempt 只旁路自身唯一 guard token，旧删除租约继续阻断采用。guard 与提交共用单图存储
   变更锁：写入或事务失败时由 handler 删除未引用候选，PostgreSQL 正式引用成立时则保留对象。
   所有新 INSERT 显式写入
   `metadata.created_by`；该字段只取冻结的 server actor，不接受客户端输入，也不进入 browser DTO。

最终入库同时取得 `ingestion.commit_concurrency=N` 的数量许可和代码内 `256 MiB` prepared 字节
许可；两者都覆盖正式对象写入、PostgreSQL 事务、暂存清理与缓存发布。提交 intent 的批量建模
使用代码内固定 10 个 worker，只建立不可变意图，不占用最终入库许可。Ingestion Worker 以同一个
进程级 preparation owner 限制 Upload / Import 合计最多 `N` 个 准备与本地结果发布；
该值与两类 pre-commit dispatch slot 均由 `normalize.concurrency=N` 派生。Import 在真正取得
Normalize 许可时立即交还 slot，因而正在下载或持有磁盘 raw 的后继始终最多为 `N`；尚未取得
preparation 许可的后继不生成 Prepared Buffer。Upload 在本项 prepare 完成时交还 slot，中央 Normalize
许可仍是全部来源与维护入口唯一的图片处理准入。两类补位各使用独立
frozen-tail 游标，
Import 的 queued 与恢复后的 received 仍共用 Redis runnable FIFO。commit dispatch window 由数量
许可派生为 `N + ceil(N / 2)`，等待数量或字节许可的任务也占用该窗口；commit 完成后的
事件补位继续使用自己的 frozen-tail 游标。上传等待与字节进度属于提交阶段；PostgreSQL
提交成功后按精确文件引用删除本地结果，清理失败进入有界重试，提交失败则保留有效结果。

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

内容接入入口在共享存储选项加载成功后打开，首次使用不临时回退到本地存储；加载失败可重试入口。
来源解析后的自动导入使用提交时的当前存储选择和默认属性。
每个 canonical 锁定 `storage_slug`。默认后端后续变化只影响新任务；ready 任务不能临时
换后端。所有接入文件统一进入 `data/temp/<session>/<image>/`，以 generation、execution token
和文件名区分原始文件、处理结果及写入中文件。浏览器预览读取主站鉴权的本地结果。

## 队列分页与状态同步

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
snapshot 才一次性交还临时计数给 Server summary，各项按当前阶段更新状态统计；待处理期间仍
保留总数和未完成数，总数不会先降到个位数再恢复，也不会双计数或扩大当前 DTO 页。

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
处理中，第二行显示待提交、提交中与已完成。等待上传 / 下载的 `queued`，以及等待提交准入或
提交结果的任务计入“等待中”；实际下载、上传、已取得 Normalize 许可的准备或取消中的任务
计入“处理中”。完整 raw 对应的 `received` 和 `preparing + prepare-waiting` 显示“待处理”，
仅保留在总数与未完成数中，不进入各状态统计；分页、清理和批量操作仍包括这些任务。
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
初始缓冲、待发与在途写入共用每连接 1,000 条 / 1 MiB 的序列化事件预算，超限关闭连接，
由现有重连与快照恢复。周期验权独立于快照和慢读写入；会话失效即关闭并释放连接资源。
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
标签在本地初始、ready 和服务端接管阶段统一追加并去重，默认标签为空时保留任务现有标签，
不因清单提供过 `tags` 而跳过追加。
本地初始阶段的空主题、空作者同样表示不修改，清单显式单值字段仍保留原优先级。

默认属性栏的分体菜单依次提供清空主题、标签、作者和全部三项。字段缺省仍表示不修改；
属性动作中的 `tags: []` 清空标签，非空数组追加去重，`author: ""` 解除作者关联，
`theme: null` 清空主题；“清空以上全部”在同一任务的 metadata 变更中同时提交三个空值，
其他字段保持当前值。操作不删除图片、任务或词条，也不改写窗口默认值。
打开确认时冻结原队列 watermark、本地 ID / attempt 和未提交数量上限；执行时跳过已提交、
锁定或不再存在的任务，普通计数和 revision 更新不扩大或取消原范围。
队列 owner 仅在确认存续期间保留本地任务身份，并在接管时补入该 attempt 的首个精确 pair；
已被新 attempt 或 incarnation 替换的目标退休。上传意图签发的 candidate pair 不代表接管；
只有 `serverAccepted` 确认后才进入精确补批，尚未接管的目标经原草稿 owner 更新，
原水位覆盖的成员继续走全队列属性动作；确认期间才接管的目标用有界 `items` 精确集合补齐，
不提升原水位来包含其他后来任务。`items` 只用于属性动作，不能携带 continuation，
服务端逐项核对 owner、queue 和 incarnation，复用相同 metadata CAS 与逐项结果。
精确集合也进入 action 指纹，不能用同一请求 ID 改换集合。已知失败只用新的动作 ID
重试原失败 pair；网络异常、服务端错误或成功响应正文无法解析时，结果仍未知，
由原队列 action owner 保留原请求、当前页游标和已知累计结果，
重试从未知页继续，不回到已经越过的第一页。仅保留最近未确认动作，完成、切换动作或
连接代次、队列 owner 卸载后释放。全部动作沿原队列 action owner 串行，
草稿写回、SSE 和快照继续由现有所有者收敛。
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

## 取消、恢复与清理

显式取消、worker 和恢复共享 `(session_id, image_id)` 的进程内不可逆协调器。数据库事务
开始前可用 pair/version CAS 收缩为 discarded；事务已经开始时返回 resolving，不撤销或伪报
取消，settle 后再按 PostgreSQL 结果收敛。Web 只有收到 discarded 才报告 canonical 已取消；
接收响应未知时，Import 任务以原幂等键重放 accept 找回 pair，Upload 任务先等待当前 raw 请求
settle，再核对状态。瞬时 missing 或仍无法确认的结果保留为可重试取消失败。Redis 不可用时
worker 停止取得新任务并中止仍可
安全中止的阶段，未完成会话的恢复以 Redis canonical 为准。重连和启动使用同一个有界恢复
入口，committing 状态始终先批量核对 PostgreSQL。

原始文件、`.part`、处理结果和正式候选的物理回收必须复验当前 canonical / generation
及 PostgreSQL 正式引用；结果未知时保留，不从文件路径反建业务状态。正式候选仍交给持久
`move.cleanup` 重试。canonical 不使用 Redis 原生过期事件：expires scanner 按 queue 分页读取
服务端 `discard_at`，Lua 再复核 version、execution token 与截止时间并原子移除 canonical、
owner / runnable / expires 索引、计数和 revision；committing 仍先经过不可逆协调器。过期、
显式取消和 clear 只决定业务 tombstone，不以物理删除是否成功反推取消结果。
延迟快速清理只携带取消时冻结的精确 raw generation；同一 pair 在 tombstone 过期后形成的新
incarnation 不会被旧清理递归删除，其他遗留项仍由保守年龄扫描收口。

独立的单实例孤儿清理 worker 每 60 秒运行。它只在 Redis operational 且 canonical 引用形成
稳定有界快照时处理本地原始文件、处理结果和写入中文件。接收、下载、Sharp prepare、预览
和提交都持有精确路径租约；扫描只删除未被引用、无活跃租约且超过年龄门槛的文件，按游标
跨周期继续，及时释放句柄并修剪空目录。检查页展示陈旧文件与本地空间，并标记扫描是否完整。
详细年龄门槛与维护边界见[存储](./storage.md)。
