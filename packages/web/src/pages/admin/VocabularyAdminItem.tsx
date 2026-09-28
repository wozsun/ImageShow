import { useLayoutEffect, useState, type ReactNode } from "react";
import type {
  AdminEntityDto,
  AuthorDto,
  AuthorMutationResponseDto
} from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { AsyncActionButton, type AsyncActionPresentation } from "../../components/actions/AsyncActionButton.js";
import { SortOrderInput } from "../../components/actions/SortOrderInput.js";
import { SlugChip } from "../../components/data-display/SlugChip.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

export const vocabularyColumnLabels = {
  slug: "标识",
  display: "显示名",
  link: "主页链接",
  count: "图片数",
  sort: "排序",
  actions: "操作"
} as const;
export type VocabularyColumnId = keyof typeof vocabularyColumnLabels;

export function VocabularyAdminItem({
  kind,
  item,
  columns,
  viewMode,
  onChanged,
  onDelete,
  onError,
  canDelete = false,
  sortBusy,
  onSortSave
}: {
  kind: "themes" | "tags" | "authors";
  item: AdminEntityDto;
  columns: readonly VocabularyColumnId[];
  viewMode: "list" | "card";
  onChanged: (item?: AuthorDto) => void | Promise<void>;
  onDelete: () => void;
  onError: (error: unknown) => void;
  canDelete?: boolean;
  sortBusy: boolean;
  onSortSave: (value: number) => Promise<number>;
}) {
  const noun = kind === "themes" ? "主题" : kind === "tags" ? "标签" : "作者";

  const isAuthor = kind === "authors";
  const derivedIdentity =
    isAuthor && "derived_identity" in item
      ? (item.derived_identity as AuthorDto["derived_identity"])
      : null;
  const [form, setForm] = useState(() => ({
    kind,
    slug: item.slug,
    display: item.display_name,
    link: item.link ?? "",
    savedDisplay: item.display_name,
    savedLink: item.link ?? ""
  }));
  const { display, link } = form;
  useLayoutEffect(() => {
    setForm((current) => {
      const replaced = current.kind !== kind || current.slug !== item.slug;
      return {
        kind,
        slug: item.slug,
        display:
          replaced || current.display === current.savedDisplay
            ? item.display_name
            : current.display,
        link: replaced || current.link === current.savedLink ? (item.link ?? "") : current.link,
        savedDisplay: item.display_name,
        savedLink: item.link ?? ""
      };
    });
  }, [item.display_name, item.link, item.slug, kind]);
  const saveStatus = useAsyncActionStatus();

  const dirty = display !== form.savedDisplay || (isAuthor && link !== form.savedLink);
  const busy = saveStatus.pending || sortBusy;
  const isSaveAction = dirty || saveStatus.status !== "idle";
  const actionPresentation: AsyncActionPresentation = {
    idle: isSaveAction
      ? { icon: "save-3-line", label: "保存" }
      : { icon: "delete-bin-6-line", label: "删除" },
    pending: { icon: "save-3-line", label: "保存中" },
    success: { icon: "check-line", label: "已保存" },
    error: { icon: "close-line", label: "保存失败" }
  };

  const acceptSaved = (savedDisplay: string, savedLink: string) => {
    setForm((current) =>
      current.kind === kind && current.slug === item.slug
        ? { ...current, display: savedDisplay, link: savedLink, savedDisplay, savedLink }
        : current
    );
  };
  const save = async () => {
    await saveStatus.run(async () => {
      try {
        const body = isAuthor
          ? { display_name: display.trim(), link: link.trim() }
          : { display_name: display.trim() };
        const response = await api<AuthorMutationResponseDto | { ok: true }>(
          `${adminApiBasePath}/${kind}/${item.slug}`,
          {
            method: "POST",
            body: JSON.stringify(body)
          }
        );
        if (isAuthor && "item" in response) {
          acceptSaved(response.item.display_name, response.item.link);
          await onChanged(response.item);
        } else {
          // Theme/tag writes persist the trimmed display name unchanged.
          acceptSaved(body.display_name, "");
          await onChanged();
        }
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    });
  };

  const cells: Record<VocabularyColumnId, ReactNode> = {
    slug: <SlugChip value={item.slug} ariaLabel={`${noun} ${item.slug} 标识`} />,
    display: (
      <input
        className="vocabulary-display-input"
        value={display}
        onChange={(event) => {
          saveStatus.reset();
          setForm({ ...form, display: event.target.value });
        }}
        placeholder="显示名"
        aria-label={`${noun} ${item.slug} 显示名`}
        disabled={busy}
        maxLength={64}
      />
    ),
    link: (
      <input
        className="vocabulary-link-input"
        value={link}
        onChange={(event) => {
          saveStatus.reset();
          setForm({ ...form, link: event.target.value });
        }}
        placeholder="作者主页链接（HTTPS，可选）"
        disabled={busy}
        maxLength={2048}
        aria-label={`作者 ${item.slug} 主页链接`}
        title={derivedIdentity ? `平台: ${derivedIdentity.provider}; UID: ${derivedIdentity.id}` : undefined}
      />
    ),
    count: (
      <span className="muted" title="全部关联图片（包含回收站）">
        {item.image_count} 张
      </span>
    ),
    sort: (
      <SortOrderInput
        itemLabel={`${noun} ${item.slug}`}
        value={item.sort_order}
        disabled={busy}
        onSave={onSortSave}
      />
    ),
    actions: (
      <div className="vocabulary-item-actions">
        {(canDelete || isSaveAction) && (
          <AsyncActionButton
            type="button"
            className={`icon vocabulary-action-button ${isSaveAction ? "button" : "danger-button is-subtle"}`}
            status={saveStatus.status}
            presentation={actionPresentation}
            aria-label={`${isSaveAction ? "保存" : "删除"}${noun} ${item.slug}`}
            disabled={busy || (isSaveAction && !dirty)}
            onClick={() => {
              if (isSaveAction) {
                if (dirty) void save();
              } else if (canDelete) {
                onDelete();
              }
            }}
          />
        )}
      </div>
    )
  };

  const renderCell = (column: VocabularyColumnId) => (
    <div
      key={column}
      className={`vocabulary-cell vocabulary-cell-${column}`}
      role={viewMode === "list" ? "cell" : undefined}
    >
      {cells[column]}
    </div>
  );

  return (
    <div
      className="vocabulary-item"
      role={viewMode === "list" ? "row" : "listitem"}
      data-vocabulary-slug={item.slug}
    >
      <div className="vocabulary-item-identity">
        {columns.filter((column) => column === "slug" || column === "display").map(renderCell)}
      </div>
      {columns.filter((column) => column === "link").map(renderCell)}
      <div className="vocabulary-item-footer">
        {columns.filter((column) => column === "count" || column === "sort" || column === "actions").map(renderCell)}
      </div>
    </div>
  );
}
