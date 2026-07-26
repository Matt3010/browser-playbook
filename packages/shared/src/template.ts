export interface TemplateContext {
  variables: Record<string, string>;
  credentials: Record<string, string>;
}

const TEMPLATE_RE = /\{\{\s*(variables|credentials)\.([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderTemplate(input: string, ctx: TemplateContext): string {
  return input.replace(TEMPLATE_RE, (match, kind: string, key: string) => {
    const source = kind === "variables" ? ctx.variables : ctx.credentials;
    if (!(key in source)) {
      throw new Error(`Unknown template reference: ${kind}.${key}`);
    }
    return source[key];
  });
}

export function extractTemplateRefs(input: string): Array<{ kind: "variables" | "credentials"; key: string }> {
  const refs: Array<{ kind: "variables" | "credentials"; key: string }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(TEMPLATE_RE);
  while ((m = re.exec(input)) !== null) {
    refs.push({ kind: m[1] as "variables" | "credentials", key: m[2] });
  }
  return refs;
}

export function isSecretTemplate(input: string): boolean {
  return extractTemplateRefs(input).some((r) => r.kind === "credentials");
}
