// sample-prd.md ends with a note listing its own planted gaps. Sending that to the
// model would make the regression check meaningless, so it is removed first.
export function blindSamplePrd(text: string): string {
  const unix = text.replace(/\r\n/g, "\n");
  const withoutNote = unix.replace(/^\*Draft v0\.1[\s\S]*?blind check\)\.\*\n\n/m, "");
  const cut = withoutNote.search(/\n---\n\n### Known planted gaps/);
  return (cut === -1 ? withoutNote : withoutNote.slice(0, cut)).trimEnd() + "\n";
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
