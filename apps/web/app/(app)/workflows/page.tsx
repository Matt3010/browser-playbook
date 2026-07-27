"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Workflow } from "@/lib/api";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  ready: "bg-green-100 text-green-700",
  disabled: "bg-amber-100 text-amber-800"
};

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const data = await api.get<Workflow[]>("/workflows");
    setWorkflows(data);
    setLoading(false);
  }

  useEffect(() => {
    load().catch(() => setLoading(false));
  }, []);

  async function remove(id: string) {
    await api.del(`/workflows/${id}`);
    await load();
  }

  /**
   * Copies a workflow. The steps come with it, the history and the schedules
   * stay with the original: a copy is a starting point, not a past.
   */
  async function clone(id: string) {
    setBusy(id);
    try {
      await api.post(`/workflows/${id}/clone`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workflow</h1>
        <Link href="/workflows/new" className="btn" data-testid="new-workflow">
          Nuovo workflow
        </Link>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Caricamento...</p>
      ) : workflows.length === 0 ? (
        <p className="card text-sm text-slate-500" data-testid="workflows-empty">
          Nessun workflow. Creane uno per iniziare.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="workflow-list">
          {workflows.map((workflow) => (
            <li
              key={workflow.id}
              className="card flex flex-wrap items-center gap-4"
              data-testid={`workflow-row-${workflow.name}`}
            >
              <div className="flex-1">
                <Link
                  href={`/workflows/${workflow.id}`}
                  className="font-medium text-blue-700 hover:underline"
                  data-testid={`workflow-link-${workflow.name}`}
                >
                  {workflow.name}
                </Link>
                <p className="text-xs text-slate-500">{workflow.startUrl}</p>
              </div>
              <span className="text-xs text-slate-500">{workflow.stepCount ?? 0} step</span>
              <span className={`badge ${STATUS_STYLE[workflow.status]}`} data-testid="workflow-status">
                {workflow.status}
              </span>
              <button
                className="btn-secondary"
                onClick={() => void clone(workflow.id)}
                disabled={busy !== null}
                data-testid={`workflow-clone-${workflow.name}`}
              >
                {busy === workflow.id ? "Copia..." : "Duplica"}
              </button>
              <button className="btn-danger" onClick={() => void remove(workflow.id)}>
                Elimina
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
