"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  api,
  ApiError,
  type Execution,
  type RecordingResult,
  type Schedule,
  type SessionInfo,
  type Step,
  type Workflow
} from "@/lib/api";
import { StepEditor } from "@/components/StepEditor";
import { VncViewer, type VncStatus } from "@/components/VncViewer";

export default function WorkflowDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const workflowId = params.id;

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [startUrl, setStartUrl] = useState("");
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [vncStatus, setVncStatus] = useState<VncStatus>("connecting");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [runAt, setRunAt] = useState("");
  const [timezone, setTimezone] = useState("Europe/Rome");
  const [dirty, setDirty] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const log = useCallback((message: string) => {
    setLogLines((lines) => [...lines.slice(-199), `${new Date().toLocaleTimeString()} ${message}`]);
  }, []);

  const loadWorkflow = useCallback(async () => {
    const data = await api.get<Workflow>(`/workflows/${workflowId}`);
    setWorkflow(data);
    setStartUrl(data.startUrl);
    setSteps(data.steps ?? []);
    setDirty(false);
  }, [workflowId]);

  const loadSchedules = useCallback(async () => {
    const data = await api.get<Schedule[]>(`/workflows/${workflowId}/schedules`);
    setSchedules(data);
  }, [workflowId]);

  useEffect(() => {
    loadWorkflow().catch((err) => setError(err.message));
    loadSchedules().catch(() => undefined);
    try {
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } catch {
      setTimezone("UTC");
    }
  }, [loadWorkflow, loadSchedules]);

  // Stop polling and release the remote browser when leaving the page.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function run<T>(label: string, action: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await action();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setError(message);
      log(`ERRORE: ${message}`);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function startBrowser() {
    await run("start", async () => {
      if (startUrl !== workflow?.startUrl) {
        await api.patch(`/workflows/${workflowId}`, { startUrl });
        await loadWorkflow();
      }
      const created = await api.post<SessionInfo>("/sessions", { startUrl, workflowId });
      setSession(created);
      log(`Sessione browser ${created.sessionId} avviata (${created.state})`);
      startPolling(created.sessionId);
    });
  }

  function startPolling(sessionId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const info = await api.get<SessionInfo>(`/sessions/${sessionId}`);
        setSession((current) => (current ? { ...current, ...info } : current));
        if (info.state === "closed" || info.state === "error") {
          if (pollRef.current) clearInterval(pollRef.current);
          log(`Sessione ${info.state}`);
          return;
        }
        if (info.recording) {
          const recording = await api.get<RecordingResult>(`/sessions/${sessionId}/recording`);
          setSteps(recording.steps);
          setDirty(true);
          if (recording.skipped > 0) {
            log(`${recording.skipped} azioni scartate: selector non univoco`);
          }
        }
      } catch {
        /* transient errors are reported by explicit actions */
      }
    }, 1200);
  }

  async function setRecording(enabled: boolean) {
    if (!session) return;
    await run(enabled ? "record" : "stop", async () => {
      await api.post(`/sessions/${session.sessionId}/recording`, { enabled });
      setSession({ ...session, recording: enabled });

      if (!enabled) {
        // Polling stops with the recording, so pull the final action stream once
        // more: otherwise the last actions would never reach the editor.
        const recording = await api.get<RecordingResult>(
          `/sessions/${session.sessionId}/recording`
        );
        setSteps(recording.steps);
        setDirty(true);
      }
      log(enabled ? "Registrazione avviata" : "Registrazione fermata");
    });
  }

  async function toggleHighlight() {
    if (!session) return;
    await run("highlight", async () => {
      const next = !session.highlight;
      await api.post(`/sessions/${session.sessionId}/highlight`, { enabled: next });
      setSession({ ...session, highlight: next });
      log(`Evidenziazione ${next ? "attiva" : "disattiva"}`);
    });
  }

  async function navigate() {
    if (!session) return;
    await run("navigate", async () => {
      await api.post(`/sessions/${session.sessionId}/navigate`, { url: startUrl });
      log(`Navigazione verso ${startUrl}`);
    });
  }

  async function closeSession() {
    if (!session) return;
    await run("close", async () => {
      await api.del(`/sessions/${session.sessionId}`);
      if (pollRef.current) clearInterval(pollRef.current);
      log("Sessione chiusa");
      setSession(null);
    });
  }

  async function save() {
    await run("save", async () => {
      // Secrets captured while recording are persisted server-side first, so the
      // {{credentials.x}} references in the steps can be resolved at run time.
      if (session) {
        const result = await api.post<{ saved: string[] }>(
          `/sessions/${session.sessionId}/credentials`
        );
        if (result.saved.length > 0) {
          log(`Credenziali salvate: ${result.saved.join(", ")}`);
        }
      }
      const saved = await api.put<Step[]>(`/workflows/${workflowId}/steps`, { steps });
      setSteps(saved);
      setDirty(false);
      await loadWorkflow();
      log(`${saved.length} step salvati`);
    });
  }

  async function execute() {
    const execution = await run("execute", async () => {
      if (dirty) {
        const saved = await api.put<Step[]>(`/workflows/${workflowId}/steps`, { steps });
        setSteps(saved);
        setDirty(false);
      }
      return api.post<Execution>(`/workflows/${workflowId}/executions`);
    });
    if (execution) router.push(`/executions/${execution.id}`);
  }

  async function schedule() {
    if (!runAt) {
      setError("Indica data e ora dell'esecuzione");
      return;
    }
    await run("schedule", async () => {
      if (dirty) {
        await api.put(`/workflows/${workflowId}/steps`, { steps });
        setDirty(false);
      }
      await api.post(`/workflows/${workflowId}/schedules`, {
        runAt: new Date(runAt).toISOString(),
        timezone
      });
      await loadSchedules();
      log("Esecuzione pianificata");
    });
  }

  async function cancelSchedule(id: string) {
    await run("cancel", async () => {
      await api.del(`/schedules/${id}`);
      await loadSchedules();
      log("Pianificazione annullata");
    });
  }

  if (!workflow) {
    return <p className="text-sm text-slate-500">Caricamento workflow...</p>;
  }

  return (
    <div className="space-y-3" data-testid="recorder-page">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold" data-testid="workflow-name">
          {workflow.name}
        </h1>
        <span className="badge bg-slate-100 text-slate-700" data-testid="workflow-status">
          {workflow.status}
        </span>
        <div className="flex-1" />
        <Link href={`/executions?workflowId=${workflowId}`} className="btn-secondary">
          Esecuzioni
        </Link>
      </div>

      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="recorder-error">
          {error}
        </p>
      ) : null}

      {/* toolbar */}
      <div className="card flex flex-wrap items-center gap-2">
        <input
          className="input max-w-md flex-1"
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
          data-testid="start-url"
          aria-label="URL iniziale"
        />
        {!session ? (
          <button className="btn" onClick={startBrowser} disabled={busy !== null} data-testid="start-browser">
            {busy === "start" ? "Avvio..." : "Avvia browser"}
          </button>
        ) : (
          <>
            <button className="btn-secondary" onClick={navigate} disabled={busy !== null} data-testid="navigate">
              Vai
            </button>
            <button
              className="btn"
              onClick={() => void setRecording(true)}
              disabled={busy !== null || session.recording}
              data-testid="record"
            >
              Registra
            </button>
            <button
              className="btn-secondary"
              onClick={() => void setRecording(false)}
              disabled={busy !== null || !session.recording}
              data-testid="stop-recording"
            >
              Stop
            </button>
            <button className="btn-secondary" onClick={toggleHighlight} disabled={busy !== null} data-testid="toggle-highlight">
              Evidenzia: {session.highlight ? "on" : "off"}
            </button>
            <button className="btn-danger" onClick={closeSession} disabled={busy !== null} data-testid="close-session">
              Chiudi browser
            </button>
          </>
        )}
        <button className="btn" onClick={save} disabled={busy !== null} data-testid="save-steps">
          {busy === "save" ? "Salvataggio..." : "Salva"}
        </button>
        <button className="btn" onClick={execute} disabled={busy !== null} data-testid="run-now">
          {busy === "execute" ? "Avvio..." : "Esegui adesso"}
        </button>
      </div>

      {/* browser + steps */}
      <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
        <div className="card h-[520px] overflow-hidden p-0" data-testid="browser-panel">
          {session?.vncPath ? (
            <VncViewer path={session.vncPath} onStatusChange={setVncStatus} />
          ) : (
            <p className="flex h-full items-center justify-center text-sm text-slate-500">
              Avvia il browser per vedere lo stream noVNC.
            </p>
          )}
        </div>

        <div className="card h-[520px] overflow-hidden p-0">
          <StepEditor
            steps={steps}
            onChange={(next) => {
              setSteps(next);
              setDirty(true);
            }}
          />
        </div>
      </div>

      {/* status + live log */}
      <div className="card">
        <div className="mb-2 flex flex-wrap gap-4 text-xs text-slate-600">
          <span data-testid="session-state" data-session-id={session?.sessionId ?? ""}>
            Sessione: {session?.state ?? "non avviata"}
          </span>
          <span data-testid="vnc-state">noVNC: {session ? vncStatus : "-"}</span>
          <span data-testid="recording-state">
            Registrazione: {session?.recording ? "attiva" : "ferma"}
          </span>
          <span data-testid="current-url">URL: {session?.currentUrl ?? "-"}</span>
          <span>Pagine: {(session?.pages ?? []).map((p) => p.pageId).join(", ") || "-"}</span>
          {dirty ? <span className="text-amber-700">Modifiche non salvate</span> : null}
        </div>
        <pre
          className="max-h-40 overflow-y-auto rounded bg-slate-900 p-2 text-xs text-slate-100"
          data-testid="live-log"
        >
          {logLines.join("\n") || "Nessun evento."}
        </pre>
      </div>

      {/* scheduling */}
      <div className="card space-y-2">
        <h2 className="font-medium">Pianificazione singola</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-xs text-slate-600">Data e ora</span>
            <input
              type="datetime-local"
              className="input"
              value={runAt}
              onChange={(e) => setRunAt(e.target.value)}
              data-testid="schedule-run-at"
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-600">Timezone</span>
            <input
              className="input"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              data-testid="schedule-timezone"
            />
          </label>
          <button className="btn" onClick={schedule} disabled={busy !== null} data-testid="schedule-submit">
            Pianifica
          </button>
        </div>

        {schedules.length === 0 ? (
          <p className="text-sm text-slate-500">Nessuna pianificazione.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm" data-testid="schedule-list">
            {schedules.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2">
                <span className="flex-1">{new Date(item.runAt).toLocaleString()}</span>
                <span className="text-xs text-slate-500">{item.timezone}</span>
                <span className="badge bg-slate-100 text-slate-700" data-testid="schedule-status">
                  {item.status}
                </span>
                {item.status === "scheduled" ? (
                  <button
                    className="btn-secondary"
                    onClick={() => void cancelSchedule(item.id)}
                    data-testid="schedule-cancel"
                  >
                    Annulla
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
