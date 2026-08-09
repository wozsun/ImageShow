import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";
import {
  parseAdminPaginationPage,
  releaseAdminPaginationSubmission,
  resolveAdminPaginationCommit,
  shouldCommitAdminPaginationInput,
  shouldPreserveAdminPaginationInputFocus
} from "./admin-pagination-model.js";

export function AdminPagination({
  page,
  totalPages,
  onPageChange,
  ariaLabel,
  className,
  disabled = false,
  previousDisabled = false,
  nextDisabled = false,
}: {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
}) {
  const [pageInput, setPageInput] = useState(String(page));
  const [pageInputInvalid, setPageInputInvalid] = useState(false);
  const submittedPageRef = useRef<number | null>(null);
  const previouslyDisabledRef = useRef(disabled);
  const pageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setPageInput(String(page));
    setPageInputInvalid(false);
    submittedPageRef.current = null;
  }, [page, totalPages]);

  useEffect(() => {
    submittedPageRef.current = releaseAdminPaginationSubmission(
      previouslyDisabledRef.current,
      disabled,
      submittedPageRef.current
    );
    previouslyDisabledRef.current = disabled;
  }, [disabled]);

  const commitPageInput = () => {
    const commit = resolveAdminPaginationCommit({
      value: pageInput,
      page,
      totalPages,
      submittedPage: submittedPageRef.current
    });
    setPageInput(commit.value);
    setPageInputInvalid(commit.invalid);
    submittedPageRef.current = commit.submittedPage;
    if (commit.targetPage !== null) onPageChange(commit.targetPage);
  };
  const preservePageInputFocus = (
    event: ReactPointerEvent<HTMLButtonElement>
  ) => {
    if (shouldPreserveAdminPaginationInputFocus(
      event.button,
      document.activeElement === pageInputRef.current
    )) {
      event.preventDefault();
    }
  };

  return (
    <nav className={`admin-pagination${className ? ` ${className}` : ""}`} aria-label={ariaLabel}>
      <button
        type="button"
        disabled={disabled || previousDisabled || page <= 1}
        onPointerDown={preservePageInputFocus}
        onClick={() => onPageChange(page - 1)}
      >
        上一页
      </button>
      <span className="admin-pagination-status">
        第
        <input
          ref={pageInputRef}
          className="admin-pagination-page-input"
          value={pageInput}
          size={Math.max(1, Math.min(8, String(totalPages).length))}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-label={`${ariaLabel}当前页`}
          aria-invalid={pageInputInvalid}
          title={`输入 1 至 ${totalPages}，按回车或移开焦点跳转`}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            const value = event.target.value;
            submittedPageRef.current = null;
            setPageInput(value);
            setPageInputInvalid(
              parseAdminPaginationPage(value, totalPages) === null
            );
          }}
          onKeyDown={(event) => {
            if (!shouldCommitAdminPaginationInput(
              event.key,
              event.nativeEvent.isComposing,
              event.keyCode
            )) {
              return;
            }
            event.preventDefault();
            commitPageInput();
          }}
          onBlur={commitPageInput}
        />
        / {totalPages} 页
      </span>
      <button
        type="button"
        disabled={disabled || nextDisabled || page >= totalPages}
        onPointerDown={preservePageInputFocus}
        onClick={() => onPageChange(page + 1)}
      >
        下一页
      </button>
    </nav>
  );
}
