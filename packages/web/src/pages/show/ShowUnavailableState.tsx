import { useEffect } from "react";
import { Link, useNavigate } from "react-router";
import { ErrorDetails } from "../../components/feedback/ErrorDetails.js";

/**
 * A stage this browser cannot start: says why, then replaces the history
 * entry with the gallery after a short notice.
 */
export function ShowUnavailableState({ error, galleryHref, webglUnavailable }: {
  error: Error;
  galleryHref: string;
  webglUnavailable: boolean;
}) {
  const navigate = useNavigate();
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void navigate(galleryHref, { replace: true });
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [galleryHref, navigate]);

  return (
    <div className="query-error-state">
      {/* Only the notice is announced, not the copyable report below it. */}
      <p role="alert">{webglUnavailable ? "当前浏览器无法显示展映（需要 WebGL）" : "当前浏览器无法启动展映"}</p>
      {webglUnavailable && <p className="show-unavailable-note">可尝试更新浏览器或开启硬件加速。</p>}
      <p className="show-unavailable-note" role="status">5 秒后自动进入画廊。</p>
      <ErrorDetails error={error} />
      <Link className="button secondary" to={galleryHref}>
        在画廊中浏览
      </Link>
    </div>
  );
}
