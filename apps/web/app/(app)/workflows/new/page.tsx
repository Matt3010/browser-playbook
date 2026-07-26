"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Workflow } from "@/lib/api";

export default function NewWorkflowPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const workflow = await api.post<Workflow>("/workflows", { name, startUrl });
      router.push(`/workflows/${workflow.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Errore inatteso");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">Nuovo workflow</h1>

      <form onSubmit={submit} className="card space-y-4" data-testid="new-workflow-form">
        {error ? (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" data-testid="workflow-error">
            {error}
          </p>
        ) : null}

        <div>
          <label className="label" htmlFor="name">
            Nome
          </label>
          <input
            id="name"
            name="name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="label" htmlFor="startUrl">
            URL iniziale
          </label>
          <input
            id="startUrl"
            name="startUrl"
            className="input"
            placeholder="https://esempio.it/login"
            value={startUrl}
            onChange={(e) => setStartUrl(e.target.value)}
            required
          />
        </div>

        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Creazione..." : "Crea workflow"}
        </button>
      </form>
    </div>
  );
}
