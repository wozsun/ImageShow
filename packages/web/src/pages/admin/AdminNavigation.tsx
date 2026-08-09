import { Fragment, useState } from "react";
import { NavLink } from "react-router";
import type {
  AdminColorScheme,
  AdminRole
} from "@imageshow/shared/browser";
import { AdminIcon, type AdminIconName } from "../../components/icon/AdminIcon.js";
import { adminBasePath } from "../../lib/constants.js";
import { AdminNavGroup } from "./AdminNavGroup.js";
import {
  type AdminRouteModuleKey
} from "./admin-route-modules.js";
import { useAdminRoutePreloadIntent } from "./useAdminRoutePreloadIntent.js";

type AdminNavigationLink = {
  kind: "link";
  to: string;
  label: string;
  icon: AdminIconName;
  end?: boolean;
  superOnly?: boolean;
  desktopClassName?: string;
  routeModule?: AdminRouteModuleKey;
};

type AdminNavigationGroup = {
  kind: "group";
  id: string;
  label: string;
  icon: AdminIconName;
  items: readonly AdminNavigationLink[];
  superOnly?: boolean;
  desktopDefaultOpenRoles?: readonly AdminRole[];
  desktopDefaultOpen?: boolean;
};

type AdminNavigationEntry = AdminNavigationLink | AdminNavigationGroup;

type AdminNavigationSections = {
  site: readonly AdminNavigationEntry[];
  main: readonly AdminNavigationEntry[];
  account: readonly AdminNavigationEntry[];
};

const adminNavigationModel = {
  site: [
    {
      kind: "link",
      to: "/",
      icon: "home-4-line",
      label: "首页",
      desktopClassName: "home-link"
    }
  ],
  main: [
    {
      kind: "link",
      to: adminBasePath,
      icon: "dashboard-line",
      label: "概览",
      end: true,
      routeModule: "overview"
    },
    {
      kind: "group",
      id: "images",
      icon: "image-line",
      label: "图片",
      desktopDefaultOpenRoles: ["image"],
      items: [
        {
          kind: "link",
          to: `${adminBasePath}/images`,
          icon: "image-line",
          label: "图片列表",
          end: true,
          routeModule: "images"
        },
        {
          kind: "link",
          to: `${adminBasePath}/themes`,
          icon: "palette-line",
          label: "主题管理",
          routeModule: "entities"
        },
        {
          kind: "link",
          to: `${adminBasePath}/tags`,
          icon: "price-tag-3-line",
          label: "标签管理",
          routeModule: "entities"
        },
        {
          kind: "link",
          to: `${adminBasePath}/authors`,
          icon: "quill-pen-line",
          label: "作者管理",
          routeModule: "entities"
        }
      ]
    },
    {
      kind: "group",
      id: "settings",
      icon: "settings-3-line",
      label: "设置",
      superOnly: true,
      items: [
        {
          kind: "link",
          to: `${adminBasePath}/site`,
          icon: "settings-3-line",
          label: "站点配置",
          routeModule: "site"
        },
        {
          kind: "link",
          to: `${adminBasePath}/advanced-config`,
          icon: "settings-3-line",
          label: "高级配置",
          routeModule: "advancedConfig"
        },
        {
          kind: "link",
          to: `${adminBasePath}/storage`,
          icon: "hard-drive-2-line",
          label: "存储管理",
          routeModule: "storage"
        },
        {
          kind: "link",
          to: `${adminBasePath}/users`,
          icon: "group-line",
          label: "用户管理",
          routeModule: "users"
        }
      ]
    },
    {
      kind: "link",
      to: `${adminBasePath}/check`,
      icon: "checkbox-circle-line",
      label: "检查",
      routeModule: "check"
    },
    {
      kind: "link",
      to: `${adminBasePath}/logs`,
      icon: "history-line",
      label: "日志",
      superOnly: true,
      routeModule: "logs"
    }
  ],
  account: [
    {
      kind: "link",
      to: `${adminBasePath}/account`,
      icon: "key-2-line",
      label: "账户",
      routeModule: "account"
    }
  ]
} as const satisfies AdminNavigationSections;

function navigationEntriesForRole(
  entries: readonly AdminNavigationEntry[],
  role: AdminRole
): AdminNavigationEntry[] {
  const isSuper = role === "super";
  const visibleEntries: AdminNavigationEntry[] = [];
  for (const entry of entries) {
    if (entry.superOnly && !isSuper) continue;
    if (entry.kind === "link") {
      visibleEntries.push(entry);
      continue;
    }
    const items = entry.items.filter((item) => !item.superOnly || isSuper);
    if (items.length) {
      visibleEntries.push({
        ...entry,
        items,
        desktopDefaultOpen:
          entry.desktopDefaultOpenRoles?.includes(role) ?? false
      });
    }
  }
  return visibleEntries;
}

export function adminNavigationForRole(role: AdminRole): AdminNavigationSections {
  return {
    site: navigationEntriesForRole(adminNavigationModel.site, role),
    main: navigationEntriesForRole(adminNavigationModel.main, role),
    account: navigationEntriesForRole(adminNavigationModel.account, role)
  };
}

function NavigationLink({
  item,
  variant
}: {
  item: AdminNavigationLink;
  variant: "desktop" | "mobile";
}) {
  const preloadIntent = useAdminRoutePreloadIntent(item.routeModule);
  return (
    <NavLink
      to={item.to}
      end={item.end}
      {...preloadIntent}
      className={({ isActive }) => [
        variant === "desktop" ? item.desktopClassName : "",
        isActive ? "active" : ""
      ].filter(Boolean).join(" ")}
    >
      <AdminIcon name={item.icon} />{item.label}
    </NavLink>
  );
}

export function AdminNavigationLinks({
  entries,
  variant
}: {
  entries: readonly AdminNavigationEntry[];
  variant: "desktop" | "mobile";
}) {
  return entries.map((entry) => {
    if (entry.kind === "link") {
      return <NavigationLink key={entry.to} item={entry} variant={variant} />;
    }
    if (variant === "desktop") {
      return (
        <AdminNavGroup
          key={entry.id}
          icon={entry.icon}
          label={entry.label}
          items={entry.items}
          defaultOpen={entry.desktopDefaultOpen}
        />
      );
    }
    return (
      <Fragment key={entry.id}>
        {entry.items.map((item) => (
          <NavigationLink key={item.to} item={item} variant="mobile" />
        ))}
      </Fragment>
    );
  });
}

const adminAppearanceOptions = {
  dark: { label: "暗色模式", icon: "moon-line" },
  light: { label: "亮色模式", icon: "sun-line" },
  system: { label: "自动模式（跟随系统）", icon: "computer-line" }
} as const satisfies Record<AdminColorScheme, {
  label: string;
  icon: AdminIconName;
}>;

export function AdminSiteNavigation({
  entries,
  variant,
  colorScheme,
  nextColorScheme,
  onColorSchemeChange
}: {
  entries: readonly AdminNavigationEntry[];
  variant: "desktop" | "mobile";
  colorScheme: AdminColorScheme;
  nextColorScheme: AdminColorScheme;
  onColorSchemeChange: (colorScheme: AdminColorScheme) => void;
}) {
  const current = adminAppearanceOptions[colorScheme];
  const target = adminAppearanceOptions[nextColorScheme];
  const [holdCommittedIcon, setHoldCommittedIcon] = useState(false);
  return (
    <div className="admin-site-navigation">
      <AdminNavigationLinks entries={entries} variant={variant} />
      <button
        className={[
          "admin-color-scheme-toggle",
          holdCommittedIcon ? "is-current-icon-held" : ""
        ].filter(Boolean).join(" ")}
        type="button"
        data-color-scheme={colorScheme}
        aria-label={`当前外观：${current.label}；切换到${target.label}`}
        title={`切换到${target.label}`}
        onClick={() => {
          setHoldCommittedIcon(true);
          onColorSchemeChange(nextColorScheme);
        }}
        onPointerEnter={() => setHoldCommittedIcon(false)}
        onPointerLeave={() => setHoldCommittedIcon(false)}
        onBlur={() => setHoldCommittedIcon(false)}
      >
        <span className="admin-color-scheme-icon-stack" aria-hidden="true">
          <span className="admin-color-scheme-icon is-current">
            <AdminIcon name={current.icon} />
          </span>
          <span className="admin-color-scheme-icon is-target">
            <AdminIcon name={target.icon} />
          </span>
        </span>
      </button>
    </div>
  );
}
