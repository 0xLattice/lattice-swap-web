/** The driver's `onWaiting`: another tab holds the wallet, and this one
 * carries on once that tab closes. */
export function OtherTab() {
  return (
    <section class="narrow">
      <div role="status" class="box strong-border">
        <span class="strong">Lattice Swap is open in another tab</span>
        <span class="small muted">Close the other tab and this one carries on.</span>
      </div>
    </section>
  );
}
