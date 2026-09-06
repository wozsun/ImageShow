# 长期契约测试与本地门禁

本目录随 Git 保存，覆盖当前核心行为、错误处理、权限、取消、缓存失效和资源释放。
测试使用合成数据、模拟请求及自动创建的隔离实例，无需个人凭据、现有图片或业务数据库。
源码门禁检查实际依赖方向、循环和配置 / 部署同步；配置通过现有解析接口验证，
源码执行沿用 Server 的 TypeScript 路径映射，无需预先构建。具体业务由行为测试验证，不重复固定
内部函数名、文件清单、调用写法或手写响应的字节数。

## 首次运行

需要满足根包 `engines` 的 Node.js / npm，以及本机可运行 Linux 容器的 Docker Engine。
Docker CLI 应连接本机 daemon，测试通过本机回环地址连接隔离服务。
依赖安装和隔离镜像拉取需要网络；测试用图片由代码生成。下载仓库后在根目录执行：

```bash
npm ci
npm run verify:release
```

完整门禁自行构建项目，并依次运行源码检查、构建检查、行为测试和隔离生产镜像验收。
默认命令不加载部署 `.env`，Server 测试会清除宿主 shell 的 RuntimeConfig 种子，不需要预先启动项目或准备根目录 `data/`、`tests/`。

## 入口与分层

| 路径 | 职责 |
| --- | --- |
| `final-server.test.ts` | Server 领域、接口、数据库与存储行为 |
| `final-web.test.ts` | Web 组件真实挂载、交互、状态与请求行为 |
| `verify/` | 源码、构建、运行时门禁和发布前总编排 |
| `support/` | 隔离测试环境与生成夹具目录的准备 |

颜色识别用例随 `verify/check-semantic-colors.mjs` 执行，再扫描项目源码；静态压缩的实际
收益用例随 `verify/check-web-chunks.mjs` 执行，再检查构建产物。两者各归所属门禁。

| 命令 | 范围与前提 |
| --- | --- |
| `npm run verify:source` | 类型、依赖、配置、文档与样式契约；已安装依赖 |
| `npm run verify:build` | 生产构建与 Web 产物边界；已安装依赖 |
| `npm run verify:runtime` | Server / Web 测试与隔离生产镜像；先完成项目构建 |
| `npm run verify:release` | 按 source → build → runtime 依次运行，失败即停 |

已完成构建时可单独运行行为测试：

```bash
node --test --test-isolation=none scripts/tests/final-server.test.ts
npm run test:final:web
```

## 数据与产物

Server 测试在导入应用模块前设置独立数据路径；宿主机生成的配置、日志、图片和临时脚本
进入根目录 `tests/tmp/` 下的唯一目录，用完清理。数据库、Redis、应用容器、网络和临时镜像
由测试独立创建和清理。根目录 `data/` 专用于应用数据。

临时复现、性能测量、真实 COS 等外部资源验收、原始运行产物和额外工作树留在根目录
`tests/`，由 Git 忽略，不是本目录的前置依赖。固定夹具只保存可公开的合成数据。

GitHub Actions 负责镜像构建与发布，本目录的测试和门禁在本地运行；测试不进入生产镜像。
结论、比较决策和验收说明放入本地 `tests/report/`，原始运行产物留在根目录 `tests/`。
