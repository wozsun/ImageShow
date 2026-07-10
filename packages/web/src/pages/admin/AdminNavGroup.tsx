import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../components/icon/Icon.js";

type AdminNavGroupItem = { to: string; label: string; end?: boolean };

export function AdminNavGroup({ icon, label, items }: {
  icon: IconName;
  label: string;
  items: AdminNavGroupItem[];
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const sectionActive = items.some((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));
  const [open, setOpen] = useState(sectionActive);
  useEffect(() => { if (sectionActive) setOpen(true); }, [sectionActive]);
  const enter = () => { setOpen(true); if (items[0]) navigate(items[0].to); };
  return (
    <div className={`admin-nav-group ${open ? "is-open" : ""}`}>
      <div className={`admin-nav-group-trigger ${sectionActive ? "active" : ""}`.trim()}>
        <button type="button" className="admin-nav-group-main" onClick={enter}>
          <Icon name={icon} />
          <span className="admin-nav-group-label">{label}</span>
        </button>
        <button
          type="button"
          className="admin-nav-caret"
          aria-label={`${open ? "收起" : "展开"}${label}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="arrow-down-s-line" />
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
