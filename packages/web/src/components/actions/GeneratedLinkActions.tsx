import { CopyButton } from "./CopyButton.js";
import { Icon } from "../icon/Icon.js";

export function GeneratedLinkActions({ url }: { url: string }) {
  return (
    <>
      <code>{url}</code>
      <CopyButton value={url} ariaLabel="复制随机图片链接" />
      <a
        className="button secondary pressable"
        href={url}
        target="_blank"
        rel="noreferrer noopener"
      >
        <Icon name="external-link-line" />打开
      </a>
    </>
  );
}
