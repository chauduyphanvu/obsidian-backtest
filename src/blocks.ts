export interface Block {
  /** The block's `name:` setting, when it has one. */
  name: string | null;
  /** Text between the fences. */
  source: string;
  /** 0-based line of the opening fence in the note. */
  line: number;
}

/** The fenced code blocks of one language in a note, in order. */
export function extractBlocks(markdown: string, lang = 'strategy'): Block[] {
  const open = new RegExp(`^\\s*(\`{3,}|~{3,})\\s*${lang}\\s*$`);
  const out: Block[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(open);
    if (!m) continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !lines[j].trim().startsWith(m[1])) body.push(lines[j++]);
    const name = body.map((l) => l.match(/^\s*name\s*:\s*(.+?)\s*$/i)).find(Boolean);
    out.push({ name: name ? name[1] : null, source: body.join('\n'), line: i });
    i = j;
  }
  return out;
}
