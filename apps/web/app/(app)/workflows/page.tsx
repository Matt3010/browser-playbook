"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Workflow } from "@/lib/api";
import { describeCron } from "@/lib/recurrence";

/** A schedule that has not happened yet, whichever workflow it belongs to. */
interface Upcoming {
  id: string;
  workflowId: string;
  workflowName: string;
  cron: string | null;
  timezone: string;
  at: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  ready: "bg-green-100 text-green-700",
  disabled: "bg-amber-100 text-amber-800"
};

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [upcoming, setUpcoming] = useState<Upcoming[]>([]);

  async function load() {
    const data = await api.get<Workflow[]>("/workflows");
    setWorkflows(data);
    setLoading(false);
    // What is due next lives on the page of the workflow it belongs to, which is
    // no help once there are a few of them.
    setUpcoming(await api.get<Upcoming[]>("/schedules/upcoming").catch(() => []));
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

      <section className="card space-y-2">
        <h2 className="font-medium">Prossimi in coda</h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-slate-500" data-testid="upcoming-empty">
            Nessuna esecuzione pianificata.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm" data-testid="upcoming-list">
            {upcoming.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="w-44 shrink-0 text-slate-700">
                  {entry.at ? new Date(entry.at).toLocaleString() : "—"}
                </span>
                <Link
                  href={`/workflows/${entry.workflowId}`}
                  className="flex-1 text-blue-700 hover:underline"
                >
                  {entry.workflowName}
                </Link>
                {/* Read as a sentence here too: a cron line on a list of what is
                    about to happen is something nobody checks. */}
                {entry.cron ? (
                  <span className="text-xs text-slate-500">{describeCron(entry.cron)}</span>
                ) : null}
                <span className="text-xs text-slate-400">{entry.timezone}</span>
                {entry.cron ? (
                  <span className="badge bg-blue-50 text-blue-700">ricorrente</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

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
