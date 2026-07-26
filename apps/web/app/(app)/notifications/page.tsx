"use client";

import { useEffect, useState } from "react";
import { api, type NotificationEntry } from "@/lib/api";

const TYPE_STYLE: Record<string, string> = {
  workflow_completed: "bg-green-100 text-green-700",
  workflow_failed: "bg-red-100 text-red-700",
  schedule_started: "bg-blue-100 text-blue-700",
  schedule_missed: "bg-amber-100 text-amber-800"
};

export default function NotificationsPage() {
  const [items, setItems] = useState<NotificationEntry[]>([]);
  const [unread, setUnread] = useState(0);

  async function load() {
    const data = await api.get<{ items: NotificationEntry[]; unread: number }>("/notifications");
    setItems(data.items);
    setUnread(data.unread);
  }

  useEffect(() => {
    load().catch(() => undefined);
    const timer = setInterval(() => void load().catch(() => undefined), 4000);
    return () => clearInterval(timer);
  }, []);

  async function markRead(id: string) {
    await api.post(`/notifications/${id}/read`);
    await load();
  }

  async function markAllRead() {
    await api.post("/notifications/read-all");
    await load();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Notifiche</h1>
        <span className="badge bg-slate-100 text-slate-700" data-testid="unread-count">
          {unread} non lette
        </span>
        <div className="flex-1" />
        <button className="btn-secondary" onClick={markAllRead} data-testid="read-all">
          Segna tutte come lette
        </button>
      </div>

      {items.length === 0 ? (
        <p className="card text-sm text-slate-500" data-testid="notifications-empty">
          Nessuna notifica.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="notification-list">
          {items.map((item) => (
            <li
              key={item.id}
              className={`card ${item.readAt ? "opacity-60" : ""}`}
              data-testid={`notification-${item.type}`}
            >
              <div className="flex items-center gap-3">
                <span className={`badge ${TYPE_STYLE[item.type] ?? "bg-slate-100 text-slate-700"}`}>
                  {item.type}
                </span>
                <span className="flex-1 font-medium" data-testid="notification-title">
                  {item.title}
                </span>
                <span className="text-xs text-slate-500">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
                {!item.readAt ? (
                  <button className="btn-secondary" onClick={() => void markRead(item.id)}>
                    Segna come letta
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-slate-600" data-testid="notification-message">
                {item.message}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
