import { Fragment } from "react";
import { NavLink } from "react-router-dom";
import type { AdminRole } from "@imageshow/shared/browser";
import { Icon, type IconName } from "../../components/icon/Icon.js";
import { adminBasePath } from "../../lib/constants.js";
import { AdminNavGroup } from "./AdminNavGroup.js";

type AdminNavigationLink = {
  kind: "link";
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  superOnly?: boolean;
  desktopClassName?: string;
};

type AdminNavigationGroup = {
  kind: "group";
  id: string;
  label: string;
  icon: IconName;
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
      end: true
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
          end: true
        },
        {
          kind: "link",
          to: `${adminBasePath}/themes`,
          icon: "palette-line",
          label: "主题管理"
        },
        {
          kind: "link",
          to: `${adminBasePath}/tags`,
          icon: "price-tag-3-line",
          label: "标签管理"
        },
        {
          kind: "link",
          to: `${adminBasePath}/authors`,
          icon: "quill-pen-line",
          label: "作者管理"
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
          label: "站点配置"
        },
        {
          kind: "link",
          to: `${adminBasePath}/advanced-config`,
          icon: "settings-3-line",
          label: "高级配置"
        },
        {
          kind: "link",
          to: `${adminBasePath}/storage`,
          icon: "hard-drive-2-line",
          label: "存储管理"
        },
        {
          kind: "link",
          to: `${adminBasePath}/users`,
          icon: "group-line",
          label: "用户管理"
        }
      ]
    },
    {
      kind: "link",
      to: `${adminBasePath}/check`,
      icon: "checkbox-circle-line",
      label: "检查"
    },
    {
      kind: "link",
      to: `${adminBasePath}/logs`,
      icon: "history-line",
      label: "日志",
      superOnly: true
    }
  ],
  account: [
    {
      kind: "link",
      to: `${adminBasePath}/account`,
      icon: "key-2-line",
      label: "账户"
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
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) => [
        variant === "desktop" ? item.desktopClassName : "",
        isActive ? "active" : ""
      ].filter(Boolean).join(" ")}
    >
      <Icon name={item.icon} />{item.label}
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
