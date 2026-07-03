# 功能与流程

本页描述 ImageShow 的主要端到端流程。底层表结构见[数据库结构](./database)，组件边界见[项目结构](./project-structure)。

## 三种图片导入模式

三种模式共用一个 `ImportJob` 队列、任务卡片、元数据编辑、最终 MD5 判重和批量提交界面。本地上传与链接下载共用 stored-image prepared import；代理链接仍保留独立流程。

```text
模式 1：本地上传

File ──► 立即创建卡片 + blob: 临时预览
     └─► 创建 upload_session（锁定 storage_slug）
          └─► PUT 原始字节
               └─► data/tmp/upload/<id>.raw
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
    └─► 创建 upload_session（锁定 storage_slug）
         └─► 服务端限时、限大小下载
              └─► data/tmp/import/<id>.raw
                   └─► 与本地上传相同的 transcodeStoredImage()、staging、ready、commit

模式 3：代理链接

URL ──► 立即创建卡片（锁定缩略图 storage_slug）
    └─► 服务端下载一次用于校验、MD5、尺寸和缩略图
         └─► Redis 暂存 URL + 探测结果 + 缩略图（TTL）
              └─► ready：编辑/提交
                   └─► metadata.object_key = URL、is_link=true
                        + <锁定后端>/link/<分类>/<id>.webp
```

stored-image prepare 完成后会删除 `data/tmp/upload|import` 下的 raw 文件；失败、取消和过期清理同样删除 raw 与 `_uploads` 候选对象。原始上传/下载字节从不写入 S3、WebDAV 等目标后端，因此不存在“先远端上传原图、再下载回来压缩”的重复传输。

### prepared import 状态机

```text
created
  └─► receiving（本地：上传中；链接：下载中）
       └─► preparing（校验 / 转码 / 缩略图 / 最终 MD5）
            └─► ready（可编辑、可提交）
                 └─► committing（只搬候选对象并写数据库）
                      └─► finalized

任一 prepare 阶段 ─► failed
可取消阶段         ─► cancel + 删除会话、raw、processed、prepared thumbnail
```

每个任务在创建会话时锁定 `storage_slug`。之后修改全局默认存储只影响新任务；ready 任务不支持换后端，commit 必须使用会话中的后端。

### prepare 与 commit 的职责

prepare 承担所有重处理：

- 原始流精确大小限制与服务端本地落盘；
- 图片解码校验、长边约束、可选 WebP 转码与体积控制；
- 标准缩略图、最终预览、设备/明暗识别；
- 基于最终候选字节计算 `metadata.md5`、大小、扩展名与尺寸；
- 仅把 processed image 和 prepared thumbnail 写入锁定后端的 `_uploads`。

commit 不重新下载、不重新转码，也不从远端读回候选文件：

1. 会话 advisory lock 防止并发重复提交；
2. `_uploads` 中 processed image 移到 `objects`，prepared thumbnail 移到 `thumbs`；
3. 短事务锁分类、分配连续序号、写 `metadata` 与会话最终状态；
4. 写标签、更新随机池和读缓存。

对象移动具有幂等检查：若上次提交已移动对象但数据库步骤失败，重试会复用已存在的目标对象。

### 前端队列与判重

- 选择本地文件后立即加入卡片，本地 `objectURL` 只用于 prepare 前临时预览；切换为服务端最终预览时立即 revoke。
- 队列状态优先走 SSE 实时推送，并用 2 秒一次的批量状态轮询兜底；轮询按当前未完成任务集合合并请求，不按单卡片单独轮询。
- 前端不读取整文件计算 MD5。批次内的预筛只用 `name + size + lastModified + webkitRelativePath`，浏览器拿不到完整路径时不依赖路径。
- 服务端返回最终 MD5 后，队列以同步 reservation 防止并发 prepare 的两张相同图片同时通过批内判重，再查询图库已有项。
- 卡片区分等待、上传/下载、处理、已就绪、提交、完成、失败、取消；显示存储后端显示名、处理前后像素尺寸、处理前后体积、质量或短路状态、失败原因及取消/重试。
- 清空列表和取消单项会先调用后端 cancel，再移除卡片；本地 XHR、下载请求和代理准备请求也会中止。

### 三种模式差异

| 项目 | 本地上传 | 链接下载 | 代理链接 |
| --- | --- | --- | --- |
| raw 临时位置 | `data/tmp/upload/<id>.raw` | `data/tmp/import/<id>.raw` | 不使用本地 prepared raw 目录 |
| 最终原图 | 标准化后的 WebP | 标准化后的 WebP | 不保存，保留 URL |
| 最终 MD5 | processed image | processed image | prepare 时下载的远程原图 |
| prepared 暂存 | `_uploads/*.image.webp` + `*.thumb.webp` | 同左 | Redis stage |
| 正式位置 | `objects` + `thumbs` | `objects` + `thumbs` | URL + `link` 缩略图 |
| 数据库标记 | `is_link=false` | `is_link=false` | `is_link=true` |

两种 URL 模式都遵循 `link_image.fill_original_url`。入库标准化参数位于顶层 `normalize`，下载并发位于 `link_image.concurrency`。

## 原图链接与外链代理

详情弹窗的「原图」先请求 `/api/images/:id/original`。后端用当前浏览器 User-Agent、无 Referer、`GET + Range: bytes=0-0` 探测：可直接访问则 302 到原 URL，否则 302 到 cookie 隔离的 `link.<域名>/original/:id`，由服务端带源站 Referer 转发。

公共接口只接受 `status=ready`。后台回收站改走带鉴权的 `/api/admin/images/:id/original`：它允许 deleted 行，能直连则 302，否则在管理员接口内私有代理，不经过 public ready 状态门禁。

## 明暗识别

`brightness=auto` 时，服务端在已生成的标准缩略图上按 CIELAB L\* 分布判断 dark/light。文件名符合 `<device>-<brightness>-<theme>-<index>` 或 `<device>-<brightness>-<index>` 时会预填具体属性，否则明暗保持 auto。重新识别同样复用缩略图。

## 随机图 API

```text
GET /random?d=&b=&t=&tag=&a=&m=
```

1. 校验参数并把主题、标签、作者别名解析为 slug。
2. 未指定设备时按 User-Agent 推断。
3. 按客户端与筛选签名做短时不重复。
4. 无标签/作者时优先走 Redis 加权池；Redis 不可用降级 PostgreSQL。有标签/作者时走 PostgreSQL 索引查询。
5. `m=proxy` 代理字节，否则 302 到对象 URL。link 图片的 URL 指向 `link.<域名>/media/<id>.<ext>`。

参数细节见[随机图 API](./random-api)。

## 画廊浏览

```text
GET /api/images?d=&b=&t=&tag=&cursor=&limit=&shuffle=
```

列表使用游标分页与 Redis 缓存。`shuffle=1` 只在出口打乱当前批次，不影响游标和共享缓存。

## 后台管理

- 图片列表、编辑、批量操作、回收站、存储迁移；
- 标签、主题、作者、用户、设置、检查与账户设置；
- 存储检查比对数据库与实际后端，可清理孤儿对象与过期 prepared 暂存；
- 应用设置写 `config.json`，存储后端与密钥写 PostgreSQL。

## 图片编辑与换分类

只改标题、描述、来源或原图 URL 时不搬对象。修改设备、明暗或主题时：事务外预拷贝候选键，事务内按固定顺序锁分类、重排连续索引并更新 metadata，提交后删除旧对象并重建缩略图；异常回滚会清理预拷贝。link 图片不搬外部原图，但会移动按分类组织的 `link` 缩略图。

## 删除生命周期

1. 软删只更新数据库状态与分类连续索引，原图/缩略图留在原位。
2. 恢复在原分类尾部重新分配序号，不搬字节。
3. 彻底删除才物理删除对象和 metadata。

公共 static/link 路由拒绝 deleted 图片；后台 `/api/admin/images/:id/raw|thumb|original` 经鉴权提供回收站查看。软删无法撤回浏览器/CDN 已缓存副本，安全级吊销需彻底删除并清 CDN。

## 后台 Worker

Worker 用 `FOR UPDATE SKIP LOCKED` 领取持久任务，按任务类型限制并发，并定期恢复僵尸任务、清理过期 upload_session、prepared staging 与孤儿 raw 临时文件。

## 缓存策略

PostgreSQL 是真相源，Redis 是可丢弃的加速层：随机池、画廊筛选、公共列表、MD5 判重与对象查找走缓存；写路径增量刷新，Redis 不可用时降级 SQL 或排缓存重建任务。
