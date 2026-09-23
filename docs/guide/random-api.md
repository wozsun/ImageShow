# 随机图 API

`GET /random` 默认从 Redis 的就绪图片读模型中随机选取一张图片；默认返回模式只可配置为
`proxy` 或 `redirect`。显式 `mode=json` 可一次
请求多张互不重复的图片元数据，也可用 `id` 限定本次请求的候选图片。

## 请求频次与白名单

GET / HEAD 按 IP 使用两个独立固定窗口，默认均为 60 秒：

| 请求 | 每 IP 上限 |
| --- | --- |
| 查询串带 `limit`，包括 `limit=1` | 10 次 |
| 查询串不带 `limit` | 60 次 |

三种返回模式、尺寸及筛选条件共用各自档位；请求在参数校验和选图前计数，后续失败不退还额度。
额度耗尽返回 `429`、错误码 `random_rate_limited` 及整数秒 `Retry-After`，所有响应继续 `no-store`。
窗口从该 IP 在该档的首次计数时开始，拒绝请求不会延长窗口。阈值通过
[`security.random_*`](../CONFIG.md#securityrandom_window_seconds) 配置。

Referer 的来源匹配本站 HTTPS origin、同端口子域或 `embed.allowed_origins` 时，两档均不计数；
精确来源只匹配自身，通配来源只匹配子域、不包含根域。未设置实际站点域名时仅隐式信任
当前请求同源。豁免不受 `embed.enabled` 控制，不增加第二份白名单；空、无效或其他 Referer
正常计数。Referer 可伪造，此机制只做轻量使用约束，不替代鉴权。

非白名单请求依赖 Redis 计数，Redis 命令失败返回 `503 redis_unavailable`；白名单请求仍可
沿用下述 PostgreSQL 有界回源。IP 读取依赖可信代理覆盖 `X-Real-IP` 或单值
`X-Forwarded-For`，缺失或非法时共用 `unknown` 额度，部署要求见[反向代理](../DEPLOY.md#反向代理与-https)。

## 查询参数

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `device` | `pc` / `mb` / `all` / `auto` | 设备；缺省在请求边界归一为 `auto`，按 User-Agent 推断，无法识别时使用全部设备；`all` 显式使用全部设备 |
| `brightness` | `dark` / `light` | 亮度，缺省两者皆可 |
| `theme` | 逗号分隔主题 | 缺省全部；`theme=a,b` 为包含，`theme=!a,!b` 为排除，二者不可混用；`null` 选无主题 |
| `tag` | 正向标签条件，可重复 | 缺省不限标签；`tag=a,b` 为任一，`tag=all:a,b` 为全部，重复条件之间为或 |
| `author` | 逗号分隔作者 | 缺省全部；`author=x,y` 为包含，`author=!x,!y` 为排除，二者不可混用 |
| `id` | 完整 UUID 或末 12 位 | 只从匹配到的可用图片中随机选择，可用逗号或重复参数给出多个值 |
| `seed` | 非空字符串 | 在相同筛选条件和候选集合下固定选取一张图片；区分大小写，不解释日期 |
| `mode` | `proxy` / `redirect` / `json` | 返回方式；缺省时取设置页的 `proxy` / `redirect` 默认值，`json` 只能显式指定 |
| `size` | `thumb` / `full` | 图片资源尺寸；缺省时 `proxy` / `redirect` 使用 `site.random_size`（默认 `full`），`json` 提供两种 URL；显式指定时只输出对应尺寸 |
| `limit` | 大于 0 的整数 | 仅显式指定 `mode=json` 时有效；缺省为 1，最多返回 200 张 |

`theme` / `tag` / `author` 可填 slug 或显示名，服务端会先解析成 slug，再按字段排序去重并生成
稳定筛选签名。`theme=null` 只选无主题，`theme=!null` 只选已设主题；排除普通主题仍
包含空主题。`null` 是保留选择器，不能用作主题标识；JSON 图片响应的无主题为 `null`。
基础随机、主题、标签和作者筛选都复用
`imageshow:cache:images:*` 就绪图片投影：无筛选直接使用根层核心 `index:all`，设备 / 轴 / 主题 /
标签 / 作者 ZSET 与组合结果统一位于 `imageshow:cache:images:derived:*`。核心重建只建立
根层投影；公开请求首次使用某个属性时立即进入 PostgreSQL fallback，并触发独立的
后台 keyset 分批构建；一次请求所需的全部缺失属性进入有界进程内串行队列。当前回源与
后台构建都经过统一公开 PG 准入，属性构建全局最多并发 1、同一属性进程内单飞。索引及其
独立 meta 使用 12 小时滑动 TTL，并同时校验
applied revision、count 与每次发布唯一的实例 token；组合结果只使用已经验证的属性索引，
且在消费后复核来源实例没有被清理或替换。派生结果缺失、过期、
revision 变化或基数不符不会关闭核心读门：首次未命中请求不等待构建，构建成功后的后续
随机请求自动使用 Redis；未取得槽位、失败或工作量超限也不改变当前有界 PostgreSQL fallback。
仅限制设备时直接复用 `derived:index:device:pc` 或 `device:mb`，与主题、标签、作者组合时
也使用该设备索引作为输入；设备加亮度使用对应轴索引。设备索引沿用 PostgreSQL 按时间 / ID
分批读取的属性构建流程，不参与核心重建或常驻增量维护。属性构建先用核心计数判断单集合
容量，已知超限立即回源；读取源数据时再次限制成员数，超限放弃整份结果并清理临时集合，
不截断候选。纯设备查询只保留设备属性集合，不再另存等价的设备组合集合。
缺省 `device` 与显式 `device=auto` 在解析后是同一个规范状态，并共享相同的候选、近期
去重签名与 key；它们不会建立额外缓存分支。属性索引、组合结果和统计结果共用 12 小时滑动
TTL 与 LRU registry，最多 1024 个结果、512 个活跃筛选签名；单个派生集合最多 100 万成员，
总成员额度为就绪图片数的 32 倍且至少 1 万，单个序列化统计结果最多 1 MiB。统计结果不计
集合成员数，但仍占用结果与签名额度。超限、损坏或
registry 不一致只使本次随机请求放弃派生结果，不触发核心投影重建。组合集合命令还限制
单命令源成员、预期结果、操作数和整次构建累计工作量；超限时不创建共享临时集合，随机
请求不物化 Redis 临时集合，直接进入同一 PostgreSQL fallback。
筛选构建最多并发 6，统计构建最多并发 3，其中大任务各最多并发 1；属性索引构建仍按前述
串行准入执行。Redis 筛选统计允许主题、标签、作者合计最多 512 个动态维度，同时仍受
单命令与累计工作量预算约束：集合物化与交集计数的单次输入各最多 40 万成员，单次操作
预计结果最多 20 万成员；一次筛选构建累计输入最多 60 万成员，一次统计累计输入最多
400 万成员、累计预计结果最多 100 万成员。同一成员参与不同运算会重复计入工作量。
筛选累计输入达到 10 万或统计累计预计结果达到 25 万时，分别按大任务准入。
缓存容量和工作量策略分别由
`images/ready-cache/derived/policy.ts` 与 `work-policy.ts` 集中定义。

查询使用有界、规范化的公开契约：

- 只接受表中十个精确小写键；`device`、`brightness`、`seed`、`mode`、`size`、`limit` 各最多出现一次。原始查询串最多
  4096 字节。
- `size` 值不区分大小写；空值、未知值、包含额外空白或重复参数返回 400。未指定状态保留到输出阶段。
- `theme`、`tag`、`author` 每项最多 64 个字符，每类最多 32 项，三类合计最多 64 项；数量按
  去重前提交项计算；标签的 `all:` 不计入词项长度，标签段数及解析后条件条数均最多 32。
  标签空值、空词项与非法表达式返回 400；主题 / 作者仍忽略空白片段，单独的 `!`、控制字符及
  同类混用包含和排除返回 400。
- `id` 只接受带连字符的完整 UUID 或最后 12 位十六进制字符，不区分大小写；可通过
  逗号或重复参数提交，每次最多 32 个非空值。重复值会归一化去重，空值返回 400。
- `limit` 必须是大于 0 的十进制整数，但只有查询串明确包含 `mode=json` 时才可使用。超过
  200 时按 200 执行。
- `seed` 最多 128 个 Unicode 字符，保留大小写及首尾空白；空字符串、纯空白、控制字符或重复
  参数返回 400。指定 `seed` 时只支持单张结果，`mode=json` 可省略 `limit` 或指定 `limit=1`，
  大于 1 时返回 400。`seed` 不能与 `id` 同时使用。
- 指定 `id` 后只允许同时指定无筛选作用的 `device=auto`、`mode`、`size` 和 `limit`。所有格式、数量和互斥校验都先于词表、
  图片查询缓存与存储访问完成；请求频次计数先于这些参数校验。
- 任一未知标签使整次请求返回 404，不丢弃条件继续查询。主题 / 作者的未知包含项返回 404，
  未知排除项从有效筛选中删除。合法但没有图片的随机筛选返回 404。

## 标签任一、全部与混合

| 查询 | 匹配条件 |
| --- | --- |
| `tag=city,night` 或 `tag=city&tag=night` | 城市或夜景 |
| `tag=all:city,night` | 城市且夜景，允许图片同时具有其他标签 |
| `tag=all:city,night&tag=rain` | （城市且夜景）或雨景 |
| `tag=all:city,night&tag=all:forest,fog` | （城市且夜景）或（森林且雾景） |
| `tag=all:city&tag=all:night` | 城市或夜景，参数之间始终为或 |

完整标签条件与设备、明暗、主题和作者条件取交集。不传 `tag` 时包括无标签图片。
所有被引用标签必须存在；已存在但没有图片的条件贡献空候选，其他或条件仍参与。
最终候选按图片去重，命中多条条件不会增加抽中权重；不先随机选分支再选图。

`all:` 仅在每个参数值开头生效，忽略大小写；词项去除首尾空白，slug 优先于同名显示名。
URL 只解码一次，不支持嵌套、括号或转义语法。与表达式前缀或逗号冲突的显示名使用对应
slug 引用。标签只支持正向文法；空值、空词项或非法词项均为普通 400 校验错误。

公开 / 后台图片列表及统计同样接受组内任一 / 全部、组间或的混合表达，页面与这些接口最多 9 组、去重前 32 个词项，全部标签值合计最多 1024 字符；`/random` 沿用本接口预算。
页面生成链接使用稳定 slug，去重排序并保留可读的逗号及 `all:` 冒号，其他字符保持必要编码。

Redis 和 PostgreSQL 使用相同候选语义。Redis 按每条全部条件求交集，再对所有分支求并集，
随后与其他属性组合；构建与预算估算共用有限运算计划，沿用成员数、命令数、TTL、LRU、
取消及发布验证边界。超限回源时保留完整条件，不能返回部分分支或截断后的候选。

## Redis 热路径与降级

不含 `id` 或 `seed` 的普通随机请求在所需派生索引已存在时不访问 PostgreSQL，也不使用
`ORDER BY random()`、count + offset 或二次元数据查询；首次属性筛选只为构建可复用
ZSET 做有界 keyset 读取。Redis 用 `ZRANDMEMBER` 从筛选 ZSET 抽取 UUID member，再从
rich item hash 批量取得返回、跳转或代理所需的完整投影。应用层先打乱候选顺序，再优先
选择不在同一客户端最近记录中的图片；候选全部近期见过时仍随机补足，不依赖 Redis
返回成员的顺序。单次响应 UUID 唯一；近期去重是尽力避重，不承诺完整轮次或绝不连抽同图。

最近历史使用 Redis 8 Array：`ARRING` 按配置大小原地覆盖最旧值，
`ARLASTITEMS ... REV` 读取最新记录；该键有 TTL，记录失败只降低短期去重效果，不影响
图片真值或随机可用性。

当前进程完成过一次 Redis 冷启动校验后，核心读模型正在更新、损坏、命令不足或不可用时，
普通随机进入 `random` 工作量级的 PostgreSQL fallback。查询先用有界索引探针取得候选
UUIDv7 时间范围，再生成随机 pivot，向后按 `id` 读取并在不足时从头 wrap；候选最多
512 个，应用层打乱、去重并优先避开仍可读取的 Redis 最近历史，不使用
`ORDER BY random()`、count + OFFSET 或临时随机池。Redis 完全断线时不建立替代历史，
故障窗口允许跨请求重复；Redis 计数不可用时只有白名单请求能继续进入此路径。空图库或合法的零匹配筛选返回 404；fallback 队列、等待、
PostgreSQL 或执行上限饱和时返回带 `Retry-After` 的 429/503，频次超限按前述规则返回 429。进程首次 Redis 校验尚未
成功时则由冷启动总门直接 503，不允许随机路由绕过硬前置。

全量重建使用 PostgreSQL repeatable-read 快照分批读取，完成完整性校验且确认 revision
未变化后才重新开放 Redis 读门；重建本身不影响 `/readyz` 或后台会话。

图片接入、属性 / 标签 / 分类修改、删除、恢复、主题或作者级联和存储迁移都在同一
PostgreSQL 事务推进 `ready_image_revision`。提交后仍持有进程内写栅栏，以旧 Redis
投影和 PostgreSQL 新投影计算精确差异，只更新核心 item、ID 末位索引、`index:all`、全局统计与
核心完整性字段，最后发布 revision。Redis 同步失败不会回滚已经成功的数据库事务，而是
关闭读门并重建。

## 固定 `seed` 选图

`seed` 是调用方指定的任意固定值，不是日期类型，也不会随服务端时间自动变化。例如：

```text
/random?device=pc&seed=wallpaper
/random?device=all&brightness=dark&seed=my-fixed-value&mode=json
/random?device=pc&seed=2026-09-15&mode=proxy
```

相同 seed、规范化后的筛选条件和候选图片集合始终选中同一张图片，不受客户端 IP、
访问次数、近期历史、响应模式、输出尺寸或服务重启影响。参数顺序、重复的筛选词和对应 slug / 显示名
会经过既有筛选归一化。缺省设备仍为 `auto`，会按 User-Agent 改变实际筛选范围；
需要跨设备固定时显式使用 `device=all`、`pc` 或 `mb`。

图片新增、删除、恢复或属性变更导致候选集合变化时允许重新选图；不保存 seed 到图片 ID 的
持久绑定。不同 seed 可能选到同一张图片，不承诺逐次或逐日不重复。需要每日固定图时由
调用方按自己的时区每天传入新的 seed，日期只是可用的字符串形式。

选图将 seed 与规范化筛选签名进行 SHA-256 哈希，取前 48 位作为 UUID 尾段索引的起点，
按 `suffix,id` 顺序选择筛选范围内的第一张，末尾不足时从头继续。Redis 复用现有尾段索引与
筛选成员校验；索引不可用或扫描超过预算时，通过同一公开 PostgreSQL 准入执行相同的两段
索引查询，单次 SQL 快照内完成选取与元数据读取。缓存重建与降级本身不改变选图结果，
seed 不进入筛选索引 key，也不读取或更新客户端近期历史。

三种响应模式与现有随机图相同，JSON 仍返回单元素 `items` 数组。没有匹配图片返回 404，
沿用现有冷启动、取消、准入及故障响应；响应继续使用 `no-store`。

## 定向 `id` 查询

`id` 路径先查同一 Redis item / 末 12 位索引；缓存不可读时直接查询 PostgreSQL 权威
数据。完整 UUID 命中主键，末 12 位命中 `ready` 部分表达式索引
`right(id::text, 12)`，两个分支合并去重后最多读取 257 行以检测边界，正式候选硬上限
为 256，超过时返回 `503 public_pg_fallback_work_limit`；合法请求最多返回 200 张。
候选在应用层打乱，不应用客户端最近历史，也绝不回退到完整随机集合。没有匹配、只匹配
到回收站图片或候选已不可用时返回 404。

```text
/random?id=00000000-0000-7000-8000-000000000001
/random?id=000000000001,000000000002&mode=proxy
/random?id=00000000-0000-7000-8000-000000000001&id=000000000002&mode=redirect
/random?id=000000000001,000000000002&mode=json&limit=2
```

## 返回方式

`size` 选择已有的全图或 WebP 缩略图资源，不做按请求动态缩放，也不改变筛选候选、固定 seed
或客户端近期去重。它可以与三种 `mode`、定向 `id` 或固定 `seed` 分别组合，`id` 与 `seed`
仍互斥。尺寸选择的缺省行为与显式指定不同：

| `size` | `proxy` / `redirect` | JSON 每项的 URL 字段 |
| --- | --- | --- |
| 未指定 | 全图字节 / 全图地址 | `object_url` 和 `thumb_url` |
| `full` | 全图字节 / 全图地址 | 仅 `object_url` |
| `thumb` | WebP 缩略图字节 / 缩略图地址 | 仅 `thumb_url` |

显式指定尺寸时，JSON 中另一 URL 字段被省略，不返回空字符串或 `null`。单图和多图应用同一规则。

```text
/random?device=pc&mode=proxy&size=thumb
/random?device=all&mode=redirect&size=full
/random?device=all&mode=json&size=thumb&limit=5
/random?device=pc&seed=wallpaper&mode=json&size=full
```

`mode=proxy` 从图片所属 local 或 S3 后端读取对应尺寸的已入库图片字节，缩略图使用
`image/webp`，全图使用实际文件类型；并附带
`X-Image-Info`（设备-明暗-主题-ID，无主题时主题段为空）；它不声明 `Accept-Ranges`。`mode=redirect` 返回 302 跳转到公开 URL。
域名未设置、为空或为 `example.com` 时，应用提供的图片 URL 使用 `/images/...` 同源路径：
浏览器会按访问地址解析，API 客户端应以请求 origin 解析 JSON 图片地址及相对 `Location`。
已配置公开地址的 S3 对象继续返回存储直链。
这里的 `proxy` 只是返回传输方式，与图片接入模式无关。

`mode=json` 返回 `application/json`，顶层 `count` 是实际数量，`items` 是图片数组。以下为未指定 `size` 的响应：

```json
{
  "ok": true,
  "count": 1,
  "items": [
    {
      "id": "00000000-0000-7000-8000-000000000001",
      "title": "示例图片",
      "author": "photographer",
      "object_url": "https://img.example.com/images/full/01/00000000-0000-7000-8000-000000000001.webp",
      "thumb_url": "https://img.example.com/images/thumbs/01/00000000-0000-7000-8000-000000000001.webp",
      "device": "pc",
      "brightness": "dark",
      "theme": "theme",
      "tags": ["sample"],
      "width": 2560,
      "height": 1440,
      "image_time": "2026-08-03T12:00:00.000Z"
    }
  ]
}
```

`title` 为图片标题，`author` 为作者 slug。`width` / `height` 仍是已入库全图的尺寸，选择缩略图
不会改写这些元数据。按 ID 定向读取采用同一 JSON 格式及尺寸规则。

站内画廊和展映通过 `/api/images` 获取图片列表，展映使用 `view=show` 并在乱序时打乱返回
批次。描述、来源及仅向管理员提供的可空原图链接在打开图片详情时读取。列表与随机图共用图片读取和
缓存基础设施，批次大小及续取规则见[功能与流程](./flows.md)。

只写 `mode=json` 等同 `limit=1`，但仍返回数组。`limit` 是上限而非数量保证。GET 与 HEAD 都为
`no-store`；HEAD 返回与 GET 一致的状态、内容类型和内容长度，但不发送正文。

随机图通过主站 `https://<域名>/random` 提供；主机边界见
[主机与图片资源](./image-resources.md)。
