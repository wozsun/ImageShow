# 快速开始（Docker Compose）

需要 Docker 和 Docker Compose。公网访问还需准备域名和 HTTPS 反向代理，配置示例见[部署说明](../DEPLOY.md#反向代理与-https)。仅运行发布镜像不需要在宿主机安装 Node.js。

## 1. 准备文件

将仓库根目录的 `compose.yaml` 和 `.env.example` 放入同一个部署目录，在该目录中执行：

```bash
cp .env.example .env
```

编辑 `.env`，填写两个不同的随机强密码，并将域名改为实际域名：

```ini
DATABASE_PASSWORD=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
SITE_DOMAIN=img.example.com
```

管理员密码须为 8–128 位，且同时包含字母和数字。首次创建后，账号密码以数据库为准；修改环境变量不会覆盖已有账号。

## 2. 启动服务

```bash
docker compose pull
docker compose up -d
```

默认 Compose 同时启动 ImageShow、PostgreSQL 和 Redis，应用端口只绑定 `127.0.0.1:5518`。反向代理将域名的 HTTPS 请求转发到该端口，并原样保留页面、API 和 `/images` 路径。

三个服务分别使用部署目录下的 `data/`、`postgres/`、`redis/` 保存持久数据，首次启动会自动创建
缺少的目录；已有部署调整挂载时，须先停机迁移原有数据，不能直接用空目录替换。

首次启动时，应用在空数据库中创建完整结构并播种初始管理员。非空数据库只做当前最小结构的
只读就绪检查，具体要求见[启动与结构契约](database.md#启动与结构契约)。日常更新见
[更新部署](../DEPLOY.md#更新部署)。

设置实际域名后，请通过该域名访问。临时本机体验可以将 `SITE_DOMAIN` 留空，再打开 `http://127.0.0.1:5518/admin`；之后配置域名需在后台高级配置或 `data/config.json` 中修改。

## 3. 登录并添加图片

1. 打开 `https://img.example.com/admin`，使用初始管理员账号登录。
2. 在图片管理页上传本地文件，或导入 URL、JSONL、微博链接。
3. 打开站点首页，进入展映或画廊查看图片。

| 入口 | 地址 |
| --- | --- |
| 首页 | `/home` |
| 展映 | `/show`，可用 `/show?mode=float` 打开漂浮模式 |
| 画廊 | `/gallery` |
| 后台 | `/admin` |
| 随机图 | `/random` |

首页、展映和画廊可分别启停；根地址展示的页面由配置决定。三者全部关闭时根地址返回 404，后台和随机图仍可独立访问。

## 后续配置与维护

- 名称、首页文案、图片处理等常用项在后台设置页修改；完整配置项见[配置说明](../CONFIG.md)。
- 外部数据库、Redis、存储、升级和恢复见[部署说明](../DEPLOY.md)与[存储指南](storage.md)。
- 上传、分类和回收站操作见[图片管理员指南](roles/image-admin.md)。
- 在宿主机开发时使用 Node.js 26.8 或更高的 26.x 版本，建议与 Docker 镜像的 Node 26.9.0 / npm 12.0.2 一致；
  最低版本由 HTTP 媒体类型解析所用的稳定 `MIMEType.parse()` API 决定，具体范围见根包 `engines`。
  构建和验证入口见[项目结构](project-structure.md#本地门禁与发布职责)。
- Dockerfile 通过同一个 `NPM_VERSION` 固定构建与容器内维护所用的 npm，开发环境可用
  `npm install --global npm@12.0.2` 对齐。依赖安装使用提交的 lockfile 和根包 `allowScripts`：
  npm 12 默认阻止未经批准的依赖安装脚本；新增需要运行安装脚本的依赖时须单独审查并更新该清单。
  应用仍直接由 Node 启动，npm 安装只发生在镜像构建期。
