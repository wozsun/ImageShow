# 随机图 API

`GET /random` 从随机池中按各分类的图片数量加权选取一张图片：

| 参数 | 取值 | 说明 |
| --- | --- | --- |
| `d` | `pc` / `mb` / `r` | 设备，缺省按 User-Agent 推断，`r` 强制随机 |
| `b` | `dark` / `light` | 亮度，缺省两者皆可 |
| `t` | 逗号分隔主题 | 缺省全部；`t=a,b` 为包含，`t=!a,!b` 为排除，二者不可混用 |
| `tag` | 逗号分隔标签 | 缺省全部；包含为「任一」，`!` 前缀为排除，二者不可混用 |
| `a` | 逗号分隔作者 | 缺省全部；`a=x,y` 为包含，`a=!x,!y` 为排除，二者不可混用 |
| `m` | `proxy` / `redirect` | 返回方式。缺省时取设置页默认值 |

`t` / `tag` / `a` 均可填 slug 或显示名（自动解析为 slug）。基础随机、主题筛选、标签筛选和作者筛选都在 Redis 随机池中完成：先按 axis/category 计数加权选集合，`tag` / `a` 再通过短期 Redis 过滤集合做包含或排除。

正常 `/random` 请求不依赖 PostgreSQL，不使用 `ORDER BY random()`，也不使用 count + offset。随机池使用 `imageshow:random:<generation>:*` 命名空间；快照 generation 与内容通过单次 Redis 脚本读取，随机集合抽样与 item hash 读取也合并为一次往返；主题 / 标签 / 作者显示名并行解析。相同标签 / 作者筛选签名的并发临时集合构建会在进程内合并；空结果由短 TTL 哨兵缓存。过滤集合先写候选键，并在读取缓存和发布候选时同时核对 mutation revision、completed revision 与增量锁，不发布过期筛选结果。

检测到合法增量锁时，筛选请求会用有界指数退避和抖动等待 completed revision 前进，
最长约 3 秒，足以覆盖正常 1–2 秒增量同步；等待期间不会误排队全量重建。锁消失但
revision 仍落后才按陈旧状态调度重建。Redis 访问失败或合法更新超过等待上限时返回 503，
并携带 `Retry-After: 1`；两种状态在内部使用不同错误类型，正常更新不再伪装成 Redis
故障。Redis 为空时应用启动后异步重建随机池，普通派生缓存为空不会阻止 HTTP 服务启动。

重建由进程内合并与 Redis 分布式锁保证单飞：repeatable-read 事务每批读取 500 条随机池所需字段，批次序列化载荷在 16 MiB 以内保留于受控内存，超过阈值自动转存到 `data/tmp` 的 NDJSON spool；COMMIT 后才从内存 / spool 逐批写未发布 generation，随机池构建不写全局图片 lookup。spool 使用非用户输入的随机文件名，校验单批、文件大小、批次数和条目数，并在完成、失败、进程关闭或下次启动时清理。每次重建记录条目数、序列化字节、峰值内存载荷估算及是否使用 spool。

全量与 `syncRandomImages` 共用 mutation revision，只有完成快照后仍通过 Lua 原子校验的 generation 才会发布；失败的未发布 generation 会定向清理或设置 TTL。增量更新锁使用 token 校验并定期续租，完成 Lua 还会校验锁所有权；锁丢失或写入状态不确定时不推进 completed revision，而是排队 `cache.rebuild`。后台 Redis 巡检把当前 generation 的 manifest 缺失直接列为 issue；每次对 generation 最多检查 25 个 TTL，但会轮换采样 offset，使超大 generation 的局部异常最终可见。

`m=proxy` 从图片所属的 local、S3 或 WebDAV 后端读取已入库图片字节，并附带 `X-Image-Info` 头；由于每次请求都会重新抽图，它不声明 `Accept-Ranges`。`m=redirect` 返回 302 跳转到图片的公开 URL。这里的 `proxy` 只是随机接口的返回传输方式，与图片导入模式无关。

`GET /img-count` 返回随机池的分组与主题统计（不接受任何查询参数）。随机图也可直接通过 `https://random.<域名>/` 访问（根路径 `/`，见 [子域名](./subdomains)）。
