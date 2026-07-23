import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject
} from "react";
import type { BatchStorageMigrationResponse } from "@imageshow/shared/browser";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { Icon } from "../../components/icon/Icon.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { api } from "../../lib/api/client.js";
import { useStorageOptions } from "../../lib/api/storage-options.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";

const migratePresentation = {
  idle: { icon: "arrow-left-right-line", label: "开始迁移" },
  pending: { icon: "arrow-left-right-line", label: "迁移中" },
  success: { icon: "check-line", label: "迁移成功" },
  error: { icon: "close-line", label: "迁移失败" }
} as const;

export function BatchStorageMigrationDialog({
  open,
  imageIds,
  single,
  returnFocusRef,
  onClose,
  onSaved,
  onSucceeded
}: {
  open: boolean;
  imageIds: string[];
  single: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void;
  onSucceeded: () => void;
}) {
  const { data } = useStorageOptions();
  const options = (data?.backends ?? []).map((backend) => ({
    value: backend.slug,
    label: backend.display_name || backend.slug
  }));
  const defaultTarget = data?.backends.find((backend) => backend.is_default)?.slug
    ?? options[0]?.value
    ?? "";
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [target, setTarget] = useState(defaultTarget);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const status = useAsyncActionStatus({ successDurationMs: null });

  useEffect(() => {
    if (defaultTarget) setTarget((current) => current || defaultTarget);
  }, [defaultTarget]);

  if (!open) return null;

  const close = () => {
    setError("");
    setMenuOpen(false);
    onClose();
  };

  const migrate = async () => status.run(async () => {
    setError("");
    try {
      const response = await api<BatchStorageMigrationResponse>(
        `${adminApiBasePath}/images/batch-migrate-storage`,
        {
          method: "POST",
          body: JSON.stringify({ ids: imageIds, target })
        }
      );
      if (response.migrated) onSaved();
      if (response.failed) {
        const unchanged = Math.max(
          0,
          imageIds.length - response.migrated - response.failed
        );
        reportAdminUiError(
          "image_metadata.storage_migration_partial",
          new Error(`批量存储迁移失败 ${response.failed}/${imageIds.length}`),
          response
        );
        setError(
          `迁移未全部完成：已迁移 ${response.migrated} 项，`
          + `未变化 ${unchanged} 项，失败 ${response.failed} 项。`
        );
        return false;
      }
      return true;
    } catch (migrationError) {
      reportAdminUiError("image_metadata.storage_migration", migrationError);
      return false;
    }
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const succeeded = await migrate();
    if (succeeded) onSucceeded();
  };

  return (
    <DialogFrame
      className="modal edit-modal"
      ariaLabel={single ? "迁移存储" : "批量迁移存储"}
      busy={status.pending}
      paused={menuOpen}
      animateClose={false}
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={close}
    >
      {({ requestClose }) => (
        <form
          className="operation-modal"
          tabIndex={-1}
          onSubmit={submit}
        >
          <header>
            <div>
              <h2>{single ? "迁移存储" : "批量迁移存储"}</h2>
              <p>{single
                ? "将这张图片迁移到目标存储后端。"
                : `将这批 ${imageIds.length} 张图片迁移到目标存储后端。`}</p>
            </div>
            <button
              ref={closeButtonRef}
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={status.pending}
              onClick={() => requestClose()}
            >
              <Icon name="close-line" />
            </button>
          </header>
          <div className="operation-body">
            <label>
              目标存储
              <SelectMenu
                className="is-storage-select"
                value={target}
                onChange={setTarget}
                onOpenChange={setMenuOpen}
                options={options}
                ariaLabel="目标存储"
              />
            </label>
            <p className="notice-line">迁移会复制对象与缩略图到目标后端、更新引用，并删除源副本；目标为对象存储时需先在设置页配置好该后端。</p>
            {error && <p className="error" role="alert" title={error}>{error}</p>}
          </div>
          <footer>
            <button
              type="button"
              disabled={status.pending}
              onClick={() => requestClose()}
            >
              取消
            </button>
            <AsyncActionButton
              className="button"
              type="submit"
              status={status.status}
              presentation={migratePresentation}
              disabled={status.pending || !target}
            />
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
