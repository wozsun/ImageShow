# 三档图片预生成

6.5.7 提供独立的存量图片预生成工具。正式图库、入库、随机图和公共资源仍使用 `full/thumbs`；预生成文件保存到 `l/m/s`，只向超级管理员提供受保护的抽查入口。

## 使用

超级管理员进入后台「检查」，点击「三档图片预生成」。打开弹窗只读取状态。设置参数后点击「开始 / 继续生成」，关闭页面不影响执行。当前图库及回收站中的保留图片均计入目标，已实际删除的图片从目标中排除。

| 参数 | large | middle | small |
| --- | --- | --- | --- |
| 初始质量 | 80，50–100 | 80，50–100 | 80，50–100 |
| 最低质量 | 60，1–80 | 60，1–80 | 60，1–80 |
| 长边 px | 4200，512–16000 | 2200，256–8000 | 600，128–2000 |
| 目标体积 KiB | 700，256–5120 | 350，128–2560 | 60，8–1280 |
| WebP effort | 4，0–6 | 4，0–6 | 4，0–6 |

每档最低质量不得超过初始质量。长边与目标体积必须满足 small ≤ middle ≤ large，允许相等。质量步长默认 5，范围 1–20。三档质量和 effort 独立配置；1 KiB 为 1024 字节。

预生成参数冻结在本轮任务中，不修改站点运行配置。修改处理参数前先停止并等待活动图片退出，再建立新任务；已有文件只有在原图摘要和有效处理条件相同、核验通过时才复用。恢复默认参数只改弹窗草稿。

图片并发默认 1，可运行中改为 1–8；降低并发时已有图片自然完成。每张图片的下载、编码、写入、核验共享一个槽位。子进程使用单线程编码，三档顺序处理。同一图片内相同处理条件的编码结果可复用，但三档始终是独立物理文件。

仅 large 可保留完整有效的原 WebP：原体积严格小于 large 目标且长边达标。middle/small 始终处理。其他转码使用首帧，符合条件的 large 动画保留原字节并核验所有帧。质量触底仍超目标时保存结果，标注体积超限，不再缩尺寸。

每完成 18 次图片逻辑尝试暂停随机 5–30 秒；每 100 次暂停 50–180 秒。失败重试耗尽也计一次，内部编码/下载重试不计。两种休息重合时执行长休息；停止发新任务，等待已有图片结束后开始计时。已选时长和计数存入 PostgreSQL，重启不重置。

「停止」先保存停止意图，再取消任务并等待子进程真正退出；处理中断保留完整产物。强制关机后按持久记录核对文件，不能仅凭目录内存在文件判为完成。「重试失败项」也允许重新处理核验发现的失效文件，仅修改待处理集合；停止状态下仍需点击继续。「核对图库变更」更新新增、变更、删除及缺失文件状态，不自动开始生成。「完整核验」为独立模式，完成后不会转为生成。

每张活动图片最多额外保留 128 MiB 编码缓存和 256 MiB 磁盘缓存；不含原图和解码工作区。并发 8 可额外占用 1 GiB 内存和 2 GiB 磁盘，须根据部署预算设置。原图检查点、缓存和候选文件按持久归属清理。磁盘余量不足、权限错误或持久化能力不满足时任务受阻，修复后需显式继续。

## CLI

以下命令只发控制请求或读取状态，处理由主服务后台任务执行。操作系统对该容器的执行权限等价于维护权限。

```sh
docker compose exec --user node imageshow node /app/packages/server/dist/normalize-prepare-cli.js status
docker compose exec --user node imageshow node /app/packages/server/dist/normalize-prepare-cli.js start --profile /app/data/preparation-profile.json --concurrency 1
docker compose exec --user node imageshow node /app/packages/server/dist/normalize-prepare-cli.js stop
docker compose exec --user node imageshow node /app/packages/server/dist/normalize-prepare-cli.js set-concurrency --concurrency 2
docker compose exec --user node imageshow node /app/packages/server/dist/normalize-prepare-cli.js retry
docker compose exec --user node imageshow node /app/packages/server/dist/normalize-prepare-cli.js reconcile
docker compose exec --user node imageshow node /app/packages/server/dist/normalize-prepare-cli.js verify
```

profile JSON 顶层为 `quality_step`、`large`、`middle`、`small`，三档各包含表中五项对应的 `quality`、`min_quality`、`max_long_edge`、`max_size_kb`、`webp_effort`。CLI 与弹窗共用规则。

离线执行必须先停止主服务及其所有子进程，使用已固定的 6.5.7 镜像、相同数据库和数据挂载，以 node 用户执行 `normalize-prepare-cli.js run`。`run` 只消费已保存的运行意图，不隐式启动新任务；通过 PostgreSQL 宿主锁排除与主服务并行。Ctrl+C 保存停止意图；SIGTERM/断电保留之前的运行意图。只支持单个受管理部署，不提供跨主机自动接管。

## PostgreSQL 结构准备

空库由完整 schema 初始化。既有 6.5.6 数据库须由维护者停机备份后，显式执行以下结构维护；应用启动不自动修改非空数据库。SQL 只增加准备表并扩展现有后台任务类型，不修改图片数据。

```sql
BEGIN;
ALTER TABLE background_job DROP CONSTRAINT background_job_current_type_check;
ALTER TABLE background_job ADD CONSTRAINT background_job_current_type_check
  CHECK (type IN ('move.cleanup', 'trash.purge', 'cache.rebuild', 'normalize.prepare'));
CREATE TABLE image_variant_preparation (
  run_id UUID NOT NULL REFERENCES background_job(id),
  image_id UUID NOT NULL,
  state TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, image_id),
  CHECK (state IN ('pending', 'running', 'ready', 'failed', 'stale', 'excluded')),
  CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX idx_image_variant_preparation_work
  ON image_variant_preparation(run_id,state,image_id);
COMMIT;
```

准备表必须为普通 WAL 表，PostgreSQL `fsync`、`full_page_writes` 必须开启，关键事务启用同步提交。文件先完整解码、记录摘要及尺寸、同步文件与目录，再发布和保存完成回执。宿主文件系统必须支持同目录原子发布和目录同步。磁盘或硬件虚报 flush 成功不在应用的断电恢复保证内。

需要停止预生成并等待退出后，再执行整库迁移或全局存储维护。旧版孤儿文件清理不会扫描 `l/m/s`。不要手工移动、覆盖或删除准备表及预生成目录。

## 人工核查与后续切换

完成全部保留图片、运行完整核验并人工抽查后，才可进入正式三档切换开发。抽查入口重新下载原图并比对本轮输入摘要，提供原图与三档预览及 100% 显示；目标体积超限与处理失败分别展示。导出清单含原图地址及维护路径，应按后台运维材料保管。

容器更新或页面可访问不等于编码、恢复、断电、并发及性能验收通过。真实断电、候选发布中断、控制竞争、权限、全量图库及性能测量在授权验收阶段执行。
