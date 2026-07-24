# 功能与流程

本页描述 ImageShow 的主要端到端流程。底层表结构见[数据库结构](./database)，组件边界见[项目结构](./project-structure)。

## 四种导入入口与两种底层模式

后台提供本地文件、URL 列表、JSONL 清单和微博导入四种入口。它们共用一个 `ImportJob` 队列、任务卡片、元数据编辑、最终 MD5 判重、SSE 状态推送、取消/重试和批量提交界面；底层统一为两种 `import_session`：`mode=upload` 由浏览器上传素材，`mode=download` 由服务器下载素材。两种模式都必须先原子完成 materialize、进入 `received`，prepare 只处理已经完整落盘的 raw 文件。

前端 `attemptKey` 负责幂等和防旧请求污染，最终会话 / 图片 UUIDv7 由服务端按 `image_time` 生成：当前时间 ID 直接使用 Node.js 原生 UUIDv7，历史图片则保留原生随机位并替换 UUIDv7 的 48 位时间戳。会话创建接口接收可选 `batch_time` 与 `manifest_position`：没有显式 `image_time` 时使用批次共享时间，并把稳定输入位置写入 UUIDv7。会话创建时写入 `request_hash`，同一 `idempotency_key` 只有在模式、URL、大小、存储后端、规范化图片时间、JSONL 临时清单位置和初始元数据摘要一致时才复用。

```text
模式 1：本地上传

File ──► 立即创建卡片 + blob: 临时预览
     └─► created：创建 import_session(mode=upload，锁定 storage_slug）
          └─► PUT upload_url
               └─► materializing：data/tmp/<id>.raw.<attempt>.part
                    └─► 原子发布为 data/tmp/<id>.raw.<attempt>
                         └─► raw_token=<attempt> → received
                         └─► POST prepare_url → preparing
                              └─► transcodeStoredImage()
                         ├─ 校验格式、尺寸
                         ├─ WebP < 阈值且尺寸达标：跳过转码
                         ├─ 否则缩放、WebP 编码、按体积逐级降质量
                         ├─ 生成标准缩略图、始终识别设备与明暗
                         └─ 计算最终 md5 / size / ext
                                   ├─► <锁定后端>/_uploads/<id>.<attempt>.image.webp
                                   └─► <锁定后端>/_uploads/<id>.<attempt>.thumb.webp
                                        └─► ready：切换为最终预览，允许编辑/提交

模式 2：链接下载

URL ──► 立即创建卡片
    └─► created：创建 import_session(mode=download，锁定 storage_slug/source_url）
         └─► POST materialize_url
              └─► materializing：服务端限时、限大小、安全下载到 .raw.<attempt>.part
                   └─► 原子发布为 data/tmp/<id>.raw.<attempt>
                        └─► raw_token=<attempt> → received
                        └─► POST prepare_url → preparing
                             └─► 与本地上传相同的转码、staging、ready、commit
```

### URL 列表、JSONL 清单与微博导入

链接导入输入窗口提供 URL 列表、JSONL 清单和微博链接三个标签，三者都进入
download 生命周期。URL 与 JSONL 按 `link_image.max_items` 限制单次输入数量，
微博链接按 `weibo.max_items` 独立限制，微博解析后的合计图片使用 1000 张固定
安全上限。输入确认后只在浏览器建立有序任务；任务真正进入 materialize 槽时才
逐项创建 `import_session`，没有一次创建整批会话的接口。单项创建只返回继续流程
所需的 ID、`prepare_url`，以及 upload 专用的 `upload_url` 或 download 专用的
`materialize_url`。

解析完成后，桌面端将有效项概括与取消、解析或导入动作放在同一行，概括最多显示
两行，不再缩小输入框；失败项明细仍保留在输入与动作之间。移动端继续把概括放在
输入框下方，保持现有纵向布局。

本地 upload 与服务器 download 共用同一个两阶段调度器实现。队列按输入顺序分配到
现有 N 条 lane；每条 lane 的当前项开始 materialize 时才创建自己的会话。前端轮询
确认服务端权威状态已经进入（或完成）`preparing` 后，才打开一个前瞻槽并为唯一
后继创建会话、执行素材化；尚在队尾的任务没有服务端会话，不会在获得执行机会前
消耗 30 分钟租期。准入轮询使用 100ms 起步、最高 1 秒的有界退避，并在等待间隔内
同时监听 prepare 请求完成，因此不会用固定 50ms 频率持续请求，也不会因退避延迟
已经完成的任务。后继即使先到 `received`，也必须等当前 prepare 请求结束后才能
prepare；失败或取消的后继同样占用这一个槽，当前结束前不会补第三项。连续追加批次
和重试进入同一个持久队列，不会另起 worker 绕过上限；页面卸载会停止取项、中止
活动传输并清理已创建会话。并发 1 时峰值为 1 个 preparing + 1 个后继
materializing，并发 N 时分别最多 N 个；真正图片标准化仍只有 N 个。

前端为一次选择生成共享 `batch_time`，所以并发完成顺序不会打乱输入顺序。JSONL 每行一个对象，可用字段为 `original`、`source`、`image_time`、`author`、`tags`、`title`、`description`、`theme`、`device`、`brightness`、`storage_slug`。`original` 同时作为下载 URL 和元数据原图 URL，`source` 仅表示来源页面；未知字段会被严格校验拒绝。

JSONL 先请求管理端解析接口，服务端按 `link_image.max_items` 限制数量、逐行严格校验并规范化 `image_time`。合法行才创建 `ImportJob`，错误行保留行号、截断后的原文预览和错误原因。任务创建时的字段优先级为“JSONL 行内字段 > 窗口默认属性 > 系统默认值”；行内 `tags: []` 是显式空标签，`device: auto` 也是显式分类选择，两者都不合并对应默认值。任务进入 ready 前，清单显式提供的设备、明暗、主题、作者和标签受保护；未提供的公共属性继续跟随管理员主动执行的“应用到全部”。ready 后所有来源采用同一编辑规则，清单属性不再受保护。JSONL 任务默认跳过重复图：判重发生在 prepare 完成并取得转码后最终 MD5 之后；图库重复会显示已有图片的缩略图、标题和分类，点击进入图片详情。JSONL 与普通 URL 在批内重复时均显示首个任务的转码结果、`original`、JSONL 行号（若有）和分类，随后重复任务立即 cancel 会话、清理自身暂存并记为“已跳过”，不会进入 commit。URL 与图库已有图片重复时仍等待用户确认，本地上传的重复处理不变。

微博标签每行接收一条无需登录即可访问的公开微博链接，可一次解析多条。服务端为
整批只申请一个临时匿名访客身份，再按 `weibo.concurrency` 运行持续补位的 worker
pool，不保存 Cookie；慢请求不会阻塞其他空闲 worker，客户端取消后停止认领后续
链接。所有批次的访客身份和帖子详情请求还共用 `weibo.global_concurrency` 进程级
许可池，排队中的请求可随客户端取消而移除。请求前会按链接解析出的微博标识去重，
返回后再按微博 ID 去重，保留首次出现的来源和输入顺序。单条链接的请求失败、正文
超时或中断、响应过大及无效 JSON 会保留输入行号与原因，其余成功微博仍可继续导入。
服务端随后按每条微博的图片顺序提取并去重原图链接，转发微博图片会继续追加。每张
图片被序列化为一行 JSONL：`original` 是原图链接；`source` 优先使用详情响应中的
用户 ID 与 `mblogid` 规范为短码 URL，缺少 `mblogid` 时改用数字微博 ID，二者都
缺少时才保留输入链接；`image_time` 是微博发布时间，`tags` 包含发布时间年份；
`device` 与 `brightness` 均显式设为 `auto`。生成的合并清单立即交给同一 JSONL
严格解析器，并在返回任务前检查微博固定的 1000 张安全上限。浏览器随后按 download
模式建立有序任务并随 lane 逐项创建会话，因此继续复用 JSONL 的字段校验、字段来源
保护、时间规范化、批内顺序、重复跳过和错误报告。

同一微博的所有图片共享微博发布时间，但按接口返回的链接顺序依次获得递增的 `manifest_position`。因此在 `image_time DESC, id DESC` 下，链接列表中越靠后的图片排序越新；多微博合并后仍先保持微博输入顺序，再保持各微博内部图片顺序。

`weibo.author_slugs` 是微博用户 ID 到 ImageShow 作者 slug 的映射。命中时 JSONL 行写入 `author=slug`，该作者在 ready 前按清单显式值保护；未命中时不生成 `author`，任务创建时继承窗口当前默认作者，默认作者为空时才保持为空。ready 后仍可在任务卡片中手动填写作者，或通过“应用到全部”批量修改。

解析接口还会按非空记录生成从 0 开始的临时清单位置，普通 URL 和本地批量文件
也会按各自经过校验、去重后的输入顺序生成批内位置。
同一批任务共享 `batch_time`，服务端在没有显式 `image_time` 时用它作为图片
时间，并把稳定的 `manifest_position` 直接写入 UUIDv7 的 `rand_a`。因此
并发会话的完成顺序不会改变 `ORDER BY image_time DESC, id DESC` 下的批内
排序，靠后的输入排列更新。显式 `image_time` 始终拥有更高优先级；该位置不写入数据库字段，也
不保证跨批次相同时间的人工顺序。JSONL 和 URL 单批默认软上限为 200，
微博链接默认软上限为 20、可配置到 50；URL 与 JSONL 可配置到 1000。
50 条微博按每条最多 18 张图片计算，最坏为 900 张，低于微博清单固定的
1000 张安全上限。通用服务端硬上限为 3600，低于 `rand_a` 的 4096 个可用位置，
仍为内部位置编码保留 496 个位置。本地文件选择默认软上限为 200、可配置到
1000，只在前端约束；服务端逐文件创建会话，不维护本地批次计数。

`image_time` 的带偏移 ISO 8601 输入由原生 `Temporal.Instant` 解析；`YYYY-MM-DD HH:mm:ss` 无偏移输入由 `Temporal.PlainDateTime` 按运行时 `TZ` 转为瞬时时间。夏令时跳跃造成的不存在时间或回拨造成的歧义时间都会被拒绝，不依赖 `Date` 的隐式本地时间解析。

prepare 完成后会删除 `data/tmp` 下的 raw 文件；素材化失败、prepare 失败、取消和过期清理同样删除 attempt 隔离的 `.raw.<attempt>` / `.raw.<attempt>.part` 与 `_uploads` 候选对象。失败路径先持久化并确认 PostgreSQL 已进入 `failed` / `cancelled` 等可清理状态，再删除 raw 与暂存对象；权威状态无法确认时一律保留。清理只匹配完整 UUID 形态的 attempt 文件，避免误删其他临时内容。完整分片通过同目录硬链接以“不覆盖本 attempt 目标”的方式原子发布为 `.raw.<attempt>`；随后只有 `execution_token` 仍匹配的执行者才能把同一 token 写入 `raw_token` 并发布 `received`。若进程在文件发布后、`received` 落库前退出，后续 materialize 会按数据库中的执行 token 恢复该完整文件；半成品不会进入恢复路径。

materialize、prepare、commit、取消和过期清理共用每会话 PostgreSQL advisory lock。专用锁连接在持锁期间监听 `error` / `end`；连接丢失会发送中止信号、等待回调完成协作式收口并销毁该连接。会话中的 `execution_token` 是数据库发布栅栏：新执行者会先换 token，旧执行者随后不能把 `received`、`ready` 或 `finalized` 发布成功；`raw_token` 另把 `received` 真值绑定到唯一完整 raw。每次 prepare 还使用“会话 ID + 尝试 ID”的唯一 processed image / thumbnail 暂存键，因此无法立即取消的迟到对象写入也不会覆盖新尝试。正式候选或旧位置的不可逆删除进入 `move.cleanup`，任务重新取得单图锁并在删除边界重读 PostgreSQL；未解决任务同时持有物理对象删除租约，commit、分类移动和存储迁移在任务终结前拒绝采用相同命名空间、前缀与键，从而封闭不可取消 DELETE 发出后的失锁窗口。取消先把 `cancelled` 写入 PostgreSQL 并中止本实例任务，再等待跨进程执行者释放该锁后清理。进程在 `preparing` 期间退出后，下一次 prepare 取得该锁、清理该会话的旧 staging，再从 `raw_token` 指向的完整 raw 重做。`received` / `ready` 状态更新的回包不确定时会先回读 PostgreSQL，权威状态无法确认时保留 raw 与 prepared 对象，不做可能破坏已发布真值的清理。

导入会话空闲有效期为 30 分钟；materialize、排队、prepare 与 commit 期间会周期性
续租 `expires_at`，取消标记和孤儿 raw 清理年龄也使用同一有效期。启动与周期性
孤儿扫描在迁移可用后运行，只对 PostgreSQL 已无对应会话、文件年龄已超过该阈值且
可非阻塞取得会话锁的 raw / `.part` 执行删除；仍有未来租约或正在执行的会话不会因
文件 mtime 较旧而丢失素材。后台清理用 `FOR UPDATE SKIP LOCKED` 原子认领真正空闲
过期的普通会话，并逐项等待同一会话锁确认执行者已经退出；对于过期的 `committing`，
只有非阻塞取得该锁、确认没有活跃提交者后，才先标记为 `cancelled`。终态会话随后按
存储后端分组：每个后端只列举一次 `_uploads` 并按 session ID 过滤，raw 临时目录也
只扫描一次；实际删除使用有界 worker pool。只有 raw、staging 和最终候选清理均成功
的会话才删除数据库行，单项失败会保留会话供下次重试。若进程在正式对象复制后、
数据库事务提交前退出，过期清理会先确认 PostgreSQL 没有图片引用，再删除最终候选
image / thumbnail；删除失败进入可重试的对象清理任务，“清理无效存储”仍作为孤儿
对象的最后防线。

download materialize 会为每个通过安全校验的当前图片 URL 生成仅含其 HTTPS origin
的 `Referer`，以兼容微博等图床的基础防盗链；发生重定向时按新目标重新计算，不会
发送原图路径、查询参数、来源页面或管理员提供的 Referer。

原始上传/下载字节从不写入 S3、WebDAV 等目标后端，因此不存在“先远端上传原图、再下载回来压缩”的重复传输。服务端为 materialize 和 prepare 建立彼此独立的进程内全局许可池，但二者分别复用当前模式的同一配置值：upload 使用 `upload.global_concurrency`，download 使用 `link_image.global_concurrency`。因此每个阶段都不能绕过服务端上限；前瞻只允许传输与处理各占 N 个许可，不增加图片处理并发。commit 则同时使用 `import.global_commit_concurrency` 与 `import.global_commit_byte_budget_mb`，在取得会话锁和数据库连接之前按任务数和 prepared 字节数排队，所有客户端与直接 API 请求共享上限。

### prepared import 状态机

```text
created
  └─► materializing（浏览器上传或服务器下载到 .raw.<attempt>.part）
       └─► received（原子发布 .raw.<attempt> 并写入 raw_token）
            └─► preparing（校验 / 转码 / 缩略图 / 最终 MD5）
                 └─► ready（可编辑、可提交）
                      └─► committing（只搬候选对象并写数据库）
                           └─► finalized

materialize / prepare 失败 ─► failed + 清理本 attempt 的临时对象
可取消阶段                 ─► cancelled + 清理 raw、processed、prepared thumbnail
```

每个任务在创建会话时锁定 `storage_slug`。之后修改全局默认存储只影响新任务；ready 任务不支持换后端，commit 必须使用会话中的后端。

任务卡只在实际传输阶段显示整数百分比：本地上传进度由浏览器 XHR 提供，
相同整数百分比不会重复更新前端任务队列；
链接下载仅在最终响应给出可信的 `Content-Length` 且没有内容编码时，通过
状态查询与 SSE 推送服务端下载进度。缺少可靠长度时不显示推测值，进入图片
处理阶段后立即清除传输百分比。

### materialize、prepare 与 commit 的职责

materialize 只负责取得完整素材：

- upload 对浏览器 PUT 的原始流执行精确大小限制；download 按配置限制请求时间和响应大小；
- download 的外部 URL 只允许 `https` 且必须使用域名，不接受直接 IP；每次请求和重定向后都会校验主机解析结果，禁止 localhost、内网、链路本地、组播和云 metadata 等受限地址，并依赖运行时 TLS 验证确认证书有效，再通过内容嗅探确认返回的是支持的图片格式；安全拒绝对外统一返回通用提示，内部 debug 日志保留拒绝原因；
- 两种模式都先写 attempt 隔离的 `.raw.<attempt>.part`，成功后以不覆盖既有目标的同目录硬链接原子发布为 `.raw.<attempt>`，再用同一 attempt token 条件更新 `raw_token` 并进入 `received`；失败、取消和失锁后的迟到执行者不会发布半成品，也不会删除或覆盖另一执行者已发布的完整 raw。

prepare 只认领 `received` 会话，承担图片重处理：

- 图片解码校验、长边约束、可选 WebP 转码与体积控制；
- 标准缩略图、最终预览、设备/明暗检测；
- 基于最终候选字节计算 `metadata.md5`；
- 把 processed image 和 prepared thumbnail 写入锁定后端的 `_uploads`。

commit 不重新下载或重新转码，但会从锁定后端读取候选并验证正式对象：

1. 全生命周期会话 advisory lock 防止 materialize、prepare、commit、取消和清理交错，单图 storage mutation lock 与分类和迁移串行；
2. 核对 `_uploads` processed image 的 prepared MD5；已存在正式对象必须逐字节等于 staging，新写入对象则立即回读验证，不一致返回 `storage_object_conflict`；
3. 验证后的 processed image 写入 `media`，prepared thumbnail 写入 `thumbs`；
4. 短事务写 `metadata`、标签关联与会话最终状态；
5. 事务成功后清理 `_uploads` 候选对象；
6. 重新读取 PostgreSQL 真值，更新随机池并推进图片 cache revision；lookup 只按该 expected revision 条件预热，revision 已被其他图片写操作推进时跳过。相关实体计数列表标为 dirty；只有事务实际创建了新主题、标签或作者时才刷新对应词表。事务后的派生缓存操作可幂等重试。

commit 成功响应只返回导入状态以及队列继续展示所需的最终展示图 URL 和缩略图 URL。

单个后台页面用 `import.commit_concurrency` 并发调用 commit，服务端再用 `import.global_commit_concurrency` 与全局字节预算统一限流。prepare 保存图片和缩略图的强摘要；commit 对 `_uploads` 源与正式目标做流式摘要校验，并优先调用存储后端内复制，避免为校验持有多份完整 Buffer。全局许可覆盖上述完整流程，任务成功、失败或请求在排队阶段取消都会释放名额。

对象提交具有完整性幂等检查和持久补偿：若目标对象已存在且内容一致，重试会复用；若正式对象已经写入但数据库事务失败，本次调用实际创建的 `media` 或 `thumbs` 会进入 `move.cleanup`，绝不删除预先存在的同名对象。正式图片已提交而 staging 清理暂时失败时仍保留 finalized 会话，由周期清理继续收口，不把已成功提交误报为失败。

### 前端队列与判重

- 选择本地文件后立即加入卡片，本地 `objectURL` 只用于 prepare 前临时预览；切换为服务端最终预览时立即 revoke。
- 队列状态优先走 SSE 实时推送；SSE 连接失败或断开后才降级为 2 秒一次的批量状态轮询，轮询按当前未完成任务集合合并请求，不按单卡片单独轮询。
- 前端不读取整文件计算 MD5。批次内的预筛只用 `name + size + lastModified + webkitRelativePath`，浏览器拿不到完整路径时不依赖路径。
- 服务端返回最终 MD5 后，队列以同步 reservation 防止并发 prepare 的两张相同图片同时通过批内判重，再查询图库已有项。
- 卡片区分等待、上传/下载、处理、已就绪、提交、完成、跳过、失败、取消；显示存储后端显示名、处理前后像素尺寸、处理前后体积、质量或短路状态、失败原因及取消/重试。窗口统计固定分成“任务 / 处理中 / 待提交”和“成功 / 跳过 / 失败 / 重复待确认”两行。
- 上传 / 导入的“默认属性”和批量编辑的“批量默认属性”在移动端默认折叠；展开后以
  与图片列表筛选相同的 `80ms` 浮层过渡覆盖卡片区，不再挤压下方列表。触控、点击、
  键盘焦点或滚轮操作发生在浮层及其弹出菜单之外时会自动收起。
- “清空已完成”移除成功提交和已跳过的卡片；清空未提交、清空重复待确认、取消单项会先调用后端 cancel，再移除卡片，本地 XHR 与服务器下载请求也会中止。
- URL / JSONL / 微博任务逐项创建会话，每个任务的 `attemptKey` 同时是服务端幂等键。
  若服务端已创建会话但该单项响应在网络中丢失，失败任务会保留原 key；用户重试时
  取得同一幂等结果，不会创建第二个空会话。服务端明确返回的业务错误则使用新的
  `attemptKey` 重试，避免把已确定失败的请求与后续修改混为同一尝试。

属性编辑按服务端处理检查点而不是只按卡片的“失败”外观决定：

| 任务阶段 | 单卡属性 | “应用到全部” |
| --- | --- | --- |
| `queued` / `uploading` / `downloading` | 锁定 | 本地上传与普通 URL 替换全部五项公共属性，空主题、空作者和空标签也会生效；JSONL / 微博仅替换清单未提供的属性 |
| `processing` | 锁定 | 锁定，避免处理中的会话同时改变语义 |
| `ready` | 可编辑 | 设备 / 明暗应用具体选择，`auto` 恢复本次 prepare 的检测结果；非空主题和作者覆盖，非空标签追加并去重，空值不清空现有值 |
| `committing` / `cancelling` / `done` / `skipped` / `cancelled` | 锁定 | 锁定 |
| 创建、传输或 prepare 失败 | 锁定 | 按失败前的首阶段规则处理，方便管理员在重试前主动调整默认属性 |
| commit 失败且服务端仍为 `ready` | 可编辑 | 按 ready 规则处理 |
| commit 失败且服务端为 `committing` 或状态无法确认 | 锁定 | 锁定；重试继续服务端已保存的提交快照 |
| commit 失败且服务端会话缺失、未就绪或 prepare 已失败 | 锁定 | 退回未就绪失败规则，重试会重新创建会话并处理 |
| cancel 失败 | 锁定 | 锁定，只允许重新取消 |

未就绪任务重试时保留当前草稿、清单字段来源和原队列位置，但清除旧会话、MD5、重复项、处理结果与设备/明暗检测结果，从会话创建、传输和 prepare 重新开始；新的检测结果会替换旧值。重试不会自动重新读取窗口默认属性，管理员需要时应先点击“应用到全部”。commit 请求失败后，前端会查询服务端会话状态：仍为 ready 才重新开放属性，已经进入 committing 则锁定属性并继续同一提交，已经 finalized 则直接收敛为完成。

### 两种模式差异

| 项目 | 本地上传 | 链接下载 |
| --- | --- | --- |
| 会话表 | `import_session(mode=upload)` | `import_session(mode=download)` |
| 素材来源 | 浏览器 PUT `upload_url` | 服务器 POST `materialize_url` 后安全下载 `source_url` |
| raw 临时位置 | `data/tmp/<id>.raw.<attempt>` | `data/tmp/<id>.raw.<attempt>` |
| 最终图片 | 标准化后的 WebP | 标准化后的 WebP |
| 最终 MD5 | processed image | processed image |
| prepared 暂存 | `_uploads/<id>.<attempt>.image.webp` + `*.thumb.webp` | 同左 |
| 正式位置 | `media` + `thumbs` | `media` + `thumbs` |

URL 下载遵循 `link_image.fill_original_url`：开启时自动把输入 URL 写入 `original` 字段，不做可直达探测；微博生成的 JSONL 始终把提取到的原图链接写入 `original`。原图按钮点击时才探测直连可用性。外链图片请求超时由 `link_image.fetch_timeout_seconds` 控制，只覆盖 download 的 materialize 外部请求，不包含后续图片标准化、缩略图生成和存储写入。微博元数据请求使用独立的 15 秒请求与正文总期限，访客响应和帖子响应分别限制为 64 KiB 与 4 MiB；入库标准化参数位于顶层 `normalize`。单客户端 URL 队列并发位于 `link_image.concurrency`，服务端全局 URL materialize 与 prepare 分别复用 `link_image.global_concurrency`；微博单批 worker 数位于 `weibo.concurrency`，跨批次上游请求并发位于 `weibo.global_concurrency`。

## 原图链接与外链代理

详情弹窗的「原图」只在 `original` 字段存在且不同于展示图时显示，并先请求 `/api/images/:id/original`。后端也执行相同判断：`original` 为空、不是 `https` 或等于展示 URL 时返回 404。只有 `original` 指向另一个 HTTPS URL 时，后端才用当前浏览器 User-Agent、无 Referer、`GET + Range: bytes=0-0` 探测：可直接访问则 302 到原 URL，否则 302 到 `link.<域名>/original/:id`，由服务端带源站 Referer 转发。

公共原图接口只接受 `status=ready`。后台回收站的原图按钮显示规则与公开页面一致：只有 `original` 存在且不同于展示图时显示；deleted 行点击时走带鉴权的 `/api/admin/images/:id/original`，它允许回收站内的独立原图链接，但仍使用 `private, no-store`。回收站查看图片本体使用带鉴权的 raw/thumb 接口。

## 设备与明暗识别

导入与编辑统一使用三态分类：`device=auto` 表示使用按图片宽高检测出的 `pc` 或 `mb`，`brightness=auto` 表示使用标准缩略图按 CIELAB L\* 分布检测出的 `dark` 或 `light`；具体值表示人工选择。`auto` 是明确业务值，不再用空字符串表示。

不论创建任务时选择自动还是具体分类，prepare 都始终检测设备与明暗。导入会话的 `prepared_payload` 分别把检测真值保存为 `detected_device` / `detected_brightness`；它们只属于本次导入会话，不作为另一组永久图片元数据。prepare 完成后，前端把仍为 `auto` 的草稿显示值收敛为检测结果，同时单独保留检测真值，供 ready 阶段再次选择“自动设备”或“自动亮暗”时恢复。人工分类不会阻止检测，因此也能随时恢复自动结果。提交只把最终收敛后的具体分类写入 `metadata`。编辑已入库图片时选择自动则重新按当前图片和缩略图检测。

上传 / 链接导入窗口顶部的“应用到全部”遵循上面的阶段表。ready 卡片选择“自动设备”或“自动亮暗”时会恢复 prepare 保存的检测真值，并清除对应淡黄色偏离提示；选择具体设备或亮度则批量强制覆盖。ready 阶段的主题、作者和标签只有非空值才生效，标签使用追加语义。处理前的本地上传和普通 URL 则使用替换语义，允许管理员用空默认值清除尚未处理的主题、作者和标签；JSONL / 微博清单显式字段在该阶段保持不变。

## 随机图 API

```text
GET /random?d=&b=&t=&tag=&a=&m=
```

1. 校验参数并把主题、标签、作者别名解析为 slug。
2. 未指定设备时按 User-Agent 推断。
3. 按客户端与筛选签名做短时不重复。
4. 在 Redis generation 随机池中按 axis/category 计数加权选集合；标签和作者筛选通过 Redis 临时过滤集合完成。合法增量更新期间有界等待 completed revision；Redis 不可用或等待超时时返回带 `Retry-After` 的 503。
5. `m=proxy` 从图片所属存储后端代理字节，否则 302 到对象 URL。

参数细节见[随机图 API](./random-api)。

## 画廊浏览

```text
GET /api/images?d=&b=&t=&tag=&a=&cursor=&limit=&shuffle=
GET /api/images/:id
```

画廊筛选维度由 `/api/gallery-facets` 单独返回；图片列表按 `image_time DESC, id DESC` 使用 `/api/images` 游标分页与 Redis 缓存，响应只包含卡片数组 `items` 和继续分页所需的 `next_cursor`。卡片字段覆盖详情首帧展示所需的 `id`、缩略图 URL、标题、标签、主题、作者、设备、尺寸、图片时间和 `diff_original` 原图按钮标记。详情弹窗仍请求 `/api/images/:id`，但只补充 `id`、展示图 URL、描述和来源，不重复返回列表已有字段，也不返回对象键、存储后端、MD5、扩展 JSON 等后台 / 内部字段。浏览器存在登录 hint 时，公开详情会直接请求 `/api/admin/images/:id/admin-info` 获取 `md5`、`created_at`、`updated_at` 与后端算好的 `storage_label`，用于补充 UUID、MD5、存储后端、导入时间和更新时间；图片时间继续复用列表项已有的 `image_time`。若该轻量接口返回 401，则清除 hint 并保持普通访客展示。列表、详情、facets、后台概览、MD5 与对象 lookup 共用一个图片缓存 revision；读请求先捕获 revision，回源后只有 revision 仍相同才写入。图片写操作先推进 revision，Redis 无法确认时本实例保持冷读，避免旧查询在失效之后回填成新缓存。原图直连探测另按原图 URL 和浏览器家族使用短 TTL，失败时回退到 link 子域代理。`shuffle=1` 只在出口打乱当前批次，不影响游标和共享缓存。Redis 缓存 miss 时，同进程内会合并相同 key 的并发查询，避免冷启动或失效瞬间重复打 PostgreSQL。

## 后台管理

- 后台图片列表通过 `/api/admin/images?status=&d=&b=&t=&tag=&a=&cursor=&limit=`
  读取 PostgreSQL，可按设备、亮度、主题、标签和作者筛选；主题、标签和作者与公共
  画廊保持相同的显示名解析及包含 / 排除语义，列表、总数和游标分页共用同一组条件。
  桌面宽屏单排按设备、亮度、主题、标签、作者 `1:1:1.5:2.5:1.5` 分配，并以
  1920px 全屏时的管理内容宽度为增长上限；中等桌面改为两排，第一排设备、亮度、
  作者为 `1:1:1.5`，第二排主题、标签为 `1:2`，各控件保留原有最小宽度。
  “无主题”页固定使用 `t=none`，界面仍显示但禁用主题筛选；移动端筛选默认折叠，
  展开后以浮层覆盖列表而不挤压下方空间，仅用户开合时播放 `80ms` 过渡，跨越桌面 /
  移动断点时立即归位；短屏横向视口中浮层居中、可内部滚动，并提供固定可见的收起
  入口。触控、点击、键盘焦点和滚动只要发生在筛选区域及其弹出菜单之外就会收起；
  筛选内部操作保持展开，但不复用公共画廊按页面滚动方向和距离自动隐藏工具栏的
  逻辑。锚定菜单开始关闭前会先移走 Portal 内焦点，避免把仍含焦点的子树标记为
  `aria-hidden`；减少动态效果偏好会禁用该过渡。图片、主题、标签和作者等分页管理
  列表的滚动视口统一延伸到管理区最右侧，卡片仍保留原有右侧留白；
- 图片列表、编辑、批量操作、回收站、存储迁移；图片管理员可以进行常规元数据编辑、
  移入回收站、单张与批量恢复，单张及批量迁移存储、回收站单张永久删除和清空
  回收站只对超级管理员显示，并由服务端再次强制校验；
- 标签、主题、作者、用户、设置、检查与账户设置；图片管理员可以查看、新建、编辑和
  排序标签、主题及作者；这些实体不提供批量删除，单项删除只对超级管理员显示，
  并由服务端按实体的独立删除权限再次强制校验；检查页的数据库、存储、Redis、
  回收站和全部五项检查
  对所有管理员开放，迁移存储后端与清理无效存储只对超级管理员显示，并由服务端
  按独立操作权限再次强制校验；
- 存储检查比对数据库与实际后端，并将 `_uploads` 明确分成仍有未过期导入会话引用的有效暂存与不再被引用的失效暂存；只有失效暂存和其他孤儿对象属于待处理问题。检查不持有维护锁，因此会在枚举存储对象前后各读取一次有效导入会话与 metadata，并将两轮引用取并集用于孤儿判断，降低并发导入期间的瞬时误报；
- 清理无效存储只删除失效暂存和其他孤儿对象。有效暂存、回收站图片及其他仍被数据库引用的对象都会保留；有效暂存会在结果中附带会话状态、过期时间与保留原因。响应分别统计候选、已删、保留、失败和回收的空目录，只有删除失败需要警告；
- 应用设置写 `config.json`，存储后端与密钥写 PostgreSQL。物理布局变更在独占位置锁内重新检查全部图片、全部未清理导入会话、未解决 `move.cleanup` 和一次 `_uploads` 快照，任一存在即拒绝；S3 Endpoint 可在同一独占锁内通过新旧 `_uploads` 快照、既有对象的有界 Range 读取和双向随机挑战证明为同一命名空间别名，成功后合并全部相交后端的 identity 集合。显示名、启停、默认项和排序只刷新注册表快照；凭据、region、path-style、公开 URL、超时等 driver 访问参数在独占位置锁内完成验证、保存和旧 driver 退役，避免打断并发存储操作。

## 后台操作反馈区域

按钮内四态反馈只用于同时满足以下条件的操作：触发按钮会持续可见、成功没有被新内容
或页面状态直接表达、失败后仍适合从同一按钮重试。读取、保存、连接测试等属于这类
操作。`AsyncActionButton` 会把空闲、进行中、成功和失败文案叠放在同一 Grid 单元，
按钮宽度由最长文案一次确定；快速操作的进行态至少展示 500ms，需显示的结果保留三秒，
成功状态仍允许再次点击。

如果新卡片出现、卡片消失、弹窗关闭或进入下一确认步骤已经明确表达成功，按钮不再
额外停留成功态。实体和管理员新建只显示至少 500ms 的进行态，成功由新卡片表示，重复
slug 或用户名在对应字段旁提示；确认操作成功后关闭弹窗，失败才留在确认按钮供重试。
存储后端删除成功由卡片消失表示，失败进入存储页区域。标签、主题和作者创建接口对
重复 slug 返回 409，不再用创建请求覆盖已有实体。

图片卡片的单张删除/恢复只提供固定尺寸图标按钮，若在按钮内加入结果文字会破坏紧凑
卡片，因此其简短结果与批量结果、拖拽排序、下拉选择和页面加载等反馈仍由页面或功能
父组件持有。后台壳层只提供区域注册上下文和视口右上角降级宿主；实体、存储和日志页
通过稳定页头网格声明区域。图片页在桌面端把区域放在右侧操作组首项，使卡片右边缘
紧贴密度切换且只消耗其左侧剩余空间；移动端把同一区域放在标题右侧。完整配置编辑器
保留卡片区域，承载没有可见按钮时的首次读取或外部刷新失败。用户管理、站点配置和
配置包导入窗口不再为按钮绑定操作注册独立区域。

消息目标使用实例对象而不是 CSS 选择器或全局名称。区域挂载时注册、卸载时注销；
目标缺失时消息进入统一降级宿主，目标重新出现后自动迁回。`ActionFeedback` 本身只
负责 `pending | info | success | error` 展示、三秒终态倒计时、悬停或键盘聚焦暂停和
手动关闭，不读取页面 DOM，不监听全局 resize / scroll，也不观察节点变化。文档流内的
单行反馈固定为 36px，高度不随长文案改变；超长文字视觉省略并通过完整 `title` 保留，
不参与页面按钮、标题或编辑区的重新排版。短文案在各视口按内容收敛宽度，出现与消失
只使用快速淡入淡出，不产生位移或缩放。

后台操作失败与管理页查询失败只在页面显示简短中文提示，原始错误名、消息、堆栈、
页面路径和操作者通过已鉴权的客户端错误入口写入应用 `ERROR` 日志。日志入口会限制各
字段长度；若日志请求本身失败，浏览器控制台仍保留原始异常，且不会递归生成新提示。
日志页按错误指纹在 60 秒窗口内去重自身查询失败，避免轮询失败形成重复上报循环。

字段校验、查询错误、图片批量操作进度、批量编辑汇总、上传 / 导入任务状态和检查结果
仍由原业务组件在原位展示。批量编辑逐项失败在页面只显示图片短 ID 与中文摘要；同一
批次只写一条聚合错误日志，最多携带 20 种错误码计数和 5 个样例，每条样例消息截断为
160 字符，整段客户端 metadata 仍受 2 KiB 上限保护。即使 200 项同时失败，也不会产生
200 次日志请求或无界载荷。

## 图片编辑与换分类

只改标题、描述、来源、原图 URL 或作者时不搬对象。修改设备、明暗或主题时进入该图的
存储 mutation lock，并在锁内重新读取数据库真值；自动分类也基于这份新快照重新检测。
服务端先流式校验源对象，复制候选原图 / 缩略图并回读验证；media 还要匹配数据库 MD5。
事务内以旧位置和分类做 CAS 更新，提交后才删除旧对象；CAS 失败或事务回滚只清理本次
创建的候选，已存在且内容一致的目标不属于本次补偿范围。显式设置非 none 主题时先取得
theme slug 锁，再取得
图片位置锁；主题删除使用相同顺序，避免互相等待。所有影响随机筛选的变更都会同步
Redis 随机池。

批量编辑只提交实际发生变化的图片和字段；服务端拒绝重复图片 ID、没有 metadata/tags 的空更新项，以及去重后仍超过上限的 tags。不同图片以固定低并发 2 执行，同一图片仍严格保持 metadata 后 tags 的顺序；分类与对象路径变化继续服从存储 mutation lock，不使用覆盖整批的长事务。单项失败不会阻止后续图片，响应包含 `updated`、`failed` 和与请求同序的 `results`；请求数量可由请求项或两项统计直接得出，不重复返回。前端保存后移除成功项、保留失败项草稿并显示 ID 与公开错误信息，再次保存只提交失败或仍有变化的图片。

metadata 与 tags 各自提交后只登记派生状态修复计划；批量更新调用不构造无人使用的完整单图 presenter，避免 metadata 后额外查询一次标签。整个批次完成数据库 / 存储步骤后，再把所有已提交图片合并为一次 `syncRandomImages()`、一次图片读缓存 revision 推进、一次 MD5 批量失效和一次 lookup 精确失效。即使 metadata 已成功而 tags 失败，该图片仍在最终修复计划内。新建 theme、tag、author 的词表及时刷新；实体写操作统一按 slug 锁串行，并按“随机池 → 词表 / 计数 → 图片缓存 revision”顺序修复派生状态。实体计数缓存由并发安全的批处理收集器汇总，在批次末尾统一失效。单图编辑向同一端点提交一项。

## 删除生命周期

1. 软删把图片标为 `deleted`、重置彻底删除认领状态并从 Redis 随机池移除，原图 / 缩略图留在原位。
2. 恢复只接受 `purge_state=idle`，更新数据库状态并重新加入 Redis 随机池，不搬字节。
3. 彻底删除先用 `FOR UPDATE SKIP LOCKED` 把行认领为 `purging` 并增加尝试号，再进入该图的存储 mutation lock。锁内重新核对状态、尝试号与对象位置；原图和缩略图的 driver DELETE 返回后均重新确认对象不存在，只有两者都确认清除，才以同一尝试号和位置条件删除 metadata。
4. 删除失败标为 `failed` 并保留错误，可安全重试；崩溃遗留的过期 `purging` 可由新尝试重新认领，旧执行者的令牌无法覆盖新结果。
5. 清空回收站的 HTTP 请求最多认领一个 `trashBatchSize` 批次并返回 `deleted`、`failed`、`remaining`；有剩余时创建独立的持久化 `trash.purge` 任务，后续批次交给 Worker。即使已有同类任务正在收尾，本次唤醒也不会被运行中任务的幂等冲突吞掉。

公共 static/link 路由拒绝 deleted 图片；后台 `/api/admin/images/:id/raw|thumb|original` 经鉴权提供回收站查看。软删无法撤回浏览器/CDN 已缓存副本，安全级吊销需彻底删除并清 CDN。

## 后台 Worker

Worker 用 `FOR UPDATE SKIP LOCKED` 领取持久任务，按任务类型限制并发。通用 `jobs` 仓储只管理领取、重试、僵尸恢复和历史裁剪，图片、导入与存储领域各自拥有 handler 和结果语义，小型注册表只负责类型分派。每次 tick 先运行到期的僵尸恢复、过期导入调度和历史裁剪，再并行给每个可运行任务类型一个最多 50 项 / 2 秒的时间片；慢队列不能无限占住 tick。调试日志记录各类型 backlog、最老等待时间、处理数、耗时和预算是否耗尽。存储孤儿清理与物理位置变更使用独占位置锁；导入会话创建、prepared 暂存写入、commit、取消及过期暂存清理持有共享位置锁，commit、分类移动、主题重分配、存储迁移与彻底删除还会取得对应单图锁。物理位置变更因此能在锁内检查全部会话、暂存对象和未解决 `move.cleanup`，不会把旧位置文件变成孤儿，也不会让旧清理任务跟随可变 slug 删除新位置。人工存储清理会保留 UUID 仍存在于任意图片或导入会话的 media / thumbnail，并保留属于任意尚未删除会话的 `_uploads`；这些对象分别交由单图清理任务或 `import.cleanup` 处理，只直接删除已无 PostgreSQL 所有者的孤儿。

确定性任务幂等键只压制执行中或仍可重试的任务；运行中的 `move.cleanup` 再次入队会留下 rerun 标记，当前 handler 成功后同一记录重新变为 `pending`。成功、忽略和耗尽失败记录允许原地重置为 `pending`。清理 payload 无效或 DELETE 后无法确认对象消失都会作为失败持久化，不会被 handler 静默忽略。已完成 / 已忽略任务保留 7 天后按批删除，普通耗尽失败任务保留 90 天；带 `retain_exhausted` 的耗尽 `move.cleanup` 不会被历史裁剪自动解除保护，可在存储管理页按后端重新排队。对象已经由运维人工清除时，重试核验不存在后自然完成。

## 高级配置编辑与迁移

「设置 → 高级配置」主体是当前实例完整 `config.json` 编辑器。浏览器先解析 JSON，
服务端再按精准 schema 做只读预检并比较访问地址变化；用户确认后，保存接口会在
共享配置写锁内重新校验，原子替换文件和内存快照。监听端口由代码固定，
PostgreSQL 与 Redis 连接只从部署环境读取，均不进入编辑器；Docker healthcheck
与主进程共享监听端口常量，应用配置通过既有监听器热加载。

「设置 → 高级配置」通过版本化 JSON 包迁移可移植运行时配置及自定义存储
后端，不搬运数据库业务数据、缓存、图片对象或新实例自己的连接与域名配置。

```text
导出：当前配置 + 自定义存储注册表
        └─► 排除基础设施字段与内置 local
             └─► imageshow-config v2 JSON（含完整存储凭据）

导入：选择 JSON
        └─► 严格校验格式、版本、配置和后端数量
             └─► 预检当前 slug
                  ├─ 无冲突：保留原 slug
                  └─ 有冲突：要求输入新 slug
                       └─► 再校验当前注册表
                            └─► 原子写配置文件 + 单事务新增后端
```

同 slug 永不覆盖现有后端。完整配置保存与配置包应用共用 PostgreSQL advisory
lock 串行执行，避免并发写入互相覆盖配置快照。存储后端事务使用持有该 lock 的同一
数据库会话；导入时先保存运行时配置快照，在事务提交前原子写入配置文件。进程内全部
运行时配置写入口共用一条写租约，导入会持有租约直到事务结果确认与补偿结束。普通错误
会回滚数据库事务，并按本次写入的精确 revision 恢复快照；提交回包不确定时使用事务
自身的 xid8 receipt 查询 PostgreSQL 状态，不根据可被后继修改的业务行猜测。无法确认
时保留候选配置供管理员核对。若导入包把某个自定义后端标为默认，成功后会在映射后的
slug 上恢复默认状态。

配置文件和 PostgreSQL 不能组成真正的跨资源事务。配置文件写入后的极小窗口内若
进程遭遇 SIGKILL、容器崩溃或主机断电，可能出现配置已更新但数据库事务已回滚。
管理员需要人工恢复导入前的配置文件，或检查存储后端注册表后重新导入配置包。

## 缓存策略

PostgreSQL 18 是真相源，Redis 8 是可丢弃的加速层：随机池、画廊筛选、公共列表、公开详情、后台实体计数列表、导入词表、后台概览、原图直连探测、MD5 判重与对象键 / 缩略图键 / 图片 id lookup 走缓存。任意筛选与游标组合按需缓存，并用进程内 `coalesce()` 合并同一 key 的首次回源。随机池与图片读模型使用独立代际：前者在 `imageshow:random:<generation>:*` 命名空间按 generation / mutation revision 发布；后者把列表、详情、facets、概览、MD5 与 `imageshow:image_lookup:*` 统一放入 `image_cache_revision`。正常写入在落 Redis 前复核 revision，失效时先推进 revision。随机标签 / 作者筛选的空结果使用短 TTL 哨兵，避免 Redis 空 set 消失后重复物化；过滤集合先写不可见候选键，Lua 在缓存读取和发布候选时都要求 mutation revision 不变、completed revision 已追平且增量锁不存在。若增量锁仍存在，读取方最长等待约 3 秒并使用退避抖动；超时返回带 `Retry-After` 的临时 503，不立即触发全量重建。

主题、标签和作者的词表与带 `image_count` 的后台列表分开加载。图片导入、归属编辑、删除和恢复只将实际受影响的计数列表标为 dirty；同一列表在下一次成功回源前只发送一次 Redis 删除。后台列表 miss 时按实体类型 `coalesce()` 单飞查询 PostgreSQL。批量编辑使用一个请求、派生状态协调器和显式失效收集器，在全部图片处理后统一同步；实体 slug、显示名、排序或作者链接变化时才刷新对应词表并失效 gallery facets。

lookup 使用 `HSETEX` 在单条命令中原子写入一个或多个字段值及其 TTL，字段 TTL 当前为 6 小时。lookup hash 名称包含图片 revision，并严格校验缓存值的当前字段。随机池全量和增量同步不预热 lookup，公开列表、详情或资源接口 miss 时才从 PostgreSQL 回源并回填。图片写路径先推进统一 revision，再批量删除前一 revision 中受影响图片的 id、对象键和缩略图键字段；主题迁移与存储迁移同样收集精准 lookup 项。Redis 失效失败时，本实例的 dirty fence 让所有 revision 读保持 miss 并禁止回填，直到能够成功推进 revision；lookup JSON 损坏时资源出口仍可回退 PostgreSQL。

随机 API 的正常路径依赖 Redis 随机池。全量重建在 PostgreSQL repeatable-read 快照中按每批 500 条只读取所需字段，并把批次序列化载荷保存在受控内存中；累计超过 16 MiB 时自动切换到 `data/tmp` 下随机命名、权限受限的 NDJSON spool。数据库提交后才校验并逐批读取内存 / spool 写 Redis generation，因此 Redis 网络等待不会占用数据库快照事务。spool 限制单批与总文件大小，核对批次数、条目数和文件字节数，并在成功、失败、优雅退出和下次启动时清理。全量与 `syncRandomImages` 共用 mutation revision；Lua 只在 revision 未变化时原子发布 generation，失败 pipeline 定向清理未发布 generation 或设置 TTL，不会删除当前及有效历史 generation。增量更新锁使用 token 所有权、30 秒租期和每 10 秒续租；completed revision 的 Lua 同时校验 generation、mutation revision 与锁 token，锁丢失时只排队全量重建。

批量图片编辑和批量存储迁移写结构化摘要日志，只包含请求 / 成功 / 失败数量、
总耗时、最大单项耗时、请求体字节数、是否触发实体计数失效和是否触发随机池全量
重建。导入会话按 lane 逐项创建，不构造整批请求或整批日志。日志不包含 URL、标题、
描述、source/original、标签明细、请求体、Cookie 或凭据。

HTTP 缓存按 CDN 友好但不泄露私有数据分层：

- `/assets/*` 的 Vite 构建产物和稳定的 `/media/*`、`/thumbs/*` 图片对象使用一年 `immutable`；`/assets/brand/*`、`/favicon.ico` 不是 hash 路径，只给短浏览器缓存和较长 CDN 缓存。构建会为可压缩静态文本生成 Brotli / gzip 版本，服务端按 `Accept-Encoding` 选择并附带 `Vary`，同时支持 ETag / Last-Modified 条件请求。前端分块遵循 `公开基础层 ⊂ 图片管理员层 ⊂ 超级管理员层`：公开入口不加载后台基础块，图片管理员入口不加载仅超级管理员页面的实现；纯通用机制和跨后台页面的小控件分别合并为全站基础块与后台基础块，路由专有实现仍按实际入口集合精确拆分。后台页面专属样式只在首次进入对应页面时加载，公开图片详情中的管理信息只在后台详情或已有管理员会话提示时加载，批量迁移存储对话框也只为拥有权限且表达操作意图的超级管理员预取。同一会话复用已解析模块，完整刷新则复用带 hash 的 immutable 资源。部署后旧会话若引用已失效的 hash 资源，路由错误边界会保留外层界面并提供整页重载。静态出口与图片字节出口共用单段 Range 语义，包括后缀范围、不可满足范围的 416 以及 `If-Range`；静态 206 的 ETag 使用完整表示长度，因此不同 Range 与完整响应共用同一验证器。`If-None-Match` 实体标签列表按 quoted opaque-tag 解析，标签内逗号不会被误拆。存储后端的公开 URL 可能被管理员修改，因此指向该 URL 的 302 只短期缓存；缩略图缺失时临时回退原图也不使用 immutable。
- `/api/images`、`/api/images/:id`、`/api/site-config`、`/api/gallery-facets` 与 `/img-count` 是公共动态数据：浏览器不持有，CDN 的新鲜、重验证和错误兜底窗口均不超过 30 秒。SPA HTML 使用由完整文档内容生成的 ETag 和 `max-age=0` 重验证，匹配 `If-None-Match` 时返回 304；文档站 HTML 保持独立短缓存策略，不与动态 API 共用时长。
- `/random` 和 `random.<域名>` 永远 `no-store`，避免 CDN 把随机图固定成同一张；每次请求都会重新抽图，因此 proxy 响应不声明 `Accept-Ranges`。
- `/api/admin/*`、登录 / ALTCHA 挑战 / 上传暂存预览 / SSE、后台图片字节、健康检查和错误响应使用 `no-store` 或 `private, no-store`，不应被 CDN 缓存。
- `link.<域名>/original` 公共代理成功响应优先继承源站 `Cache-Control` / `Expires`；源站未声明时使用站内 CDN fallback：浏览器缓存 1 天、共享缓存 1 年，并允许 stale 回源兜底。后台原图代理仍为 `private, no-store`。

公共 API 的缓存响应按 `Sec-Fetch-Site` 分变体，所有 API 按 `Accept-Encoding` 分变体。动态压缩读取不超过 1 KiB 的响应前缀决定是否压缩，避免完整缓冲大响应。本站静态 / link 子域直接输出的存储图片带 `Content-Length` 和内容或对象版本 ETag；有可靠验证器时支持正确的 304，单段 Range 使用同一完整对象验证器并按强 ETag 或日期处理 `If-Range`。多段或不可满足的 Range 返回带对象总长度的 416；WebDAV 忽略 Range 时按流跳过并截取所需区间，不缓冲完整对象。

推荐 Nginx 配置面向当前 stable 1.30.3，不重复声明其默认 HTTP/1.1 / keepalive，也不重复实现应用缓存；它只负责 TLS、HTTP/2、转发头，并为导入 / SSE 与长时间检查路径关闭请求缓冲或放宽超时。若需要共享 HTTP 缓存，优先让外部 CDN 遵循 Hono 返回的 `Cache-Control` 与 `Vary`。
