/**
 * 输入控件下方的错误说明，与控件上的 aria-invalid 红框配套使用；message 为空时不渲染。
 * 是否以 announce 立即播报由调用方决定：提交后才出现的错误播报，纯输入过程中的规则提示可不播报。
 * id 供控件以 aria-describedby 关联。
 */
export function FieldError({
  id,
  message,
  announce = false
}: {
  id?: string;
  message?: string | null;
  announce?: boolean;
}) {
  if (!message) return null;
  return (
    <span id={id} className="admin-field-error" role={announce ? "alert" : undefined}>
      {message}
    </span>
  );
}
