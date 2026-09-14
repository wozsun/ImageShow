import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { isSortOrder, sortOrderMin, sortOrderMax } from "@imageshow/shared/browser";
import { Icon } from "../icon/Icon.js";

function parseDraft(draft: string) {
  const text = draft.trim();
  const value = Number(text);
  return /^[+-]?\d+$/.test(text) && isSortOrder(value) ? value : null;
}

export function SortOrderInput({ value, itemLabel, disabled, onSave }: {
  value: number;
  itemLabel: string;
  disabled: boolean;
  onSave: (value: number) => Promise<number>;
}) {
  const [form, setForm] = useState({ draft: String(value), savedValue: value });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const runningRef = useRef(false);
  const mountedRef = useRef(false);
  const errorId = useId();
  const parsed = parseDraft(form.draft);
  const busy = disabled || pending;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useLayoutEffect(() => {
    setForm((current) => ({
      draft: parseDraft(current.draft) === current.savedValue ? String(value) : current.draft,
      savedValue: value
    }));
  }, [value]);

  const commit = async () => {
    if (busy || runningRef.current) return;
    if (parsed === null) {
      setError(`请输入 ${sortOrderMin} 至 ${sortOrderMax} 之间的整数`);
      return;
    }
    if (parsed === value) {
      setForm({ draft: String(value), savedValue: value });
      setError("");
      return;
    }
    runningRef.current = true;
    setPending(true);
    setError("");
    try {
      const saved = await onSave(parsed);
      if (mountedRef.current) setForm({ draft: String(saved), savedValue: saved });
    } catch (failure) {
      if (mountedRef.current) setError(failure instanceof Error ? failure.message : "排序保存失败，请重试");
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  };
  const step = (delta: number) => {
    if (busy || parsed === null || !isSortOrder(parsed + delta)) return;
    setForm({ ...form, draft: String(parsed + delta) });
    setError("");
  };

  return (
    <div className="sort-order-field">
      <div
        className="sort-order-control"
        role="group"
        aria-label={`${itemLabel}排序`}
        aria-busy={pending}
        title="排序值，越大越靠前"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) void commit();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          void commit();
        }}
      >
        <button type="button" className="icon sort-order-step"
          aria-label={`${itemLabel}排序值减一`}
          title="排序值减 1（更靠后）"
          disabled={busy}
          aria-disabled={busy || parsed === null || parsed <= sortOrderMin}
          onClick={() => step(-1)}>
          <Icon name="subtract-line" />
        </button>
        <input
          type="text"
          inputMode="numeric"
          role="spinbutton"
          aria-label={`${itemLabel}排序值`}
          aria-valuemin={sortOrderMin}
          aria-valuemax={sortOrderMax}
          aria-valuenow={parsed ?? undefined}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          value={form.draft}
          style={{ width: `calc(${Math.max(3, form.draft.length)}ch + 1px)` }}
          disabled={busy}
          onChange={(event) => {
            setForm({ ...form, draft: event.target.value });
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            step(event.key === "ArrowUp" ? 1 : -1);
          }}
        />
        <button type="button" className="icon sort-order-step"
          aria-label={`${itemLabel}排序值加一`}
          title="排序值加 1（更靠前）"
          disabled={busy}
          aria-disabled={busy || parsed === null || parsed >= sortOrderMax}
          onClick={() => step(1)}>
          <Icon name="add-line" />
        </button>
      </div>
      {error && <p id={errorId} className="admin-field-error" role="alert">{error}</p>}
    </div>
  );
}
