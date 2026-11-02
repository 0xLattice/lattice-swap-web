import type { OffersState } from '../app';
import { bounded, btc, refundAfter } from '../format';
import { NoRelay } from './swap';

/** Where a seller learns to list offers: `lattice-swap offer --relay`. */
const SELL_DOCS = 'https://github.com/0xLattice/lattice-swap#swapping-through-a-relay';

export function Offers({
  relay,
  offers,
  onPick,
}: {
  relay: string | null;
  offers: OffersState;
  onPick: (text: string) => void;
}) {
  return (
    <section class="wide">
      <div class="heading">
        <h1>Offers</h1>
        <span class="small muted">Sellers online now · best price first</span>
      </div>
      {relay === null && <NoRelay />}
      {offers.error !== null && (
        <p role="alert" class="error">
          Could not read the relay's offers: {bounded(offers.error)}
        </p>
      )}
      {relay !== null && offers.loaded && offers.error === null && offers.list.length === 0 && (
        <div role="status" class="box">
          No offers on the relay right now.
        </div>
      )}
      {offers.list.length > 0 && (
        <div class="table">
          <table>
            <thead>
              <tr>
                <th>Price per NEX</th>
                <th>You can pay</th>
                <th>If it doesn’t finish</th>
                <th>
                  <span class="visually-hidden">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {offers.list.map(({ text, offer }) => (
                <tr key={offer.template.swap_id}>
                  <td>{btc(offer.quote.price)} BTC</td>
                  <td>
                    {btc(offer.quote.min_btc_amount)} – {btc(offer.quote.max_btc_amount)} BTC
                  </td>
                  <td>BTC back in {refundAfter(offer)} with this page open</td>
                  <td class="action">
                    <button type="button" class="secondary" onClick={() => onPick(text)}>
                      Swap
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div class="box sell">
        <div class="grow">
          <span class="strong">Sell NEX</span>
          <span class="small muted">
            Selling runs on an always-on computer: a seller must answer buyers and finish each swap on time. Run{' '}
            <code>lattice-swap offer --relay</code> and your offers appear here.
          </span>
        </div>
        <a href={SELL_DOCS} target="_blank" rel="noopener">
          Set up a seller →
        </a>
      </div>
    </section>
  );
}
