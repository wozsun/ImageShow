# 随机图 API

`/random` 可以直接用作 `<img>` 地址或 CSS 背景，也可以用 JSON 一次取得多张图片的信息。下文用 `img.example.com` 代表站点地址。

## 快速开始

```html
<img src="https://img.example.com/random" alt="随机图片">
```

```css
body {
  background: url("https://img.example.com/random?device=pc&size=large") center / cover;
}
```

```bash
curl "https://img.example.com/random?mode=json&limit=3"
```

在站点的画廊或展映中设置好筛选条件，打开「分享」，在「随机图片API」一栏复制对应链接。

> [!WARNING]
> **在其他网站上使用前**
>
> 来自其他网站的请求会计入访问频率限制；直接引用站点自己提供的图片地址时还会检查来源。需要大量使用时，请联系站点管理员把你的网站加入允许列表，见[来源检查与频率限制](#来源检查与频率限制)。

## 参数

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `device` | `auto`、`pc`、`mb`、`all` | 横竖。`pc` 横版，`mb` 竖版，`all` 不限。默认 `auto`：按访问设备判断，无法判断时不限 |
| `brightness` | `dark`、`light`、`all` | 明暗，省略或 `all` 时不限 |
| `theme` | 主题，逗号分隔 | `theme=a,b` 属于其中任一主题；`theme=!a,!b` 排除这些主题；混写时取包含的主题中未被排除的，如 `theme=a,b,!b` 等同 `theme=a` |
| `author` | 作者，逗号分隔 | 写法同 `theme` |
| `tag` | 标签表达式，可重复 | 见[标签](#标签) |
| `size` | `large`、`medium`、`small` | 图片尺寸，省略时使用站点默认值（默认 `medium`） |
| `mode` | `redirect`、`proxy`、`json` | 返回方式，见[返回方式](#返回方式)。省略时使用站点默认值（默认 `redirect`），`json` 只能显式指定 |
| `limit` | 正整数 | 一次最多返回几张不重复的图片，超过 200 按 200 处理。大于 1 时只能搭配 `mode=json`；`limit=1` 与不填相同，任何返回方式都可用 |
| `seed` | 任意字符串 | 固定选图，见[固定选图](#固定选图) |
| `fallback` | 维度列表、`all`、`none` | 零匹配时依次放宽的条件，见[零匹配回退](#零匹配回退) |
| `id` | 图片 ID | 从指定图片范围中选，见[指定图片](#指定图片) |
| `group` | 分组标识 | 从指定分组的成员中选，见[图片分组](#图片分组) |

- 主题、标签、作者可以使用标识（如 `city-night`）或显示名（如 `城市夜景`）。
- 不存在的主题、标签、作者不匹配任何图片：`theme=a,写错的名字` 只返回主题 a 的图片，排除不存在的名字没有效果；要包含的名字全部不存在且未允许对应维度回退时返回 404，错误详情的 `ignored` 列出这些名字。
- `theme=null` 只选没有主题的图片，`theme=!null` 只选有主题的图片；`author=null`、`author=!null` 同理，按有无作者筛选。`null` 可与其他名字混写，如 `author=photographer,null` 为该作者或没有作者的图片。
- 参数值为空或只有空白（如 `device=`）时视为未填写，`seed`、`id` 和 `group` 除外；除 `seed` 外，参数值和列表项的首尾空白会被忽略，逗号分隔的列表会忽略空项，如 `theme=a,`；`theme`、`author` 还会忽略空的排除项，如 `theme=a,!`。
- `device`、`brightness`、`fallback`、`seed`、`mode`、`size`、`limit` 只取一个值。重复出现时，取值相同（不区分大小写，`seed` 除外）或其余几次为空，按一次处理，如 `size=small&size=small`、`device=&device=pc`；取值不同返回 400。`fallback` 比较时忽略空格和空项，但顺序不同算作不同取值。
- 参数名必须小写；不认识的参数会返回 400。

参数可以自由组合，分三类：`id` 与 `group` 决定从哪些图片里选，两者取并集，都省略时为整个图库；`device`、`brightness`、`theme`、`tag`、`author` 在其中筛选，同时满足才会被选中；`seed`、`limit`、`mode`、`size` 决定怎样取图和返回。

| 示例 | 含义 |
| --- | --- |
| `/random?theme=city-night` | 主题为「城市夜景」 |
| `/random?theme=城市夜景` | 同上，使用显示名 |
| `/random?theme=!city-night` | 不要主题「城市夜景」 |
| `/random?author=photographer` | 作者「photographer」的图片 |

> [!TIP]
> **不需要防缓存参数**
>
> 响应本身不会被缓存，不要附加 `?t=时间戳` 之类的参数，否则会返回 400。同一页面需要多张不同的图片时，用 `mode=json&limit=张数` 一次取得。

## 标签

| 写法 | 含义 |
| --- | --- |
| `tag=city,night` | 有「city」或「night」 |
| `tag=all:city,night` | 同时有「city」和「night」 |
| `tag=all:city,night&tag=rain` | （「city」和「night」）或「rain」 |
| `tag=all:city,night&tag=all:forest,fog` | （「city」和「night」）或（「forest」和「fog」） |

`tag=a,b` 也可以写成 `tag=a&tag=b`。多个 `tag` 参数之间总是“或”，标签条件与其他参数是“且”的关系。不传 `tag` 时也包括没有标签的图片。`all:` 组里有不存在的标签时，这一组不会命中，其他组照常生效。

## 零匹配回退

默认严格匹配。可用 `fallback=brightness,theme` 指定零匹配时允许放宽的维度，支持 `device`、`brightness`、`author`、`tag`、`theme`；书写顺序就是放宽顺序，每个维度只写一次。列表末尾可以写 `all`，表示其余维度按站点配置的顺序（`site.random_fallback_order`，默认为设备、明暗、作者、标签、主题）接在后面；单独写 `all` 即全部维度按站点顺序放宽。省略、空值或 `none` 不放宽。列表中同一项写了两次、`all` 不在末尾、`none` 与其他值混写、`null` 与未知值返回 400。

整个列表写在一个 `fallback` 参数里，用逗号分隔；中间经过的 CDN 可能重排查询参数，但不会改动参数值内部的顺序，所以不能用多个 `fallback` 参数表达顺序。

按列表顺序累加放宽，每放宽一项重新选图，有结果即停止，数量不足 `limit` 时也不会继续补齐。未实际限制的维度直接跳过；缺省 / 自动设备在识别出访问设备时也是限制，`device=all` 或无法识别设备时不算限制。

主题和作者只去掉包含条件，所有 `!` 排除条件仍有效；标签表达式整体去掉。未知的包含名称也可以随对应维度放宽。指定图片范围始终保留，范围为空仍返回 404。400、429、503、缓存不可用和近期图片重复本身不触发回退。

例如 `/random?theme=city&brightness=dark&fallback=brightness,theme` 先找暗色城市图片，再找不限明暗的城市图片，仍无匹配才移除主题条件；写成 `fallback=theme,brightness` 则先找不限主题的暗色图片。JSON 的 `fallback` 始终列出实际放宽的维度（按应用顺序），没有放宽时为 `[]`；跳转与代理只返回图片，不增加响应头。固定 `seed` 同时考虑有效筛选与实际放宽的维度集合，与放宽的先后无关。

## 返回方式

### redirect

返回 `302`，跳转到图片地址。地址可能在站点的 `/images/` 下，也可能是图片存储的公开地址。

### proxy

直接返回图片内容，`Content-Type: image/webp`。这种方式由站点转发图片，会占用站点带宽。需要图片信息时使用 `json` 模式。

### json

```bash
curl "https://img.example.com/random?device=all&mode=json"
```

```json
{
  "ok": true,
  "count": 1,
  "fallback": [],
  "items": [
    {
      "id": "00000000-0000-7000-8000-000000000001",
      "title": "示例图片",
      "author": "photographer",
      "url": "https://img.example.com/images/medium/01/00000000-0000-7000-8000-000000000001.webp",
      "device": "pc",
      "brightness": "dark",
      "theme": "theme",
      "tags": ["sample"],
      "width": 2200,
      "height": 1238,
      "byte_size": 218000,
      "image_time": "2026-08-03T12:00:00.000000Z"
    }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `count` | 实际返回的数量，可能少于 `limit` |
| `fallback` | 实际放宽的维度数组，按应用顺序排列；未回退时为 `[]` |
| `id` | 图片 ID |
| `title` | 标题 |
| `author` / `theme` / `tags` | 作者、主题、标签的标识；没有作者或主题时为 `null` |
| `url` | 所选尺寸的图片地址（绝对地址） |
| `device` / `brightness` | 横竖（`pc` / `mb`）、明暗（`dark` / `light`） |
| `width` / `height` / `byte_size` | 所选尺寸的宽、高（像素）和文件大小（字节） |
| `image_time` | 图片时间，UTC，精确到微秒 |

`/random` 的响应都带 `Cache-Control: no-store`，也支持 `HEAD` 请求。JSON 中的图片地址有自己的缓存策略，可以保存并重复使用。

## 固定选图

传入 `seed` 后，只要筛选条件和符合条件的图片集合不变，同一个 `seed` 就会得到相同的选图结果。单图模式固定一张；`mode=json` 可以搭配 `limit` 返回顺序固定、互不重复的多张图片：

```text
/random?device=pc&seed=wallpaper
/random?device=all&seed=2026-09-15&mode=json&limit=3
```

- `seed` 只是一个普通字符串，不会随时间变化。想要“每日一图”，每天传入当天的日期即可。
- 只增大 `limit` 时，原来的图片仍位于结果开头，顺序不变。例如 `limit=5` 的前三张与 `limit=3` 相同。符合条件的图片不足时，只返回实际数量。
- 切换 `size` 不改变选中的图片；单图模式返回同一组结果中的第一张。
- 图库新增、删除或修改图片后，同一个 `seed` 可能选到别的图片。
- 默认的 `device=auto` 会因访问设备不同而得到不同结果；需要在所有设备上一致时，指定 `device=pc`、`mb` 或 `all`。
- `seed` 保留大小写和首尾空白，不能是空字符串、纯空白或包含控制字符。
- 与 `id` 同用时，同一个 `seed` 在指定图片（经筛选后）中得到固定顺序，见[指定图片](#指定图片)。

## 指定图片

`id` 可以是完整的图片 ID，也可以是 ID 的最后 12 位。用逗号分隔或重复参数传多个，每次最多 32 个，站点从中随机选取：

```text
/random?id=00000000-0000-7000-8000-000000000001
/random?id=000000000001,000000000002&mode=json&limit=2
```

`id` 可以搭配其他所有参数：

- 筛选参数在指定图片中再按同样的含义筛选，如 `id=…&brightness=dark&theme=city-night`；没有图片同时满足时返回 404。
- `device` 也与普通请求相同：默认的 `auto` 按访问设备只取横版或竖版，指定图片中没有这类图时返回 404，不会改取另一类。需要不论访问设备都取这些图片时，写 `device=all`。
- 不带 `seed` 时随机选取，并尽量避开最近返回给同一访问者的图片；只指定一张图时照常返回这一张。
- 带 `seed` 时结果固定：同一个 `seed`、规范化后的范围和筛选条件与同一组符合条件的图片得到相同顺序，增大 `limit` 时原来的图片仍在开头。不同 `seed` 之间相互独立，图片较少时可能选到同一张；需要一组互不重复的固定图片时，用 `seed` 搭配 `mode=json&limit`。

回收站中的图片不会被选中。

## 图片分组

`group` 只接受分组标识（slug），不接受显示名。用逗号或重复参数指定多个分组，每次最多 32 项；多个分组取并集，重复成员只出现一次。与 `id` 同用时，先合并分组成员与指定图片，再应用设备、明暗、主题、标签和作者筛选。

```text
/random?group=wallpaper&fallback=device
/random?group=a,b&device=all&mode=json&limit=146
/random?group=a&group=b&id=000000000001&device=all
/random?group=wallpaper&device=mb&seed=daily
```

背景类嵌入可显式加 `fallback=device`，允许范围内没有对应设备图片时改取其他设备；想取整组、不随访问设备筛选时使用 `device=all`。缺省与显式 `device=auto` 均按访问设备筛选，分组不会隐含放宽条件。`fallback` 始终保留 `group` 与 `id` 合并后的范围。

未知分组不匹配任何图片，与有效分组混用时仍可取有效成员；全部未知、空组、成员全部在回收站或筛选后无剩余时返回 404。未知标识在错误详情 `ignored.group` 中列出。空参数、非法标识或超过 32 项返回 400。

分组没有成员数量上限，单次 JSON 仍最多返回 200 张。超过 200 张时可多次请求，不带 `seed` 会尽量避开近期返回的图片；这不是分页接口，不保证有限次请求覆盖整个分组。固定 `seed` 的请求遵循[固定选图](#固定选图)规则。

## 来源检查与频率限制

> [!NOTE]
> **以下是默认设置**
>
> 频率限制的次数和时长、允许列表都由站点管理员设置，各站点的实际值可能不同。

**频率限制**：默认每个 IP 在 60 秒内最多取 60 张图。不带 `limit` 的请求计 1 张，`limit` 不超过 6 时按 `limit` 计张数；`limit` 大于 6 的请求另行计数，60 秒内最多 10 次。超出后返回 `429`，响应头 `Retry-After` 表示需要等待的秒数。

| `limit` | 不带或 1 | 2 | 3 | 4 | 5 | 6 | 7–200 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 60 秒内可请求次数 | 60 | 30 | 20 | 15 | 12 | 10 | 10 |

分界值 6 等于图片额度除以批量请求次数（60 ÷ 10），管理员调整这两项后随之变化。

**来源检查**：站点按请求的 Referer 判断来源。

- 来自站点自身或允许列表中网站的请求，不计入频率限制；其他请求，包括没有 Referer 的请求，都会计入。
- `/random` 不按来源拒绝请求，`redirect` 跳转时要求浏览器不发送 Referer。使用 `<img src="https://img.example.com/random">` 或 `mode=proxy` 时仍受上述频率限制；跳转到外部图片地址后，还需遵守该服务的访问规则。
- 站点自己提供的三档公开图片地址（主站 `/images/large/*`、`/images/medium/*`、`/images/small/*`，或本地存储的独立图片域名）只允许没有 Referer、来自站点自身或允许列表的请求，其他来源返回 `403`；云存储的公开地址不经过这项检查。在其他网站直接使用这类地址（例如 `mode=json` 返回的 `url`）时，给图片加上 `referrerpolicy="no-referrer"`。

需要大量使用时，请站点管理员把你的网站加入允许列表（后台「站点配置 → 外部嵌入」）。

## 跨站读取

`/random` 的三种模式及错误响应都允许匿名跨站读取（`Access-Control-Allow-Origin: *`），不要求调用网站位于嵌入允许列表中。浏览器可以直接获取 JSON：

```js
const response = await fetch(
  "https://img.example.com/random?device=all&mode=json&seed=wallpaper&limit=3",
  { credentials: "omit" }
);
if (!response.ok) {
  const retryAfter = response.headers.get("Retry-After");
  throw new Error(`随机图请求失败：${response.status}${retryAfter ? `，${retryAfter} 秒后重试` : ""}`);
}
const { items } = await response.json();
// items 中每项的 url 可用于图片、背景或轮播。
```

- `credentials: "omit"` 表示不发送登录 Cookie 等凭据。这些公开入口不开放携带凭据的跨站读取，不要设为 `"include"`；同站后台登录不受影响。
- CORS 让浏览器能够读取响应；[频率限制和图片来源检查](#来源检查与频率限制)仍然生效。iframe 是否允许嵌入则由[嵌入设置](embed.md#开启嵌入)决定。
- 主站三档公开图片和 ImageShow 提供的独立本地图片地址也支持匿名跨站读取。用 `fetch(item.url, { credentials: "omit", referrerPolicy: "no-referrer" })` 可省略 Referer 并读取图片内容；原图 `/images/original/*` 需要管理员登录，不开放跨站读取。
- 如果返回或跳转到云存储、CDN 等外部地址，最终图片响应也必须允许跨站读取。外部服务未配置 CORS 时，可以使用本站 `mode=proxy` 获取图片内容。

请求使用 `GET` 或 `HEAD`。`/random` 支持 `OPTIONS` 预检，允许 `Content-Type` 请求头，并向浏览器脚本开放读取 `Retry-After`。三档图片的预检允许 `Range`、`If-None-Match`、`If-Modified-Since`、`If-Range` 请求头，响应额外开放读取 `ETag`、`Content-Range`、`Accept-Ranges`。

## 错误

出错时返回 JSON：

```json
{ "ok": false, "code": "not_found", "error": "Not Found: No available images" }
```

| 状态码 | 原因 |
| --- | --- |
| `400` | 参数格式错误，例如未知参数、取值不合法、同一参数重复且取值不同、`limit` 大于 1 而未指定 `mode=json` |
| `403` | 直接引用站点提供的图片地址时，来源不在允许列表中 |
| `404` | 没有符合条件的图片，包括要包含的主题、作者或标签全部不存在，以及指定的图片或分组不存在、分组为空或筛选后没有剩余 |
| `405` | `/random` 使用了不支持的请求方法 |
| `429` | 请求过于频繁，按 `Retry-After` 等待后重试 |
| `503` | 站点暂时不可用，稍后重试 |

参数限制：

- 查询串最多 4096 字节；`device`、`brightness`、`seed`、`mode`、`size`、`limit` 不能以不同的值重复。
- `limit` 不能为 0；`tag` 不支持排除写法。
- `theme`、`tag`、`author` 每项最多 64 字符，每类最多 32 项，合计最多 64 项。
- `id` 与 `group` 各最多 32 项；分组标识最长 32 字符，由小写字母、数字和连字符组成，首尾必须为字母或数字。`seed` 最多 128 字符。
