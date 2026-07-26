"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type CredentialEntry } from "@/lib/api";

export default function CredentialsPage() {
  const [entries, setEntries] = useState<CredentialEntry[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<"variable" | "secret">("variable");
  const [error, setError] = useState<string | null>(null);

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

  async function remove(id: string) {
    await api.del(`/credentials/${id}`);
    await load();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Variabili e credenziali</h1>

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
              data-testid="credential-name"
            />
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
            <li key={entry.id} className="card flex items-center gap-3">
              <span className="badge bg-slate-100 text-slate-700">{entry.kind}</span>
              <code className="flex-1 text-sm">{entry.name}</code>
              <span className="text-sm text-slate-500" data-testid={`credential-value-${entry.name}`}>
                {entry.kind === "secret" ? "••••••• (nascosto)" : entry.value}
              </span>
              <button className="btn-danger" onClick={() => void remove(entry.id)}>
                Elimina
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
