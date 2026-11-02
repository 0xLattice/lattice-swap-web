import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import qrcode from 'qrcode-generator';

export function Row({ label, children, strong }: { label: string; children: ComponentChildren; strong?: boolean }) {
  return (
    <div class="row">
      <span class="muted">{label}</span>
      <span class={strong ? 'strong' : undefined}>{children}</span>
    </div>
  );
}

/** `address`, its QR code, and a copy button. */
export function Address({ label, address }: { label: string; address: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(address);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [address]);
  const [copied, setCopied] = useState(false);
  return (
    <div class="address">
      <div class="qr" role="img" aria-label={`QR code of ${address}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div class="address-text">
        <span class="small muted">{label}</span>
        <div class="copy">
          <code>{address}</code>
          <button
            type="button"
            class="ghost"
            onClick={() => navigator.clipboard?.writeText(address).then(() => setCopied(true), () => {})}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
