"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Execution, type Workflow } from "@/lib/api";

export default function DashboardPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);

  useEffect(() => {
    api.get<Workflow[]>("/workflows").then(setWorkflows).catch(() => undefined);
    api.get<Execution[]>("/executions?limit=5").then(setExecutions).catch(() => undefined);
  }, []);

  return (
    <div className="space-y-4" data-testid="dashboard">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <Link href="/workflows/new" className="btn" data-testid="new-workflow">
          Nuovo workflow
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="card">
          <p className="text-sm text-slate-500">Workflow</p>
          <p className="text-2xl font-semibold" data-testid="stat-workflows">
            {workflows.length}
          </p>
        </div>
        <div className="card">
          <p className="text-sm text-slate-500">Pronti all&apos;esecuzione</p>
          <p className="text-2xl font-semibold" data-testid="stat-ready">
            {workflows.filter((w) => w.status === "ready").length}
          </p>
        </div>
        <div className="card">
          <p className="text-sm text-slate-500">Esecuzioni recenti</p>
          <p className="text-2xl font-semibold" data-testid="stat-executions">
            {executions.length}
          </p>
        </div>
      </div>

      <section className="card">
        <h2 className="mb-2 font-medium">Ultime esecuzioni</h2>
        {executions.length === 0 ? (
          <p className="text-sm text-slate-500">Nessuna esecuzione registrata.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {executions.map((execution) => (
              <li key={execution.id} className="flex items-center justify-between py-2">
                <Link href={`/executions/${execution.id}`} className="text-blue-700 hover:underline">
                  {execution.workflow?.name ?? execution.workflowId}
                </Link>
                <span className="text-slate-500">{execution.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
