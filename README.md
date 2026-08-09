# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是一个面向个人服务器的图片展示、图库管理与随机图 API 服务。它提供公开首页与瀑布流画廊、后台上传管理、本地 / S3 兼容对象存储 / WebDAV 多后端并存、Redis 8 就绪图片读模型，以及一键 Docker 部署。

## 功能

- 公开首页完整展示设备、明暗、主题、标签与作者目录及图片数量，十万级图库总量仍能
  稳定排版，可组合选择后携带查询参数进入画廊；首页使用永久深色遮罩、分阶段 Hero
  与目录单次揭示，画廊卡片在同一查询中只入场一次，虚拟卸载后重挂载不会重播。
  首页与画廊共用固定导航外壳、单一位移栈、独立的顶部保护和主导航手势阈值，公开
  主导航在 SPA 会话内只入场一次，从画廊返回首页时仅首页次级筛选栏轻量入场，路由
  在触控设备保留本地回弹反馈；画廊支持最新 / 随机排序，以分级导航手势、有界瀑布
  流窗口、逐游标页一页前瞻和共享图片解码队列支持长列表连续浏览。
- `random.*`、`static.*`、`link.*` 三个职责隔离的保留子域名。
- 可选的 `/embed/home` 与 `/embed/gallery` 复用完整公开页面能力但移除主导航；
  启用后自动允许站点自身 HTTPS origin 及其全部子域嵌入，还可配置使用 DNS 主机名
  的额外精确 origin 或受限子域通配符。功能默认关闭，不扩展 API 的跨源访问权限。
- `/random` 随机图 API 支持 `d`/`b`/`t`/`tag`/`a`/`id`/`m`/`n` 参数，既可代理或
  跳转单张图片，也可返回一组去重的 JSON 图片元数据；接口在访问词表、Redis 与存储前
  执行有界查询校验，再把 slug / 显示名规范化为稳定筛选签名；
  `/api/gallery-stats` 提供图库总量及设备、明暗、主题、标签、作者统计，`random.*`
  子域根路径可直接作为随机图链接。完整契约见[随机图 API 指南](docs/guide/random-api.md)。
- 后台图片上传 / 链接导入、JSONL 清单导入、公开微博导入、编辑、删除、回收站、最终
  MD5 判重、日志查看与运行时设置；图片列表可按设备、亮度、主题、标签和作者筛选，
  上传与下载队列使用单项前瞻的有界流水线，在不增加图片处理并发的前提下重叠素材
  传输与处理；任务缩略图在首次就绪前显示静态加载提示，并在暂存 / 正式地址切换时
  等待新图片完成解码后再替换，取消竞态标记按会话代际和所有者在执行收口后立即释放。
- 图片管理员可从公开画廊或后台的图片详情直接编辑可用图片，也可处理常规上传、移入
  回收站和恢复图片，查看、新建、编辑及用精确移动按钮或桌面拖动排序主题、标签和
  作者，并执行数据库、存储、Redis、回收站及全部五项只读检查；检查页默认以一次
  轻量请求独立展示 PostgreSQL 与 Redis 状态，并区分图片核心投影、带生命周期的派生
  缓存、revision、记录占用和重建进度，完整扫描只在手动深度检查时执行。后台概览的
  存储与大小区域同时显示该 Redis 图片核心投影的条目数、记录占用与同步状态；最多
  500 张的
  图片变更精确同步，词表删除、批量图片操作、导入提交或整后端迁移超过该边界时不为
  缓存加载完整 ID 列表，而在保留 PostgreSQL 事务、对象锁和失败补偿的前提下只安排
  一次后台投影重建；图片存储迁移、永久删除、清空回收站、主题/标签/作者的单项删除、
  存储后端迁移和无效存储清理由
  超级管理员专属权限保护，前端隐藏无权限入口，服务端仍会独立拦截请求。
- 后台导航在鼠标悬浮、键盘聚焦或指针按下内部页面入口时预加载对应路由的 JS、CSS
  与静态依赖；页面仍只在实际导航后挂载和读取数据，同一 SPA 会话复用预加载结果。
- 管理员界面偏好以 PostgreSQL 为真相源跨端同步，浏览器本地缓存支持首帧显示与断网后
  补同步；后台外观可选亮色、暗色或实时跟随设备，缺少偏好时默认跟随设备；公开首页、
  画廊及其中打开的管理弹窗始终保持暗色。
- URL、JSONL 与微博链接统一由服务端安全下载，经过标准化后按普通图片保存；解析结果无问题时可按默认开启的配置直接开始导入，JSONL 可为每张图指定展示时间、来源、作者、标签和其他元数据。
- 微博导入可批量输入多条公开微博，自动提取发布时间、原图链接和用户 ID，以各自微博链接作为来源、发布年份作为标签，并按配置的用户 ID → 作者 slug 映射填写作者。
- **存储多后端并存**：本地目录、S3 兼容对象存储与 WebDAV 可同时使用，每张图片记录自己所在后端，可单张、批量或整后端迁移；存储卡片会按当前占用提供删除、迁移或阻断原因说明，删除配置前还会二次确认并由服务端重新校验。在用 S3 Endpoint 可经同命名空间证明后安全换绑，迁移提交真值与对象删除均会核验并持久补偿。
- WebP 缩略图，数据库 / 存储 / Redis 自检与存储迁移工具。

## 本地体验与生产部署

仓库根目录的 `compose.yaml` 自带 PostgreSQL 与 Redis，只用于本地体验、开发和全新安装
验证，不是当前正式生产拓扑。当前生产部署固定为一台主机上的一个 ImageShow 应用容器；
PostgreSQL 与 Redis 在另一套基础设施 Compose 中各运行一个单机单容器。升级时停止对应
当前容器，更新后原位启动，不并行保留另一套应用容器。应用只监听一个端口（默认
`5518`），主域名及其全部子域名都由它按 `Host` 提供，前置反向代理负责终止 HTTPS。

### 1. 准备

- 安装 Docker 与 Docker Compose。连接外部 Redis 时也必须提供 `INCREX`、`ARRING`
  与 `ARLASTITEMS`；应用会在启动时检查，不固定次版本号。
- 仅在宿主机直接开发或构建时需要 Node.js `>=26.3.0 <27`；Docker 部署已内置 Node.js。
- 一个域名，把**主域名与其通配子域名**（`random.` / `static.` / `link.` 都走同一应用）解析到服务器。

### 2. 配置部署参数

用于本地快速体验的 `compose.yaml` 已为站点域名、端口、时区、数据库和 Redis 连接提供默认值，
无需创建 `.env` 也能展开完整配置。若直接编辑 Compose 文件，全新安装至少应在
`services.imageshow.environment` 中设置首次管理员用户名和密码，并在文件顶部
`x-database-settings` 中修改数据库用户名和密码；正式使用前还要把
`SITE_DOMAIN` 的默认值换成实际主域名。`TZ` 默认使用 `UTC`。

也可以复制环境变量模板覆盖这些默认值：

```bash
cp .env.example .env
```

首次启动必填（`ADMIN_*` 仅用于创建首个 super 管理员，初始化后可从 `.env` 移除）：

```ini
SITE_DOMAIN=img.example.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=                   # 必填，至少 8 位且同时包含字母和数字
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=                # 必填，请使用随机强密码
REDIS_PASSWORD=                   # 仅连接带密码的外部 Redis 时填写
```

已有 super 管理员时，启动不会再读取环境变量覆盖账号或密码；请在后台账户页面修改。
`DATABASE_*` 与 `REDIS_*` 是每次启动都读取的部署配置，必须持续由
Compose、`.env` 或 Secret 提供。内置 Redis 位于 Compose 私有网络且不设置密码；
只有连接启用了认证的外部 Redis 时才填写 `REDIS_PASSWORD`。仓库 Compose 不配置或
推断 Redis 内存上限、淘汰策略与容器硬限制；应用只读取 `INFO MEMORY` 供运维观测，
  启动与 `/readyz` 只核对 PostgreSQL 核心 schema、必要初始化、Redis 连接及
  `INCREX`、`ARRING`、`ARLASTITEMS` 三项必需命令；命令能力会在 ImageShow 自有的
  5 秒 TTL 探针键上实际执行，检查后尝试立即 `UNLINK`，权限不允许时由 TTL 收口；
  ACL 拒绝不能仅凭 `COMMAND INFO` 通过。HTTP 会先开放 `/livez` 与
`/readyz`，但当前进程首次通过 Redis 能力校验前不开放任何业务路由，也不启动 worker。
数据库迁移完成后，应用还会用一条专用 PostgreSQL session 持有固定生命周期 advisory
lock；连接同一数据库的第二个 ImageShow 进程会在清理、管理员初始化、HTTP 和 worker
启动前明确退出。该 session 意外断开即表示单实例所有权丢失，当前进程立即停止接收新
请求，执行既有有界排空并关闭数据库连接池后以失败状态退出；这只是误部署保护，不代表
支持多应用实例。
首次校验成功后业务门在该进程内永久打开；运行期 Redis 断线时 `/readyz` 保持非就绪，
后台统一返回 `503 redis_unavailable`，公开画廊、详情、统计、图片资源与随机 API 通过
有并发、队列、超时和 SQL 工作量上限的 PostgreSQL 回源继续服务。Redis 新连接恢复后还需
复核连接 epoch 与命令，随后复核图片 schema、revision、meta 与核心完整性，才自动切回
Redis-first。后台会话 key 仍由 Redis 保存；每次认证再按其中的用户名对 PostgreSQL
`admin_account` 做一次主键查询，核对权威角色与密码代际。PostgreSQL 查询失败返回
`503 database_unavailable` 并保留会话；只有账号明确不存在、角色变化、密码代际不匹配或
会话 key 确实丢失时才返回 401。
其余应用选项只在首次启动时播种进
`data/config.json`，之后以该文件为准——完整字段与默认值见仓库根的
[`config.example.jsonc`](config.example.jsonc)。主进程会在装配 HTTP 路由和启动
后台任务前显式完成配置读取、归一化及必要写回；健康检查只读取现有快照，密码恢复
命令不会创建或修改该文件。

无法登录后台时，可在宿主机通过交互式终端重置任意管理员密码：

```bash
docker exec -it imageshow imageshow reset-password admin
```

密码只通过隐藏输入读取，不得作为命令参数传入。密码直接更新 PostgreSQL 真值；Redis
可用时再清除所有登录会话。Redis 故障不阻止密码恢复，目标账号旧会话在下一次认证时会
因 PostgreSQL 密码代际不匹配而失效；命令只警告其他管理员会话未按恢复流程清除。修改
`.env` 中的
`ADMIN_PASSWORD` 或重启容器不会重置已有账号。源码环境可执行
`npm run admin:reset-password -- admin`。

### 3. 启动本地快速体验栈

```bash
docker compose pull
docker compose up -d
```

> Linux 用 bind mount 时，先让镜像用户（UID/GID `1000`）可写数据目录：`sudo install -d -o 1000 -g 1000 data`。

启动后（下例以 `img.example.com` 为站点域名）：首页 `https://img.example.com/home`、画廊 `/gallery`、后台 `/admin`、随机图 `/random`。如需嵌入无主导航页面，在 `data/config.json` 的顶层 `embed` 配置组中启用后即可从 `https://img.example.com` 及其任意层级子域使用 `/embed/home` 或 `/embed/gallery`；其他网站可在 `allowed_origins` 追加使用 DNS 主机名的精确 HTTPS origin，或形如 `https://*.example.com` 且不包含根域名的子域通配符。重载配置后生效，普通后台设置页不读取或修改该配置。

### 4. 反向代理与 HTTPS

生产环境务必在可信反向代理终止 TLS，用**通配证书**覆盖 `*.img.example.com`，把主域名与所有子域名转发到应用的 `5518` 端口，并**覆盖**（而非透传）客户端伪造的 `X-Forwarded-*` 头：

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name img.example.com *.img.example.com;   # 证书需覆盖通配子域名

  client_max_body_size 256m;

  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;

  location / {
    proxy_pass http://127.0.0.1:5518;
  }
}
```

Nginx 必须覆盖 `X-Real-IP` 和 `X-Forwarded-For`，不要使用会拼接客户端自带值的
`$proxy_add_x_forwarded_for`。前置 CDN 场景应先通过 Nginx `real_ip` 模块和受信任
节点网段恢复 `$remote_addr`，或用 CDN 保证覆盖且无法由访客伪造的来源 IP 头同时
设置这两个转发头。

反向代理的请求体上限不能低于应用内任一对应设置。单张输入图片的应用配置上限为
200 MiB，JSONL 解析使用独立的 128 MiB 档；示例仍使用
`client_max_body_size 256m`，为代理层保留 56 MiB 余量。否则请求会在到达应用鉴权
和校验逻辑前被代理返回 413。不要把应用 HTTP 端口直接暴露公网；
`X-Forwarded-Proto` 缺失会导致
Secure Cookie、同源检查与跳转 URL 出错。示例面向当前 stable Nginx 1.30.3；
仓库文档提供可直接复制的[最少配置与推荐配置](docs/guide/deployment.md#反向代理与-https)，
推荐配置只增加上传流式转发和长任务超时，不在 Nginx 重复实现 Hono 的缓存策略。

### 数据与配置

- **本地快速体验持久化**：`./data`（bind mount，含 `config.json`、`storage/` 本地图片、`log/` 日志）＋ `postgresql18_data` / `redis_data` 两个卷。数据库与 Redis 连接只保存在部署环境或 Secret 中。
- **改配置**：应用策略可在后台「设置」页修改，或编辑 `data/config.json` 后点「读取配置文件」热加载；数据库 / Redis 连接修改 `.env` 或 Compose 后重建容器。容器内固定监听 `5518`，宿主机映射端口由 `HOST_PORT` 控制。
- 内置 PostgreSQL 默认不对宿主发布端口；需直连时用 `docker exec -it imageshow-postgresql psql`。

正式环境只运行一个应用容器，并连接基础设施 Compose 中各一个 PostgreSQL、Redis
容器；部署、停机更新、配置、子域名与架构细节见仓库内[维护文档](docs/README.md)。

## 许可

见 [LICENSE](LICENSE)。
