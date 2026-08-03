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

查询使用有界、规范化的公开契约：

- 只接受表中六个精确小写键；`d`、`b`、`m` 各最多出现一次，空值等同未指定。
- 原始查询串最多 4096 字节。`t`、`tag`、`a` 每项最多 64 个字符，每类最多
  32 项，三类合计最多 64 项；数量按去重前的非空提交项计算，不能用重复值绕过。
- selector 可通过逗号或重复参数提交；空白片段忽略，单独的 `!`、控制字符以及同一类
  混用包含和排除均返回 400。
- 上述结构、数量、`d` / `b` / `m` 值域和互斥校验全部在读取词表、随机池 Redis 或
  存储前完成。主题、标签和作者随后统一按不区分大小写的 slug / 显示名解析。
- 未知包含项返回 404；未知排除项从有效筛选中删除。已存在于主题词表、但不属于当前
  随机池主题快照的主题仍按非法主题返回 400，其他合法但无图片的筛选返回 404。
- 解析后的 slug 按字段排序去重后生成规范签名，因此重复项、输入顺序、slug / 显示名
  写法和 `m` 返回方式不拆分短期去重或 Redis 筛选缓存。

完成所请求的词表解析后，正常 `/random` 选择路径不依赖 PostgreSQL，不使用
`ORDER BY random()`，也不使用 count + offset。随机池使用
`imageshow:random:<generation>:*` 命名空间；快照 generation 与内容通过单次 Redis
脚本读取，随机集合抽样与 item hash 读取也合并为一次往返；请求涉及的主题 / 标签 /
作者显示名并行解析。相同标签 / 作者筛选签名的并发临时集合构建会在进程内合并；
空结果由短 TTL 哨兵缓存。过滤集合先写候选键，并在读取缓存和发布候选时同时核对
mutation revision、completed revision 与增量锁，不发布过期筛选结果。

检测到合法增量锁时，筛选请求会用有界指数退避和抖动等待 completed revision 前进，
最长约 3 秒，足以覆盖正常 1–2 秒增量同步；等待期间不会误排队全量重建。锁消失但
revision 仍落后才按陈旧状态调度重建。Redis 访问失败或合法更新超过等待上限时返回 503，
并携带 `Retry-After: 1`；两种状态在内部使用不同错误类型，正常更新不再伪装成 Redis
故障。Redis 为空时应用启动后异步重建随机池，普通派生缓存为空不会阻止 HTTP 服务启动。
首次缺池触发另受 Redis 固定窗口保护：同一 10 秒窗口最多接纳 8 个跨实例冷构建
等待者，同进程相同构建只计一个共享 Promise；超额的随机 API 请求返回 429，并用
`Retry-After` 给出当前窗口剩余秒数。已有池暂时更新、Redis 故障或后台排队仍保持原有
503 / 恢复语义，不被误报为限流。

重建由进程内共享构建注册表与 Redis 分布式锁保证单飞：调用方中止只停止自己的等待，
不会取消仍被其他请求、启动预热或 Worker 共用的底层 Promise；底层操作一直登记到真正
收敛。进程关闭先禁止新构建并中止所有底层 controller，再与 Worker 一起有界排空，
因此不会遗漏已经脱离原请求的工作。repeatable-read 事务每批读取 500 条随机池所需
字段，批次序列化载荷在 16 MiB 以内保留于受控内存，超过阈值自动转存到 `data/tmp`
的 NDJSON spool；COMMIT 后才从内存 / spool 逐批写未发布 generation，随机池构建
不写全局图片 lookup。spool 使用非用户输入的随机文件名，校验单批、文件大小、批次数
和条目数，并在完成、失败、进程关闭或下次启动时清理。每次重建记录条目数、序列化
字节、峰值内存载荷估算及是否使用 spool。

全量与 `syncRandomImages` 共用 mutation revision，发布 Lua 同时核对 revision、重建锁
token，并要求增量锁不存在；续租失败、锁丢失、revision 变化或增量同步中都不能发布
generation。构建中的每个 Redis
键在写入同一事务内先取得一小时临时 TTL，成功发布后按 500 键批次移除 TTL；失败、
中止和结果确定未发布时按本次 generation 前缀与 manifest 定向 `UNLINK`，发布结果
不确定时保留 TTL，既不误删当前池也不会留下永久孤儿。发布 Lua 在切换 current 的同一
原子操作中把旧代际写入退役集合；发布收尾或下次启动会按 manifest 分批给其全部键补上
回收 TTL。当前代际先持久化 manifest，再用 `SSCAN` 有界校验并持久化其中的实际键；
增量同步由单个 Lua 栅栏原子核对 current generation、mutation revision、
update-lock token 与 manifest，并在同一步更新集合、item、snapshot、画廊筛选选项、
manifest 和 completed revision；
单次增量最多接收 200 张图片和 500 个集合键，超过任一边界就只推进 revision 并排队
全量重建，避免以超大 Lua 脚本长时间阻塞 Redis；
健康空池不登记不存在的 item hash。若进程中途退出，下次启动预热继续完成，缺失必需键则撤销 current 并让后台
重建任务接续。标签 / 作者筛选的每个 base、
union、intersection、difference 与 candidate 键也在创建事务内取得 90 秒 TTL，成功、
失败或中止后只 `UNLINK` 本次随机 token 所有的键；进程崩溃则由 TTL 收口。增量更新
锁同样使用 token 校验并定期续租，原子更新 Lua 还会校验锁所有权；锁丢失或写入状态不
确定时不推进 completed revision，而是排队 `cache.rebuild`。后台 Redis 巡检把当前
generation 的 manifest 缺失直接列为 issue；每次对 generation 最多检查 25 个 TTL，
但会轮换采样 offset，使超大 generation 的局部异常最终可见。

`m=proxy` 从图片所属的 local、S3 或 WebDAV 后端读取已入库图片字节，并附带 `X-Image-Info` 头；由于每次请求都会重新抽图，它不声明 `Accept-Ranges`。`m=redirect` 返回 302 跳转到图片的公开 URL。这里的 `proxy` 只是随机接口的返回传输方式，与图片导入模式无关。

随机图也可直接通过 `https://random.<域名>/` 访问（根路径 `/`，见
[子域名](./subdomains.md)）。图库总量和分类数量不从随机池推导，统一由主站
`GET /api/gallery-stats` 从 PostgreSQL 一致快照返回。
