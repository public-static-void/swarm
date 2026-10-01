// Shell segment splitter (protocol-gate-local).
//
// Breaks a compound shell command into ordered segments on `&&`, `||`,
// `;`, and single `|` so denial feedback can name the exact failing piece
// instead of blaming the whole compound. Quoted spans (single, double, and
// backtick) are opaque: separators inside them never split. A backslash
// escapes the next character. Pure function, no filesystem access, so it
// stays cheap on the tool-call hot path.

export function parseSegments(raw) {
  if (typeof raw !== "string") return [];
  const segments = [];
  let current = "";
  let quote = null;
  let i = 0;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = "";
  };
  while (i < raw.length) {
    const ch = raw[i];
    if (quote !== null) {
      if (ch === "\\" && i + 1 < raw.length) {
        current += ch + raw[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) {
      current += ch + raw[i + 1];
      i += 2;
      continue;
    }
    if (ch === "&" && raw[i + 1] === "&") {
      push();
      i += 2;
      continue;
    }
    if (ch === "|" && raw[i + 1] === "|") {
      push();
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";") {
      push();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  push();
  return segments;
}
