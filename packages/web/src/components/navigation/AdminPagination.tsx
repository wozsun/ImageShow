export function AdminPagination({
  page,
  totalPages,
  onPrevious,
  onNext,
  ariaLabel,
  className,
  disabled = false,
  previousDisabled = false,
  nextDisabled = false,
}: {
  page: number;
  totalPages: number;
  onPrevious: () => void;
  onNext: () => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
}) {
  return (
    <nav className={`admin-pagination${className ? ` ${className}` : ""}`} aria-label={ariaLabel}>
      <button
        type="button"
        disabled={disabled || previousDisabled || page <= 1}
        onClick={onPrevious}
      >
        上一页
      </button>
      <span>第 {page} / {totalPages} 页</span>
      <button
        type="button"
        disabled={disabled || nextDisabled || page >= totalPages}
        onClick={onNext}
      >
        下一页
      </button>
    </nav>
  );
}
