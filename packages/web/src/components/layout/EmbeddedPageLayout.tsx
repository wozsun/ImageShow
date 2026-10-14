import { Outlet } from "react-router";
import { useEmbeddedCursorBridge } from "./useEmbeddedCursorBridge.js";
import { useEmbeddedSafeArea } from "./useEmbeddedSafeArea.js";
import "../../styles/embed-cursor.css";

/** Wraps embedded pages; the routes render it only while embedding is enabled. */
export function EmbeddedPageLayout() {
  useEmbeddedCursorBridge();
  useEmbeddedSafeArea();
  return <Outlet />;
}
