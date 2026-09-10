import { useLayoutEffect, useRef, useState, type DragEvent } from "react";
import type {
  AdminEntityDto,
  AuthorDto,
  AuthorMutationResponseDto
} from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { AdminIcon } from "../../components/icon/AdminIcon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { ReorderControls } from "../../components/actions/ReorderControls.js";
import { SlugChip } from "../../components/data-display/SlugChip.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import type { ReorderDirection } from "../../lib/ui/reorder.js";

export function VocabularyAdminCard({ kind, item, onChanged, onDelete, onError, canDelete = false, reorderBusy, canMovePrevious, canMoveNext, onMove, onReorderControlRef, onDragStart, onDragEnter, onDragEnd }: {
  kind: "themes" | "tags" | "authors";
  item: AdminEntityDto;
  onChanged: (item?: AuthorDto) => void | Promise<void>;
  onDelete: () => void;
  onError: (error: unknown) => void;
  canDelete?: boolean;
  reorderBusy: boolean;
  canMovePrevious: boolean;
  canMoveNext: boolean;
  onMove: (direction: ReorderDirection) => void;
  onReorderControlRef: (
    direction: ReorderDirection,
    node: HTMLButtonElement | null
  ) => void;
  onDragStart?: (slug: string) => void;
  onDragEnter?: (slug: string) => void;
  onDragEnd?: () => void;
}) {
  const noun = kind === "themes" ? "主题" : kind === "tags" ? "标签" : "作者";

  const isAuthor = kind === "authors";
  const derivedIdentity = isAuthor && "derived_identity" in item
    ? item.derived_identity as AuthorDto["derived_identity"]
    : null;
  const [form, setForm] = useState(() => ({
    kind, slug: item.slug,
    display: item.display_name, link: item.link ?? "",
    savedDisplay: item.display_name, savedLink: item.link ?? ""
  }));
  const { display, link } = form;
  useLayoutEffect(() => {
    setForm((current) => {
      const replaced = current.kind !== kind || current.slug !== item.slug;
      return {
        kind, slug: item.slug,
        display: replaced || current.display === current.savedDisplay ? item.display_name : current.display,
        link: replaced || current.link === current.savedLink ? item.link ?? "" : current.link,
        savedDisplay: item.display_name, savedLink: item.link ?? ""
      };
    });
  }, [item.display_name, item.link, item.slug, kind]);
  const saveStatus = useAsyncActionStatus();

  const cardRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const dirty = display !== form.savedDisplay || (isAuthor && link !== form.savedLink);
  const cardBusy = saveStatus.pending || reorderBusy;
  const savePresentation = {
    idle: { icon: "save-3-line", label: "保存" },
    pending: { icon: "save-3-line", label: "保存中" },
    success: { icon: "check-line", label: "已保存" },
    error: { icon: "close-line", label: "保存失败" }
  } as const;

  const acceptSaved = (savedDisplay: string, savedLink: string) => {
    setForm((current) => current.kind === kind && current.slug === item.slug
      ? { ...current, display: savedDisplay, link: savedLink, savedDisplay, savedLink }
      : current);
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

  const begin = (event: DragEvent<HTMLSpanElement>) => {
    if (cardBusy) {
      event.preventDefault();
      return;
    }
    setDragging(true);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.slug);
    onDragStart?.(item.slug);
  };

  return (
    <div
      ref={cardRef}
      className={`entity-card${dragging ? " is-dragging" : ""}`}
      onDragEnter={() => { onDragEnter?.(item.slug); }}
      onDragOver={(event) => { event.preventDefault(); }}
    >
      <div className="entity-card-row">
        <SlugChip value={item.slug} ariaLabel={`${noun} slug`} />
        <input
          className="entity-display-input"
          value={display}
          onChange={(event) => setForm({ ...form, display: event.target.value })}
          placeholder="显示名"
          disabled={cardBusy}
          maxLength={64}
        />
      </div>
      {isAuthor && (
        <div className="entity-card-row entity-card-link-row">
          <input
            className="entity-link-input"
            value={link}
            onChange={(event) => setForm({ ...form, link: event.target.value })}
            placeholder="作者主页链接（HTTPS，可选）"
            disabled={cardBusy}
            maxLength={2048}
            aria-label={`作者 ${item.slug} 链接`}
            title={derivedIdentity
              ? `平台: ${derivedIdentity.provider}; UID: ${derivedIdentity.id}`
              : undefined}
          />
        </div>
      )}
      <div className="entity-card-foot">
        <span className="muted entity-count">{item.image_count} 张</span>
        {(dirty || saveStatus.status !== "idle") && (
          <AsyncActionButton
            type="button"
            className="button"
            status={saveStatus.status}
            presentation={savePresentation}
            disabled={cardBusy || (!dirty && saveStatus.status === "idle")}
            onClick={() => void save()}
          />
        )}
        <ReorderControls
          itemLabel={`${noun} ${item.slug}`}
          busy={cardBusy}
          canMovePrevious={canMovePrevious}
          canMoveNext={canMoveNext}
          onMove={onMove}
          onControlRef={onReorderControlRef}
          dragPreviewRef={cardRef}
          onDragStart={begin}
          onDragEnd={() => {
            setDragging(false);
            onDragEnd?.();
          }}
        />
        {canDelete && (
          <button
            className="icon danger-button is-subtle"
            type="button"
            disabled={cardBusy}
            title={`删除${noun}`}
            onClick={onDelete}
          >
            <AdminIcon name="delete-bin-6-line" />
          </button>
        )}
      </div>
    </div>
  );
}
