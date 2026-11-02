import { download, reminder } from '../download';
import { bounded, btc, nex, when } from '../format';
import type { Status } from '../types';
import { Row } from './ui';

/** `n` of the `of` confirmations the swap asks for. */
const confirmations = (n: number | null, of: number) => `${n ?? 0} of ${of} confirmation${of === 1 ? '' : 's'}`;

const STEPS = ['Lock your BTC', 'Seller locks NEX', 'Finish', 'NEX received'];

/** Which of the four steps the swap is on, from `status()`; null once it
 * left them, to a refund or another end. */
export function stepOf(status: Status): number | null {
  const { step, outcome, confirmations } = status;
  if (step === 'swapping') return confirmations.nexLock === null && !confirmations.funding ? 0 : 1;
  if (step === 'finishing') return 2;
  if (step === 'done' && outcome === 'swapped') return 3;
  return null;
}

function detail(status: Status, at: number): string {
  const { funding, nexLock } = status.confirmations;
  if (at === 0) return funding === null ? 'Locking BTC from your wallet.' : 'Your lock is in the mempool, waiting for a block.';
  if (at === 1) {
    if (nexLock !== null) return `The seller’s NEX lock is seen, ${confirmations(nexLock, status.nex_confirmations)}.`;
    return `Your lock has ${confirmations(funding, status.btc_confirmations)}. Waiting for the seller to lock NEX on Nexus. Nothing to do.`;
  }
  if (at === 2) return 'Your browser completes the swap with the seller.';
  return `${nex(status.nex_amount)} NEX is in your address.`;
}

function Deadlines({ status }: { status: Status }) {
  const { cancel, refund, punish } = status.deadlines;
  return (
    <div class="details">
      {cancel && (
        <Row label="Cancel from">
          block {cancel.height} · {when(cancel.eta)}
        </Row>
      )}
      {refund && (
        <Row label="Refund in">
          block {refund.from}, before block {refund.until}
        </Row>
      )}
      {punish && (
        <Row label="Seller can claim from">
          block {punish.height} · {when(punish.eta)}
        </Row>
      )}
      {status.tip !== null && <Row label="Bitcoin tip">block {status.tip}</Row>}
    </div>
  );
}

const ENDS: Record<string, string> = {
  aborted: 'Stopped before anything was at stake. Your BTC is in your wallet.',
  punished:
    'The seller took your BTC and no NEX arrived: your refund did not confirm before the punish height, so the seller claimed the lock.',
  drained:
    'The seller took your BTC and no NEX arrived: the NEX lock was already spent when your browser learned its key.',
};

export function Progress(props: {
  status: Status;
  backedUp: boolean;
  onBackup: () => void;
  onWithdraw: () => void;
  onSwapAgain: () => void;
}) {
  const { status } = props;
  const at = stepOf(status);
  const { cancel } = status.deadlines;
  const swapping = status.step === 'swapping' || status.step === 'finishing';
  // While the page must stay open, "come back by" would tell the buyer
  // they may close it.
  const comeBack = cancel && !status.mustStayOpen && `Come back by ${when(cancel.eta)} and keep this page open until your refund confirms.`;
  const saveReminder = () =>
    cancel &&
    download(
      `lattice-swap-${status.swapId.slice(0, 8)}.ics`,
      reminder(status.swapId, cancel.eta, 'Lattice Swap: open the page for your refund', comeBack || ''),
      'text/calendar',
    );
  const swapAgain = (
    <button type="button" class="primary" onClick={props.onSwapAgain}>
      Swap again
    </button>
  );
  return (
    <section class="wide">
      {status.mustStayOpen && (
        <div role="status" class="banner">
          <span class="strong">Keep this page open</span>
          <span class="small">
            {status.step === 'refunding'
              ? 'Refunding your BTC. Leave this page open until it confirms.'
              : 'Finishing your swap. Leave this page open until it settles.'}
          </span>
        </div>
      )}
      <div>
        <div class="label">Swap</div>
        <h1>{`${btc(status.btc_amount)} BTC → ${nex(status.nex_amount)} NEX`}</h1>
        {status.nexAddress !== null && (
          <span class="small muted">
            To <code class="break">{status.nexAddress}</code>
          </span>
        )}
      </div>

      {status.backupCovers === 'lock' && status.outcome === null && !props.backedUp && (
        <div class="box strong-border inline">
          <span class="small grow">If this browser’s data is lost, this file gets your BTC back.</span>
          <button type="button" class="primary" onClick={props.onBackup}>
            Download recovery file
          </button>
        </div>
      )}

      {swapping && cancel && !status.mustStayOpen && status.warning === null && (
        <div class="box small muted">
          If the swap stalls, come back by {when(cancel.eta)} and keep this page open until your refund confirms.{' '}
          <button type="button" class="link" onClick={saveReminder}>
            Save reminder (.ics)
          </button>
        </div>
      )}

      {swapping && status.warning !== null && (
        <div role="alert" class="box strong-border">
          <span class="strong">The swap is stalled</span>
          <span class="small muted">{bounded(status.warning)}</span>
          {comeBack && <span class="small muted">{comeBack}</span>}
          <Deadlines status={status} />
        </div>
      )}

      {status.step === 'refunding' && (
        <div class="box strong-border">
          <span class="strong">Refunding your BTC</span>
          {status.warning !== null && <span class="small muted">{bounded(status.warning)}</span>}
          <Deadlines status={status} />
        </div>
      )}

      {status.step === 'refunded' && (
        <div class="box strong-border">
          <span class="strong">Refunded. Your BTC is back in your wallet.</span>
          <div class="buttons">
            <button type="button" class="secondary" onClick={props.onWithdraw}>
              Withdraw
            </button>
            {swapAgain}
          </div>
        </div>
      )}

      {status.step === 'done' && status.outcome !== 'swapped' && (
        <div class="box strong-border">
          <span class="strong">{ENDS[status.outcome ?? ''] ?? `The swap ended: ${status.outcome}.`}</span>
          <div class="buttons">{swapAgain}</div>
        </div>
      )}

      {at !== null && (
        <ol class="steps">
          {STEPS.map((title, i) => {
            const done = i < at || (i === 3 && at === 3);
            const current = i === at;
            return (
              <li key={title} class={current ? 'current' : done ? 'done' : undefined} aria-current={current ? 'step' : undefined}>
                <span class="mark">{done ? '✓' : i + 1}</span>
                <div class="step-body">
                  <span class="step-title">{title}</span>
                  {current && <span class="small muted">{detail(status, i)}</span>}
                  {current && i === 3 && <div class="buttons">{swapAgain}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
