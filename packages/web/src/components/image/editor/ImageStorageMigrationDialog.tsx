import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject
} from "react";
import { type ImageStorageMigrationResponseDto, adminApiBasePath } from "@imageshow/shared/browser";
import { AsyncActionButton } from "../../actions/AsyncActionButton.js";
import { DialogFrame } from "../../dialog/DialogFrame.js";
import { SelectMenu } from "../../form/SelectMenu.js";
import { AdminIcon } from "../../icon/AdminIcon.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { api } from "../../../lib/api/client.js";
import { useStorageOptions } from "../../../lib/api/storage-options.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { errorMessage } from "../../../lib/ui/formatters.js";

const migratePresentation = {
  idle: { icon: "arrow-left-right-line", label: "开始迁移" },
  pending: { icon: "arrow-left-right-line", label: "迁移中" },
  success: { icon: "check-line", label: "迁移成功" },
  error: { icon: "close-line", label: "迁移失败" }
} as const;

export function ImageStorageMigrationDialog({
  open,
  imageIds,
  returnFocusRef,
  onClose,
  onSaved,
  onSucceeded
}: {
  open: boolean;
  imageIds: string[];
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onSucceeded: (message: string, storageLabel: string) => void;
}) {
  const single = imageIds.length === 1;
  const { data, isLoading, isError } = useStorageOptions();
  // 迁移极低频，图片数据不为它携带所在后端，这里列出全部已启用后端；
  // 已在目标后端的图片由服务端计为未变化。
  const options = (data?.backends ?? [])
    .filter((backend) => backend.enabled)
    .map((backend) => ({
      value: backend.slug,
      label: backend.display_name || backend.slug
    }));
  const defaultStorageSlug = data?.backends.find((backend) => backend.is_default)?.slug;
  const defaultTarget =
    options.find(
      (option) => option.value === defaultStorageSlug
    )?.value
      ?? options[0]?.value
      ?? "";
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [target, setTarget] = useState(defaultTarget);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const status = useAsyncActionStatus({ successDurationMs: null });
  const targetAvailable = options.some((option) => option.value === target);

  useEffect(() => {
    if (!targetAvailable) setTarget(defaultTarget);
  }, [defaultTarget, targetAvailable]);

  if (!open) return null;

  const close = () => {
    setError("");
    setMenuOpen(false);
    onClose();
  };

  const migrate = async () => {
    let completedMessage = "";
    let completedStorageLabel = "";
    const succeeded = await status.run(async () => {
      setError("");
      if (!targetAvailable) {
        setError("请选择目标存储。");
        return false;
      }
      let response: ImageStorageMigrationResponseDto;
      try {
        response = await api<ImageStorageMigrationResponseDto>(
          `${adminApiBasePath}/images/migrate-storage`,
          {
            method: "POST",
            body: JSON.stringify({ ids: imageIds, target })
          }
        );
      } catch (migrationError) {
        reportAdminUiError("image_metadata.storage_migration", migrationError);
        setError(`迁移失败：${errorMessage(migrationError)}`);
        return false;
      }

      // 迁移结果已经由服务端提交后，界面刷新失败不能把 mutation 误报为失败或诱导
      // 用户重复迁移。刷新异常单独记录，成功/部分失败仍严格按服务端统计呈现。
      const unchanged = Math.max(
        0,
        imageIds.length - response.migrated - response.failed
      );
      if (response.migrated || unchanged) {
        try {
          await onSaved();
        } catch (refreshError) {
          reportAdminUiError(
            "image_metadata.storage_migration_refresh",
            refreshError,
            response
          );
        }
      }
      if (response.failed) {
        reportAdminUiError(
          "image_metadata.storage_migration_partial",
          new Error(`图片存储迁移失败 ${response.failed}/${imageIds.length}`),
          response
        );
        const reasons = [
          ...new Set(
            response.results.flatMap((result) =>
              result.status === "failed" ? [result.message] : []
            )
          )
        ];
        setError(
          `迁移未全部完成：已迁移 ${response.migrated} 项，` +
            `未变化 ${unchanged} 项，失败 ${response.failed} 项。` +
            (reasons.length ? ` ${reasons.join("；")}` : "")
        );
        return false;
      }
      const targetLabel = response.storage_label;
      const message = single
        ? response.migrated
          ? `图片已迁移到${targetLabel}`
          : `图片已在${targetLabel}，无需迁移`
        : `存储迁移完成：已迁移 ${response.migrated} 张${
            unchanged ? `，${unchanged} 张未变化` : ""
          }`;
      completedMessage = message;
      completedStorageLabel = targetLabel;
      return true;
    });
    return succeeded
      ? { message: completedMessage, storageLabel: completedStorageLabel }
      : null;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await migrate();
    if (result) onSucceeded(result.message, result.storageLabel);
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
        <form className="operation-modal" tabIndex={-1} onSubmit={submit}>
          <header>
            <div>
              <h2>{single ? "迁移存储" : "批量迁移存储"}</h2>
              <p>
                {single
                  ? "将这张图片迁移到目标存储后端。"
                  : `将这批 ${imageIds.length} 张图片迁移到目标存储后端。`}
              </p>
            </div>
            <button
              ref={closeButtonRef}
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={status.pending}
              onClick={() => requestClose()}
            >
              <AdminIcon name="close-line" />
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
                disabled={!options.length}
              />
            </label>
            {isLoading && <p className="muted">正在加载存储后端</p>}
            {isError && (
              <p className="admin-error" role="alert">
                存储后端列表加载失败，请关闭弹窗后重试。
              </p>
            )}
            <p className="notice-line">
              迁移会复制对象与缩略图到目标后端、更新引用，并删除源副本；目标为对象存储时需先在设置页配置好该后端。
            </p>
            {error && (
              <p className="admin-error" role="alert" title={error}>
                {error}
              </p>
            )}
          </div>
          <footer>
            <button type="button" disabled={status.pending} onClick={() => requestClose()}>
              取消
            </button>
            <AsyncActionButton
              className="button"
              type="submit"
              status={status.status}
              presentation={migratePresentation}
              disabled={status.pending || isError || !targetAvailable}
            />
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
