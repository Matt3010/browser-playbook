"use client";

import Link from "next/link";
import { useEffect, useState, type ComponentType } from "react";
import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";

/**
 * The only thing this needs of an icon: something that renders when given a
 * size and a class. Any icon set satisfies it, so the sidebar does not depend
 * on which one the application happens to use.
 */
export type SidebarIcon = ComponentType<{ size?: number | string; className?: string }>;

/** One destination in the navigation. */
export interface SidebarLink {
  href: string;
  label: string;
  /** Shown on its own when the sidebar is folded, so it has to stand for the label. */
  icon: SidebarIcon;
  /** A count worth interrupting for, such as unread notifications. */
  badge?: number;
}

export interface SidebarProps {
  links: SidebarLink[];
  /** The current path, to mark where we are. */
  activeHref: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Who is logged in: what tells you which account you are about to act on. */
  user: string | null;
  onLogout: () => void;
  /** Shown at the top when there is room for it. */
  title?: string;
}

/** Where the choice of folding it away is remembered. */
const COLLAPSED_KEY = "sidebar-collapsed";
/** Below this, it starts folded: the content needs the width more than the labels do. */
const NARROW_PX = 1024;

/**
 * The folded/unfolded choice, remembered across pages and reloads, and given up
 * while the window is too narrow to afford it.
 *
 * Decided once the browser is there: on the server there is no window to measure
 * and no choice to read, so the first render is unfolded and the effect corrects
 * it. Below the threshold it folds and stays folded — a quarter of a narrow
 * window is taken from the page that needs it most — and it can still be opened
 * by hand from there: folding is the default, not a rule. Widen the window again
 * and the remembered choice comes back.
 */
export function useRememberedCollapse(narrowPx: number = NARROW_PX): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const narrow = window.matchMedia(`(max-width: ${narrowPx - 1}px)`);
    const apply = () => {
      if (narrow.matches) {
        setCollapsed(true);
        return;
      }
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "true");
    };
    apply();
    narrow.addEventListener("change", apply);
    return () => narrow.removeEventListener("change", apply);
  }, [narrowPx]);

  const toggle = () =>
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // Private browsing: it simply forgets, which is not worth failing over.
      }
      return next;
    });

  return [collapsed, toggle];
}

/**
 * The navigation of the application, as a column that folds to icons.
 *
 * A row of links across the top takes width from every page; a column can be
 * folded away by the person looking at the page that needs the width — which,
 * here, is the one showing a remote screen.
 */
export function Sidebar({
  links,
  activeHref,
  collapsed,
  onToggle,
  user,
  onLogout,
  title
}: SidebarProps) {
  return (
    <aside
      /*
       * Nothing in here may wrap. The labels are wider than the folded column,
       * so left to themselves they turn one line into two halfway through the
       * animation: the rows grow, the sidebar shuffles, and the page beside it
       * moves with it. They are clipped instead, and the width does the talking.
       */
      className={`sticky top-0 flex h-screen shrink-0 flex-col gap-1 overflow-hidden whitespace-nowrap border-r border-slate-200 bg-white p-2 transition-[width] ${
        collapsed ? "w-14" : "w-60"
      }`}
      data-testid="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="flex items-center gap-2">
        <button
          className="btn-mini"
          onClick={onToggle}
          title={collapsed ? "Espandi il menu" : "Riduci il menu"}
          aria-label={collapsed ? "Espandi il menu" : "Riduci il menu"}
          aria-expanded={!collapsed}
          data-testid="sidebar-toggle"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        {collapsed || !title ? null : (
          <span className="truncate font-semibold">{title}</span>
        )}
      </div>

      <nav className="mt-2 flex flex-1 flex-col gap-1 text-sm">
        {links.map((link) => {
          const active = activeHref.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              data-testid={`nav-${link.href.slice(1)}`}
              title={link.label}
              className={`flex min-h-[36px] items-center gap-2 rounded-md px-2 ${
                active
                  ? "bg-blue-50 font-medium text-blue-700"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <link.icon size={18} className="shrink-0" aria-hidden="true" />
              {collapsed ? null : <span className="truncate">{link.label}</span>}
              {link.badge ? (
                <span className="badge bg-red-100 text-red-700" data-testid="unread-badge">
                  {link.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="mt-2 border-t border-slate-200 pt-2">
        {/* Kept mounted while folded: it is what tells you which account you are
            about to act on, and it is read on every page. */}
        <span
          className={`block truncate text-xs text-slate-500 ${collapsed ? "sr-only" : ""}`}
          data-testid="current-user"
        >
          {user}
        </span>
        <button
          className="btn-secondary mt-2 w-full justify-center"
          onClick={onLogout}
          title="Logout"
          data-testid="logout"
        >
          {collapsed ? <LogOut size={16} /> : "Logout"}
        </button>
      </div>
    </aside>
  );
}
