// Raw newlines and tabs inside a JSON string are invalid; escape them.
function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
    } else if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      out += ch;
      inString = false;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += ch;
    }
  }
  return out;
}

// A double quote inside a string value that is not escaped. A real closing quote
// is followed by a comma, a closing bracket or a colon; any other quote cannot be
// the end of the string, so it is escaped. It cannot rescue a quote that happens
// to be followed by a comma, which is why this is a last resort.
function escapeInnerQuotes(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
    } else if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === "\\") {
      out += ch;
      escaped = true;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      const next = text[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
      }
    } else {
      out += ch;
    }
  }
  return out;
}

// Decodes a list or object that the model sent as text, tolerating the usual
// slips: a code fence, text around the JSON, trailing commas, raw newlines and
// unescaped quotes inside strings. Throws if it still cannot be parsed.
export function parseJsonLoosely(text: string): unknown {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const open = t.search(/[[{]/);
  const close = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
  if (open !== -1 && close > open) t = t.slice(open, close + 1);
  const noTrailingCommas = t.replace(/,\s*([\]}])/g, "$1");
  const noControlChars = escapeControlCharsInStrings(noTrailingCommas);
  for (const attempt of [t, noTrailingCommas, noControlChars, escapeInnerQuotes(noControlChars)]) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next repair
    }
  }
  throw new Error("not parseable");
}
