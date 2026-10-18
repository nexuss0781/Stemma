/* Approved visual fixture only. Sample bill values are not real funds, bills, or payments. */
class PaymentExperience {
  constructor() {
    this.isBillOpen = false;
    this.isReceiptOpen = false;
    this.demoReceiptTime = '';
  }

  renderBill() {
    // Reference-screen sample figures only; never submitted or linked to Overview's mock balance.
    return `<article class="bill-page telebirr-preview" data-ui-preview="true" aria-labelledby="bill-page-title">
      <header class="bill-page-heading">
        <button class="bill-back" type="button" data-bill-back aria-label="Back to payment"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4-8 8 8 8M4 12h16"/></svg></button>
        <h1 id="bill-page-title">Pay Ethio telecom bill</h1>
      </header>
      <section class="bill-details-card" aria-label="Illustrative bill details">
        <div class="bill-customer"><span>Customer Name:</span><strong>Customer 001</strong></div>
        <table class="bill-details-table"><caption class="payment-visually-hidden">Visual preview using sample bill information, not a retrieved invoice.</caption><thead><tr><th scope="col">Month</th><th scope="col">Amount</th><th scope="col">Due Date</th></tr></thead><tbody><tr><td>12/2024</td><td>676.45<small>ETB</small></td><td class="bill-example-due">27/01/2025</td></tr></tbody></table>
      </section>
      <fieldset class="bill-amount-options" disabled>
        <legend class="payment-visually-hidden">Illustrative amount selection</legend>
        <label><input type="radio" name="bill-amount" value="total" checked /><span class="bill-radio-mark is-selected" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3 8 3 3 7-8"/></svg></span><span>Total Bill Amount</span><strong>676.45 ETB</strong></label>
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
        <p class="bill-sheet-amount"><span>676.45</span><small>ETB</small></p>
        <section class="bill-method-card" aria-labelledby="bill-method-title">
          <h3 id="bill-method-title">Payment Method</h3>
          <div class="bill-balance-method"><span class="bill-wallet-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h14a2 2 0 0 1 2 2v12H3V7a3 3 0 0 1 3-3h10v2M16 12h5v5h-5z"/></svg></span><div><strong>Balance</strong><p>(Available Balance:701.00ETB)</p></div><span class="bill-method-badge" aria-label="Illustrative selected payment method"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-8"/></svg></span></div>
        </section>
        <button class="bill-pay-button" type="button" data-bill-pay data-demo-pay aria-describedby="bill-sheet-note">Pay</button>
        <p class="bill-sheet-note" id="bill-sheet-note">Visual preview only · Telebirr is not connected. Pay opens a receipt preview; no payment is sent.</p>
      </dialog>
    </article>`;
  }

  renderReceipt() {
    // Static QR contains a harmless demo identifier only, never a payment URL or transaction record.
    return `<article class="bill-page telebirr-preview demo-receipt" data-ui-preview="true" aria-labelledby="receipt-title" aria-describedby="receipt-no-payment-note">
      <button class="bill-back receipt-back" type="button" data-receipt-back aria-label="Back to bill details"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 4-8 8 8 8M4 12h16"/></svg></button>
      <header class="receipt-status">
        <span class="receipt-success-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="m8 16 5 5 12-13"/></svg></span>
        <h1 id="receipt-title">Receipt Preview</h1>
      </header>
      <section class="receipt-payment-summary" aria-label="Simulated payment amount">
        <h2>Payment Method</h2>
        <p class="receipt-amount">-676.45 <small>(ETB)</small></p>
      </section>
      <dl class="receipt-details">
        <div><dt>Transaction Time:</dt><dd>${this.demoReceiptTime || '—'}</dd></div>
        <div><dt>Transaction Type:</dt><dd>Bill Payment</dd></div>
        <div><dt>Transaction To:</dt><dd>Ethio telecom</dd></div>
        <div><dt>Transaction Number:</dt><dd class="receipt-reference">RCP-67645-001</dd></div>
      </dl>
      <figure class="receipt-qr">
        <div class="receipt-qr-code" data-demo-qr data-qr-payload="STEMMA-DEMO-RECEIPT-67645-001" role="img" aria-label="Receipt identifier QR code">
          <svg viewBox="0 0 41 41" aria-hidden="true" shape-rendering="crispEdges"><rect width="41" height="41" fill="#fff"/><path d="M4 4h7v1h-7zM12 4h1v1h-1zM15 4h4v1h-4zM20 4h3v1h-3zM24 4h1v1h-1zM26 4h1v1h-1zM28 4h1v1h-1zM30 4h7v1h-7zM4 5h1v1h-1zM10 5h1v1h-1zM16 5h3v1h-3zM21 5h1v1h-1zM23 5h4v1h-4zM30 5h1v1h-1zM36 5h1v1h-1zM4 6h1v1h-1zM6 6h3v1h-3zM10 6h1v1h-1zM13 6h2v1h-2zM16 6h1v1h-1zM18 6h3v1h-3zM22 6h1v1h-1zM24 6h1v1h-1zM27 6h2v1h-2zM30 6h1v1h-1zM32 6h3v1h-3zM36 6h1v1h-1zM4 7h1v1h-1zM6 7h3v1h-3zM10 7h1v1h-1zM12 7h1v1h-1zM14 7h2v1h-2zM19 7h1v1h-1zM21 7h3v1h-3zM25 7h3v1h-3zM30 7h1v1h-1zM32 7h3v1h-3zM36 7h1v1h-1zM4 8h1v1h-1zM6 8h3v1h-3zM10 8h1v1h-1zM13 8h1v1h-1zM17 8h1v1h-1zM19 8h1v1h-1zM24 8h3v1h-3zM30 8h1v1h-1zM32 8h3v1h-3zM36 8h1v1h-1zM4 9h1v1h-1zM10 9h1v1h-1zM13 9h2v1h-2zM16 9h1v1h-1zM18 9h2v1h-2zM21 9h1v1h-1zM23 9h1v1h-1zM26 9h1v1h-1zM30 9h1v1h-1zM36 9h1v1h-1zM4 10h7v1h-7zM12 10h1v1h-1zM14 10h1v1h-1zM16 10h1v1h-1zM18 10h1v1h-1zM20 10h1v1h-1zM22 10h1v1h-1zM24 10h1v1h-1zM26 10h1v1h-1zM28 10h1v1h-1zM30 10h7v1h-7zM13 11h4v1h-4zM19 11h1v1h-1zM21 11h2v1h-2zM24 11h1v1h-1zM28 11h1v1h-1zM6 12h1v1h-1zM8 12h3v1h-3zM12 12h1v1h-1zM15 12h7v1h-7zM27 12h1v1h-1zM29 12h1v1h-1zM33 12h1v1h-1zM36 12h1v1h-1zM4 13h3v1h-3zM8 13h1v1h-1zM11 13h1v1h-1zM17 13h1v1h-1zM19 13h2v1h-2zM23 13h3v1h-3zM27 13h1v1h-1zM30 13h1v1h-1zM32 13h3v1h-3zM36 13h1v1h-1zM7 14h2v1h-2zM10 14h1v1h-1zM12 14h2v1h-2zM15 14h1v1h-1zM20 14h1v1h-1zM22 14h1v1h-1zM26 14h1v1h-1zM29 14h2v1h-2zM32 14h1v1h-1zM36 14h1v1h-1zM9 15h1v1h-1zM15 15h1v1h-1zM17 15h1v1h-1zM19 15h1v1h-1zM21 15h1v1h-1zM23 15h5v1h-5zM29 15h1v1h-1zM31 15h3v1h-3zM36 15h1v1h-1zM7 16h2v1h-2zM10 16h1v1h-1zM12 16h1v1h-1zM15 16h1v1h-1zM18 16h7v1h-7zM26 16h1v1h-1zM28 16h1v1h-1zM30 16h3v1h-3zM34 16h1v1h-1zM36 16h1v1h-1zM5 17h2v1h-2zM8 17h1v1h-1zM13 17h3v1h-3zM17 17h1v1h-1zM19 17h4v1h-4zM24 17h1v1h-1zM26 17h3v1h-3zM30 17h2v1h-2zM33 17h1v1h-1zM5 18h1v1h-1zM7 18h1v1h-1zM9 18h2v1h-2zM14 18h3v1h-3zM18 18h1v1h-1zM22 18h3v1h-3zM28 18h1v1h-1zM30 18h6v1h-6zM8 19h1v1h-1zM14 19h2v1h-2zM17 19h1v1h-1zM20 19h2v1h-2zM23 19h2v1h-2zM27 19h3v1h-3zM31 19h1v1h-1zM33 19h1v1h-1zM35 19h2v1h-2zM4 20h2v1h-2zM7 20h5v1h-5zM14 20h5v1h-5zM20 20h2v1h-2zM26 20h1v1h-1zM30 20h1v1h-1zM32 20h4v1h-4zM5 21h4v1h-4zM15 21h1v1h-1zM18 21h5v1h-5zM27 21h1v1h-1zM29 21h1v1h-1zM31 21h3v1h-3zM35 21h1v1h-1zM5 22h2v1h-2zM10 22h1v1h-1zM13 22h1v1h-1zM15 22h4v1h-4zM20 22h3v1h-3zM24 22h1v1h-1zM26 22h1v1h-1zM28 22h2v1h-2zM32 22h1v1h-1zM34 22h2v1h-2zM4 23h1v1h-1zM6 23h4v1h-4zM13 23h3v1h-3zM18 23h1v1h-1zM22 23h3v1h-3zM29 23h3v1h-3zM33 23h4v1h-4zM5 24h2v1h-2zM8 24h1v1h-1zM10 24h3v1h-3zM17 24h1v1h-1zM20 24h2v1h-2zM24 24h1v1h-1zM26 24h2v1h-2zM29 24h1v1h-1zM31 24h1v1h-1zM33 24h3v1h-3zM5 25h3v1h-3zM14 25h1v1h-1zM22 25h6v1h-6zM29 25h1v1h-1zM31 25h1v1h-1zM35 25h1v1h-1zM4 26h1v1h-1zM8 26h1v1h-1zM10 26h1v1h-1zM14 26h1v1h-1zM16 26h2v1h-2zM19 26h1v1h-1zM21 26h1v1h-1zM26 26h1v1h-1zM31 26h4v1h-4zM36 26h1v1h-1zM5 27h3v1h-3zM11 27h6v1h-6zM22 27h1v1h-1zM24 27h4v1h-4zM29 27h2v1h-2zM33 27h1v1h-1zM4 28h1v1h-1zM8 28h1v1h-1zM10 28h3v1h-3zM22 28h1v1h-1zM26 28h1v1h-1zM28 28h7v1h-7zM36 28h1v1h-1zM12 29h2v1h-2zM16 29h6v1h-6zM23 29h1v1h-1zM26 29h3v1h-3zM32 29h2v1h-2zM36 29h1v1h-1zM4 30h7v1h-7zM13 30h3v1h-3zM17 30h1v1h-1zM20 30h1v1h-1zM22 30h2v1h-2zM25 30h1v1h-1zM28 30h1v1h-1zM30 30h1v1h-1zM32 30h1v1h-1zM34 30h1v1h-1zM36 30h1v1h-1zM4 31h1v1h-1zM10 31h1v1h-1zM12 31h3v1h-3zM19 31h4v1h-4zM28 31h1v1h-1zM32 31h2v1h-2zM35 31h1v1h-1zM4 32h1v1h-1zM6 32h3v1h-3zM10 32h1v1h-1zM12 32h1v1h-1zM16 32h2v1h-2zM19 32h1v1h-1zM24 32h1v1h-1zM27 32h6v1h-6zM34 32h2v1h-2zM4 33h1v1h-1zM6 33h3v1h-3zM10 33h1v1h-1zM13 33h1v1h-1zM15 33h3v1h-3zM21 33h2v1h-2zM25 33h1v1h-1zM27 33h3v1h-3zM34 33h2v1h-2zM4 34h1v1h-1zM6 34h3v1h-3zM10 34h1v1h-1zM12 34h4v1h-4zM18 34h2v1h-2zM21 34h1v1h-1zM24 34h1v1h-1zM26 34h2v1h-2zM29 34h1v1h-1zM32 34h1v1h-1zM36 34h1v1h-1zM4 35h1v1h-1zM10 35h1v1h-1zM13 35h2v1h-2zM16 35h2v1h-2zM19 35h2v1h-2zM22 35h3v1h-3zM27 35h1v1h-1zM29 35h2v1h-2zM34 35h3v1h-3zM4 36h7v1h-7zM16 36h1v1h-1zM19 36h2v1h-2zM23 36h1v1h-1zM25 36h2v1h-2zM31 36h2v1h-2zM34 36h1v1h-1zM36 36h1v1h-1z" fill="#000"/></svg>
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
