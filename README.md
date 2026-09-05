# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是面向个人服务器的自托管图片画廊、随机图 API 与轻量后台管理服务。项目由
Node.js 26 / Hono、React 19、PostgreSQL、Redis 8 和 Docker 构成。

## 功能

- 公开首页、双模式 WebGL 展映、瀑布流画廊、图片详情与可选无导航嵌入页。展映与画廊
  共用主导航、五类筛选、副导航和详情；展映只在自动播放期间启用三秒无点击隐藏，暂停播放即取消计时，
  恢复播放后重新计满三秒。加载、无图、错误、页面隐藏、减少动态效果或 WebGL 暂停时不计时，鼠标移动不重置计时。桌面双模式中，鼠标向上
  拖动仍收起导航，向下拖动及其惯性不唤出；滚轮和移动端拖动保留原有显隐行为。菜单、筛选面板或详情展开时暂停计时。
  已展开导航内存在鼠标悬停或键盘焦点时，取消计时并暂停滚动收起；两者都离开且展映正在自动播放时重新计满三秒，首页主导航及嵌入页
  同样保护导航内的操作。触控设备忽略触摸残留的悬停和普通按钮焦点，关闭筛选后恢复自动隐藏及滚动收起，仍保护键盘可见焦点。
  画廊不启用空闲计时，只保留滚动显隐。展映与画廊的主导航、筛选栏及背景通过同一位移收起。
  画廊、展映及其嵌入页启用 iOS 安全区布局；展映画布和底部操作层使用动态视口高度，导航、
  筛选、回顶及展映按钮避开刘海和底部安全区，离开这两类页面后恢复原有视口设置。
  展映中加载失败的缩略图，在详情成功加载同一 URL 后会原位重试，保留卡片位置、缩放和已有纹理；
  仍然失败时继续暂停请求，避免反复重试。
  展映、画廊及其嵌入页共用固定、不重复平铺的星点背景，保留各页面的底色、光晕与明暗层次。
  首页、画廊与展映均可通过真实鼠标移入内容视口顶部 36px 唤出导航，画布合成移动与导航动画造成的悬停目标变化不触发唤出。
  唤出后沿用各页面的隐藏规则。展映以一个共享 PixiJS Application、ticker 与有界纹理
  LRU 在 `waterfall` 和 `float` 间切换。`waterfall` 支持全向拖动、wheel / pinch 缩放、惯性、
  自动巡航及 `0.5G–8G` 逐列尺寸调整，手动运动结束后立即恢复巡航。首次超过 `3G` 前提示：
  “继续显示更多图片会占用更多内存和 GPU，可能会**卡顿掉帧**。”取消停在 `3G`，确认后本次浏览不再重复提示；
  按钮、Ctrl + 滚轮和双指缩放共用该限制。缩放位移
  不触发导航显隐，只有手动平移及其惯性位移参与导航滚动采样；`float` 让错位图片持续上浮，
  按局部空位、预测遮挡与相邻间距调整布局和路径，每档混排目标宽度 50%–130% 的图片，让较小图片
  填补大图之间的空位；横移缓慢加减速，并叠加约 ±3° 的旋转，放大时按混合面积调整数量和平滑布局。
  上下拖动和滚轮纵移持续双向回收、补图，已回收区域重新取图，不保留历史画面；暂停自动漂浮后仍可手动滚动和加载。
  快速反向会清除旧方向的剩余位移，只调配完全屏外的卡片补足进入侧缓冲；大幅位移分段补图，保持屏内图片连续移动。
  上下两侧分别保留后续纹理队列，合计仍在共享预算内按窄屏 6–18 张、宽屏 12–36 张提前加载。
  鼠标离开画布或浏览器窗口失焦时清除悬停，直到指针重新进入画布才恢复图片命中。
  两种展映模式的底部按钮随导航收起降至 30% 不透明度，底部提示使用偏白的浅灰蓝文字与较深的灰色描边，
  保持显示并降至 20% 不透明度；导航出现、鼠标靠近任一侧按钮或键盘聚焦按钮时，两侧控件和提示同步恢复。
  模式可由 `/show?mode=waterfall|float` 指定，缺省读取站点配置且
  不改写地址栏；右下角模式链接在手动切换时始终显式写入目标 `mode`，包括切回默认模式。
  启用嵌入后，`/embed/home`、`/embed/show`、`/embed/gallery` 复用对应公开页，只省去主导航。
  嵌入展映保留双模式、筛选、详情与底部操作，支持相同的 `mode` 参数，切换后仍停留在嵌入路径；
  首页筛选入口默认进入展映，可配置为画廊；嵌入首页遵循同一配置，父页面来源沿用嵌入白名单。
  图片、动画与命中检测不进入 React 逐帧渲染；DOM 继续负责导航、控件、详情与键盘 / 读屏代理，
  同图重复填屏时键盘焦点只作用于当前卡片；鼠标关闭详情回到画布，键盘关闭回到原卡片代理，
  后续真实鼠标操作把 DOM 焦点交回画布，避免旧卡片继续响应。
  离页时释放 Canvas、ticker、输入与纹理引用。画廊卡片使用标题或 UUID 短标识，
  列表只携带主题 / 标签 slug，Web 复用会话级画廊 facets 映射显示名并派生卡片副标题；长画廊
  使用有界 DTO / DOM 窗口，远页按 keyset cursor 恢复。移动端首页目录显示约 8 行半主题、7 行半标签和 6 行半作者选项，以
  露出的半行提示还可继续滚动；桌面端目录尺寸保持不变。后台图库、无主题与回收站则由
  服务端按数字页直达，不在浏览器补齐前序 cursor 边界。公开画廊与后台图片页共用主题、标签和
  作者筛选组件：展开时搜索框在原筛选按钮位置内联显示，并在同一次直接激活中取得输入焦点；
  候选、已选及包含 / 排除仍由锚定弹层承载，软键盘平移页面时，弹层继续保持与该输入槽的邻接间隔；
  两页都可一次清空设备、亮度、主题、标签和作者筛选，移动端清空不会改变外层筛选面板开合。
  展映、画廊与后台图片页的筛选控件不再重复显示上方字段和操作标题，保留控件内文案及无障碍名称。
  公开工具栏在链接框内前部显示“随机API”，生成的随机图片链接按剩余可用宽度截断，并在复制按钮前以贴合文字基线的 ASCII `...`
  标记；“随机API”和省略号不可选。首次点击或键盘聚焦链接时全选完整 URL，保持焦点后可局部选择，
  移开焦点后再次进入会重新全选；复制按钮始终使用完整 URL。
  公开与后台详情中的当前展示图保留
  浏览器原生右键与长按保存能力；未登录访客的公开“原图”按钮由
  `site.gallery.public_original_button` 控制，服务端确认已登录的管理员则继续复用同一详情中的
  管理能力判定并始终看到该入口。“来源”与“原图”只打开各自另行登记的地址，互不替代。
- 主站 `/random` 随机图 API，以及集中承载本地媒体、缩略图和外链原图直连决策 / 代理的
  `static.*` 资源子域；已解析随机池在一次只读 Redis 原子调用内完成校验、抽样和 rich item
  读取，近期去重与最终排序仍由应用负责；不提供随机、外链或主题专用子域。
- 后台图片上传、URL / JSONL / 微博导入、编辑、分类、回收站、日志与运行状态检查；本地上传
  使用一次有界 Upload intent POST 加逐文件 raw PUT，Import 来源一次批量 accept 后由单实例 Redis
  worker 接管。页面上传窗口、Server raw、Upload / Import 共用的 prepare / staging、全部 Sharp
  normalize 与最终 commit 各有唯一准入 owner；prepare / staging 和 Import 后继窗口均由 normalize
  容量派生，前者限制持有处理后 Buffer 直至 `_uploads` 和 ready 发布，后者只预取下一批 raw；
  raw 已完整但尚未取得 Normalize 许可时明确显示“待处理”并计入等待，许可取得后才显示“处理中”。
  微博帖子元数据请求全进程串行，复用一个访客身份并在相邻请求间随机等待 2–5 秒；解析器按媒体
  实际所属 status 提取账号 UID，批次结束后一次查询 PostgreSQL 作者身份，为命中项填入作者草稿，
  再进入同一后继窗口。作者身份只由管理员保存的主页链接派生，不在 RuntimeConfig 或 Redis 维护
  第二份映射。
  `import.keep_original_link` 可分别决定 URL、JSONL 与微博导入是否把下载 URL 保留为公开原图链接，
  `weibo.source_enabled` 独立决定新解析的微博图片是否填写帖子来源页；两项都不影响素材下载与入库。
  Upload、Import 与直接 API 共用 `ingestion.*` 的原图体积、长边和队列分页边界，页面预检不替代
  Server 权威校验。Upload / Import 的默认标签和逐图标签都使用固定单行可视窗口；按需覆盖的
  22px 圆角边缘按钮、标签框内独占的鼠标滚轮、触控板原生横向手势和移动端拖动可浏览全部已选
  标签，不改变工作流纵向布局。上传、导入和图片编辑的标签在禁用期间保留原有宽度与删除符号，
  避免保存时布局跳动。逐图原图 / 来源 URL 只在失焦时执行共享的 HTTPS 格式解析；
  无效编辑不进入草稿同步，也不显示界面提示或状态，真正的远端图片下载与外链代理继续由
  Server 独立安全校验。
  异步提交只冻结意图并以 PostgreSQL 图片行
  确认完成；相同最终内容在提交边界
  串行确认，单项重复冲突不会中断同一批的其他图片，确认后复用该项已锁定的提交意图继续；
  Upload / Import 队列按当前管理员分别用一个 SSE 和有界分页快照同步；展示保持新批次置顶、
  同批来源顺序 1→N，并在窗口重开和跨页后保持稳定。重连只废止旧动作权威，当前页继续稳定
  展示直至新快照原位替换；实时 completed 直接复用提交事务生成的 PostgreSQL 投影，窗口恢复时
  再按页批量水合，并按精确 pair 同步当前文档中暂时离页的卡片，翻页首帧无需等待新快照才显示
  最终状态；全队列提交、默认值和清理
  使用预冻结签名 watermark 与有界 continuation，HTTP 接管到状态通道之间以独立 revision
  围栏和点击时精确 pair 集合关闭动作缺口。Server 在冻结最大 accepted order 后按 order 递增扫描
  候选，仍保留逐项并发且不把水位后的新任务纳入本轮；当前文档在窗口生命周期内保留新建批次的来源
  顺序，业务权威仍逐项立即转交 Server，窗口重开后才完全使用 Server display；重复详情按
  当前页 MD5 批量读取 PostgreSQL；单项取消以 `discarded` 的精确队列 revision 立即释放卡片和
  统计，页界收缩时先原子夹紧当前页，再用一次权威快照证明，旧分页基线不会把已移除项重新
  插回列表；另一窗口已经退休的当前文档 pair 会在快照中精确返回 stale，缺失 canonical 的
  有界集合只批量反查一次 display 投影，不随 stale 数量重复扫描整条队列；
  “导入图片”主按钮与下拉按钮共享内容接入工作流和来源输入模块的意图预载，来源菜单选择会在
  菜单退场前同步取得启动互斥；惰性加载与最外层工作流共用页面根 `inert` 锁，背景按钮从点击、
  显示到淡出都不呈现业务禁用；窗口首帧在首份 bounded snapshot 返回前直接显示默认选择入口，
  服务端汇总先到时仍保留该入口，直到未完成任务水合为现有队列卡片后才替换，不插入空白等待
  画面；接管后的逐项事件在
  bounded snapshot 覆盖前保留来源无关的临时汇总占位，
  处理开始时只在等待与处理中迁移而不回落总数；完成事件按提交批次合并刷新
  图库投影，关闭窗口默认只清理当时已经完成的卡片与 Redis 回执，未完成任务继续保留。
- local 与多个 S3 兼容对象存储后端并存；支持单图、批量和整后端迁移，以及检查页显式
  预览、确认后执行的存储维修与孤儿清理。单实例后台还会按固定周期回收超过保守年龄门槛、
  且不再被 Redis canonical 精确引用的 raw、`.part` 与 `_uploads` generation；Redis 异常、
  存储列表不完整或键代际无法解析时保守保留。正式候选在复制前登记持久清理 guard，只有
  PostgreSQL 未引用时才会回收。业务清理与永久删除统一使用 provider 中性 1…N 契约；S3 / COS 原生
  `DeleteObjects` 每批最多 1000 个 key，业务清理与永久删除生产者固定共享一个活动调用，
  并逐对象确认结果。
- 完整展示图固定使用 `full/<UUID 尾部两位>/<UUID>.<ext>`，缩略图使用
  `thumbs/<UUID 尾部两位>/<UUID>.webp`；设备、亮度、主题、作者和标签只保存在 metadata，
  这些可编辑属性只更新 PostgreSQL metadata，正式对象键与所在存储后端保持不变。
- 成功提交的图片以正式缩略图为不变量；正常读取严格只读，缺图显示统一损坏图标并由
  检查页“存储维护”显式修复。数据库已记录有效缩略图时，维修会先确认现有对象；记录为
  未采用时直接校验原图并生成，再在发布前复核当前位置和缩略图，避免无消费者的远端探测。
- PostgreSQL 保存全部业务真值，Redis 只承载会话、限流、统一就绪图片投影与可重建缓存。
- 回收站单图、批量与清空操作先把精确 `1..N` 成员原子绑定到持久 `trash.purge` 任务，再由后台
  逐图删除对象；正常确认弹窗等待该范围完全删除后只刷新一次。断线、有限等待结束或任务异常时，
  列表才以“待彻底删除”显示尚未完成的成员并禁用恢复，不用浏览器轮询冒充完成状态。耗尽重试和
  异常引用修复集中在检查页“存储维护”，一次确认同时覆盖存储对象和持久删除任务。
- 后台概览只对固定核心图片投影键执行准确内存测量，不扫描键空间；卡片可见副标题只保留
  占用大小与同步状态，来源和测量时间留在 hover 详情。检查页先以固定成本展示图片投影
  数量、revision 与重建时间，再自动执行一次有界 Redis 深检，扫描当前 ImageShow 键空间
  并汇总核心 / 派生占用；手动 Redis 检查复用同一查询。
- 图片管理员与超级管理员使用集中权限矩阵；高风险接口在服务端独立鉴权。
- 管理员会话按空闲时间过期；只有既有 `/api/admin/auth/me` 探针成功确认会话时才滑动续期，
  普通后台请求、公开页与后台之间的路由切换及长连接认证心跳都不会额外 touch 或启动轮询。
- 管理员偏好跨端同步，公开页面固定暗色，后台可选亮色、暗色或跟随设备。
- 应用配置默认值由服务端统一提供，前端在真实配置就绪后使用；后台初次读取失败可重试，
  后台刷新失败时保留已有配置和正在操作的工作流。
- 超级管理员可导出固定格式的完整配置包；导入时由目标版本逐项采用可识别值，缺失或错误值
  使用当前默认值，未知字段与无法安全识别的存储后端独立跳过，不维护跨版本迁移链。导入在
  FIFO 写租约内先原子持久化候选文件，完成 PostgreSQL 结果核对并作出收敛决定后才向活进程
  发布；结果无法确认时保留并发布候选、返回明确 503，由管理员核对配置文件与后端注册表。
- 单应用实例、可信反向代理和容器健康检查组成当前生产边界。

完整行为见[维护文档](docs/README.md)，随机接口见
[随机图 API 指南](docs/guide/random-api.md)。

## 快速开始

仓库根目录的 `compose.yaml` 用于本地体验、开发和干净安装验证，包含 PostgreSQL 与
Redis。Docker 部署不需要宿主机安装 Node.js；只有源码开发时需要 Node.js
`>=26.3.0 <27`。

### 配置

默认 `compose.yaml` 不提供数据库密码或首个 super 管理员密码。首次启动前先复制环境变量
模板，并为 `DATABASE_PASSWORD` 与 `ADMIN_PASSWORD` 分别设置非空密码；任一变量未设置或
为空时，Compose 会在展开阶段直接失败：

```bash
cp .env.example .env
```

`.env.example` 是完整环境变量目录，但 `.env` 只作为 Compose 插值来源。默认
`compose.yaml` 的 ImageShow 环境前部只保留空数据启动必要值：与 PostgreSQL 共享的数据库
名、用户名和密码，以及首次管理员用户名和密码，共五项。其他部署覆盖和全部 RuntimeConfig
seed 均不会因出现在 `.env` 而自动进入容器。需要填写的前五项为：

```ini
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=                   # 8–128 位且同时包含字母和数字
```

两个密码没有默认值，应使用不同的随机强密码。`ADMIN_*` 只在数据库尚无 super 管理员时使用，
不会覆盖已有账号。数据库身份每次启动都由默认 Compose 注入；内置拓扑的数据库 host / port、
Redis 连接和时区使用代码默认值。外部拓扑需要在 Compose override 中逐项映射对应变量。其他
应用配置保存在 `data/config.json`，完整字段见
[配置说明](docs/guide/configuration.md#runtimeconfig-参数目录)。当前根页面字段为
`site.root`，可选择 `home`、`show` 或 `gallery`，对应首次播种变量 `SITE_ROOT`。首页筛选入口与
展映的启用、自动播放、默认模式、初始密度、漂移速度、默认顺序及画廊启用状态也分别支持
`SITE_HOME_BROWSE_TARGET`、`SITE_SHOW_ENABLED`、`SITE_SHOW_AUTOPLAY`、`SITE_SHOW_MODE`、`SITE_SHOW_DENSITY`、
`SITE_SHOW_DRIFT_SPEED`、`SITE_SHOW_ORDER`、
`SITE_GALLERY_ENABLED` 首次播种。首页、展映与画廊均关闭时，根路径返回 404，后台与随机图 API
仍可通过自身路径访问；
`SITE_DOMAIN`、`SITE_DESCRIPTION` 和其他 seed 一样，
只有显式扩展 `services.imageshow.environment` 后才参与空目录首次生成。公开原图入口字段为
`site.gallery.public_original_button`，对应 `SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON`；现行每个
RuntimeConfig 叶子都有唯一环境变量映射，不保留配置文件专属分支。
配置包的导出、目标版本宽松识别、敏感凭据与冲突重命名边界见
[配置说明中的配置包章节](docs/guide/configuration.md#配置包)。

### 启动

```bash
docker compose pull
docker compose up -d
```

首次登录后台时，用户名默认为 `admin`，密码使用 `.env` 中设置的 `ADMIN_PASSWORD`。

Linux bind mount 用户应先确保镜像用户 UID/GID `1000` 可写数据目录：

```bash
sudo install -d -o 1000 -g 1000 data
```

默认 Compose 固定把 `127.0.0.1:5518` 映射到容器内 `5518`；需要其他宿主端口或绑定地址时
使用 `compose.override.yaml`、其他部署清单或 `docker run -p [host-ip:]<host-port>:5518`。
配置域名后可访问：

- `https://img.example.com/home`
- `https://img.example.com/show`
- `https://img.example.com/gallery`
- `https://img.example.com/admin`
- `https://img.example.com/random`

本地正式图片和配置位于 `./data`，PostgreSQL 和 Redis 使用各自 Docker volume。Redis volume
只提供尽力而为的重启保留，不承诺未完全入库内容不可丢失；派生状态可从 PostgreSQL 重建。
内置 PostgreSQL 默认不向宿主发布端口；需要直连时使用：

```bash
docker compose exec postgresql sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

## 数据库基线

`schema.sql` 定义上一已封版版本的完整干净安装基线，包括作者身份、
`metadata.created_by TEXT NOT NULL`、`metadata.purge_job_id` 及其长期 CHECK；
`schema-additions.sql` 承载当前发布相对该基线的结构增量，目前为注释占位。空数据库在同一事务中
执行基线与 additions；符合该基线的非空数据库执行 additions 后进入只读 readiness。readiness
核对当前读写所需的最小列、约束、索引、
权限与受支持身份 provider。additions 每个发布周期只承载一次受控增量；全部受控数据库应用并通过
readiness 后，下一发布以结果结构作为新的干净安装基线。部署和备份恢复按相邻发布顺序应用
additions；破坏性结构整理由维护者在停机、备份和恢复验证后单独执行。应用的自动结构职责由干净
初始化、单周期 additions 和最小 readiness 组成。精确契约见
[数据库结构](docs/guide/database.md#启动与结构契约)。

非空数据库以当前 additions 和 readiness 作为唯一启动结构路径；缺失当前运行所需结构或类型
不兼容时会明确拒绝启动，应用未消费的额外表、列、索引和约束不会影响 readiness 结论。
readiness 在启动事务的同一 PostgreSQL 连接上顺序执行 SQL，包括作者与图片 CHECK 约束读取。

Redis 是必需的 operational datastore，但不是业务真相源；服务 unavailable 或命令 OOM 时，
Ingestion 会话、写入和 worker 均 fail closed，不回退到 PostgreSQL 或进程内队列。停应用后把
已确认专供 ImageShow 的 logical database 清为空库是受支持冷启动：管理员重新登录，未完成
内容接入任务允许消失，派生状态从 PostgreSQL 重建。运行中清空或局部缺失 canonical / owner /
metadata 结构不受支持，受影响队列会 fail closed 并要求停机处理。连接必须支持 Redis 8 以及
项目使用的
`INCREX`、`ARRING`、`ARLASTITEMS`、`SET ... IFEQ ... KEEPTTL` 与
`DELEX ... IFEQ` 能力；应用启动时会实际验证成功、条件失败、缺失、TTL 语义和 ACL 权限。

## 生产部署

当前生产拓扑只支持一个 ImageShow 应用实例；Compose 或部署平台必须保证不会并行启动第二个
连接同一数据库的应用进程，应用不实现多实例互斥、接管或跨进程一致性。应用应只监听回环或
私有网络，由可信反向代理终止 HTTPS，并覆盖客户端传入的 `Host`、`X-Real-IP`、
`X-Forwarded-For` 与 `X-Forwarded-Proto`；应用不解析转发 Host 或多级 IP 链。
产品无关的代理要求与唯一一份可替换的 Nginx 最简示例见[部署指南](docs/guide/deployment.md#反向代理与-https)。

反向代理请求体上限不得低于应用配置。仓库示例使用 `client_max_body_size 256m`，覆盖
最高可配置的 200 MiB 单图上限并留出代理层余量。完整 Docker、健康检查、停机、密码恢复及
Nginx 配置见[生产部署指南](docs/guide/deployment.md)。

## 开发与验证

```bash
npm ci
npm run check
npm run build
npm run knip
npm run verify:release
```

`verify:release` 是完整本地发布门禁，依次覆盖源码契约、生产构建、最终测试和隔离生产
镜像。门禁实现和 benchmarks 位于本地、Git 忽略的 `tests/`；上传后的 GitHub Actions
只负责生产容器构建、镜像发布和 GitHub Release，不代替本地验收。

常用独立门禁：

- `npm run verify:source`：只读源码、依赖方向和静态契约。
- `npm run verify:build`：生产构建及产物边界。
- `npm run verify:runtime`：最终测试及隔离镜像运行验收。
- `npm run test:final:web`：当前 Web 最终测试。

## 文档索引

按身份进入：

- [普通用户](docs/guide/roles/ordinary-user.md)
- [图片管理员](docs/guide/roles/image-admin.md)
- [超级管理员](docs/guide/roles/super-admin.md)
- [实例维护者](docs/guide/roles/instance-maintainer.md)

技术参考：

- [架构总览](docs/guide/architecture.md)、[项目结构](docs/guide/project-structure.md)
- [配置说明](docs/guide/configuration.md)、[数据库结构](docs/guide/database.md)、
  [存储](docs/guide/storage.md)、[安全](docs/guide/security.md)
- [功能与流程](docs/guide/flows.md)、[随机图 API](docs/guide/random-api.md)、
  [生产部署](docs/guide/deployment.md)

完整导航见[文档首页](docs/README.md)。

## 许可

见 [LICENSE](LICENSE)。
