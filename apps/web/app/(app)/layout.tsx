"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Bell, KeyRound, LayoutDashboard, Play, Workflow } from "lucide-react";
import { api, ApiError, type NotificationEntry } from "@/lib/api";
import { Sidebar, useRememberedCollapse, type SidebarLink } from "@/components/Sidebar";

const NAV: SidebarLink[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/workflows", label: "Workflow", icon: Workflow },
  { href: "/credentials", label: "Variabili e credenziali", icon: KeyRound },
  { href: "/executions", label: "Esecuzioni", icon: Play },
  { href: "/notifications", label: "Notifiche", icon: Bell }
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [checked, setChecked] = useState(false);
  const [collapsed, toggleSidebar] = useRememberedCollapse();

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ email: string }>("/auth/me")
      .then((me) => {
        if (!cancelled) {
          setEmail(me.email);
          setChecked(true);
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
        } else if (!cancelled) {
          setChecked(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    const load = () =>
      api
        .get<{ items: NotificationEntry[]; unread: number }>("/notifications")
        .then((data) => {
          if (!cancelled) setUnread(data.unread);
        })
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [email, pathname]);

  async function logout() {
    await api.post("/auth/logout").catch(() => undefined);
    router.replace("/login");
  }

  if (!checked && !email) {
    return (
      <main className="p-8 text-sm text-slate-500" data-testid="app-loading">
        Caricamento...
      </main>
    );
  }

  // The badge belongs to the notifications entry, and nowhere else knows the count.
  const links = NAV.map((link) =>
    link.href === "/notifications" && unread > 0 ? { ...link, badge: unread } : link
  );

  return (
    <div className="flex min-h-screen">
      <Sidebar
        links={links}
        activeHref={pathname}
        collapsed={collapsed}
        onToggle={toggleSidebar}
        user={email}
        onLogout={logout}
        title="Browser Automation"
      />
      <main className="min-w-0 flex-1 p-4">{children}</main>
    </div>
  );
}
