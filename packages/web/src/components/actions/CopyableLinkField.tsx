import { CopyButton } from "./CopyButton.js";

/**
 * 只读链接框加复制按钮，点击链接框全选。prefix 是框内左侧的小字说明，此时链接框与说明共用
 * 一个外框。颜色、尺寸与复制按钮的位置（并排或嵌入框内）由所在页面的样式决定。
 */
export function CopyableLinkField({
  className,
  value,
  inputLabel,
  copyLabel,
  prefix,
  copyVariant = "icon"
}: {
  className: string;
  value: string;
  inputLabel: string;
  copyLabel: string;
  prefix?: string;
  copyVariant?: "icon" | "text";
}) {
  const input = (
    <input
      readOnly
      value={value}
      aria-label={inputLabel}
      onClick={(event) => event.currentTarget.select()}
    />
  );
  return (
    <div className={className}>
      {prefix ? (
        <label className="copyable-link-field">
          <span className="copyable-link-prefix">{prefix}</span>
          {input}
        </label>
      ) : input}
      <CopyButton value={value} ariaLabel={copyLabel} variant={copyVariant} />
    </div>
  );
}
