/* Approved visual fixture only. Sample bill values are not real funds, bills, or payments. */
function normalizeDepositAmount(value) {
  const raw = String(value ?? '').trim();
  if (!/^(?:\d{1,9}(?:\.\d{1,2})?|\.\d{1,2})$/.test(raw)) return null;
  const [integer, fraction = ''] = raw.split('.');
  const amount = `${(integer || '0').replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
  return amount === '0.00' ? null : amount;
}

class PaymentExperience {
  constructor() {
    this.isBillOpen = false;
    this.isReceiptOpen = false;
    this.demoReceiptTime = '';
    this.isDeposit = false;
    this.depositAmount = '';
  }

  openDeposit(rawAmount) {
    const amount = normalizeDepositAmount(rawAmount);
    if (!amount) return false;
    this.depositAmount = amount;
    this.isDeposit = true;
    this.isBillOpen = true;
    this.isReceiptOpen = false;
    return true;
  }

  renderDeposit() {
    return this.renderReferenceBill(this.depositAmount, true);
  }

  renderBill() {
    if (this.isDeposit) return this.renderDeposit();
    return this.renderReferenceBill('676.45');
  }

  renderReferenceBill(amount, isDeposit = false) {
    // Reference-screen sample figures only; never submitted or linked to Overview's mock balance.
    return `<article class="bill-page telebirr-preview" data-ui-preview="true" aria-labelledby="bill-page-title">
      <header class="bill-page-heading">
        <button class="bill-back" type="button" data-bill-back aria-label="${isDeposit ? 'Back to Deposit' : 'Back to payment'}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4-8 8 8 8M4 12h16"/></svg></button>
        <h1 id="bill-page-title">Pay Ethio telecom bill</h1>
      </header>
      <section class="bill-details-card" aria-label="Illustrative bill details">
        <div class="bill-customer"><span>Customer Name:</span><strong>Customer 001</strong></div>
        <table class="bill-details-table"><caption class="payment-visually-hidden">Visual preview using sample bill information, not a retrieved invoice.</caption><thead><tr><th scope="col">Month</th><th scope="col">Amount</th><th scope="col">Due Date</th></tr></thead><tbody><tr><td>12/2024</td><td>${amount}<small>ETB</small></td><td class="bill-example-due">27/01/2025</td></tr></tbody></table>
      </section>
      <fieldset class="bill-amount-options" disabled>
        <legend class="payment-visually-hidden">Illustrative amount selection</legend>
        <label><input type="radio" name="bill-amount" value="total" checked /><span class="bill-radio-mark is-selected" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-8"/></svg></span><span>Total Bill Amount</span><strong>${amount} ETB</strong></label>
        <label><input type="radio" name="bill-amount" value="other" /><span class="bill-radio-mark" aria-hidden="true"></span><span>Other amount</span></label>
      </fieldset>
      <div class="bill-page-actions">
        <p class="bill-page-preview-note">Visual preview only · Telebirr is not connected.</p>
        <button class="bill-secondary-action" type="button" data-bill-back>Back</button>
        <button class="bill-primary-action" type="button" data-review-bill>Continue</button>
      </div>
      <dialog class="bill-payment-sheet telebirr-sheet" id="bill-payment-dialog" aria-labelledby="bill-sheet-title" aria-describedby="bill-sheet-note">
        <button class="bill-sheet-close" type="button" data-close-bill-sheet aria-label="Close payment details">${icon('close')}</button>
        <h2 id="bill-sheet-title">Pay Bill</h2>
        <p class="bill-sheet-amount"><span>${amount}</span><small>ETB</small></p>
        <section class="bill-method-card" aria-labelledby="bill-method-title">
          <h3 id="bill-method-title">Payment Method</h3>
          <div class="bill-balance-method"><span class="bill-wallet-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h14a2 2 0 0 1 2 2v12H3V7a3 3 0 0 1 3-3h10v2M16 12h5v5h-5z"/></svg></span><div><strong>Balance</strong><p>(Available Balance:701.00ETB)</p></div><span class="bill-method-badge" aria-label="Illustrative selected payment method"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-8"/></svg></span></div>
        </section>
        <button class="bill-pay-button" type="button" data-bill-pay data-demo-pay aria-describedby="bill-sheet-note">Pay</button>
        <p class="bill-sheet-note" id="bill-sheet-note">Visual preview only · Telebirr is not connected. Pay opens a demo receipt; no payment is sent.</p>
      </dialog>
    </article>`;
  }

  renderReceipt() {
    const amount = this.isDeposit ? this.depositAmount : '676.45';
    // Static QR contains a harmless demo identifier only, never a payment URL or transaction record.
    return `<article class="bill-page telebirr-preview demo-receipt" data-ui-preview="true" aria-labelledby="receipt-title" aria-describedby="receipt-no-payment-note">
      <button class="bill-back receipt-back" type="button" data-receipt-back aria-label="Back to bill details"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4-8 8 8 8M4 12h16"/></svg></button>
      <header class="receipt-status">
        <span class="receipt-success-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="m8 16 5 5 12-13"/></svg></span>
        <h1 id="receipt-title">Successful</h1>
      </header>
      <section class="receipt-payment-summary" aria-label="Simulated payment amount">
        <h2>Payment Method</h2>
        <p class="receipt-amount">-${amount} <small>(ETB)</small></p>
      </section>
      <dl class="receipt-details">
        <div><dt>Transaction Time:</dt><dd>${this.demoReceiptTime || '—'}</dd></div>
        <div><dt>Transaction Type:</dt><dd>Bill Payment</dd></div>
        <div><dt>Transaction To:</dt><dd>Ethio telecom</dd></div>
        <div><dt>Transaction Number:</dt><dd class="receipt-reference">DEMO-RCP-001</dd></div>
      </dl>
      <figure class="receipt-qr">
        <div class="receipt-qr-code" data-demo-qr data-qr-payload="STEMMA-DEMO-RECEIPT-001" role="img" aria-label="Receipt identifier QR code">
          <svg viewBox="0 0 41 41" aria-hidden="true" shape-rendering="crispEdges"><rect width="41" height="41" fill="#fff"/><path d="M4 4h7v1h-7zM12 4h5v1h-5zM18 4h1v1h-1zM20 4h4v1h-4zM25 4h1v1h-1zM28 4h1v1h-1zM30 4h7v1h-7zM4 5h1v1h-1zM10 5h1v1h-1zM19 5h1v1h-1zM21 5h1v1h-1zM24 5h5v1h-5zM30 5h1v1h-1zM36 5h1v1h-1zM4 6h1v1h-1zM6 6h3v1h-3zM10 6h1v1h-1zM13 6h2v1h-2zM16 6h2v1h-2zM23 6h2v1h-2zM26 6h1v1h-1zM30 6h1v1h-1zM32 6h3v1h-3zM36 6h1v1h-1zM4 7h1v1h-1zM6 7h3v1h-3zM10 7h1v1h-1zM12 7h2v1h-2zM15 7h2v1h-2zM18 7h1v1h-1zM21 7h5v1h-5zM28 7h1v1h-1zM30 7h1v1h-1zM32 7h3v1h-3zM36 7h1v1h-1zM4 8h1v1h-1zM6 8h3v1h-3zM10 8h1v1h-1zM12 8h1v1h-1zM15 8h1v1h-1zM17 8h2v1h-2zM22 8h3v1h-3zM28 8h1v1h-1zM30 8h1v1h-1zM32 8h3v1h-3zM36 8h1v1h-1zM4 9h1v1h-1zM10 9h1v1h-1zM12 9h1v1h-1zM15 9h1v1h-1zM17 9h2v1h-2zM20 9h1v1h-1zM22 9h2v1h-2zM26 9h1v1h-1zM30 9h1v1h-1zM36 9h1v1h-1zM4 10h7v1h-7zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM18 10h1v1h-1zM20 10h1v1h-1zM22 10h1v1h-1zM24 10h1v1h-1zM26 10h1v1h-1zM28 10h1v1h-1zM30 10h7v1h-7zM12 11h1v1h-1zM14 11h1v1h-1zM18 11h5v1h-5zM25 11h3v1h-3zM4 12h1v1h-1zM8 12h1v1h-1zM10 12h3v1h-3zM15 12h4v1h-4zM20 12h1v1h-1zM22 12h2v1h-2zM29 12h5v1h-5zM36 12h1v1h-1zM4 13h4v1h-4zM9 13h1v1h-1zM12 13h1v1h-1zM14 13h2v1h-2zM17 13h1v1h-1zM23 13h2v1h-2zM27 13h4v1h-4zM32 13h5v1h-5zM6 14h3v1h-3zM10 14h2v1h-2zM13 14h3v1h-3zM19 14h1v1h-1zM21 14h1v1h-1zM24 14h4v1h-4zM29 14h4v1h-4zM35 14h2v1h-2zM6 15h1v1h-1zM11 15h2v1h-2zM15 15h1v1h-1zM18 15h5v1h-5zM25 15h1v1h-1zM27 15h2v1h-2zM30 15h1v1h-1zM33 15h1v1h-1zM36 15h1v1h-1zM4 16h2v1h-2zM7 16h1v1h-1zM9 16h4v1h-4zM17 16h2v1h-2zM22 16h3v1h-3zM28 16h1v1h-1zM31 16h1v1h-1zM33 16h2v1h-2zM6 17h1v1h-1zM12 17h1v1h-1zM14 17h4v1h-4zM20 17h2v1h-2zM23 17h1v1h-1zM26 17h1v1h-1zM29 17h2v1h-2zM34 17h1v1h-1zM36 17h1v1h-1zM4 18h4v1h-4zM9 18h4v1h-4zM15 18h1v1h-1zM20 18h1v1h-1zM22 18h2v1h-2zM25 18h2v1h-2zM29 18h2v1h-2zM32 18h1v1h-1zM36 18h1v1h-1zM4 19h1v1h-1zM6 19h4v1h-4zM12 19h3v1h-3zM16 19h1v1h-1zM18 19h1v1h-1zM23 19h4v1h-4zM28 19h1v1h-1zM31 19h3v1h-3zM5 20h2v1h-2zM8 20h3v1h-3zM12 20h2v1h-2zM16 20h2v1h-2zM19 20h1v1h-1zM24 20h1v1h-1zM27 20h1v1h-1zM29 20h2v1h-2zM33 20h4v1h-4zM4 21h1v1h-1zM6 21h3v1h-3zM11 21h1v1h-1zM14 21h1v1h-1zM18 21h1v1h-1zM20 21h4v1h-4zM25 21h1v1h-1zM27 21h2v1h-2zM32 21h1v1h-1zM36 21h1v1h-1zM7 22h1v1h-1zM10 22h1v1h-1zM13 22h1v1h-1zM15 22h3v1h-3zM20 22h1v1h-1zM22 22h2v1h-2zM27 22h2v1h-2zM31 22h1v1h-1zM33 22h1v1h-1zM4 23h1v1h-1zM6 23h4v1h-4zM11 23h3v1h-3zM15 23h3v1h-3zM23 23h2v1h-2zM26 23h4v1h-4zM31 23h2v1h-2zM34 23h2v1h-2zM4 24h2v1h-2zM7 24h6v1h-6zM16 24h5v1h-5zM26 24h1v1h-1zM29 24h2v1h-2zM33 24h1v1h-1zM35 24h2v1h-2zM4 25h2v1h-2zM7 25h1v1h-1zM13 25h1v1h-1zM16 25h1v1h-1zM18 25h1v1h-1zM22 25h3v1h-3zM28 25h1v1h-1zM30 25h4v1h-4zM36 25h1v1h-1zM6 26h1v1h-1zM8 26h1v1h-1zM10 26h2v1h-2zM13 26h2v1h-2zM17 26h3v1h-3zM21 26h1v1h-1zM24 26h5v1h-5zM31 26h1v1h-1zM33 26h4v1h-4zM6 27h1v1h-1zM8 27h2v1h-2zM13 27h2v1h-2zM17 27h6v1h-6zM25 27h1v1h-1zM27 27h1v1h-1zM29 27h2v1h-2zM34 27h3v1h-3zM4 28h2v1h-2zM8 28h4v1h-4zM15 28h4v1h-4zM20 28h1v1h-1zM22 28h2v1h-2zM28 28h5v1h-5zM34 28h2v1h-2zM12 29h1v1h-1zM16 29h1v1h-1zM23 29h2v1h-2zM27 29h2v1h-2zM32 29h1v1h-1zM35 29h2v1h-2zM4 30h7v1h-7zM12 30h4v1h-4zM19 30h1v1h-1zM21 30h1v1h-1zM24 30h5v1h-5zM30 30h1v1h-1zM32 30h5v1h-5zM4 31h1v1h-1zM10 31h1v1h-1zM14 31h1v1h-1zM16 31h7v1h-7zM25 31h1v1h-1zM27 31h2v1h-2zM32 31h2v1h-2zM36 31h1v1h-1zM4 32h1v1h-1zM6 32h3v1h-3zM10 32h1v1h-1zM12 32h1v1h-1zM15 32h1v1h-1zM22 32h3v1h-3zM28 32h6v1h-6zM4 33h1v1h-1zM6 33h3v1h-3zM10 33h1v1h-1zM13 33h1v1h-1zM15 33h1v1h-1zM20 33h2v1h-2zM23 33h1v1h-1zM25 33h7v1h-7zM34 33h3v1h-3zM4 34h1v1h-1zM6 34h3v1h-3zM10 34h1v1h-1zM14 34h4v1h-4zM20 34h1v1h-1zM22 34h2v1h-2zM29 34h4v1h-4zM4 35h1v1h-1zM10 35h1v1h-1zM13 35h1v1h-1zM23 35h2v1h-2zM26 35h2v1h-2zM29 35h3v1h-3zM33 35h1v1h-1zM36 35h1v1h-1zM4 36h7v1h-7zM12 36h3v1h-3zM17 36h3v1h-3zM24 36h1v1h-1zM26 36h2v1h-2zM29 36h1v1h-1zM32 36h5v1h-5z" fill="#000"/></svg>
        </div>
        <figcaption>Payment QR Code</figcaption>
      </figure>
      <p class="receipt-preview-note" id="receipt-no-payment-note">No payment was sent.</p>
    </article>`;
  }

  openDemoReceipt() {
    if (!this.isBillOpen || this.isReceiptOpen) return;
    this.closeSheet();
    this.demoReceiptTime = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Africa/Addis_Ababa', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(new Date()).replaceAll('-', '/');
    this.isReceiptOpen = true;
  }

  showSheet() {
    const dialog = document.getElementById('bill-payment-dialog');
    if (dialog && !dialog.open) dialog.showModal();
  }

  closeSheet() {
    const dialog = document.getElementById('bill-payment-dialog');
    if (dialog?.open) dialog.close();
  }

}
