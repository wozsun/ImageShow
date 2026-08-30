import { useId, useRef, useState, type RefObject } from "react";
import {
  slugFormatHint,
  slugMaxLength,
  slugPattern
} from "../../../lib/constants.js";
import type { AdvancedConfigPreview } from "../../../lib/types.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { AsyncActionButton } from "../../../components/actions/AsyncActionButton.js";
import { DialogFrame } from "../../../components/feedback/DialogFrame.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";

const importPackagePresentation = {
  idle: { icon: "upload-cloud-2-line", label: "确认导入" },
  pending: { icon: "upload-cloud-2-line", label: "正在导入" },
  success: { icon: "check-line", label: "导入成功" },
  error: { icon: "close-line", label: "导入失败" }
} as const;

function previewDate(value: string | null) {
  if (!value) return "未提供";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function configPackageRecognitionNotice(preview: Pick<
  AdvancedConfigPreview,
  "config_values" | "skipped_storage_backends"
>) {
  const { recognized, defaulted, ignored } = preview.config_values;
  const skipped = [
    ignored > 0 ? `忽略 ${ignored} 个未知或错误的运行时配置字段` : "",
    preview.skipped_storage_backends > 0
      ? `跳过 ${preview.skipped_storage_backends} 个无法安全识别的存储后端`
      : ""
  ].filter(Boolean);
  const skippedCopy = skipped.length > 0 ? `；${skipped.join("，")}` : "";
  return `当前版本将逐项读取：采用 ${recognized} 个运行时配置项，${defaulted} 个运行时配置项使用当前默认值${skippedCopy}。未知、已删除或错误的运行时配置字段不会阻止其余内容导入。`;
}

function suggestedSlug(slug: string) {
  const suffix = "-imported";
  return `${slug.slice(0, slugMaxLength - suffix.length).replace(/-+$/, "")}${suffix}`;
}

export function configPackageSlugMappingError(
  preview: Pick<
    AdvancedConfigPreview,
    "conflicts" | "existing_slugs" | "storage_backends"
  >,
  slugMappings: Record<string, string>,
  sourceSlug: string
) {
  const target = (slugMappings[sourceSlug] ?? "").trim().toLowerCase();
  if (!target) return "必须填写新的 slug";
  if (target.length > slugMaxLength) {
    return `slug 不能超过 ${slugMaxLength} 个字符`;
  }
  if (target === "local" || !slugPattern.test(target)) return slugFormatHint;
  if (preview.existing_slugs.includes(target)) return "该 slug 已存在，请使用新的标识";
  const resolved = preview.storage_backends.map((backend) =>
    preview.conflicts.includes(backend.slug)
      ? (slugMappings[backend.slug] ?? "").trim().toLowerCase()
      : backend.slug
  );
  if (resolved.filter((slug) => slug === target).length > 1) return "导入后的 slug 不能重复";
  return "";
}

export function ConfigPackageImportDialog({
  preview,
  busy,
  returnFocusRef,
  onClose,
  onImport
}: {
  preview: AdvancedConfigPreview;
  busy: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onImport: (slugMappings: Record<string, string>) => Promise<boolean>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const operationBodyRef = useRef<HTMLDivElement | null>(null);
  const [slugMappings, setSlugMappings] = useState<Record<string, string>>(() => Object.fromEntries(
    preview.conflicts.map((slug) => [slug, suggestedSlug(slug)])
  ));
  const importStatus = useAsyncActionStatus({ successDurationMs: null });
  const blocked = busy || importStatus.pending;

  const mappingError = (sourceSlug: string) => configPackageSlugMappingError(
    preview,
    slugMappings,
    sourceSlug
  );

  const mappingErrors = preview.conflicts.map(mappingError).filter(Boolean);
  const submit = async (requestClose: () => void) => {
    const normalized = Object.fromEntries(
      Object.entries(slugMappings).map(([slug, replacement]) => [slug, replacement.trim().toLowerCase()])
    );
    if (await importStatus.run(() => onImport(normalized))) requestClose();
  };

  return (
    <DialogFrame
      className="modal edit-modal config-package-dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      busy={blocked}
      initialFocusRef={closeButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form onSubmit={(event) => { event.preventDefault(); void submit(requestClose); }}>
          <header>
            <div className="config-package-dialog-copy">
              <h2 id={titleId}>导入配置包</h2>
              <p id={descriptionId}>确认当前版本识别的配置和即将新增的自定义存储后端。</p>
            </div>
            <button
              ref={closeButtonRef}
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={blocked}
              onClick={() => requestClose()}
            >
              <AdminIcon name="close-line" />
            </button>
          </header>
          <div ref={operationBodyRef} className="operation-body">
            <dl className="advanced-config-summary">
              <div><dt>来源格式</dt><dd>{preview.format ?? "未提供"}</dd></div>
              <div><dt>来源版本</dt><dd>{preview.application_version ?? "未提供"}</dd></div>
              <div><dt>导出时间</dt><dd>{previewDate(preview.exported_at)}</dd></div>
              <div>
                <dt>采用配置项</dt>
                <dd>
                  {preview.config_values.recognized}/
                  {preview.config_values.recognized + preview.config_values.defaulted}
                </dd>
              </div>
            </dl>
            <p className="muted advanced-config-import-notice">
              {configPackageRecognitionNotice(preview)}
            </p>
            <div className="advanced-config-backends">
              {preview.storage_backends.length ? preview.storage_backends.map((backend) => {
                const conflict = preview.conflicts.includes(backend.slug);
                const error = conflict ? mappingError(backend.slug) : "";
                return (
                  <article key={backend.slug} className={`advanced-config-backend${conflict ? " has-conflict" : ""}`}>
                    <div>
                      <strong>{backend.display_name || backend.slug}</strong>
                      <span>
                        {backend.slug} · 对象存储
                        {backend.is_default ? " · 默认" : ""}{backend.enabled ? "" : " · 已停用"}
                      </span>
                    </div>
                    {conflict ? (
                      <label>
                        重命名 slug
                        <input
                          value={slugMappings[backend.slug] ?? ""}
                          onChange={(event) => setSlugMappings((current) => ({
                            ...current,
                            [backend.slug]: event.target.value.toLowerCase()
                          }))}
                          aria-invalid={Boolean(error)}
                          disabled={blocked}
                          maxLength={slugMaxLength}
                        />
                        {error && <small className="admin-error">{error}</small>}
                      </label>
                    ) : <span className="advanced-config-ready"><AdminIcon name="check-line" />可新增</span>}
                  </article>
                );
              }) : <p className="muted">配置包不包含自定义存储后端。</p>}
            </div>
          </div>
          <OverlayScrollbar targetRef={operationBodyRef} />
          <footer>
            <button type="button" disabled={blocked} onClick={() => requestClose()}>取消</button>
            <AsyncActionButton
              className="button"
              type="submit"
              status={importStatus.status}
              presentation={importPackagePresentation}
              disabled={blocked || mappingErrors.length > 0}
            />
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
