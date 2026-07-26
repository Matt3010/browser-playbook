export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 0; padding: 2rem; background: #f5f6f8; color: #16181d;
  }
  main { max-width: 720px; margin: 0 auto; background: #fff; padding: 2rem;
    border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  h1 { margin-top: 0; font-size: 1.5rem; }
  label { display: block; margin: 1rem 0 .25rem; font-weight: 600; font-size: .875rem; }
  input[type=text], input[type=email], input[type=password], select, textarea {
    width: 100%; padding: .55rem .7rem; border: 1px solid #c9ced6;
    border-radius: 6px; font-size: 1rem; font-family: inherit;
  }
  textarea { min-height: 90px; }
  button, .btn {
    margin-top: 1.25rem; padding: .6rem 1.1rem; border: 0; border-radius: 6px;
    background: #2f6fed; color: #fff; font-size: 1rem; cursor: pointer;
    display: inline-block; text-decoration: none;
  }
  button:disabled { background: #9aa3b2; cursor: not-allowed; }
  .row { display: flex; gap: 1.5rem; align-items: center; margin-top: 1rem; }
  .checkbox-row { display: flex; align-items: center; gap: .5rem; margin-top: 1rem; }
  .checkbox-row input { margin: 0; }
  .checkbox-row label { margin: 0; font-weight: 400; }
  .error { background: #fdecec; color: #a32020; padding: .7rem 1rem;
    border-radius: 6px; margin-bottom: 1rem; }
  nav a { margin-right: 1rem; }
  iframe { width: 100%; height: 140px; border: 1px solid #c9ced6; border-radius: 6px; }
  dl { background: #f0f2f5; padding: 1rem; border-radius: 6px; }
  dt { font-weight: 600; font-size: .8rem; color: #555c6b; }
  dd { margin: .15rem 0 .75rem; }
  fieldset { border: 1px solid #d6dae1; border-radius: 6px; margin-top: 1.5rem; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}
