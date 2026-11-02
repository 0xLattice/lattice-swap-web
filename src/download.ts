/** Hands the viewer `text` as the file `name`. */
export function download(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

/** `text` as an RFC 5545 TEXT value: backslash, semicolon, comma and
 * newline escaped. */
const escape = (text: string) => text.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');

const octets = new TextEncoder();

/** `line` folded as RFC 5545 asks: no line over 75 octets, each
 * continuation starting with a space, never inside a character. */
function fold(line: string): string {
  let out = '';
  let length = 0;
  for (const char of line) {
    const size = octets.encode(char).length;
    if (length + size > 75) {
      out += '\r\n ';
      length = 1;
    }
    out += char;
    length += size;
  }
  return out;
}

/** A calendar file holding one reminder at `eta`. */
export function reminder(swapId: string, eta: number, summary: string, description: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lattice Swap//EN',
    'BEGIN:VEVENT',
    `UID:${swapId}@lattice-swap`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(eta)}`,
    `DTEND:${stamp(eta + 30 * 60_000)}`,
    `SUMMARY:${escape(summary)}`,
    `DESCRIPTION:${escape(description)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
