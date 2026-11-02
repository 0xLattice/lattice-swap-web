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

/** A calendar file holding one reminder at `eta`. */
export function reminder(swapId: string, eta: number, summary: string, description: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lattice Swap//EN',
    'BEGIN:VEVENT',
    `UID:${swapId}@lattice-swap`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(eta)}`,
    `DTEND:${stamp(eta + 30 * 60_000)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
