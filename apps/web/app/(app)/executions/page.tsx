"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, type Execution } from "@/lib/api";

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-slate-100 text-slate-700",
  starting: "bg-blue-100 text-blue-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-amber-100 text-amber-800"
};

export default function ExecutionsPage() {
  const searchParams = useSearchParams();
  const workflowId = searchParams.get("workflowId");
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<Execution[]>(`/executions${workflowId ? `?workflowId=${workflowId}` : ""}`)
        .then((data) => {
          if (!cancelled) {
            setExecutions(data);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [workflowId]);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Esecuzioni</h1>

      {loading ? (
        <p className="text-sm text-slate-500">Caricamento...</p>
      ) : executions.length === 0 ? (
        <p className="card text-sm text-slate-500" data-testid="executions-empty">
          Nessuna esecuzione.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="execution-list">
          {executions.map((execution) => (
            <li key={execution.id} className="card flex items-center gap-3">
              <Link
                href={`/executions/${execution.id}`}
                className="flex-1 font-medium text-blue-700 hover:underline"
              >
                {execution.workflow?.name ?? execution.workflowId}
              </Link>
              {execution.scheduleId ? (
                <span className="badge bg-purple-100 text-purple-700">pianificata</span>
              ) : null}
              <span className="text-xs text-slate-500">
                {new Date(execution.createdAt).toLocaleString()}
              </span>
              <span
                className={`badge ${STATUS_STYLE[execution.status] ?? "bg-slate-100"}`}
                data-testid="execution-status"
              >
                {execution.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
