/* Read-only friend-bill discovery. Production never substitutes sample students or amounts. */
function escapeFriendHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function normalizeFriendUsername(value, allowPartial = false) {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/^@/, '');
  return (allowPartial ? /^[A-Za-z0-9_.]{0,30}$/ : /^[A-Za-z0-9_.]{3,30}$/).test(username) ? username : null;
}
function validateFriendStudent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.billId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.billId)) return null;
  if (typeof value.username !== 'string' || !/^[A-Za-z0-9_.]{3,30}$/.test(value.username)) return null;
  if (typeof value.firstName !== 'string' || typeof value.lastName !== 'string') return null;
  const firstName = value.firstName.trim(), lastName = value.lastName.trim();
  if (!firstName || !lastName || firstName.length > 80 || lastName.length > 80 || value.currency !== 'ETB') return null;
  if (typeof value.amountDue !== 'string') return null;
  const amountDue = normalizeDepositAmount(value.amountDue);
  if (!amountDue) return null;
  const photoURL = `/api/friend-bills/${encodeURIComponent(value.billId)}/photo`;
  if (value.photoURL !== photoURL) return null;
  const month = typeof value.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month) ? value.month : '';
  let dueDate = '';
  if (typeof value.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.dueDate)) {
    const [year, monthNumber, day] = value.dueDate.split('-').map(Number);
    const date = new Date(Date.UTC(year, monthNumber - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === monthNumber - 1 && date.getUTCDate() === day) dueDate = value.dueDate;
  }
  return Object.freeze({ billId: value.billId, username: value.username, firstName, lastName, amountDue, currency: 'ETB', photoURL, month, dueDate });
}
class FriendPaymentFlow {
  constructor() {
    this.query = '';
    this.students = [];
    this.selectedBillId = '';
    this.status = 'idle';
    this.notice = '';
    this.revision = 0;
  }
  clear() {
    this.revision += 1;
    this.query = '';
    this.students = [];
    this.selectedBillId = '';
    this.status = 'idle';
    this.notice = '';
  }
  cancel() { this.revision += 1; }
  get selected() { return this.students.find(student => student.billId === this.selectedBillId) || null; }
  async request(path) {
    const response = await window.fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) { const error = new Error('Student bill could not be loaded.'); error.status = response.status; throw error; }
    return response.json();
  }
  async search(rawQuery) {
    const query = normalizeFriendUsername(rawQuery);
    if (!query) return false;
    const revision = ++this.revision;
    this.query = query;
    this.students = [];
    this.selectedBillId = '';
    this.status = 'loading';
    this.notice = '';
    try {
      const data = await this.request(`/api/friend-bills?username=${encodeURIComponent(query)}`);
      if (revision !== this.revision) return false;
      if (!data || !Array.isArray(data.students)) throw new Error('Invalid student list.');
      const seen = new Set();
      this.students = data.students.slice(0, 10).map(validateFriendStudent).filter(student => {
        if (!student || seen.has(student.billId) || !student.username.toLowerCase().startsWith(query.toLowerCase())) return false;
        seen.add(student.billId); return true;
      });
      this.status = this.students.length ? 'ready' : 'empty';
    } catch (error) {
      if (revision !== this.revision) return false;
      this.students = [];
      this.status = error.status === 401 || error.status === 403 ? 'guest' : 'error';
    }
    return true;
  }
  async resolve(billId) {
    if (typeof billId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(billId)) throw new Error('Invalid student bill.');
    const data = await this.request(`/api/friend-bills/${encodeURIComponent(billId)}`);
    const student = validateFriendStudent(data?.student);
    if (!student || student.billId !== billId) throw new Error('Student bill is no longer available.');
    return student;
  }
  renderForm() {
    return `<div class="friend-entry-wrap"><section class="deposit-entry-card friend-entry-card" aria-labelledby="friend-entry-title">
      <h2 id="friend-entry-title">For friend</h2>
      <form id="friend-username-form">
        <label for="friend-username">Username</label>
        <div class="friend-username-field"><span aria-hidden="true">@</span><input id="friend-username" name="username" type="text" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="31" pattern="@?[A-Za-z0-9_.]{3,30}" required placeholder="username" value="${escapeFriendHTML(this.query)}" aria-describedby="friend-entry-note" /></div>
        <button class="deposit-entry-submit" type="submit">Continue to Pay</button>
        <p id="friend-entry-note">Select an eligible student bill. No payment will be sent.</p>
      </form>
    </section><dialog class="friend-student-dialog" id="friend-student-dialog" aria-labelledby="friend-picker-title" aria-describedby="friend-picker-note"></dialog></div>`;
  }
  renderPicker() {
    let content;
    if (this.status === 'loading') content = '<p class="friend-picker-message" role="status">Loading eligible students…</p>';
    else if (this.status === 'guest') content = '<p class="friend-picker-message" role="status">Sign in to look up eligible student bills.</p>';
    else if (this.status === 'error') content = '<p class="friend-picker-message" role="status">Student bills could not be loaded. Please close this card and try again.</p>';
    else if (!this.students.length) content = '<p class="friend-picker-message" role="status">No eligible students with an amount due are available.</p>';
    else {
      const student = this.selected;
      content = `<fieldset class="friend-username-options"><legend>Available students</legend>${this.students.map(item => `<button type="button" data-friend-student="${escapeFriendHTML(item.billId)}" aria-pressed="${item.billId === this.selectedBillId}">@${escapeFriendHTML(item.username)}</button>`).join('')}</fieldset>`;
      content += student ? `<section class="friend-selected-student" aria-label="Selected student bill"><span class="friend-student-avatar"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 22v-2a8 8 0 0 1 16 0v2"/></svg><img class="friend-student-photo" src="${escapeFriendHTML(student.photoURL)}" alt="${escapeFriendHTML(`${student.firstName} ${student.lastName}`)} profile photo" /></span><h3>${escapeFriendHTML(student.firstName)} ${escapeFriendHTML(student.lastName)}</h3><p class="friend-due-label">Amount due</p><p class="friend-due-amount">${escapeFriendHTML(student.amountDue)} <small>ETB</small></p></section>` : '<p class="friend-picker-message">Select a username to review the student’s bill.</p>';
    }
    return `<button class="friend-picker-close" type="button" data-close-friend-picker aria-label="Close student selection">${icon('close')}</button><h2 id="friend-picker-title">Choose a student</h2>${content}${this.notice ? `<p class="friend-picker-message" role="status">${escapeFriendHTML(this.notice)}</p>` : ''}<button class="friend-confirm" type="button" data-confirm-friend ${this.status !== 'ready' || !this.selected ? 'disabled aria-disabled="true"' : ''}>Confirm</button><p class="friend-picker-note" id="friend-picker-note">Visual preview only · Pay is disabled. No payment will be sent.</p>`;
  }
}
