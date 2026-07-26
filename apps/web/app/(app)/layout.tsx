"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type NotificationEntry } from "@/lib/api";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/workflows", label: "Workflow" },
  { href: "/credentials", label: "Variabili e credenziali" },
  { href: "/executions", label: "Esecuzioni" },
  { href: "/notifications", label: "Notifiche" }
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [email, setEmail] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [checked, setChecked] = useState(false);

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

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Browser Automation</span>
          <nav className="flex flex-1 items-center gap-4 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`nav-${item.href.slice(1)}`}
                className={
                  pathname.startsWith(item.href)
                    ? "font-medium text-blue-700"
                    : "text-slate-600 hover:text-slate-900"
                }
              >
                {item.label}
                {item.href === "/notifications" && unread > 0 ? (
                  <span
                    className="badge ml-1 bg-red-100 text-red-700"
                    data-testid="unread-badge"
                  >
                    {unread}
                  </span>
                ) : null}
              </Link>
            ))}
          </nav>
          <span className="text-sm text-slate-500" data-testid="current-user">
            {email}
          </span>
          <button className="btn-secondary" onClick={logout} data-testid="logout">
            Logout
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4">{children}</main>
    </div>
  );
}
