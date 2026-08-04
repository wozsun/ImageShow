# 随机图 API

`GET /random` 默认从 Redis 的就绪图片读模型中随机选取一张图片；`m=json` 可一次
请求多张互不重复的图片元数据，也可用 `id` 限定本次请求的候选图片。

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `d` | `pc` / `mb` / `r` | 设备，缺省按 User-Agent 推断，`r` 强制随机 |
| `b` | `dark` / `light` | 亮度，缺省两者皆可 |
| `t` | 逗号分隔主题 | 缺省全部；`t=a,b` 为包含，`t=!a,!b` 为排除，二者不可混用 |
| `tag` | 逗号分隔标签 | 缺省全部；包含为“任一”，`!` 前缀为排除，二者不可混用 |
| `a` | 逗号分隔作者 | 缺省全部；`a=x,y` 为包含，`a=!x,!y` 为排除，二者不可混用 |
| `id` | 完整 UUID 或末 12 位 | 只从匹配到的可用图片中随机选择，可用逗号或重复参数给出多个值 |
| `m` | `proxy` / `redirect` / `json` | 返回方式。缺省时取设置页默认值 |
| `n` | 大于 0 的整数 | 仅显式指定 `m=json` 时有效；缺省为 1，最多执行 200 张 |

`t` / `tag` / `a` 可填 slug 或显示名，服务端会先解析成 slug，再按字段排序去重并生成
稳定筛选签名。基础随机、主题、标签和作者筛选都复用
`imageshow:cache:images:*` 就绪图片投影：无筛选直接使用全量 ZSET，简单筛选直接使用
轴 / 主题 / 标签 / 作者 ZSET，组合与排除筛选生成带 6 小时 TTL 的派生 ZSET。派生结果
带 PostgreSQL revision 和基数元数据；revision 变化、基数不符或核心键缺失时不会继续读。

查询使用有界、规范化的公开契约：

- 只接受表中八个精确小写键；`d`、`b`、`m`、`n` 各最多出现一次。原始查询串最多
  4096 字节。
- `t`、`tag`、`a` 每项最多 64 个字符，每类最多 32 项，三类合计最多 64 项；数量按
  去重前的非空提交项计算。空白片段忽略，单独的 `!`、控制字符以及同类混用包含和
  排除均返回 400。
- `id` 只接受带连字符的完整 UUID 或最后 12 位十六进制字符，不区分大小写；可通过
  逗号或重复参数提交，每次最多 32 个非空值。重复值会归一化去重，空值返回 400。
- `n` 必须是大于 0 的十进制整数，但只有查询串明确包含 `m=json` 时才可使用。超过
  200 时按 200 执行。
- 指定 `id` 后只允许同时指定 `m` 和 `n`。所有格式、数量和互斥校验都先于词表、
  Redis 与存储访问完成。
- 未知包含项返回 404；未知排除项从有效筛选中删除。合法但没有图片的筛选返回 404。

## Redis 热路径与降级

不含 `id` 的正常随机请求不访问 PostgreSQL，也不使用 `ORDER BY random()`、count +
offset 或二次元数据查询。Redis 用 `ZRANDMEMBER` 从筛选 ZSET 抽取 UUID member，再从
rich item hash 批量取得返回、跳转或代理所需的完整投影。单次响应 UUID 唯一，并优先
避开同一客户端最近拿到的图片。

最近历史使用 Redis 8 Array：`ARRING` 按配置大小原地覆盖最旧值，
`ARLASTITEMS ... REV` 读取最新记录；该键有 TTL，记录失败只降低短期去重效果，不影响
图片真值或随机可用性。

核心读模型正在更新、损坏或不可用时，普通随机请求不临时从 PostgreSQL 构造随机池：
服务端关闭缓存读门、排队单飞重建，并返回 `503 random_cache_unavailable` 与
`Retry-After: 1`。空且健康的图库返回 404。全量重建使用 PostgreSQL
repeatable-read 快照分批读取，完成完整性校验且确认 revision 未变化后才重新开放读门。

图片导入、属性 / 标签 / 分类修改、删除、恢复、主题或作者级联和存储迁移都在同一
PostgreSQL 事务推进 `ready_image_revision`。提交后仍持有进程内写栅栏，以旧 Redis
投影和 PostgreSQL 新投影计算精确差异，更新 item、反查、ZSET、统计与完整性字段，最后
发布 revision。Redis 同步失败不会回滚已经成功的数据库事务，而是关闭读门并重建。

## 定向 `id` 查询

`id` 路径先查同一 Redis item / 末 12 位索引；缓存不可读时直接查询 PostgreSQL 权威
数据。完整 UUID 命中主键，末 12 位命中 `ready` 部分表达式索引
`right(id::text, 12)`，两个分支合并去重后再打乱。它不应用客户端最近历史，也绝不
回退到完整随机集合。没有匹配、只匹配到回收站图片或候选已不可用时返回 404。

```text
/random?id=019f8457-063a-7002-a580-7a432dc7fd8d
/random?id=7a432dc7fd8d,25a377d90f7f&m=proxy
/random?id=019f8457-063a-7002-a580-7a432dc7fd8d&id=25a377d90f7f&m=redirect
/random?id=7a432dc7fd8d,25a377d90f7f&m=json&n=2
```

## 返回方式

`m=proxy` 从图片所属 local、S3 或 WebDAV 后端读取已入库图片字节，并附带
`X-Image-Info`；它不声明 `Accept-Ranges`。`m=redirect` 返回 302 跳转到公开 URL。
这里的 `proxy` 只是返回传输方式，与图片导入模式无关。

`m=json` 返回 `application/json`，顶层 `count` 是实际数量，`items` 是图片数组：

```json
{
  "ok": true,
  "count": 1,
  "items": [
    {
      "id": "019f8457-063a-7002-a580-7a432dc7fd8d",
      "object_url": "https://static.example.com/media/pc/dark/theme/example.webp",
      "thumb_url": "https://static.example.com/thumbs/pc/dark/theme/example.webp",
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

只写 `m=json` 等同 `n=1`，但仍返回数组。`n` 是上限而非数量保证。GET 与 HEAD 都为
`no-store`；HEAD 返回与 GET 一致的状态、内容类型和内容长度，但不发送正文。

随机图也可通过 `https://random.<域名>/` 访问根路径，见[子域名](./subdomains.md)。
