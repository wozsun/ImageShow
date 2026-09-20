import { Outlet } from "react-router";
import { useEmbeddedCursorBridge } from "../../hooks/useEmbeddedCursorBridge.js";
import "../../styles/embed-cursor.css";

export function EmbeddedPageLayout({ enabled }: { enabled: boolean }) {
  useEmbeddedCursorBridge(enabled);
  return <Outlet />;
}
