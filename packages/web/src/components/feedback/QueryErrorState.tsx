import { errorMessage } from "../../lib/ui/formatters.js";
import { Icon } from "../icon/Icon.js";

export function QueryErrorState({ error, onRetry, fullPage = false }: {
  error: unknown;
  onRetry: () => void;
  fullPage?: boolean;
}) {
  return (
    <div className={`${fullPage ? "center " : ""}query-error-state`} role="alert">
      <p>加载失败：{errorMessage(error)}</p>
      <button type="button" onClick={onRetry}><Icon name="refresh-line" />重试</button>
    </div>
  );
}
