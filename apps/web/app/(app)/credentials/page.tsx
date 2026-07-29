"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type CredentialEntry } from "@/lib/api";

/**
 * The tokens a variable may contain, listed for the person typing one.
 *
 * Written out here rather than imported: the browser bundle deliberately holds
 * no workspace package — `@app/shared` carries jwt and bcrypt with it. The list
 * cannot drift silently for it, though: an e2e reads these very elements and
 * asks the real engine whether it recognises each one.
 */
const FORMULA_TOKENS = [
  { id: "timestamp", label: "data e ora", token: "{{timestamp}}", describes: "20260728-113045" },
  { id: "date", label: "data", token: "{{date}}", describes: "2026-07-28" },
  { id: "time", label: "ora", token: "{{time}}", describes: "11:30:45" },
  { id: "random", label: "casuale", token: "{{random}}", describes: "sei caratteri casuali" },
  { id: "random10", label: "casuale lungo", token: "{{random:10}}", describes: "dieci caratteri casuali" },
  { id: "uuid", label: "identificatore", token: "{{uuid}}", describes: "un identificatore unico" }
];

/** Same shape the engine looks for, only to decide whether to show a badge. */
const FORMULA_RE = /\{\{\s*(timestamp|date|time|uuid|random)(?::[a-zA-Z0-9_-]{1,20})?\s*\}\}/;

export default function CredentialsPage() {
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<"variable" | "secret">("variable");
  const [error, setError] = useState<string | null>(null);
  /** What just happened, when it worked: a deletion says nothing otherwise. */
  const [notice, setNotice] = useState<string | null>(null);
  /** The entry being changed, and what will be written when it is saved. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function load() {
    setEntries(await api.get<CredentialEntry[]>("/credentials"));
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api.post("/credentials", { name, value, kind });
      setName("");
      setValue("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Errore inatteso");
    }
  }

  /**
   * Deletes a value, and says what happened either way.
   *
   * The server refuses to remove one a workflow still names, and answers with
   * the workflows that would stop working. The page used to throw that answer
   * away: the button did nothing, said nothing, and looked broken — and on the
   * other side, a deletion that did go through was just as silent.
   */
  async function remove(entry: CredentialEntry) {
    setError(null);
    setNotice(null);
    try {
      const result = await api.del<{ referencedByDisabled?: string[] }>(
        `/credentials/${entry.id}`
      );
      const suspended = result?.referencedByDisabled ?? [];
      setNotice(
        suspended.length === 0
          ? `"${entry.name}" eliminata.`
          : `"${entry.name}" eliminata. È ancora nominata da uno step disabilitato di: ` +
            `${suspended.join(", ")} — riattivandolo, il workflow non partirà.`
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Errore inatteso");
    }
  }

  /**
   * Opens an entry for change. A variable is ordinary data and starts from what
   * it holds; a secret starts empty, because the server never sends it back and
   * a field that looked prefilled would be a lie about what saving would store.
   */
  function edit(entry: CredentialEntry) {
    setError(null);
    setDraft(entry.kind === "secret" ? "" : entry.value ?? "");
    setEditingId(entry.id);
  }

  async function commit(entry: CredentialEntry) {
    setError(null);
    try {
      await api.patch(`/credentials/${entry.id}`, { value: draft });
      setEditingId(null);
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Errore inatteso");
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Variabili e credenziali</h1>

      {notice ? (
        <p
          className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800"
          data-testid="credential-notice"
        >
          {notice}
        </p>
      ) : null}

      <form onSubmit={save} className="card space-y-3" data-testid="credential-form">
        {error ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="credential-error">
            {error}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="label">Tipo</span>
            <select
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value as "variable" | "secret")}
              data-testid="credential-kind"
            >
              <option value="variable">Variabile</option>
              <option value="secret">Credenziale segreta</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Nome</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="customerName"
              required
              pattern="[a-zA-Z0-9_]+"
              title="Solo lettere, numeri e underscore"
              data-testid="credential-name"
            />
            <span className="mt-1 block text-xs text-slate-400">
              Solo lettere, numeri e underscore
            </span>
          </label>
          <label className="block">
            <span className="label">Valore</span>
            <input
              className="input"
              type={kind === "secret" ? "password" : "text"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
              data-testid="credential-value"
            />
            {kind === "variable" ? (
              // Buttons, not documentation: nobody has to work out where the
              // tokens go or whether to type the braces — the first thing tried
              // was typing one into the name, which the API refuses.
              <span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                <span>Aggiungi al valore:</span>
                {FORMULA_TOKENS.map((entry) => (
                  <button
                    key={entry.token}
                    type="button"
                    className="btn-mini"
                    title={`Diventa ${entry.describes}`}
                    onClick={() => setValue((current) => current + entry.token)}
                    data-testid={`formula-token-${entry.id}`}
                    // What it inserts, so a test can ask the engine whether it
                    // recognises every token this page offers.
                    data-token={entry.token}
                  >
                    {entry.label}
                  </button>
                ))}
              </span>
            ) : null}
          </label>
        </div>

        <p className="text-xs text-slate-500">
          Uso nei passaggi:{" "}
          <code>
            {kind === "secret" ? "{{credentials." : "{{variables."}
            {name || "nome"}
            {"}}"}
          </code>
        </p>

        <button className="btn" type="submit" data-testid="credential-submit">
          Salva
        </button>
      </form>

      {entries.length === 0 ? (
        <p className="card text-sm text-slate-500" data-testid="credentials-empty">
          Nessuna variabile o credenziale salvata.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="credential-list">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="card flex flex-wrap items-center gap-3"
              data-testid={`credential-row-${entry.name}`}
            >
              <span className="badge bg-slate-100 text-slate-700">{entry.kind}</span>
              <code className="flex-1 text-sm">{entry.name}</code>

              {editingId === entry.id ? (
                <>
                  <input
                    className="input max-w-xs"
                    type={entry.kind === "secret" ? "password" : "text"}
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commit(entry);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    placeholder={entry.kind === "secret" ? "Nuovo valore" : ""}
                    data-testid={`credential-input-${entry.name}`}
                  />
                  <button
                    className="btn"
                    onClick={() => void commit(entry)}
                    data-testid={`credential-save-${entry.name}`}
                  >
                    Salva
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => setEditingId(null)}
                    data-testid={`credential-cancel-${entry.name}`}
                  >
                    Annulla
                  </button>
                </>
              ) : (
                <>
                  <span
                    className="text-sm text-slate-500"
                    data-testid={`credential-value-${entry.name}`}
                  >
                    {entry.kind === "secret"
                      ? entry.hasValue
                        ? "••••••• (nascosto)"
                        : "(vuota)"
                      : entry.hasValue
                        ? entry.value
                        : "(vuota)"}
                  </span>
                  {/* Outside the value: what is stored is the formula, and the
                      badge must not become part of it when it is read. */}
                  {entry.kind === "variable" && FORMULA_RE.test(entry.value ?? "") ? (
                    <span className="badge bg-blue-50 text-blue-700">formula</span>
                  ) : null}
                  <button
                    className="btn-secondary"
                    onClick={() => edit(entry)}
                    data-testid={`credential-edit-${entry.name}`}
                  >
                    {entry.kind === "secret" ? "Sostituisci" : "Modifica"}
                  </button>
                  <button
                    className="btn-danger"
                    onClick={() => void remove(entry)}
                    data-testid={`credential-delete-${entry.name}`}
                  >
                    Elimina
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
