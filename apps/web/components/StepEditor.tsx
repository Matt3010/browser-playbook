"use client";

import { useState } from "react";
import type { Selector, Step, StepVerification } from "@/lib/api";

const STEP_TYPES = [
  "goto",
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "wait",
  "waitForElement",
  "assertVisible",
  "assertText",
  "switchPage",
  "download",
  "upload"
] as const;

const SELECTOR_STRATEGIES = [
  "role",
  "label",
  "placeholder",
  "text",
  "testid",
  "name",
  "id",
  "css",
  "xpath"
] as const;

function describeSelector(selector: Selector | null): string {
  if (!selector) return "-";
  if (selector.strategy === "role") {
    return `role=${selector.role}${selector.name ? `[name="${selector.name}"]` : ""}`;
  }
  return `${selector.strategy}=${selector.value ?? ""}`;
}

/**
 * A closing action is recorded without being performed and must stay the last step:
 * nothing may depend on an effect nobody observed while recording. The server
 * refuses a list that breaks this, so the editor must not be able to build one —
 * appending a wait after a recorded closing action used to leave the user with a
 * workflow that would not save and no obvious way to repair it.
 */
function trailingFinalIndex(steps: Step[]): number | null {
  const last = steps.length - 1;
  return last >= 0 && steps[last]?.isFinal ? last : null;
}

/** Where a newly added step goes: before a trailing closing action, else at the end. */
export function insertionIndex(steps: Step[]): number {
  return trailingFinalIndex(steps) ?? steps.length;
}

/** True when the step at this index may swap with its neighbour in that direction. */
export function canMove(steps: Step[], index: number, direction: -1 | 1): boolean {
  const target = index + direction;
  if (target < 0 || target >= steps.length) return false;
  // Moving the closing action up, or moving another step down past it, would both
  // leave an ordinary step after it.
  if (direction === -1 && steps[index]?.isFinal) return false;
  if (direction === 1 && steps[target]?.isFinal) return false;
  return true;
}

function newId(): string {
  return crypto.randomUUID();
}

interface StepEditorProps {
  steps: Step[];
  onChange: (steps: Step[]) => void;
  /** Aligned with `steps`: whether each one resolves on the live page. */
  verifications?: StepVerification[];
}

const VERIFICATION_LABEL: Record<string, { text: string; className: string }> = {
  ok: { text: "verificato", className: "bg-green-100 text-green-700" },
  ambiguous: { text: "selector ambiguo", className: "bg-red-100 text-red-700" },
  "not-found": { text: "non trovato", className: "bg-red-100 text-red-700" },
  unchecked: { text: "non verificato", className: "bg-slate-100 text-slate-600" }
};

export function StepEditor({ steps, onChange, verifications = [] }: StepEditorProps) {
  const [editingId, setEditingId] = useState<string | null>(null);

  function update(id: string, patch: Partial<Step>) {
    onChange(steps.map((step) => (step.id === id ? { ...step, ...patch } : step)));
  }

  function updateSelector(id: string, patch: Partial<Selector>) {
    onChange(
      steps.map((step) =>
        step.id === id && step.selector
          ? { ...step, selector: { ...step.selector, ...patch } }
          : step
      )
    );
  }

  function move(index: number, direction: -1 | 1) {
    if (!canMove(steps, index, direction)) return;
    const target = index + direction;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  /** Adds a step at the only position that keeps the list valid. */
  function insert(step: Step) {
    const next = [...steps];
    next.splice(insertionIndex(steps), 0, step);
    onChange(next);
  }

  function remove(id: string) {
    onChange(steps.filter((step) => step.id !== id));
  }

  function addWait() {
    insert(
      {
        id: newId(),
        type: "wait",
        name: "Attendi 1000 ms",
        pageId: "main",
        selector: null,
        value: "1000",
        timeoutMs: 10000,
        enabled: true,
        isFinal: false
      }
    );
  }

  function addAssertion() {
    insert(
      {
        id: newId(),
        type: "assertVisible",
        name: "Verifica elemento visibile",
        pageId: "main",
        selector: { strategy: "text", value: "", fallback: null, pageId: "main", frame: null },
        value: null,
        timeoutMs: 10000,
        enabled: true,
        isFinal: false
      }
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 p-2">
        <span className="text-sm font-medium">Step registrati ({steps.length})</span>
        <div className="flex-1" />
        <button className="btn-secondary" onClick={addWait} data-testid="add-wait">
          + Attesa
        </button>
        <button className="btn-secondary" onClick={addAssertion} data-testid="add-assertion">
          + Assertion
        </button>
      </div>

      {steps.length === 0 ? (
        <p className="p-3 text-sm text-slate-500" data-testid="steps-empty">
          Nessuno step. Avvia il browser e premi Registra.
        </p>
      ) : (
        <ol className="flex-1 divide-y divide-slate-100 overflow-y-auto" data-testid="step-list">
          {steps.map((step, index) => (
            <li key={step.id} className="p-2 text-sm" data-testid={`step-${index}`}>
              <div className="flex items-start gap-2">
                <span className="w-5 pt-1 text-right text-xs text-slate-400">{index + 1}</span>

                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="badge bg-slate-100 text-slate-700"
                      data-testid={`step-type-${index}`}
                    >
                      {step.type}
                    </span>
                    <span
                      className={step.enabled ? "font-medium" : "font-medium text-slate-400 line-through"}
                      data-testid={`step-name-${index}`}
                    >
                      {step.name}
                    </span>
                    {(() => {
                      const check = verifications[index];
                      if (!check) return null;
                      const label = VERIFICATION_LABEL[check.status];
                      if (!label) return null;
                      return (
                        <span
                          className={`badge ${label.className}`}
                          title={check.message ?? "Il selector risolve su un solo elemento"}
                          data-testid={`step-verification-${index}`}
                          data-status={check.status}
                        >
                          {label.text}
                        </span>
                      );
                    })()}
                    {step.isFinal ? (
                      <span
                        className="badge bg-amber-100 text-amber-800"
                        title="Registrata senza essere eseguita: viene eseguita solo all'avvio del workflow, e deve restare l'ultimo step"
                        data-testid={`step-final-${index}`}
                      >
                        azione finale
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-slate-500" title={describeSelector(step.selector)}>
                    {describeSelector(step.selector)}
                    {step.value !== null && step.value !== undefined && step.value !== ""
                      ? ` → ${step.value}`
                      : ""}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex gap-1">
                    <button
                      className="rounded border border-slate-200 px-1.5 text-xs hover:bg-slate-50"
                      onClick={() => move(index, -1)}
                      disabled={!canMove(steps, index, -1)}
                      title={
                        step.isFinal
                          ? "L'azione finale deve restare l'ultimo step"
                          : "Sposta su"
                      }
                      data-testid={`step-up-${index}`}
                    >
                      ↑
                    </button>
                    <button
                      className="rounded border border-slate-200 px-1.5 text-xs hover:bg-slate-50"
                      onClick={() => move(index, 1)}
                      disabled={!canMove(steps, index, 1)}
                      title={
                        steps[index + 1]?.isFinal
                          ? "L'azione finale deve restare l'ultimo step"
                          : "Sposta giù"
                      }
                      data-testid={`step-down-${index}`}
                    >
                      ↓
                    </button>
                  </div>
                  <div className="flex gap-1">
                    <button
                      className="rounded border border-slate-200 px-1.5 text-xs hover:bg-slate-50"
                      onClick={() => setEditingId(editingId === step.id ? null : step.id)}
                      data-testid={`step-edit-${index}`}
                    >
                      {editingId === step.id ? "Chiudi" : "Modifica"}
                    </button>
                    <button
                      className="rounded border border-slate-200 px-1.5 text-xs hover:bg-slate-50"
                      onClick={() => update(step.id, { enabled: !step.enabled })}
                      data-testid={`step-toggle-${index}`}
                    >
                      {step.enabled ? "Disabilita" : "Abilita"}
                    </button>
                    <button
                      className="rounded border border-red-200 px-1.5 text-xs text-red-700 hover:bg-red-50"
                      onClick={() => remove(step.id)}
                      data-testid={`step-delete-${index}`}
                    >
                      Elimina
                    </button>
                  </div>
                </div>
              </div>

              {editingId === step.id ? (
                <div className="mt-2 space-y-2 rounded-md bg-slate-50 p-2" data-testid={`step-form-${index}`}>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-xs text-slate-600">Nome</span>
                      <input
                        className="input"
                        value={step.name}
                        onChange={(e) => update(step.id, { name: e.target.value })}
                        data-testid={`step-name-input-${index}`}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-slate-600">Tipo</span>
                      <select
                        className="input"
                        value={step.type}
                        onChange={(e) => update(step.id, { type: e.target.value })}
                      >
                        {STEP_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-xs text-slate-600">Valore</span>
                      <input
                        className="input"
                        value={step.value ?? ""}
                        onChange={(e) => update(step.id, { value: e.target.value })}
                        placeholder="{{credentials.password}}"
                        data-testid={`step-value-input-${index}`}
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs text-slate-600">Timeout (ms)</span>
                      <input
                        className="input"
                        type="number"
                        value={step.timeoutMs}
                        onChange={(e) => update(step.id, { timeoutMs: Number(e.target.value) })}
                      />
                    </label>
                  </div>

                  {step.selector ? (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block">
                        <span className="text-xs text-slate-600">Strategia selector</span>
                        <select
                          className="input"
                          value={step.selector.strategy}
                          onChange={(e) => updateSelector(step.id, { strategy: e.target.value })}
                          data-testid={`step-strategy-${index}`}
                        >
                          {SELECTOR_STRATEGIES.map((strategy) => (
                            <option key={strategy} value={strategy}>
                              {strategy}
                            </option>
                          ))}
                        </select>
                      </label>
                      {step.selector.strategy === "role" ? (
                        <>
                          <label className="block">
                            <span className="text-xs text-slate-600">Role</span>
                            <input
                              className="input"
                              value={step.selector.role ?? ""}
                              onChange={(e) => updateSelector(step.id, { role: e.target.value })}
                            />
                          </label>
                          <label className="block">
                            <span className="text-xs text-slate-600">Name accessibile</span>
                            <input
                              className="input"
                              value={step.selector.name ?? ""}
                              onChange={(e) => updateSelector(step.id, { name: e.target.value })}
                            />
                          </label>
                        </>
                      ) : (
                        <label className="block">
                          <span className="text-xs text-slate-600">Valore selector</span>
                          <input
                            className="input"
                            value={step.selector.value ?? ""}
                            onChange={(e) => updateSelector(step.id, { value: e.target.value })}
                            data-testid={`step-selector-value-${index}`}
                          />
                        </label>
                      )}
                      <label className="block">
                        <span className="text-xs text-slate-600">Fallback CSS/XPath</span>
                        <input
                          className="input"
                          value={step.selector.fallback ?? ""}
                          onChange={(e) =>
                            updateSelector(step.id, { fallback: e.target.value || null })
                          }
                        />
                      </label>
                      <label className="block">
                        <span className="text-xs text-slate-600">Pagina / tab</span>
                        <input
                          className="input"
                          value={step.pageId}
                          onChange={(e) =>
                            onChange(
                              steps.map((s) =>
                                s.id === step.id
                                  ? {
                                      ...s,
                                      pageId: e.target.value,
                                      selector: s.selector
                                        ? { ...s.selector, pageId: e.target.value }
                                        : null
                                    }
                                  : s
                              )
                            )
                          }
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
