/**
 * Script injected into every page and same-origin frame of a recording session.
 *
 * It is serialised and evaluated in the browser, so it must be completely
 * self-contained: no imports, no references to anything outside its argument.
 *
 * Responsibilities:
 *  - highlight interactive elements with the documented colour scheme,
 *  - show a tooltip describing the hovered element and its proposed selector,
 *  - report user actions back to Node through the exposed bindings.
 *
 * Highlighting is done with a single injected stylesheet: no DOM node is
 * modified, nothing affects layout (outlines do not reflow), and the rules keep
 * applying after navigation and to nodes added later by SPA code.
 */
export interface RecorderScriptArg {
  /** Overlay stylesheet, built in Node by buildHighlightCss(). */
  css: string;
  tooltipId: string;
}

export function recorderBrowserScript(arg: RecorderScriptArg): void {
  const w = window as unknown as Record<string, any>;
  if (w.__recorderInstalled) return;
  w.__recorderInstalled = true;

  const STYLE_ID = "__recorder_highlight_style__";
  const TOOLTIP_ID = arg.tooltipId;
  const CSS = arg.css;

  // ---- highlighting ------------------------------------------------------

  function setHighlight(enabled: boolean): void {
    const existing = document.getElementById(STYLE_ID);
    if (enabled) {
      if (existing) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    } else if (existing) {
      existing.remove();
    }
  }

  // ---- element description ----------------------------------------------

  function tagOf(el: Element): string {
    return el.tagName.toLowerCase();
  }

  function implicitRole(el: Element): string | null {
    const tag = tagOf(el);
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      if (type === "email" || type === "tel" || type === "url" || type === "text" || type === "" || type === "password") {
        return "textbox";
      }
      return null;
    }
    return null;
  }

  function roleOf(el: Element): string | null {
    return el.getAttribute("role") || implicitRole(el);
  }

  function labelTextFor(el: Element): string | null {
    const id = el.getAttribute("id");
    if (id) {
      const escaped = typeof CSS !== "undefined" && (window as any).CSS?.escape
        ? (window as any).CSS.escape(id)
        : id.replace(/["\\]/g, "\\$&");
      const explicit = document.querySelector(`label[for="${escaped}"]`);
      if (explicit && explicit.textContent) return explicit.textContent.trim();
    }
    const wrapping = el.closest("label");
    if (wrapping && wrapping.textContent) return wrapping.textContent.trim();
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target && target.textContent) return target.textContent.trim();
    }
    return null;
  }

  function accessibleName(el: Element): string | null {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target && target.textContent) return target.textContent.trim();
    }
    const tag = tagOf(el);
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && (type === "submit" || type === "button" || type === "reset")) {
      const value = (el as HTMLInputElement).value;
      if (value) return value.trim();
    }
    if (tag === "button" || tag === "a" || el.getAttribute("role") === "button") {
      const text = (el.textContent || "").trim();
      if (text) return text.replace(/\s+/g, " ");
    }
    const label = labelTextFor(el);
    if (label) return label;
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const title = el.getAttribute("title");
    if (title) return title.trim();
    return null;
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current.nodeType === 1 && parts.length < 8) {
      let part = tagOf(current);
      const parent: Element | null = current.parentElement;
      if (!parent) {
        parts.unshift(part);
        break;
      }
      const siblings = Array.prototype.filter.call(
        parent.children,
        (c: Element) => tagOf(c) === part
      ) as Element[];
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (tagOf(parent) === "body" || tagOf(parent) === "html") break;
      current = parent;
    }
    return parts.join(" > ");
  }

  function xpathOf(el: Element): string {
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current.nodeType === 1) {
      const parent: Element | null = current.parentElement;
      if (!parent) {
        parts.unshift(`/${tagOf(current)}`);
        break;
      }
      const same = Array.prototype.filter.call(
        parent.children,
        (c: Element) => tagOf(c) === tagOf(current as Element)
      ) as Element[];
      const index = same.indexOf(current) + 1;
      parts.unshift(`/${tagOf(current)}[${index}]`);
      current = parent;
    }
    return parts.join("");
  }

  function countByRoleAndName(role: string, name: string): number {
    const all = Array.prototype.slice.call(document.querySelectorAll("*")) as Element[];
    let count = 0;
    for (const candidate of all) {
      if (roleOf(candidate) !== role) continue;
      const candidateName = accessibleName(candidate);
      if (candidateName && candidateName === name) count += 1;
      if (count > 1) return count;
    }
    return count;
  }

  function countByLabel(label: string): number {
    const controls = Array.prototype.slice.call(
      document.querySelectorAll("input, textarea, select")
    ) as Element[];
    let count = 0;
    for (const control of controls) {
      if (labelTextFor(control) === label) count += 1;
      if (count > 1) return count;
    }
    return count;
  }

  function countByText(text: string): number {
    const candidates = Array.prototype.slice.call(
      document.querySelectorAll("a, button, [role='button'], [role='link'], label, span, div, li, td, h1, h2, h3")
    ) as Element[];
    let count = 0;
    for (const candidate of candidates) {
      const own = (candidate.textContent || "").trim().replace(/\s+/g, " ");
      if (own === text) count += 1;
      if (count > 1) return count;
    }
    return count;
  }

  function safeCount(selector: string): number {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  }

  function quote(value: string): string {
    return value.replace(/["\\]/g, "\\$&");
  }

  /** Selector of the iframe this document lives in, when same-origin. */
  function frameSelector(): string | null {
    try {
      const frameEl = window.frameElement as Element | null;
      if (!frameEl) return null;
      const id = frameEl.getAttribute("id");
      if (id) return `#${id}`;
      const name = frameEl.getAttribute("name");
      if (name) return `iframe[name="${quote(name)}"]`;
      return cssPath(frameEl);
    } catch {
      // Cross-origin parent: not supported by the MVP.
      return null;
    }
  }

  function describe(el: Element): Record<string, any> {
    const role = roleOf(el);
    const name = accessibleName(el);
    const label = labelTextFor(el);
    const placeholder = el.getAttribute("placeholder");
    const testId = el.getAttribute("data-testid");
    const nameAttr = el.getAttribute("name");
    const id = el.getAttribute("id");
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);

    const unique: Record<string, boolean> = {};
    if (role && name) unique.role = countByRoleAndName(role, name) === 1;
    if (label) unique.label = countByLabel(label) === 1;
    if (placeholder) unique.placeholder = safeCount(`[placeholder="${quote(placeholder)}"]`) === 1;
    if (text) unique.text = countByText(text) === 1;
    if (testId) unique.testid = safeCount(`[data-testid="${quote(testId)}"]`) === 1;
    if (nameAttr) unique.name = safeCount(`[name="${quote(nameAttr)}"]`) === 1;
    if (id) unique.id = safeCount(`#${quote(id)}`) === 1;
    unique.css = true;
    unique.xpath = true;

    return {
      tag: tagOf(el),
      type: el.getAttribute("type"),
      role,
      accessibleName: name,
      label,
      placeholder,
      text: text || null,
      testId,
      nameAttr,
      id,
      cssPath: cssPath(el),
      xpath: xpathOf(el),
      unique,
      frame: frameSelector()
    };
  }

  // ---- tooltip ----------------------------------------------------------

  function proposedSelector(info: Record<string, any>): string {
    const u = info.unique || {};
    if (info.role && info.accessibleName && u.role) {
      return `getByRole('${info.role}', { name: '${info.accessibleName}' })`;
    }
    if (info.label && u.label) return `getByLabel('${info.label}')`;
    if (info.placeholder && u.placeholder) return `getByPlaceholder('${info.placeholder}')`;
    if (info.text && u.text) return `getByText('${info.text}')`;
    if (info.testId) return `getByTestId('${info.testId}')`;
    if (info.nameAttr) return `${info.tag}[name='${info.nameAttr}']`;
    if (info.id) return `#${info.id}`;
    return info.cssPath || info.xpath || "n/d";
  }

  function ensureTooltip(): HTMLElement {
    let tooltip = document.getElementById(TOOLTIP_ID);
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = TOOLTIP_ID;
      tooltip.setAttribute("aria-hidden", "true");
      tooltip.style.cssText = [
        "position:fixed",
        "z-index:2147483647",
        "pointer-events:none",
        "max-width:420px",
        "padding:6px 8px",
        "background:rgba(17,19,24,.94)",
        "color:#fff",
        "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
        "border-radius:5px",
        "white-space:pre-wrap",
        "display:none"
      ].join(";");
      document.documentElement.appendChild(tooltip);
    }
    return tooltip;
  }

  function showTooltip(el: Element, x: number, y: number): void {
    const info = describe(el);
    const tooltip = ensureTooltip();
    const disabled =
      (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true";
    const lines = [
      `tag: ${info.tag}${info.type ? `[type=${info.type}]` : ""}${disabled ? " (disabled)" : ""}`,
      `role: ${info.role ?? "-"}`,
      `name: ${info.accessibleName ?? "-"}`,
      `label: ${info.label ?? "-"}`,
      `text: ${info.text ?? "-"}`,
      `id: ${info.id ?? "-"}`,
      `placeholder: ${info.placeholder ?? "-"}`,
      `selector: ${proposedSelector(info)}`
    ];
    tooltip.textContent = lines.join("\n");
    tooltip.style.display = "block";
    const rect = tooltip.getBoundingClientRect();
    const left = Math.min(x + 12, Math.max(0, window.innerWidth - rect.width - 8));
    const top = y + 12 + rect.height > window.innerHeight ? Math.max(0, y - rect.height - 12) : y + 12;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip(): void {
    const tooltip = document.getElementById(TOOLTIP_ID);
    if (tooltip) tooltip.style.display = "none";
  }

  // ---- action reporting -------------------------------------------------

  const state = { recording: false, highlight: false, lastEmitAt: 0 };

  function emit(action: Record<string, any>): void {
    if (!state.recording) return;
    try {
      const emitter = w.__recorderEmit;
      if (typeof emitter === "function") {
        state.lastEmitAt = Date.now();
        emitter({ ...action, timestamp: state.lastEmitAt });
      }
    } catch {
      // Never let recording break the page under automation.
    }
  }

  function isInstrumented(el: Element | null): boolean {
    return !!el && el.id !== TOOLTIP_ID;
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      if (!isInstrumented(target)) return;
      const el = target as Element;
      const tag = tagOf(el);
      const type = (el.getAttribute("type") || "").toLowerCase();
      // Checkbox/radio clicks are reported by the change handler instead, so a
      // single interaction never produces two steps.
      if (tag === "input" && (type === "checkbox" || type === "radio")) return;
      emit({ kind: "click", element: describe(el) });
    },
    true
  );

  document.addEventListener(
    "change",
    (event) => {
      const target = event.target as Element | null;
      if (!isInstrumented(target)) return;
      const el = target as Element;
      const tag = tagOf(el);
      const type = (el.getAttribute("type") || "").toLowerCase();

      if (tag === "select") {
        emit({ kind: "select", element: describe(el), value: (el as HTMLSelectElement).value });
        return;
      }
      if (tag === "input" && type === "checkbox") {
        emit({
          kind: (el as HTMLInputElement).checked ? "check" : "uncheck",
          element: describe(el)
        });
        return;
      }
      if (tag === "input" && type === "radio") {
        emit({ kind: "check", element: describe(el) });
        return;
      }
      if (tag === "input" && type === "file") {
        const files = (el as HTMLInputElement).files;
        emit({
          kind: "upload",
          element: describe(el),
          value: files && files.length > 0 ? files[0].name : ""
        });
      }
    },
    true
  );

  document.addEventListener(
    "input",
    (event) => {
      const target = event.target as Element | null;
      if (!isInstrumented(target)) return;
      const el = target as Element;
      const tag = tagOf(el);
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag !== "input" && tag !== "textarea") return;
      if (["checkbox", "radio", "file", "submit", "button", "reset"].indexOf(type) >= 0) return;

      emit({
        kind: "fill",
        element: describe(el),
        value: (el as HTMLInputElement).value,
        isPassword: type === "password"
      });
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      const key = (event as KeyboardEvent).key;
      // Only keys that carry workflow meaning are recorded; plain typing is
      // already captured as a fill action.
      if (["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"].indexOf(key) < 0) return;
      const target = event.target as Element | null;
      emit({
        kind: "press",
        element: isInstrumented(target) ? describe(target as Element) : null,
        key
      });
    },
    true
  );

  document.addEventListener(
    "submit",
    (event) => {
      const target = event.target as Element | null;
      if (!isInstrumented(target)) return;
      // A submit triggered by clicking the submit button or pressing Enter is
      // already represented by that action; recording it again would duplicate
      // the step. Only a submit with no preceding interaction is recorded.
      if (Date.now() - state.lastEmitAt < 600) return;
      emit({ kind: "submit", element: describe(target as Element) });
    },
    true
  );

  document.addEventListener(
    "mouseover",
    (event) => {
      if (!state.highlight) return;
      const target = event.target as Element | null;
      if (!isInstrumented(target)) return;
      const mouse = event as MouseEvent;
      showTooltip(target as Element, mouse.clientX, mouse.clientY);
    },
    true
  );

  document.addEventListener("mouseout", () => hideTooltip(), true);

  // ---- control surface --------------------------------------------------

  function apply(next: { recording: boolean; highlight: boolean }): void {
    state.recording = !!next.recording;
    state.highlight = !!next.highlight;
    setHighlight(state.highlight);
    if (!state.highlight) hideTooltip();
  }

  w.__recorderApply = apply;

  /**
   * Inspects one element the way the hover tooltip does. Used by the recorder
   * panel in the UI to show the selected element and its proposed selector.
   */
  w.__recorderDescribe = (selector: string) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const info = describe(el);
    const computed = window.getComputedStyle(el);
    return {
      ...info,
      proposedSelector: proposedSelector(info),
      outlineColor: computed.outlineColor,
      outlineWidth: computed.outlineWidth,
      outlineStyle: computed.outlineStyle,
      disabled:
        (el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true",
      highlightActive: !!document.getElementById(STYLE_ID)
    };
  };

  // Pull the current configuration so a freshly navigated page or a new tab
  // immediately continues with the same recording/highlight state.
  function bootstrap(): void {
    try {
      const getConfig = w.__recorderConfig;
      if (typeof getConfig === "function") {
        Promise.resolve(getConfig()).then((cfg: any) => {
          if (cfg) apply(cfg);
        });
      }
    } catch {
      /* ignore */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
}
