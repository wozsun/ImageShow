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
| `final-server.test.ts` | Server 统一入口，只按确定顺序装配领域套件 |
| `final-web.test.ts` | Web 统一入口，只按确定顺序装配领域套件 |
| `server/` | 配置、HTTP / 鉴权、进程、缓存、存储、图片、内容接入和数据库集成 |
| `web/` | 共享交互、公开导航、画廊、后台、内容接入、表单和展映 |
| `verify/` | 源码、构建、运行时门禁和发布前总编排 |
| `support/` | DOM / 全局属性恢复、可控时钟、进程树和隔离目录等窄职责支撑 |
| `tsconfig.json` | 测试源码专用的无产物类型检查，不进入生产构建 |

颜色识别用例随 `verify/check-semantic-colors.mjs` 执行，再扫描项目源码；静态压缩的实际
收益用例随 `verify/check-web-chunks.mjs` 执行，再检查构建产物。两者各归所属门禁。

| 命令 | 范围与前提 |
| --- | --- |
| `npm run verify:source` | 生产与测试源码类型、依赖、配置、文档与样式契约；已安装依赖 |
| `npm run verify:build` | 生产构建与 Web 产物边界；已安装依赖 |
| `npm run verify:runtime` | Server / Web 测试与隔离生产镜像；先完成项目构建 |
| `npm run verify:release` | 按 source → build → runtime 依次运行，失败即停 |

已完成构建时可单独运行行为测试：

```bash
node --test --test-isolation=none scripts/tests/final-server.test.ts
npm run test:final:web
```

领域测试使用名称前缀，可在统一入口中选择；筛选后应看到实际执行的匹配用例，不能把只有入口
文件或全部跳过的结果当成通过。例如：

```bash
npx tsx --test --test-name-pattern="^\[Server/内容接入\]" scripts/tests/final-server.test.ts
npx tsx --test --test-name-pattern="^\[Web/展映\]" scripts/tests/final-web.test.ts
```

数据库集成、其中的存储 / 接入跨域合同与 Web 队列 Hook 还提供进程环境变量选择内部具名场景。
数据库始终先自行准备本次 PostgreSQL / Redis；每个跨域合同使用独立数据库并清空一次性 Redis，
Web 场景始终建立自己的 DOM、请求模拟与 React root：

```bash
IMAGESHOW_DATABASE_SCENARIO=cold-redis npx tsx --test \
  --test-name-pattern="数据库以单一基线" scripts/tests/server/database-integration.test.ts
IMAGESHOW_DATABASE_SCENARIO=storage-ingestion \
IMAGESHOW_STORAGE_INGESTION_SCENARIO=commit-success npx tsx --test \
  --test-name-pattern="数据库以单一基线" scripts/tests/server/database-integration.test.ts
IMAGESHOW_WEB_QUEUE_SCENARIO=handoff-completion npx tsx --test \
  --test-name-pattern="Server 内容接入队列 Hook" scripts/tests/web/ingestion.test.ts
```

PowerShell 中使用 `$env:IMAGESHOW_DATABASE_SCENARIO = "cold-redis"`、
`$env:IMAGESHOW_STORAGE_INGESTION_SCENARIO = "commit-success"` 或
`$env:IMAGESHOW_WEB_QUEUE_SCENARIO = "handoff-completion"` 设置同名变量；运行后用
`Remove-Item Env:IMAGESHOW_DATABASE_SCENARIO` 或对应名称清除。`verify:*` 总入口会主动移除
全部场景选择器，保证完整门禁不会因 shell 残留变量而少跑。

数据库场景值为 `schema-baseline`、`storage-ingestion`、`cold-redis`、`readiness`。
`storage-ingestion` 下的独立场景按职责列于下表，每次只选择一个值：

| 职责 | `IMAGESHOW_STORAGE_INGESTION_SCENARIO` 值 |
| --- | --- |
| 配置与身份 | `config-package-consistency`、`auth-author-contracts` |
| 图片写入与分类 | `image-update-consistency`、`image-classification-consistency` |
| 查询与缓存 | `image-read-consistency`、`ready-cache-read-model`、`redis-business-commands` |
| 存储与回收站 | `local-io-lifecycle`、`storage-registry-lifecycle`、`storage-migration-recovery`、`storage-cleanup-recovery`、`storage-lock-admission`、`trash-purge-recovery` |
| 存储维护 | `storage-thumbnail-recovery`、`storage-maintenance-cancellation` |
| 接入服务与队列 | `ingestion-service-contracts`、`ingestion-action-protocol`、`ingestion-upload-lifecycle`、`ingestion-import-queue`、`ingestion-queue-actions`、`redis-canonical` |
| 正式提交 | `ingestion-commit-guards`、`commit-success`、`commit-conflict`、`commit-recovery` |
| 接入文件生命周期 | `ingestion-raw-lifecycle`、`ingestion-orphan-lifecycle` |

Web 队列场景值为 `strict-mode`、
`empty-reconnect`、`reconnect-pagination`、`handoff-completion`。
不设置变量时执行完整场景，未知值会失败而不是产生零测试通过。

## 证据边界

- 纯规则测试证明输入到输出的领域契约，不证明真实数据库、文件系统或浏览器排版。
- `linkedom` 组件测试通过公开 DOM 事件验证 React 交互、请求、取消和卸载，不把模拟视口当成
  CSS 排版或 GPU 呈现验收。
- 数据库集成测试使用一次性 PostgreSQL / Redis 和合成图片；strict `.mts` 场景分别验证
  schema、readiness、配置与图片事务、权限与会话、真实 Redis canonical 和业务命令、接入
  队列与正式提交、存储迁移及维护、raw 租约与孤儿清理，以及读模型重建。故障用例验证真实
  数据或文件副作用、取消和资源释放；它不接触部署中的现有实例。
- 运行时镜像门禁另行验证生产镜像冷启动、HTTP、schema 和重启；局部测试通过不能替代
  `npm run verify:release`。

## 数据与产物

Server 测试在导入应用模块前设置独立数据路径；宿主机生成的配置、日志、图片和临时脚本
进入根目录 `tests/tmp/` 下的唯一目录，用完清理。数据库、Redis、应用容器、网络和临时镜像
由测试独立创建和清理。根目录 `data/` 专用于应用数据。

辅助进程由共享进程管理器登记。使用 IPC 的辅助进程遵循 `imageshow:shutdown` 协议，
中断时先清理各自持有的子进程和目录，再退出；关闭请求超时后强制终止，并拒绝中断后新建资源。

临时复现、性能测量、真实 COS 等外部资源验收、原始运行产物和额外工作树留在根目录
`tests/`，由 Git 忽略，不是本目录的前置依赖。固定夹具只保存可公开的合成数据。

GitHub Actions 负责镜像构建与发布，本目录的测试和门禁在本地运行；测试不进入生产镜像。
结论、比较决策和验收说明放入本地 `tests/report/`，原始运行产物留在根目录 `tests/`。
