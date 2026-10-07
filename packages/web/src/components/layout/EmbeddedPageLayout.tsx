import { Outlet } from "react-router";
import { useEmbeddedCursorBridge } from "./useEmbeddedCursorBridge.js";
import { useEmbeddedSafeArea } from "./useEmbeddedSafeArea.js";
import "../../styles/embed-cursor.css";

export function EmbeddedPageLayout({ enabled }: { enabled: boolean }) {
  useEmbeddedCursorBridge(enabled);
  useEmbeddedSafeArea(enabled);
  return <Outlet />;
}
