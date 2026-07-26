"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Execution, type ExecutionLog } from "@/lib/api";

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-slate-100 text-slate-700",
  starting: "bg-blue-100 text-blue-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-amber-100 text-amber-800"
};

const TERMINAL = ["completed", "failed", "cancelled"];

export default function ExecutionDetailPage({ params }: { params: { id: string } }) {
  const executionId = params.id;
  const [execution, setExecution] = useState<Execution | null>(null);
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const seen = useRef(new Set<string>());

  // Initial snapshot, including logs already stored.
  useEffect(() => {
    api
      .get<Execution>(`/executions/${executionId}`)
      .then((data) => {
        setExecution(data);
        for (const log of data.logs ?? []) seen.current.add(log.id);
        setLogs(data.logs ?? []);
      })
      .catch(() => undefined);
  }, [executionId]);

  // Live updates over Server-Sent Events until the execution is terminal.
  useEffect(() => {
    const source = new EventSource(`/api/executions/${executionId}/logs/stream`, {
      withCredentials: true
    });

    source.addEventListener("log", (event) => {
      const log = JSON.parse((event as MessageEvent).data) as ExecutionLog;
      if (seen.current.has(log.id)) return;
      seen.current.add(log.id);
      setLogs((current) => [...current, log]);
    });

    source.addEventListener("status", (event) => {
      const status = JSON.parse((event as MessageEvent).data) as Partial<Execution>;
      setExecution((current) => (current ? { ...current, ...status } : current));
    });

    source.addEventListener("end", () => {
      source.close();
      // Reload once at the end to pick up artifacts and final timings.
      api
        .get<Execution>(`/executions/${executionId}`)
        .then(setExecution)
        .catch(() => undefined);
    });

    source.onerror = () => source.close();
    return () => source.close();
  }, [executionId]);

  /** Stops a run that is still queued or in progress, releasing its browser. */
  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      const updated = await api.post<Execution>(`/executions/${executionId}/cancel`);
      setExecution((current) => (current ? { ...current, ...updated } : updated));
    } catch (err) {
      setCancelError(err instanceof ApiError ? err.message : "Errore inatteso");
    } finally {
      setCancelling(false);
    }
  }

  if (!execution) {
    return <p className="text-sm text-slate-500">Caricamento esecuzione...</p>;
  }

  const screenshots = (execution.artifacts ?? []).filter((a) => a.type === "screenshot");
  const downloads = (execution.artifacts ?? []).filter((a) => a.type === "download");

  return (
    <div className="space-y-4" data-testid="execution-detail">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">
          {execution.workflow?.name ?? "Esecuzione"}
        </h1>
        <span
          className={`badge ${STATUS_STYLE[execution.status] ?? "bg-slate-100"}`}
          data-testid="execution-status"
        >
          {execution.status}
        </span>
        {!TERMINAL.includes(execution.status) ? (
          <>
            <span className="text-xs text-slate-500" data-testid="execution-live">
              aggiornamento live
            </span>
            <button
              className="btn-danger"
              onClick={cancel}
              disabled={cancelling}
              data-testid="cancel-execution"
            >
              {cancelling ? "Annullamento..." : "Annulla esecuzione"}
            </button>
          </>
        ) : null}
      </div>

      {cancelError ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="cancel-error">
          {cancelError}
        </p>
      ) : null}

      <div className="card grid gap-2 text-sm sm:grid-cols-2">
        <p>
          <span className="text-slate-500">Avviata: </span>
          {execution.startedAt ? new Date(execution.startedAt).toLocaleString() : "-"}
        </p>
        <p>
          <span className="text-slate-500">Terminata: </span>
          {execution.finishedAt ? new Date(execution.finishedAt).toLocaleString() : "-"}
        </p>
        <p>
          <span className="text-slate-500">Durata: </span>
          <span data-testid="execution-duration">
            {execution.durationMs !== null && execution.durationMs !== undefined
              ? `${execution.durationMs} ms`
              : "-"}
          </span>
        </p>
        <p className="truncate">
          <span className="text-slate-500">URL finale: </span>
          <span data-testid="execution-url">{execution.currentUrl ?? "-"}</span>
        </p>
        {execution.failedStepId ? (
          <p>
            <span className="text-slate-500">Step fallito: </span>
            <code data-testid="failed-step-id">{execution.failedStepId}</code>
          </p>
        ) : null}
      </div>

      {execution.errorMessage ? (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="execution-error">
          {execution.errorMessage}
        </div>
      ) : null}

      <section className="card">
        <h2 className="mb-2 font-medium">Log</h2>
        <pre
          className="max-h-80 overflow-y-auto rounded bg-slate-900 p-2 text-xs text-slate-100"
          data-testid="execution-logs"
        >
          {logs.length === 0
            ? "Nessun log."
            : logs
                .map(
                  (log) =>
                    `${new Date(log.createdAt).toLocaleTimeString()} [${log.level}] ${log.message}`
                )
                .join("\n")}
        </pre>
      </section>

      {screenshots.length > 0 ? (
        <section className="card">
          <h2 className="mb-2 font-medium">Screenshot errore</h2>
          <div className="space-y-2" data-testid="execution-screenshots">
            {screenshots.map((artifact) => (
              // A plain <img> is intentional: the artifact is served by the API
              // behind authentication, so Next.js image optimisation cannot fetch it.
              <img
                key={artifact.id}
                src={`/api/artifacts/${artifact.id}/file`}
                alt="Screenshot dell'errore"
                className="w-full rounded border border-slate-200"
                data-testid="error-screenshot"
              />
            ))}
          </div>
        </section>
      ) : null}

      {downloads.length > 0 ? (
        <section className="card">
          <h2 className="mb-2 font-medium">File scaricati</h2>
          <ul className="text-sm" data-testid="execution-downloads">
            {downloads.map((artifact) => (
              <li key={artifact.id}>
                <a className="text-blue-700 hover:underline" href={`/api/artifacts/${artifact.id}/file`}>
                  {artifact.path.split("/").pop()}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
