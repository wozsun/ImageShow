# 功能与流程

本页描述 ImageShow 的主要端到端流程。底层表结构见[数据库结构](./database)，组件边界见[项目结构](./project-structure)。

## 三种图片导入模式

三种模式共用一个 `ImportJob` 队列、任务卡片、元数据编辑、最终 MD5 判重、SSE 状态推送、取消/重试和批量提交界面。底层统一为 `import_session`：`mode=upload` 保存浏览器上传文件，`mode=download` 由服务端下载并保存，`mode=proxy` 只保存缩略图与外部链接。会话创建时写入 `request_hash`，同一 `idempotency_key` 只有在模式、URL、大小、存储后端和初始元数据摘要一致时才复用。

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
                         ├─ 生成标准缩略图、识别设备与明暗
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
         └─► 服务端安全下载一次用于校验、MD5、尺寸、明暗识别和缩略图
              ├─► <锁定后端>/_uploads/<id>.thumb.webp
              └─► ready：编辑/提交
                   └─► metadata.object_key = URL、is_link=true
                        + <锁定后端>/link/<分类>/<id>.webp
```

prepare 完成后会删除 `data/tmp` 下的 raw 文件；失败、取消和过期清理同样删除 raw 与 `_uploads` 候选对象。清理只匹配 UUID 形态的 `.raw` / `.raw.part` 文件，避免误删其他临时内容。原始上传/下载字节从不写入 S3、WebDAV 等目标后端，因此不存在“先远端上传原图、再下载回来压缩”的重复传输。服务端还会按 `upload.global_concurrency` / `link_image.global_concurrency` 对 prepare 做进程内全局限流，防止绕过前端队列直接并发压垮进程；触发全局等待时会通过状态消息显示“服务端全局处理名额已满，等待空闲名额”。

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
- 三种模式：标准缩略图、最终预览、设备/明暗识别；
- upload/download 基于最终候选字节计算 `metadata.md5`；proxy 基于外部原图字节计算 `metadata.md5`；
- upload/download 把 processed image 和 prepared thumbnail 写入锁定后端的 `_uploads`；proxy 只写 prepared thumbnail。

commit 不重新下载、不重新转码，也不从远端读回候选文件：

1. 会话 advisory lock 防止并发重复提交；
2. upload/download：`_uploads` 中 processed image 复制到 `media`，prepared thumbnail 复制到 `thumbs`；proxy：prepared thumbnail 复制到 `link`；
3. 短事务写 `metadata` 与会话最终状态；
4. 事务成功后清理 `_uploads` 候选对象；
5. 写标签、更新随机池和读缓存。

对象提交具有幂等检查和异常补偿：若目标对象已存在，重试会复用；若正式对象已经复制但数据库事务失败，会 best-effort 删除本次复制出的 `media`、`thumbs` 或 `link` 对象，减少孤儿文件。

### 前端队列与判重

- 选择本地文件后立即加入卡片，本地 `objectURL` 只用于 prepare 前临时预览；切换为服务端最终预览时立即 revoke。
- 队列状态优先走 SSE 实时推送；SSE 连接失败或断开后才降级为 2 秒一次的批量状态轮询，轮询按当前未完成任务集合合并请求，不按单卡片单独轮询。
- 前端不读取整文件计算 MD5。批次内的预筛只用 `name + size + lastModified + webkitRelativePath`，浏览器拿不到完整路径时不依赖路径。
- 服务端返回最终 MD5 后，队列以同步 reservation 防止并发 prepare 的两张相同图片同时通过批内判重，再查询图库已有项。
- 卡片区分等待、上传/下载、处理、已就绪、提交、完成、失败、取消；显示存储后端显示名、处理前后像素尺寸、处理前后体积、质量或短路状态、失败原因及取消/重试。
- 清空列表和取消单项会先调用后端 cancel，再移除卡片；本地 XHR、下载请求和代理准备请求也会中止。

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

两种 URL 模式都遵循 `link_image.fill_original_url`：开启时自动把输入 URL 写入 `original` 字段，不做可直达探测；原图按钮点击时才探测直连可用性。入库标准化参数位于顶层 `normalize`；单客户端 URL 队列并发位于 `link_image.concurrency`，服务端全局 URL prepare 并发位于 `link_image.global_concurrency`。

## 原图链接与外链代理

详情弹窗的「原图」只在 `original` 字段存在且不同于展示图时显示，并先请求 `/api/images/:id/original`。后端也执行相同判断：`original` 为空、不是 `https` 或等于展示 URL 时返回 404。只有 `original` 指向另一个 HTTPS URL 时，后端才用当前浏览器 User-Agent、无 Referer、`GET + Range: bytes=0-0` 探测：可直接访问则 302 到原 URL，否则 302 到 `link.<域名>/original/:id`，由服务端带源站 Referer 转发。

公共原图接口只接受 `status=ready`。后台回收站的原图按钮显示规则与公开页面一致：只有 `original` 存在且不同于展示图时显示；deleted 行点击时走带鉴权的 `/api/admin/images/:id/original`，它允许回收站内的独立原图链接，但仍使用 `private, no-store`。回收站查看图片本体使用带鉴权的 raw/thumb 接口。

## 明暗识别

`brightness=auto` 时，服务端在已生成的标准缩略图上按 CIELAB L\* 分布判断 dark/light。本地上传仍兼容旧文件名规则：如 `pc-dark-theme-001` 会预填设备、明暗和主题，`pc-dark-001` 会预填设备和明暗；不命中时明暗保持 auto。重新识别同样复用缩略图。

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
GET /api/images?d=&b=&t=&tag=&cursor=&limit=&shuffle=
GET /api/images/:id
```

画廊筛选维度由 `/api/gallery-facets` 单独返回；图片列表使用 `/api/images` 游标分页与 Redis 缓存，返回字段只覆盖卡片渲染所需的 `id`、缩略图 URL、标题、标签、主题、设备、尺寸和创建时间。详情弹窗打开后再请求 `/api/images/:id` 获取完整公开详情，详情响应同样按 `public_images_gen + id` 进入 Redis 缓存。原图按钮会先尝试无 Referer 直连探测；探测结果按原图 URL 和浏览器家族短 TTL 缓存，失败时回退到 link 子域代理。`shuffle=1` 只在出口打乱当前批次，不影响游标和共享缓存。Redis 缓存 miss 时，同进程内会合并相同 key 的并发查询，避免冷启动或失效瞬间重复打 PostgreSQL。

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

Worker 用 `FOR UPDATE SKIP LOCKED` 领取持久任务，按任务类型限制并发，并定期恢复僵尸任务、清理过期 `import_session`、prepared staging 与孤儿 raw 临时文件。

## 缓存策略

PostgreSQL 是真相源，Redis 是可丢弃的加速层：随机池、画廊筛选、公共列表、公开详情、后台概览、原图直连探测、MD5 判重与对象查找走缓存；写路径增量刷新，Redis 不可用时排缓存重建任务。随机 API 的正常路径依赖 Redis 随机池，避免 PostgreSQL 随机排序或 count+offset。

HTTP 缓存按 CDN 友好但不泄露私有数据分层：

- `/assets/*` 的 Vite 构建产物和 `/media/*`、`/thumbs/*` 图片对象使用一年 `immutable`；`/assets/brand/*`、`/favicon.ico` 不是 hash 路径，只给短浏览器缓存和较长 CDN 缓存。
- SPA HTML、文档 HTML、`/api/images`、`/api/site-config`、`/api/gallery-facets`、`/img-count` 都是公共数据：浏览器不长期持有，CDN 通过 `s-maxage` 短缓存，并允许 `stale-while-revalidate` / `stale-if-error`。
- `/random` 和 `random.<域名>` 永远 `no-store`，避免 CDN 把随机图固定成同一张。
- `/api/admin/*`、登录 / 验证码 / 上传暂存预览 / SSE、后台图片字节、健康检查和错误响应使用 `no-store` 或 `private, no-store`，不应被 CDN 缓存。
- `link.<域名>/media` 与仍需使用的 `/original` 公共代理成功响应优先继承源站 `Cache-Control` / `Expires`；源站未声明时使用站内 CDN fallback：浏览器缓存 1 天、共享缓存 1 年，并允许 stale 回源兜底。`/media` 回源失败退回 link 缩略图时，该兜底缩略图缓存 1 周。后台代理仍为 `private, no-store`。
