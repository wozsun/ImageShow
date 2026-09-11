# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是面向个人服务器的自托管图片画廊，集图片展示、随机图 API 和轻量后台管理于一体，方便收藏、整理和分享图片。

## 功能

- **图片浏览**：提供首页、瀑布流画廊、图片详情，以及瀑布流和漂浮两种自动展映模式，适配桌面与移动端。
- **分类筛选**：按设备、亮度、主题、标签和作者筛选图片；主题可留空，支持无主题筛选。
- **随机图 API**：通过 `/random` 获取随机图片，支持通过查询参数指定随机范围。
- **上传与导入**：支持本地上传，以及 URL、JSONL 和微博链接批量导入。
- **图片管理**：支持图片属性编辑、批量应用和清空分类属性、分类管理、回收站和恢复。
- **灵活存储**：支持本地存储和 S3 兼容对象存储，可在存储之间迁移图片。
- **站点管理**：提供管理员权限分工、站点设置、配置导入导出、日志和运行状态检查，并可开启页面嵌入。

## 快速部署

以下以 Linux 服务器首次安装为例。请先安装 Docker 和 Docker Compose；公网访问需准备域名。

### 1. 准备配置

在服务器上新建一个 `imageshow` 目录，将 [compose.yaml](compose.yaml) 和 [.env.example](.env.example) 下载到该目录。在这个目录中执行：

```bash
cp .env.example .env
```

打开 `.env`，为以下两项填写不同的随机强密码：

```ini
DATABASE_PASSWORD=
ADMIN_PASSWORD=
```

`ADMIN_PASSWORD` 是后台登录密码，须为 8–128 位且同时包含字母和数字。

强烈建议同时将 `.env` 中的 `SITE_DOMAIN` 改为实际域名，不带 `https://` 或路径。未填写或保留 `example.com` 时，项目会自动使用访问 Host。

### 2. 启动服务

在同一目录中启动服务：

```bash
docker compose pull
docker compose up -d
```

应用数据、PostgreSQL 和 Redis 分别保存在部署目录下的 `data/`、`postgres/`、`redis/`。

### 3. 配置域名并访问

未设置域名时，在服务器本机可访问 `http://127.0.0.1:5518/admin`。如需公网访问：

- 在域名管理页面添加 DNS 解析，将该域名指向服务器公网 IP。
- 在服务器防火墙和云平台安全组中放行 `80`、`443` 端口。
- 在服务器上配置反向代理：使用该域名，转发目标填写 `http://127.0.0.1:5518`，申请证书并启用 HTTPS。具体配置见[反向代理示例](docs/DEPLOY.md#反向代理与-https)。

完成后，将以下地址中的域名替换为自己的域名：

- 打开 `https://img.example.com/admin`，使用用户名 `admin` 和 `.env` 中的 `ADMIN_PASSWORD` 登录，上传图片。
- 打开 `https://img.example.com`，查看自己的图片站点。

更多说明见[部署指南](docs/DEPLOY.md)、[配置说明](docs/CONFIG.md)和[随机图 API 指南](docs/guide/random-api.md)。

## 许可

见 [LICENSE](LICENSE)。
