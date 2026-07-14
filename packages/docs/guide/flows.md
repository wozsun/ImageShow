# 功能与流程

本页描述 ImageShow 的主要端到端流程。底层表结构见[数据库结构](./database)，组件边界见[项目结构](./project-structure)。

## 三种图片导入模式

三种模式共用一个 `ImportJob` 队列、任务卡片、元数据编辑、最终 MD5 判重、SSE 状态推送、取消/重试和批量提交界面。底层统一为 `import_session`：`mode=upload` 保存浏览器上传文件，`mode=download` 由服务端下载并保存，`mode=proxy` 只保存缩略图与外部链接。前端 `attemptKey` 只负责幂等和防旧请求污染，最终会话 / 图片 UUIDv7 由服务端按 `image_time` 生成：当前时间 ID 直接使用 Node.js 原生 UUIDv7，历史图片则保留原生随机位并替换 UUIDv7 的 48 位时间戳。会话创建时写入 `request_hash`，同一 `idempotency_key` 只有在模式、URL、大小、存储后端、规范化图片时间、JSONL 临时清单位置和初始元数据摘要一致时才复用。

```text
模式 1：本地上传

File ──► 立即创建卡片 + blob: 临时预览
     └─► 创建 import_session(mode=upload，锁定 storage_slug）
          └─► PUT 原始字节
               └─► data/tmp/<id>.raw
                    └─► transcodeStoredImage()
                         ├─ 校验格式、尺寸
                         ├─ WebP < 阈值且尺寸达标：跳过转码
                         ├─ 否则缩放、WebP 编码、按体积逐级降质量
                         ├─ 生成标准缩略图、确认或识别设备与明暗
                         └─ 计算最终 md5 / size / ext
                              ├─► <锁定后端>/_uploads/<id>.image.webp
                              └─► <锁定后端>/_uploads/<id>.thumb.webp
                                   └─► ready：切换为最终预览，允许编辑/提交

模式 2：链接下载

URL ──► 立即创建卡片
    └─► 创建 import_session(mode=download，锁定 storage_slug/source_url）
         └─► 服务端限时、限大小、安全下载图片
              └─► data/tmp/<id>.raw
                   └─► 与本地上传相同的 transcodeStoredImage()、staging、ready、commit

模式 3：代理链接

URL ──► 立即创建卡片
    └─► 创建 import_session(mode=proxy，锁定缩略图 storage_slug/source_url）
         └─► 服务端安全下载一次用于校验、MD5、尺寸、明暗确认和缩略图
              ├─► <锁定后端>/_uploads/<id>.thumb.webp
              └─► ready：编辑/提交
                   └─► metadata.object_key = URL、is_link=true
                        + <锁定后端>/link/<分类>/<id>.webp
```

### URL 列表与 JSONL 清单

链接导入按钮提供 URL 列表和 JSONL 清单两种输入方式，二者最终都进入上面的 download / proxy 生命周期。URL 列表按 `link_image.url_list_max_items` 限制单次输入数量，保持原有逐 URL 导入体验，`image_time` 由后端使用会话创建时间。JSONL 每行一个对象，正式字段为 `original`、`source`、`image_time`、`author`、`tags`、`mode`、`title`、`description`、`theme`、`device`、`brightness`、`storage_slug`；`original` 同时作为下载 URL 和元数据原图 URL，`source` 仅表示来源页面。

JSONL 先请求管理端解析接口，服务端按 `link_image.jsonl_max_items` 限制数量、逐行严格校验并规范化 `image_time`。合法行才创建 `ImportJob`，错误行保留行号、截断后的原文预览和错误原因。字段优先级为“JSONL 行内字段 > 应用到全部默认值 > 系统默认值”；行内 `tags: []` 是显式空标签，不合并默认标签。JSONL 任务默认跳过重复图：判重发生在 prepare 完成并取得转码后最终 MD5 之后；图库重复会显示已有图片的缩略图、标题和分类，点击进入图片详情。JSONL、普通 URL 和代理链接在批内重复时均显示首个任务的转码结果、`original`、JSONL 行号（若有）和分类，点击打开该处理结果预览；随后重复任务立即 cancel 会话、清理自身暂存并记为“已跳过”，不会进入 commit。普通 URL 和代理链接与图库已有图片重复时仍等待用户确认，本地上传的重复处理不变。批内首个任务的预览若在提交后切换为持久图片地址，重复卡片会同步更新；清除首个已完成任务时仍保留该持久快照，提前移除未完成的首个任务则把重复卡片标为不可预览。

解析接口还会按非空记录生成从 0 开始的临时清单位置，普通 URL、代理
URL 和本地批量文件也会按各自经过校验、去重后的输入顺序生成批内位置。
服务端把位置直接写入 UUIDv7 的 `rand_a`，因此现有
`ORDER BY image_time DESC, id DESC` 在 `image_time` 相同时会让靠后的输入
排序更新。`image_time` 始终拥有更高优先级；该位置不写入数据库字段，也
不保证跨批次相同时间的人工顺序。JSONL 和 URL 单批默认上限 100，低于
`rand_a` 的 4096 个可用位置。

`image_time` 的带偏移 ISO 8601 输入由原生 `Temporal.Instant` 解析；`YYYY-MM-DD HH:mm:ss` 无偏移输入由 `Temporal.PlainDateTime` 按运行时 `TZ` 转为瞬时时间。夏令时跳跃造成的不存在时间或回拨造成的歧义时间都会被拒绝，不依赖 `Date` 的隐式本地时间解析。

prepare 完成后会删除 `data/tmp` 下的 raw 文件；失败、取消和过期清理同样删除 raw 与 `_uploads` 候选对象。清理只匹配 UUID 形态的 `.raw` / `.raw.part` 文件，避免误删其他临时内容。导入会话空闲有效期为 30 分钟；接收、排队、prepare 与 commit 期间会周期性续租 `expires_at`，取消标记和孤儿 raw 清理年龄也使用同一有效期。后台清理用 `FOR UPDATE SKIP LOCKED` 原子认领真正空闲过期的会话，不处理 `committing`。原始上传/下载字节从不写入 S3、WebDAV 等目标后端，因此不存在“先远端上传原图、再下载回来压缩”的重复传输。服务端按 `upload.global_concurrency` / `link_image.global_concurrency` 对 prepare 做进程内全局限流，防止绕过前端队列直接并发压垮进程；触发全局等待时会通过状态消息显示“服务端全局处理名额已满，等待空闲名额”。commit 则独立使用 `import.global_commit_concurrency`，在取得会话锁和数据库连接之前排队，所有客户端与直接 API 请求共享上限。

### prepared import 状态机

```text
created
  ├─► receiving（本地：接收上传；下载保存：服务端下载）
  │    └─► preparing（校验 / 转码 / 缩略图 / 最终 MD5）
  └─► preparing（代理链接：探测外链 / 生成缩略图 / 最终 MD5）
            └─► ready（可编辑、可提交）
                 └─► committing（只搬候选对象并写数据库）
                      └─► finalized

任一 prepare 阶段 ─► failed
可取消阶段         ─► cancel + 删除会话、raw、processed、prepared thumbnail
```

每个任务在创建会话时锁定 `storage_slug`。之后修改全局默认存储只影响新任务；ready 任务不支持换后端，commit 必须使用会话中的后端。

### prepare 与 commit 的职责

prepare 承担所有重处理：

- upload/download：原始流精确大小限制与服务端本地落盘；
- download/proxy：外部 URL 只允许 `https` 且必须使用域名，不接受直接 IP；每次请求和重定向后都会校验主机解析结果，禁止 localhost、内网、链路本地、组播和云 metadata 等受限地址，并依赖运行时 TLS 验证确认证书有效，再通过内容嗅探确认返回的是支持的图片格式；安全拒绝对外统一返回通用提示，内部 debug 日志保留拒绝原因；
- upload/download：图片解码校验、长边约束、可选 WebP 转码与体积控制；
- 三种模式：标准缩略图、最终预览、设备/明暗确认；
- upload/download 基于最终候选字节计算 `metadata.md5`；proxy 基于外部原图字节计算 `metadata.md5`；
- upload/download 把 processed image 和 prepared thumbnail 写入锁定后端的 `_uploads`；proxy 只写 prepared thumbnail。

commit 不重新下载、不重新转码，也不从远端读回候选文件：

1. 会话 advisory lock 防止并发重复提交；
2. upload/download：`_uploads` 中 processed image 复制到 `media`，prepared thumbnail 复制到 `thumbs`；proxy：prepared thumbnail 复制到 `link`；
3. 短事务写 `metadata`、标签关联与会话最终状态；
4. 事务成功后清理 `_uploads` 候选对象；
5. 更新标签词表、随机池和读缓存；事务后的派生缓存操作可幂等重试。

单个后台页面用 `import.commit_concurrency` 并发调用 commit，服务端再用 `import.global_commit_concurrency` 统一限流。全局许可覆盖上述完整流程，任务成功、失败或请求在排队阶段取消都会释放名额。

对象提交具有幂等检查和异常补偿：若目标对象已存在，重试会复用；若正式对象已经复制但数据库事务失败，会 best-effort 删除本次复制出的 `media`、`thumbs` 或 `link` 对象，减少孤儿文件。

### 前端队列与判重

- 选择本地文件后立即加入卡片，本地 `objectURL` 只用于 prepare 前临时预览；切换为服务端最终预览时立即 revoke。
- 队列状态优先走 SSE 实时推送；SSE 连接失败或断开后才降级为 2 秒一次的批量状态轮询，轮询按当前未完成任务集合合并请求，不按单卡片单独轮询。
- 前端不读取整文件计算 MD5。批次内的预筛只用 `name + size + lastModified + webkitRelativePath`，浏览器拿不到完整路径时不依赖路径。
- 服务端返回最终 MD5 后，队列以同步 reservation 防止并发 prepare 的两张相同图片同时通过批内判重，再查询图库已有项。
- 卡片区分等待、上传/下载、处理、已就绪、提交、完成、跳过、失败、取消；显示存储后端显示名、处理前后像素尺寸、处理前后体积、质量或短路状态、失败原因及取消/重试。窗口统计固定分成“任务 / 处理中 / 待提交”和“成功 / 跳过 / 失败 / 重复待确认”两行。
- “清空已完成”只移除成功提交的卡片，跳过项会继续保留以便核对重复信息；清空未提交、清空重复待确认、取消单项会先调用后端 cancel，再移除卡片，本地 XHR、下载请求和代理准备请求也会中止。

### 三种模式差异

| 项目 | 本地上传 | 链接下载 | 代理链接 |
| --- | --- | --- | --- |
| 会话表 | `import_session(mode=upload)` | `import_session(mode=download)` | `import_session(mode=proxy)` |
| raw 临时位置 | `data/tmp/<id>.raw` | `data/tmp/<id>.raw` | 不保存 raw |
| 最终原图 | 标准化后的 WebP | 标准化后的 WebP | 不保存，保留 URL |
| 最终 MD5 | processed image | processed image | prepare 时下载的远程原图 |
| prepared 暂存 | `_uploads/*.image.webp` + `*.thumb.webp` | 同左 | `_uploads/*.thumb.webp` |
| 正式位置 | `media` + `thumbs` | `media` + `thumbs` | URL + `link` 缩略图 |
| 数据库标记 | `is_link=false` | `is_link=false` | `is_link=true` |

两种 URL 模式都遵循 `link_image.fill_original_url`：开启时自动把输入 URL 写入 `original` 字段，不做可直达探测；原图按钮点击时才探测直连可用性。外链图片请求超时由 `link_image.fetch_timeout_seconds` 控制，只覆盖下载和代理准备阶段的外部请求，不包含后续图片标准化、缩略图生成和存储写入。入库标准化参数位于顶层 `normalize`；单客户端 URL 队列并发位于 `link_image.concurrency`，服务端全局 URL prepare 并发位于 `link_image.global_concurrency`。

## 原图链接与外链代理

详情弹窗的「原图」只在 `original` 字段存在且不同于展示图时显示，并先请求 `/api/images/:id/original`。后端也执行相同判断：`original` 为空、不是 `https` 或等于展示 URL 时返回 404。只有 `original` 指向另一个 HTTPS URL 时，后端才用当前浏览器 User-Agent、无 Referer、`GET + Range: bytes=0-0` 探测：可直接访问则 302 到原 URL，否则 302 到 `link.<域名>/original/:id`，由服务端带源站 Referer 转发。

公共原图接口只接受 `status=ready`。后台回收站的原图按钮显示规则与公开页面一致：只有 `original` 存在且不同于展示图时显示；deleted 行点击时走带鉴权的 `/api/admin/images/:id/original`，它允许回收站内的独立原图链接，但仍使用 `private, no-store`。回收站查看图片本体使用带鉴权的 raw/thumb 接口。

## 设备与明暗识别

导入与编辑统一使用三态分类：`device=auto` 表示按图片宽高落到 `pc` 或 `mb`，`brightness=auto` 表示在标准缩略图上按 CIELAB L\* 分布判断 `dark` 或 `light`；传入具体值则视为用户已明确指定，服务端不再重新识别。

本地上传默认把设备与明暗设为自动，不再从文件名推断旧索引格式。prepare 完成后，卡片中的“识别中”会替换为服务端识别结果。导入会话的 `prepared_payload` 保存 `resolved_device` / `resolved_brightness`，它们是 prepare 阶段把用户选择或自动识别结果收敛后的兜底分类；提交时只有最终元数据仍为 `auto` 才会使用它们。编辑图片时可把设备改为“自动设备”，服务端按当前图片宽高重新落到 `pc` 或 `mb`；重新识别明暗同样复用缩略图。

上传 / 链接导入窗口顶部的“应用到全部”会让设备 / 亮度遵循当前顶部选择：保持“自动设备”或“自动亮暗”时，已就绪卡片恢复为 prepare 阶段保存的自动识别结果，并清除对应淡黄色偏离提示；选择具体设备或亮度时则批量强制覆盖。主题、作者和标签按顶部填写值覆盖已有卡片。JSONL 行内显式提供的设备、亮度、主题、作者或标签是锁定值，不会被后续“应用到全部”覆盖；未提供的字段仍可应用窗口默认值。

## 随机图 API

```text
GET /random?d=&b=&t=&tag=&a=&m=
```

1. 校验参数并把主题、标签、作者别名解析为 slug。
2. 未指定设备时按 User-Agent 推断。
3. 按客户端与筛选签名做短时不重复。
4. 在 Redis generation 随机池中按 axis/category 计数加权选集合；标签和作者筛选通过 Redis 临时过滤集合完成。Redis 不可用时随机 API 返回 503。
5. `m=proxy` 代理字节，否则 302 到对象 URL。link 图片的 URL 指向 `link.<域名>/media/<id>.<ext>`。

参数细节见[随机图 API](./random-api)。

## 画廊浏览

```text
GET /api/images?d=&b=&t=&tag=&a=&cursor=&limit=&shuffle=
GET /api/images/:id
```

画廊筛选维度由 `/api/gallery-facets` 单独返回；图片列表按 `image_time DESC, id DESC` 使用 `/api/images` 游标分页与 Redis 缓存，返回字段覆盖卡片与详情首帧展示所需的 `id`、缩略图 URL、标题、标签、主题、作者、设备、尺寸、图片时间和 `diff_original` 原图按钮标记。详情弹窗仍请求 `/api/images/:id`，但只补充 `id`、展示图 URL、描述和来源，不重复返回列表已有字段，也不返回对象键、存储后端、MD5、扩展 JSON 等后台 / 内部字段。浏览器存在登录 hint 时，公开详情会直接请求 `/api/admin/images/:id/admin-info` 获取 `md5`、`image_time`、`created_at`、`updated_at` 与后端算好的 `storage_label`，用于展示 UUID、MD5、存储后端、图片时间、导入时间和更新时间；若该轻量接口返回 401，则清除 hint 并保持普通访客展示。详情响应同样按 `public_images_gen + id` 进入 Redis 缓存。原图按钮会先尝试无 Referer 直连探测；探测结果按原图 URL 和浏览器家族短 TTL 缓存，失败时回退到 link 子域代理。`shuffle=1` 只在出口打乱当前批次，不影响游标和共享缓存。Redis 缓存 miss 时，同进程内会合并相同 key 的并发查询，避免冷启动或失效瞬间重复打 PostgreSQL。

## 后台管理

- 图片列表、编辑、批量操作、回收站、存储迁移；
- 标签、主题、作者、用户、设置、检查与账户设置；
- 存储检查比对数据库与实际后端，可清理孤儿对象与过期 prepared 暂存；
- 应用设置写 `config.json`，存储后端与密钥写 PostgreSQL。

## 图片编辑与换分类

只改标题、描述、来源、原图 URL 或作者时不搬对象。修改设备、明暗或主题时：事务外预拷贝候选对象键，事务内更新 metadata，提交后删除旧对象并重建缩略图；异常回滚会清理预拷贝。link 图片不搬外部原图，但会移动按分类组织的 `link` 缩略图。所有影响随机筛选的变更都会同步 Redis 随机池。

## 删除生命周期

1. 软删只更新数据库状态并从 Redis 随机池移除，原图/缩略图留在原位。
2. 恢复只更新数据库状态并重新加入 Redis 随机池，不搬字节。
3. 彻底删除才物理删除对象和 metadata。

公共 static/link 路由拒绝 deleted 图片；后台 `/api/admin/images/:id/raw|thumb|original` 经鉴权提供回收站查看。软删无法撤回浏览器/CDN 已缓存副本，安全级吊销需彻底删除并清 CDN。

## 后台 Worker

Worker 用 `FOR UPDATE SKIP LOCKED` 领取持久任务，按任务类型限制并发，并定期恢复僵尸任务、清理过期 `import_session`、prepared staging 与孤儿 raw 临时文件。存储孤儿清理使用独占维护锁；导入、分类移动、主题重分配和存储迁移持有共享写锁，防止清理任务删除尚未写入最终数据库引用的候选对象。已完成 / 已忽略任务保留 7 天后按批删除，耗尽重试的失败任务保留 90 天后删除；待执行、运行中和仍在重试窗口内的失败任务不会被历史清理删除。

## 高级配置编辑与迁移

「设置 → 高级配置」主体是当前实例完整 `config.json` 编辑器。浏览器先解析 JSON，
服务端再按精准 schema 做只读预检并比较危险字段；用户确认后，保存接口会在共享
配置写锁内重新校验，原子替换文件和内存快照。连接与端口变更等待容器重启，其他
支持热加载的字段通过既有监听器立即应用。服务进程启动监听后会记录实际端口；
healthcheck 使用该运行态端口而非可能已保存但尚未生效的新配置值。

「设置 → 高级配置」通过版本化 JSON 包迁移可移植运行时配置及自定义存储
后端，不搬运数据库业务数据、缓存、图片对象或新实例自己的连接与域名配置。

```text
导出：当前配置 + 自定义存储注册表
        └─► 排除基础设施字段与内置 local
             └─► imageshow-config v1 JSON（含完整存储凭据）

导入：选择 JSON
        └─► 严格校验格式、版本、配置和后端数量
             └─► 预检当前 slug
                  ├─ 无冲突：保留原 slug
                  └─ 有冲突：要求输入新 slug
                       └─► 再校验当前注册表
                            └─► 原子写配置文件 + 单事务新增后端
```

同 slug 永不覆盖现有后端。完整配置保存与配置包应用共用 PostgreSQL advisory
lock 串行执行，避免并发写入互相覆盖配置快照。导入时先保存运行时配置快照，在存储后端数据库
事务提交前原子写入配置文件；普通写入、查询或事务提交错误会回滚数据库事务并恢复
配置快照。若导入包把某个自定义后端标为默认，成功后会在映射后的 slug 上恢复默认状态。

配置文件和 PostgreSQL 不能组成真正的跨资源事务。配置文件写入后的极小窗口内若
进程遭遇 SIGKILL、容器崩溃或主机断电，可能出现配置已更新但数据库事务已回滚。
管理员需要人工恢复导入前的配置文件，或检查存储后端注册表后重新导入配置包。

## 缓存策略

PostgreSQL 是真相源，Redis 是可丢弃的加速层：随机池、画廊筛选、公共列表、公开详情、后台概览、原图直连探测、MD5 判重与对象键 / 缩略图键 / 图片 id lookup 走缓存；写路径按“公共列表 generation / facets / 定向 lookup 字段”分别失效，避免一次图片修改清空全部 lookup，只有会批量改写对象键和 link 缩略图键的主题迁移清空三个 lookup namespace。lookup 使用 Redis 8 hash 字段级 TTL，不会因其他图片回填而延长旧字段寿命。域名、静态 / link 子域或存储公开 URL 变化时也会提升公共读缓存 generation。Redis 不可用或 lookup JSON 损坏时资源出口回退 PostgreSQL。随机 API 的正常路径依赖 Redis 随机池，避免 PostgreSQL 随机排序或 count+offset；随机池冷启动全量重建使用进程内合并和 Redis 分布式锁，同一时刻只有一个实例查询 PostgreSQL 并发布新 generation。每次强制重建先递增请求 revision，持锁实例发布后写入完成 revision；重建期间出现的新写入会让持锁实例在释放锁前再执行一轮，避免返回与写入竞态的旧 generation。

HTTP 缓存按 CDN 友好但不泄露私有数据分层：

- `/assets/*` 的 Vite 构建产物和稳定的 `/media/*`、`/thumbs/*` 图片对象使用一年 `immutable`；`/assets/brand/*`、`/favicon.ico` 不是 hash 路径，只给短浏览器缓存和较长 CDN 缓存。构建会为可压缩静态文本生成 Brotli / gzip 版本，服务端按 `Accept-Encoding` 选择并附带 `Vary`，同时支持 ETag / Last-Modified 条件请求。存储后端的公开 URL 可能被管理员修改，因此指向该 URL 的 302 只短期缓存；缩略图缺失时临时回退原图也不使用 immutable。
- `/api/images`、`/api/images/:id`、`/api/site-config`、`/api/gallery-facets` 与 `/img-count` 是公共动态数据：浏览器不持有，CDN 的新鲜、重验证和错误兜底窗口均不超过 30 秒。SPA 与文档 HTML 使用独立的短缓存策略，不与动态 API 共用时长。
- `/random` 和 `random.<域名>` 永远 `no-store`，避免 CDN 把随机图固定成同一张。
- `/api/admin/*`、登录 / 验证码 / 上传暂存预览 / SSE、后台图片字节、健康检查和错误响应使用 `no-store` 或 `private, no-store`，不应被 CDN 缓存。
- `link.<域名>/media` 与仍需使用的 `/original` 公共代理成功响应优先继承源站 `Cache-Control` / `Expires`；源站未声明时使用站内 CDN fallback：浏览器缓存 1 天、共享缓存 1 年，并允许 stale 回源兜底。`/media` 回源失败退回 link 缩略图时，该兜底缩略图缓存 1 周。后台代理仍为 `private, no-store`。

公共 API 的缓存响应按 `Sec-Fetch-Site` 分变体，所有 API 按 `Accept-Encoding` 分变体。动态压缩先读取不超过 1 KiB 的响应前缀决定是否压缩，不再复制并完整缓冲大响应。本站直接输出的图片对象带 `Content-Length`、ETag、`Accept-Ranges: bytes`，支持单段 Range 和 `If-Range`；多段或不可满足的 Range 返回带对象总长度的 416。

推荐 Nginx 配置面向当前 stable 1.30.3，不重复声明其默认 HTTP/1.1 / keepalive，也不重复实现应用缓存；它只负责 TLS、HTTP/2、转发头，并为导入 / SSE 与长时间检查路径关闭请求缓冲或放宽超时。若需要共享 HTTP 缓存，优先让外部 CDN 遵循 Hono 返回的 `Cache-Control` 与 `Vary`。
