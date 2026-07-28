import { useEffect, useState, type FormEvent } from "react";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { Icon } from "../../components/icon/Icon.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import {
  useStorageOptions,
  type StorageBackendOption
} from "../../lib/api/storage-options.js";

const migrationPresentation = {
  idle: { icon: "arrow-left-right-line", label: "开始执行" },
  pending: { icon: "arrow-left-right-line", label: "迁移中" },
  success: { icon: "check-line", label: "迁移完成" },
  error: { icon: "close-line", label: "迁移失败" }
} as const;

function backendLabel(backend: StorageBackendOption) {
  const name = backend.display_name || backend.slug;
  return backend.enabled ? name : `${name}（已停用）`;
}

function preferredSource(
  backends: readonly StorageBackendOption[],
  initialSource: string
) {
  if (initialSource) return initialSource;
  return backends[0]?.slug ?? "";
}

function preferredTarget(
  backends: readonly StorageBackendOption[],
  source: string
) {
  return backends.find(
    (backend) => backend.enabled && backend.is_default && backend.slug !== source
  )?.slug ?? backends.find(
    (backend) => backend.enabled && backend.slug !== source
  )?.slug ?? "";
}

export function StorageLocationMigrationDialog({
  initialSource = "",
  busy = false,
  onClose,
  onRun
}: {
  initialSource?: string;
  busy?: boolean;
  onClose: () => void;
  onRun: (source: string, target: string) => Promise<boolean>;
}) {
  const { data, isLoading, isError } = useStorageOptions();
  const backends = data?.backends ?? [];
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const [targetMenuOpen, setTargetMenuOpen] = useState(false);
  const status = useAsyncActionStatus({ successDurationMs: null });

  useEffect(() => {
    setSource((current) => {
      if (initialSource) return initialSource;
      if (backends.some((backend) => backend.slug === current)) return current;
      return preferredSource(backends, initialSource);
    });
  }, [backends, initialSource]);

  useEffect(() => {
    setTarget((current) => {
      if (backends.some(
        (backend) =>
          backend.slug === current
          && backend.enabled
          && backend.slug !== source
      )) {
        return current;
      }
      return preferredTarget(backends, source);
    });
  }, [backends, source]);

  const sourceOptions = backends.map((backend) => ({
    value: backend.slug,
    label: backendLabel(backend)
  }));
  const targetOptions = backends
    .filter((backend) => backend.enabled && backend.slug !== source)
    .map((backend) => ({
      value: backend.slug,
      label: backend.display_name || backend.slug
    }));
  const blocked = busy || status.pending;
  const sourceLocked = Boolean(initialSource);
  const hasSource = sourceOptions.some((option) => option.value === source);
  const hasTarget = targetOptions.some((option) => option.value === target);
  const sourceUnavailable = Boolean(
    data && sourceLocked && !hasSource
  );

  const submit = async (
    event: FormEvent<HTMLFormElement>,
    requestClose: () => void
  ) => {
    event.preventDefault();
    const succeeded = await status.run(() => onRun(source, target));
    if (succeeded) requestClose();
  };

  return (
    <DialogFrame
      className="modal edit-modal"
      ariaLabel="迁移存储后端"
      busy={blocked}
      paused={sourceMenuOpen || targetMenuOpen}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          className="operation-modal"
          onSubmit={(event) => void submit(event, requestClose)}
        >
          <header>
            <div>
              <h2>迁移存储后端</h2>
              <p>复制图片和缩略图到目标存储后端，并更新数据库中的存储引用。</p>
            </div>
            <button
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={blocked}
              onClick={() => requestClose()}
            >
              <Icon name="close-line" />
            </button>
          </header>
          <div className="operation-body">
            <label>
              源后端
              <SelectMenu
                value={source}
                onChange={setSource}
                onOpenChange={setSourceMenuOpen}
                options={sourceOptions}
                ariaLabel="源后端"
                disabled={blocked || sourceLocked || !sourceOptions.length}
              />
            </label>
            <label>
              目标后端
              <SelectMenu
                value={target}
                onChange={setTarget}
                onOpenChange={setTargetMenuOpen}
                options={targetOptions}
                ariaLabel="目标后端"
                disabled={blocked || !targetOptions.length}
              />
            </label>
            {isLoading && <p className="muted">正在加载存储后端</p>}
            {isError && (
              <p className="error" role="alert">
                存储后端列表加载失败，请关闭弹窗后重试。
              </p>
            )}
            {sourceUnavailable && (
              <p className="error" role="alert">
                源后端状态已变化，请关闭弹窗并刷新页面后重试。
              </p>
            )}
            {data && !sourceUnavailable && !targetOptions.length && (
              <p className="error" role="alert">
                没有其他已启用的目标后端，请先启用或新增一个存储后端。
              </p>
            )}
            <p className="notice-line">
              此操作会修改存储对象。执行前请先运行存储检查，确认检查结果，并避免同时上传或批量编辑图片。
            </p>
          </div>
          <footer>
            <button
              type="button"
              disabled={blocked}
              onClick={() => requestClose()}
            >
              取消
            </button>
            <AsyncActionButton
              className="button"
              type="submit"
              status={status.status}
              presentation={migrationPresentation}
              disabled={blocked || isError || !hasSource || !hasTarget}
            />
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
