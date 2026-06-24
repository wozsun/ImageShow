import { useMemo, useState } from "react";
import { api } from "../../lib/api.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { Icon } from "../../components/Icon.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { useAnimatedClose } from "../../components/useAnimatedClose.js";

export function CheckPage() {
  const [result, setResult] = useState<unknown>(null);
  const [running, setRunning] = useState("");
  const [migrationDirection, setMigrationDirection] = useState<"local-to-s3" | "s3-to-local">("local-to-s3");
  const [operationModal, setOperationModal] = useState<"migrate-storage-location" | "migrate-storage-paths" | "storage-cleanup" | null>(null);
  const checks = useMemo(() => [
    { name: "db", label: "数据库" },
    { name: "storage", label: "存储" },
    { name: "redis", label: "Redis" },
    { name: "cors", label: "CORS" },
    { name: "trash", label: "回收站" },
    { name: "all", label: "全部" }
  ], []);
  const runCheck = async (name: string, body?: Record<string, unknown>) => {
    setRunning(name);
    try {
      setResult(await api(`${adminApiBasePath}/check/${name}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }));
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning("");
    }
  };
  return (
    <section className="workspace">
      <header className="workspace-head">
        <div><h1>检查</h1><p>check</p></div>
        <div className="check-actions">
          <div className="actions">
            {checks.map((check) => <button type="button" key={check.name} disabled={Boolean(running)} onClick={() => void runCheck(check.name)}><Icon name="refresh-line" />{running === check.name ? "运行中" : check.label}</button>)}
          </div>
          <div className="actions">
            <button type="button" disabled={Boolean(running)} onClick={() => void runCheck("backfill-md5")}><Icon name="fingerprint-line" />{running === "backfill-md5" ? "补全中" : "补全 MD5"}</button>
            <button type="button" disabled={Boolean(running)} onClick={() => setOperationModal("migrate-storage-location")}><Icon name="database-2-line" />{running === "migrate-storage-location" ? "迁移中" : "迁移存储后端"}</button>
            <button type="button" disabled={Boolean(running)} onClick={() => setOperationModal("migrate-storage-paths")}><Icon name="refresh-line" />{running === "migrate-storage-paths" ? "整理中" : "整理路径结构"}</button>
            <button className="danger-button" type="button" disabled={Boolean(running)} onClick={() => setOperationModal("storage-cleanup")}><Icon name="delete-bin-6-line" />{running === "storage-cleanup" ? "清理中" : "清理无效存储"}</button>
          </div>
        </div>
      </header>
      {operationModal && (
        <CheckOperationModal
          operation={operationModal}
          running={running}
          migrationDirection={migrationDirection}
          onDirectionChange={setMigrationDirection}
          onClose={() => setOperationModal(null)}
          onRun={async () => {
            if (operationModal === "migrate-storage-location") {
              await runCheck("migrate-storage-location", { direction: migrationDirection });
            } else {
              await runCheck(operationModal);
            }
          }}
        />
      )}
      {result !== null && <CheckResult result={result} />}
    </section>
  );
}

function CheckOperationModal({ operation, running, migrationDirection, onDirectionChange, onClose, onRun }: {
  operation: "migrate-storage-location" | "migrate-storage-paths" | "storage-cleanup";
  running: string;
  migrationDirection: "local-to-s3" | "s3-to-local";
  onDirectionChange: (value: "local-to-s3" | "s3-to-local") => void;
  onClose: () => void;
  onRun: () => Promise<void>;
}) {
  const isLocationMigration = operation === "migrate-storage-location";
  const isCleanup = operation === "storage-cleanup";
  const title = isLocationMigration ? "迁移存储后端" : isCleanup ? "清理无效存储" : "整理路径结构";
  const description = isLocationMigration
    ? "复制图片和缩略图到目标存储后端，并更新数据库中的存储引用。"
    : isCleanup
      ? "删除数据库未引用的原图、缩略图、回收站对象和已失效的上传暂存文件。不会删除仍在使用的对象。"
      : "在当前存储后端内移动对象到规范路径，并同步更新数据库。";
  const runningText = isLocationMigration ? "迁移中" : isCleanup ? "清理中" : "整理中";
  const exit = useAnimatedClose(onClose);
  return (
    <div className={`modal edit-modal ${exit.closing ? "is-closing" : ""}`} onAnimationEnd={exit.onAnimationEnd} onClick={running ? undefined : () => exit.requestClose()}>
      <form className="operation-modal" onSubmit={async (event) => { event.preventDefault(); await onRun(); exit.requestClose(); }} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <button className="icon close pressable" type="button" title="关闭" disabled={Boolean(running)} onClick={() => exit.requestClose()}><Icon name="close-line" /></button>
        </header>
        <div className="operation-body">
          {isLocationMigration && (
            <label>迁移方向<SelectMenu value={migrationDirection} onChange={(value) => onDirectionChange(value as "local-to-s3" | "s3-to-local")} options={[{ value: "local-to-s3", label: "本地迁往 S3" }, { value: "s3-to-local", label: "S3 迁往本地" }]} ariaLabel="迁移方向" /></label>
          )}
          <p className="notice-line">此操作会修改存储对象。执行前请先运行存储检查，确认检查结果，并避免同时上传或批量编辑图片。</p>
        </div>
        <footer>
          <button type="button" disabled={Boolean(running)} onClick={() => exit.requestClose()}>取消</button>
          <button className="button" type="submit" disabled={Boolean(running)}><Icon name="refresh-line" />{running === operation ? runningText : "开始执行"}</button>
        </footer>
      </form>
    </div>
  );
}

function CheckResult({ result }: { result: unknown }) {
  const objectResult = result && typeof result === "object" ? result as Record<string, unknown> : { value: result };
  const entries = Object.entries(objectResult).filter(([key]) => key !== "ok");
  const totalIssues = countCheckIssues(objectResult);
  return (
    <>
      <div className={`check-summary ${totalIssues ? "warn" : "ok"}`}>
        <strong>{totalIssues ? `发现 ${totalIssues} 项需要处理` : "检查结果正常"}</strong>
        <span>下方卡片展示每项检查的摘要，展开 JSON 可查看原始明细。</span>
      </div>
      <div className="check-result">
        {entries.map(([key, value]) => {
          const count = countValue(value);
          const issue = isIssueKey(key) ? count : 0;
          return (
            <section key={key} className={issue ? "check-card warn" : "check-card ok"}>
              <div className="check-card-head">
                <h2>{key}</h2>
                <span>{issue ? `${issue} 项` : "正常"}</span>
              </div>
              <pre>{JSON.stringify(value, null, 2)}</pre>
            </section>
          );
        })}
      </div>
    </>
  );
}

function isIssueKey(key: string) {
  return ["issues", "mismatches", "index_gaps", "operations", "missing_objects", "missing_thumbs", "missing_trash", "orphan_objects", "orphan_thumbs", "orphan_trash", "staging_files"].includes(key);
}

function countCheckIssues(result: Record<string, unknown>) {
  return Object.entries(result)
    .filter(([key]) => isIssueKey(key))
    .reduce((sum, [, value]) => sum + countValue(value), 0);
}

function countValue(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return typeof value === "number" ? value : value ? 1 : 0;
}
