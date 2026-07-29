"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  api,
  ApiError,
  type Execution,
  type RecordingResult,
  type Recurrence,
  type Schedule,
  type SessionInfo,
  type CredentialEntry,
  type Step,
  type StepVerification,
  type Workflow
} from "@/lib/api";
import { mergeRecording } from "@/lib/recording";
import { describeCron, describeRecurrence, WEEKDAYS } from "@/lib/recurrence";
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
  /** The repeating schedule being composed: what the user picks, not a cron line. */
  const [repeatKind, setRepeatKind] = useState<Recurrence["kind"]>("days");
  const [repeatTime, setRepeatTime] = useState("03:00");
  /**
   * The largest interval each unit accepts. Cron counts in whole units inside
   * the next one up: 59 minutes, 23 hours, 30 days, 12 months.
   */
  const REPEAT_MAX: Record<string, number> = { minutes: 59, hours: 23, days: 30, months: 12 };

  /** Minute of the hour for an hourly schedule, and the gap for one in minutes. */
  const [repeatMinute, setRepeatMinute] = useState(0);
  const [repeatEvery, setRepeatEvery] = useState(1);
  const [repeatWeekday, setRepeatWeekday] = useState(1);
  const [repeatDay, setRepeatDay] = useState(1);
  const [timezone, setTimezone] = useState("Europe/Rome");
  const [dirty, setDirty] = useState(false);
  const [verifications, setVerifications] = useState<StepVerification[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  /** The variables and secrets the steps reference, to show what they hold. */
  const [values, setValues] = useState<CredentialEntry[]>([]);
  /** Text on its way to the remote browser. */
  const [remoteText, setRemoteText] = useState("");
  /**
   * Secrets this recording captured that the user already has, and the ones they
   * chose to replace. A secret is shared by every workflow on that site, so
   * typing the password again while recording must not silently overwrite it.
   */
  const [knownSecrets, setKnownSecrets] = useState<string[]>([]);
  const [replacing, setReplacing] = useState<string[]>([]);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * What the recorder last handed over, by step id, and what the user has
   * deleted since. The editor polls the recording while it runs, so without
   * these two the poll simply undoes whatever was done to the list a second
   * earlier: a deleted step comes back and can never be removed.
   */
  const lastPulledRef = useRef<Map<string, Step>>(new Map());
  const removedRef = useRef<Set<string>>(new Set());
  /** The step list as it stands, readable outside a state updater. */
  const stepsRef = useRef<Step[]>([]);
  // Whether the last poll saw the recording running. The worker stops it by
  // itself when it captures the closing action, so this is what tells a stop the
  // user asked for from one the editor has not seen the actions of yet.
  const wasRecordingRef = useRef(false);

  const log = useCallback((message: string) => {
    setLogLines((lines) => [...lines.slice(-199), `${new Date().toLocaleTimeString()} ${message}`]);
  }, []);

  /**
   * Pulls the recorded steps into the editor. Every path that needs them goes
   * through here: the poll, and stopping the recording by hand.
   */
  const pullRecording = useCallback(async (sessionId: string): Promise<RecordingResult> => {
    const recording = await api.get<RecordingResult>(`/sessions/${sessionId}/recording`);
    const checks = new Map<string, StepVerification>();
    recording.steps.forEach((step, index) => {
      const check = (recording.verifications ?? [])[index];
      if (check) checks.set(step.id, check);
    });

    const merged = mergeRecording(recording.steps, stepsRef.current, {
      lastPulled: lastPulledRef.current,
      removed: removedRef.current
    });
    lastPulledRef.current = new Map(recording.steps.map((step) => [step.id, step]));
    setVerifications(merged.map((step) => checks.get(step.id) ?? { status: "unchecked" }));

    // Only a pull that actually brought something marks the list unsaved. A poll
    // that changed nothing used to set the flag anyway, so "Modifiche non
    // salvate" came back a second after every save for as long as the recording
    // ran — and nothing could tell a real change from the clock.
    const changed = JSON.stringify(merged) !== JSON.stringify(stepsRef.current);
    if (changed) {
      setSteps(merged);
      setDirty(true);
    }
    setKnownSecrets(
      (recording.credentials ?? []).filter((entry) => entry.exists).map((entry) => entry.name)
    );
    return recording;
  }, []);

  const loadWorkflow = useCallback(async () => {
    const data = await api.get<Workflow>(`/workflows/${workflowId}`);
    setWorkflow(data);
    setStartUrl(data.startUrl);
    setSteps(data.steps ?? []);
    setDirty(false);
  }, [workflowId]);

  const loadValues = useCallback(async () => {
    setValues(await api.get<CredentialEntry[]>("/credentials"));
  }, []);

  const loadSchedules = useCallback(async () => {
    const data = await api.get<Schedule[]>(`/workflows/${workflowId}/schedules`);
    setSchedules(data);
  }, [workflowId]);

  // The list, mirrored where the poll can read it without a state updater.
  useEffect(() => {
    stepsRef.current = steps;
  }, [steps]);

  useEffect(() => {
    loadWorkflow().catch((err) => setError(err.message));
    loadSchedules().catch(() => undefined);
    loadValues().catch(() => undefined);
    try {
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } catch {
      setTimezone("UTC");
    }
  }, [loadWorkflow, loadSchedules, loadValues]);

  // Release the remote browser when leaving the page, so its slot does not stay
  // taken until the idle timeout reclaims it. `keepalive` lets the request
  // outlive the page during a tab close or a reload.
  useEffect(() => {
    const sessionId = session?.sessionId;
    if (!sessionId) return;

    const release = () => {
      try {
        void fetch(`/api/sessions/${sessionId}`, {
          method: "DELETE",
          credentials: "include",
          keepalive: true
        });
      } catch {
        // The server-side reaper is the backstop.
      }
    };

    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      if (pollRef.current) clearInterval(pollRef.current);
      release();
    };
  }, [session?.sessionId]);

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

  /**
   * Renames the workflow. The response is merged into the loaded workflow rather
   * than reloading it: reloading replaces the step list with the saved one, and
   * a rename in the middle of a recording would throw away everything recorded
   * since the last save.
   */
  async function renameWorkflow() {
    const next = nameDraft.trim();
    if (!next || next === workflow?.name) {
      setRenaming(false);
      return;
    }
    await run("rename", async () => {
      const updated = await api.patch<Workflow>(`/workflows/${workflowId}`, { name: next });
      setWorkflow((current) => (current ? { ...current, name: updated.name } : current));
      setRenaming(false);
      log(`Workflow rinominato in "${updated.name}"`);
    });
  }

  async function startBrowser() {
    await run("start", async () => {
      if (startUrl !== workflow?.startUrl) {
        const updated = await api.patch<Workflow>(`/workflows/${workflowId}`, { startUrl });
        // Merged, not reloaded, for the same reason as the rename: the editor may
        // be holding a recording that has not been saved yet.
        setWorkflow((current) =>
          current ? { ...current, startUrl: updated.startUrl } : current
        );
      }
      const created = await api.post<SessionInfo>("/sessions", { startUrl, workflowId });
      setSession(created);
      log(`Sessione browser ${created.sessionId} avviata (${created.state})`);
      startPolling(created.sessionId);
    });
  }

  /** Closes every live session of the current user, to free the session slots. */
  async function releaseStaleSessions() {
    await run("release", async () => {
      const live = await api.get<Array<{ sessionId: string }>>("/sessions");
      for (const item of live) {
        await api.del(`/sessions/${item.sessionId}`).catch(() => undefined);
      }
      if (pollRef.current) clearInterval(pollRef.current);
      setSession(null);
      log(`${live.length} sessioni chiuse`);
    });
  }

  /**
   * Forgets the remote browser. The toolbar is driven by whether a session is
   * held, so a session that is gone has to be dropped rather than kept as a
   * dead handle: leaving it offered "Chiudi browser" for a browser that had
   * already closed, and no way back to "Avvia browser" but a reload.
   */
  const forgetSession = useCallback(
    (why: string) => {
      if (pollRef.current) clearInterval(pollRef.current);
      wasRecordingRef.current = false;
      setSession(null);
      log(why);
    },
    [log]
  );

  function startPolling(sessionId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const info = await api.get<SessionInfo>(`/sessions/${sessionId}`);
        setSession((current) => (current ? { ...current, ...info } : current));
        if (info.state === "closed" || info.state === "error") {
          forgetSession(
            info.state === "error"
              ? `Sessione in errore: ${info.error ?? "causa sconosciuta"}`
              : "Sessione chiusa"
          );
          return;
        }
        // Capturing the closing action stops the recording on the worker, which
        // disables Stop — the only other thing that pulls. Pulling once more on
        // the way down is what keeps that last action from being lost.
        if (info.recording || wasRecordingRef.current) {
          const recording = await pullRecording(sessionId);
          if (recording.skipped > 0) {
            log(`${recording.skipped} azioni scartate: selector non univoco`);
          }
          // The capture is the only stop the user did not ask for, so it is the
          // only one worth reporting here; Stop reports itself.
          if (!info.recording && recording.steps.some((s) => s.isFinal)) {
            log("Azione finale registrata senza eseguirla; registrazione fermata");
          }
        }
        wasRecordingRef.current = info.recording;
      } catch (err) {
        // A session the server no longer knows is gone for good; anything else
        // is a hiccup the next tick will recover from.
        if (err instanceof ApiError && err.status === 404) {
          forgetSession("Sessione non più disponibile");
        }
      }
    }, 1200);
  }

  async function setRecording(enabled: boolean) {
    if (!session) return;
    await run(enabled ? "record" : "stop", async () => {
      await api.post(`/sessions/${session.sessionId}/recording`, { enabled });
      setSession({ ...session, recording: enabled });

      if (!enabled) {
        // Pull the final action stream once more, and take the transition with
        // it, so the poll does not report this stop a second time.
        const recording = await pullRecording(session.sessionId);
        wasRecordingRef.current = false;

        const broken = (recording.verifications ?? []).filter(
          (v) => v.status === "ambiguous" || v.status === "not-found"
        );
        log(
          broken.length === 0
            ? `Registrazione fermata: ${recording.steps.length} step, tutti verificati`
            : `Registrazione fermata: ${broken.length} step non rieseguibili, controllali prima di salvare`
        );
        return;
      }
      log(enabled ? "Registrazione avviata" : "Registrazione fermata");
    });
  }

  /**
   * Arms the capture of the closing action. The next thing clicked in the remote
   * browser is recorded but not performed, so a destructive final step is never
   * triggered while recording.
   */
  async function armFinalAction() {
    if (!session) return;
    await run("arm", async () => {
      const next = !session.armedFinal;
      await api.post(`/sessions/${session.sessionId}/arm-final`, { enabled: next });
      setSession({ ...session, armedFinal: next });
      log(
        next
          ? "Azione finale armata: il prossimo click verra registrato ma NON eseguito"
          : "Azione finale disarmata"
      );
    });
  }

  /** Discards everything recorded so far, unlocking recording again. */
  async function clearRecording() {
    if (!session) return;
    await run("clear", async () => {
      await api.del(`/sessions/${session.sessionId}/recording`);
      lastPulledRef.current = new Map();
      removedRef.current = new Set();
      setSteps([]);
      setVerifications([]);
      setDirty(true);
      setSession({ ...session, armedFinal: false, recording: false });
      log("Registrazione azzerata");
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

  /** The description panel that follows the pointer inside the stream. */
  async function toggleTooltip() {
    if (!session) return;
    await run("tooltip", async () => {
      const next = !session.tooltip;
      await api.post(`/sessions/${session.sessionId}/tooltip`, { enabled: next });
      setSession({ ...session, tooltip: next });
      log(`Tooltip ${next ? "attivo" : "disattivo"}`);
    });
  }

  /**
   * Types into the remote browser. The stream is a canvas, so on a tablet there
   * is no field to focus and no keyboard to raise: the text is typed here, into
   * whatever the remote page has focused, and arrives there as real key events —
   * so the recorder turns it into the same step as typing on a keyboard.
   */
  async function typeRemotely() {
    if (!session || !remoteText) return;
    await run("type", async () => {
      await api.post(`/sessions/${session.sessionId}/interact`, {
        kind: "type",
        value: remoteText
      });
      log(`Scritto nel browser remoto: ${remoteText.length} caratteri`);
      setRemoteText("");
    });
  }

  /** Sends a single key to whatever the remote page has focused. */
  async function pressRemotely(key: string) {
    if (!session) return;
    await run("press", async () => {
      await api.post(`/sessions/${session.sessionId}/interact`, { kind: "press", value: key });
      log(`Tasto inviato al browser remoto: ${key}`);
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

  /**
   * Writes the step list to the workflow. Secrets captured while recording are
   * persisted server-side first, so the {{credentials.x}} references in the
   * steps can be resolved at run time. Both Save and "Esegui adesso" go through
   * here: saving the steps without the secret they reference queues a run that
   * fails on the first field it has to fill.
   */
  async function persistSteps(): Promise<Step[]> {
    if (session) {
      const result = await api.post<{ saved: string[]; kept: string[] }>(
        `/sessions/${session.sessionId}/credentials`,
        // Only what the user asked to replace: everything else that already
        // exists keeps the value the other workflows on that site rely on.
        { overwrite: replacing }
      );
      if (result.saved.length > 0) {
        log(`Credenziali salvate: ${result.saved.join(", ")}`);
      }
      if (result.kept?.length > 0) {
        log(`Credenziali riusate: ${result.kept.join(", ")}`);
      }
    }
    const saved = await api.put<Step[]>(`/workflows/${workflowId}/steps`, { steps });
    setSteps(saved);
    setDirty(false);
    return saved;
  }

  async function save() {
    await run("save", async () => {
      const saved = await persistSteps();
      await loadWorkflow();
      // Saving creates every value the steps refer to, so the list the editor
      // shows them from is out of date the moment the request returns.
      await loadValues().catch(() => undefined);
      log(`${saved.length} step salvati`);
    });
  }

  async function execute() {
    const execution = await run("execute", async () => {
      if (dirty) await persistSteps();
      return api.post<Execution>(`/workflows/${workflowId}/executions`);
    });
    if (execution) router.push(`/executions/${execution.id}`);
  }

  /** Builds the recurrence out of the fields the form shows for the chosen kind. */
  /**
   * Why this interval cannot be scheduled, or null when it can.
   *
   * Cron steps are whole numbers — there is no every-half-hour — and the form
   * used to accept one anyway, show a sentence that cannot exist, and leave the
   * refusal to the server after the click. Half an hour does have a home, so the
   * message says which one.
   */
  function intervalProblem(): string | null {
    if (repeatKind === "weekly") return null;
    if (!Number.isInteger(repeatEvery)) {
      return "Solo numeri interi: per la mezz'ora scegli Minuti e metti 30.";
    }
    const max = REPEAT_MAX[repeatKind] ?? 1;
    if (repeatEvery < 1 || repeatEvery > max) {
      return `Un intervallo va da 1 a ${max}.`;
    }
    return null;
  }

  function currentRecurrence(): Recurrence {
    switch (repeatKind) {
      case "minutes":
        return { kind: "minutes", every: repeatEvery };
      case "hours":
        return { kind: "hours", every: repeatEvery, minute: repeatMinute };
      case "weekly":
        return { kind: "weekly", weekday: repeatWeekday, time: repeatTime };
      case "months":
        return { kind: "months", every: repeatEvery, day: repeatDay, time: repeatTime };
      default:
        return { kind: "days", every: repeatEvery, time: repeatTime };
    }
  }

  async function scheduleRecurring() {
    await run("schedule-recurring", async () => {
      if (dirty) await persistSteps();
      await api.post(`/workflows/${workflowId}/schedules`, {
        recurrence: currentRecurrence(),
        timezone
      });
      await loadSchedules();
      log(`Pianificazione ricorrente creata (${describeRecurrence(currentRecurrence())})`);
    });
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
        {renaming ? (
          <>
            <input
              className="input w-72 text-lg font-semibold"
              value={nameDraft}
              autoFocus
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void renameWorkflow();
                if (event.key === "Escape") setRenaming(false);
              }}
              data-testid="workflow-name-input"
            />
            <button
              className="btn"
              onClick={() => void renameWorkflow()}
              disabled={busy !== null}
              data-testid="rename-save"
            >
              Salva nome
            </button>
            <button
              className="btn-secondary"
              onClick={() => setRenaming(false)}
              data-testid="rename-cancel"
            >
              Annulla
            </button>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold" data-testid="workflow-name">
              {workflow.name}
            </h1>
            <button
              className="btn-secondary"
              onClick={() => {
                setNameDraft(workflow.name);
                setRenaming(true);
              }}
              data-testid="rename-workflow"
            >
              Rinomina
            </button>
          </>
        )}
        <span className="badge bg-slate-100 text-slate-700" data-testid="workflow-status">
          {workflow.status}
        </span>
        <div className="flex-1" />
        {/* What acts on the workflow, not on the remote browser. */}
        <button className="btn" onClick={save} disabled={busy !== null} data-testid="save-steps">
          {busy === "save" ? "Salvataggio..." : "Salva"}
        </button>
        <button className="btn" onClick={execute} disabled={busy !== null} data-testid="run-now">
          {busy === "execute" ? "Avvio..." : "Esegui adesso"}
        </button>
        <Link href={`/executions?workflowId=${workflowId}`} className="btn-secondary">
          Esecuzioni
        </Link>
      </div>

      {error ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          data-testid="recorder-error"
        >
          <span>{error}</span>
          {error.includes("concurrent browser sessions") ? (
            <button
              className="btn-secondary"
              onClick={releaseStaleSessions}
              disabled={busy !== null}
              data-testid="release-sessions"
            >
              Chiudi le sessioni aperte
            </button>
          ) : null}
        </div>
      ) : null}

      {knownSecrets.length > 0 ? (
        <div
          className="card border-amber-200 bg-amber-50 text-sm"
          data-testid="secret-reuse"
        >
          {/* Asked, not decided: the value behind this name is what every other
              workflow on the site logs in with. */}
          <p className="mb-2">
            Per questo sito hai già {knownSecrets.length === 1 ? "una credenziale" : "delle credenziali"}
            . Riuso {knownSecrets.length === 1 ? "quella salvata" : "quelle salvate"}, oppure
            {" "}
            {knownSecrets.length === 1 ? "la sostituisco" : "le sostituisco"} con quanto hai appena
            digitato?
          </p>
          <ul className="space-y-1">
            {knownSecrets.map((name) => {
              const replace = replacing.includes(name);
              return (
                <li key={name} className="flex flex-wrap items-center gap-2">
                  <code className="flex-1">{name}</code>
                  <span className="text-xs text-slate-600" data-testid={`secret-choice-${name}`}>
                    {replace ? "sostituisco con quella digitata" : "riuso quella salvata"}
                  </span>
                  <button
                    className="btn-secondary"
                    onClick={() =>
                      setReplacing((current) =>
                        replace ? current.filter((n) => n !== name) : [...current, name]
                      )
                    }
                    data-testid={`secret-toggle-${name}`}
                  >
                    {replace ? "Riusa quella salvata" : "Sostituisci"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* browser + steps, stacked: the stream gets the full width, and its box
          keeps the remote screen's 16:10 ratio so nothing is letterboxed. The
          controls that drive the remote browser sit in a bar attached to it, so
          they read as part of the stream rather than as workflow commands. */}
      <div className="grid gap-3">
      <div className="card overflow-hidden p-0" data-testid="browser-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 p-2">
        <input
          className="input max-w-md flex-1"
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
          data-testid="start-url"
          aria-label="URL iniziale"
        />
        {!session ? (
          <>
            <button className="btn" onClick={startBrowser} disabled={busy !== null} data-testid="start-browser">
              {busy === "start" ? "Avvio..." : "Avvia browser"}
            </button>
            <span className="text-xs text-slate-500">
              Avvia il browser per vedere lo stream noVNC.
            </span>
          </>
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
            <button
              className={session.armedFinal ? "btn-danger" : "btn-secondary"}
              onClick={armFinalAction}
              disabled={busy !== null || !session.recording}
              title="Registra l'ultima azione senza eseguirla: verra eseguita solo all'avvio del workflow"
              data-testid="arm-final"
            >
              {session.armedFinal ? "Armata: clicca il bottone finale" : "Azione finale"}
            </button>
            <button
              className="btn-secondary"
              onClick={clearRecording}
              disabled={busy !== null}
              title="Scarta gli step registrati in questa sessione"
              data-testid="clear-recording"
            >
              Azzera
            </button>
            <button className="btn-secondary" onClick={toggleHighlight} disabled={busy !== null} data-testid="toggle-highlight">
              Evidenzia: {session.highlight ? "on" : "off"}
            </button>
            <button
              className="btn-secondary"
              onClick={toggleTooltip}
              disabled={busy !== null}
              title="Il riquadro che descrive l'elemento sotto il puntatore, dentro lo stream"
              data-testid="toggle-tooltip"
            >
              Tooltip: {session.tooltip ? "on" : "off"}
            </button>
            <button className="btn-danger" onClick={closeSession} disabled={busy !== null} data-testid="close-session">
              Chiudi browser
            </button>
          </>
        )}
      </div>

      {session ? (
        // Its own row: this is how you write into the remote browser from a
        // tablet, where the stream cannot raise a keyboard, and how you paste
        // into it from a desktop, where the clipboard is not shared.
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 pb-2">
          <input
            className="input max-w-md flex-1"
            value={remoteText}
            onChange={(e) => setRemoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void typeRemotely();
            }}
            placeholder="Scrivi nel campo selezionato del browser remoto"
            aria-label="Testo da scrivere nel browser remoto"
            data-testid="type-text"
          />
          <button
            className="btn"
            onClick={typeRemotely}
            disabled={busy !== null || !remoteText}
            title="Tocca prima il campo dentro lo stream, poi scrivi qui"
            data-testid="type-send"
          >
            Scrivi
          </button>
          <button
            className="btn-secondary"
            onClick={() => void pressRemotely("Enter")}
            disabled={busy !== null}
            data-testid="type-enter"
          >
            Invio
          </button>
          <button
            className="btn-secondary"
            onClick={() => void pressRemotely("Tab")}
            disabled={busy !== null}
            data-testid="type-tab"
          >
            Tab
          </button>
        </div>
      ) : null}

        {/* No stream, no box: an empty frame the height of the screen says
            nothing that the hint in the bar does not say in one line. */}
        {session?.vncPath ? (
          <div className="aspect-[16/10] max-h-[78vh]">
            <VncViewer path={session.vncPath} onStatusChange={setVncStatus} />
          </div>
        ) : null}
        </div>

        <div className="card h-[460px] overflow-hidden p-0">
          <StepEditor
            steps={steps}
            verifications={verifications}
            values={values}
            onChange={(next) => {
              // What the editor removed has to be remembered, or the next poll
              // hands it straight back.
              for (const step of steps) {
                if (!next.some((kept) => kept.id === step.id)) removedRef.current.add(step.id);
              }
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
          {dirty ? (
            <span className="text-amber-700" data-testid="unsaved-changes">
              Modifiche non salvate
            </span>
          ) : null}
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
        <h2 className="font-medium">Pianificazione ricorrente</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="text-xs text-slate-600">Ogni</span>
            <select
              className="input"
              value={repeatKind}
              onChange={(e) => setRepeatKind(e.target.value as Recurrence["kind"])}
              data-testid="repeat-kind"
            >
              <option value="minutes">Minuti</option>
              <option value="hours">Ore</option>
              <option value="days">Giorni</option>
              <option value="weekly">Settimana</option>
              <option value="months">Mesi</option>
            </select>
          </label>

          {repeatKind === "weekly" ? (
            <label className="block">
              <span className="text-xs text-slate-600">Giorno</span>
              <select
                className="input"
                value={repeatWeekday}
                onChange={(e) => setRepeatWeekday(Number(e.target.value))}
                data-testid="repeat-weekday"
              >
                {WEEKDAYS.map((label, index) => (
                  <option key={label} value={index}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {repeatKind === "months" ? (
            <label className="block">
              <span className="text-xs text-slate-600">Giorno del mese</span>
              <input
                className="input w-24"
                type="number"
                min={1}
                max={28}
                value={repeatDay}
                onChange={(e) => setRepeatDay(Number(e.target.value))}
                title="Fino al 28: un workflow fissato al 31 non partirebbe a febbraio"
                data-testid="repeat-day"
              />
            </label>
          ) : null}

          {repeatKind !== "weekly" ? (
            <label className="block">
              <span className="text-xs text-slate-600">Quanti</span>
              <input
                className="input w-24"
                type="number"
                min={1}
                max={REPEAT_MAX[repeatKind] ?? 1}
                step={1}
                value={repeatEvery}
                onChange={(e) => setRepeatEvery(Number(e.target.value))}
                data-testid="repeat-every"
              />
            </label>
          ) : null}

          {repeatKind === "hours" ? (
            // A number, not a clock: the field said "Minuto" and showed hours
            // and minutes, so a 15 typed into it became the hour and the minute
            // stayed nought.
            <label className="block">
              <span className="text-xs text-slate-600">Minuto dell&apos;ora</span>
              <input
                className="input w-28"
                type="number"
                min={0}
                max={59}
                value={repeatMinute}
                onChange={(e) => setRepeatMinute(Number(e.target.value))}
                data-testid="repeat-minute"
              />
            </label>
          ) : null}

          {repeatKind !== "minutes" && repeatKind !== "hours" ? (
            <label className="block">
              <span className="text-xs text-slate-600">Ora</span>
              <input
                className="input"
                type="time"
                value={repeatTime}
                onChange={(e) => setRepeatTime(e.target.value)}
                data-testid="repeat-time"
              />
            </label>
          ) : null}

          <button
            className="btn"
            onClick={scheduleRecurring}
            disabled={busy !== null || intervalProblem() !== null}
            data-testid="repeat-submit"
          >
            Pianifica ricorrente
          </button>
          {intervalProblem() ? (
            <span className="text-xs text-red-700" data-testid="repeat-error">
              {intervalProblem()}
            </span>
          ) : (
            <span className="text-xs text-slate-500" data-testid="repeat-preview">
              {describeRecurrence(currentRecurrence())}
            </span>
          )}
        </div>
      </div>

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
                <span className="flex-1" data-testid="schedule-when">
                  {item.cron ? describeCron(item.cron) : new Date(item.runAt!).toLocaleString()}
                </span>
                {item.cron ? (
                  <span className="badge bg-blue-50 text-blue-700">ricorrente</span>
                ) : null}
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
