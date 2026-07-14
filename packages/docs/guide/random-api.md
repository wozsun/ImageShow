# 随机图 API

`GET /random` 从随机池中按各分类的图片数量加权选取一张图片：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `d` | `pc` / `mb` / `r` | 设备，缺省按 User-Agent 推断，`r` 强制随机 |
| `b` | `dark` / `light` | 亮度，缺省两者皆可 |
| `t` | 逗号分隔主题 | 缺省全部；`t=a,b` 为包含，`t=!a,!b` 为排除，二者不可混用 |
| `tag` | 逗号分隔标签 | 缺省全部；包含为「任一」，`!` 前缀为排除，二者不可混用 |
| `a` | 逗号分隔作者 | 缺省全部；`a=x,y` 为包含，`a=!x,!y` 为排除，二者不可混用 |
| `m` | `proxy` / `redirect` | 返回方式。缺省时取设置页默认值（普通图与外链图一致，见下） |

`t` / `tag` / `a` 均可填 slug 或显示名（自动解析为 slug）。基础随机、主题筛选、标签筛选和作者筛选都在 Redis 随机池中完成：先按 axis/category 计数加权选集合，`tag` / `a` 再通过短期 Redis 过滤集合做包含或排除。

正常 `/random` 请求不依赖 PostgreSQL，不使用 `ORDER BY random()`，也不使用 count + offset。快照 generation 与内容通过单次 Redis 脚本读取，随机集合抽样与 item hash 读取也合并为一次往返；主题 / 标签 / 作者显示名并行解析。相同标签 / 作者筛选签名的并发临时集合构建会在进程内合并。Redis 随机池不可用时返回 503；Redis 为空时应用启动后异步重建随机池，普通派生缓存为空不会阻止 HTTP 服务启动。

重建由进程内合并与 Redis 分布式锁保证单飞：repeatable-read 事务只分批读取随机池所需字段，COMMIT 后才写未发布 generation，随机池构建不写全局图片 lookup。全量与 `syncRandomImages` 共用 mutation revision，只有完成快照后仍通过 Lua 原子校验的 generation 才会发布；失败的未发布 generation 会定向清理或设置 TTL。增量更新锁使用 token 校验并定期续租，完成 Lua 还会校验锁所有权；锁丢失或写入状态不确定时不推进 completed revision，而是排队 `cache.rebuild`。

`m=proxy` 直接回源图片字节并附带 `X-Image-Info` 头；由于每次请求都会重新抽图，它不声明 `Accept-Ranges`。`m=redirect` 返回 302 跳转到图片的公开 URL。

**外链图（is_link）的返回方式**：与普通图一样遵循设置页默认值，显式 `m=` 始终优先（外链图不再恒定走代理）。区别只在“图片公开 URL”指向哪里——外链图的公开 URL 是 `link.<域名>/media/<id>.<ext>`，而非外部主机。

- `m=redirect`：302 跳转到该 `link.<域名>/media` 地址；浏览器随后请求它，由**服务端代理**抓取外部原图——以图片自身域名作为 `Referer`（浏览器无法伪造，服务端可以）绕过防盗链——再转发字节。因此 redirect 也能稳定显示外链图。
- `m=proxy`：`/random` 直接同源回源外链图字节（便于用 `fetch` 取 blob）。

两种方式最终都经服务端代理，拉取失败时降级为 302 到外部 URL（尽力而为）。

`GET /img-count` 返回随机池的分组与主题统计（不接受任何查询参数）。随机图也可直接通过 `https://random.<域名>/` 访问（根路径 `/`，见 [子域名](./subdomains)）。
