import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { AdminIcon, type AdminIconName } from "../../components/icon/AdminIcon.js";

type AdminNavGroupItem = { to: string; label: string; end?: boolean };

export function AdminNavGroup({ icon, label, items, defaultOpen = false }: {
  icon: AdminIconName;
  label: string;
  items: readonly AdminNavGroupItem[];
  defaultOpen?: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const sectionActive = items.some((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));
  const [open, setOpen] = useState(sectionActive || defaultOpen);
  useEffect(() => { if (sectionActive) setOpen(true); }, [sectionActive]);
  const enter = () => { setOpen(true); if (items[0]) navigate(items[0].to); };
  return (
    <div className={`admin-nav-group ${open ? "is-open" : ""}`}>
      <div className={`admin-nav-group-trigger ${sectionActive ? "active" : ""}`.trim()}>
        <button type="button" className="admin-nav-group-main" onClick={enter}>
          <AdminIcon name={icon} />
          <span className="admin-nav-group-label">{label}</span>
        </button>
        <button
          type="button"
          className="admin-nav-caret"
          aria-label={`${open ? "收起" : "展开"}${label}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <AdminIcon name="arrow-down-s-line" />
        </button>
      </div>
      <div className={`admin-nav-sub ${open ? "is-open" : ""}`}>
        <div className="admin-nav-sub-inner">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => isActive ? "active" : ""}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      </div>
    </div>
  );
}
