import rateLimit from 'express-rate-limit';

const BILL_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const USERNAME_RE = /^[A-Za-z0-9_.]{3,30}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]{0,8})\.[0-9]{2}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_SOURCE_SCAN = 20;
const MAX_RESULTS = 10;

function setPrivateNoStore(res) {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer'
  });
}

function normalizedPrefix(value) {
  if (typeof value !== 'string') return null;
  const prefix = value.startsWith('@') ? value.slice(1) : value;
  return USERNAME_RE.test(prefix) ? prefix : null;
}

function validMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : '';
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

function validBill(record, requesterSubject) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      typeof record.billId !== 'string' || !BILL_ID_RE.test(record.billId) ||
      typeof record.subject !== 'string' || !record.subject || record.subject.length > 256 || CONTROL_RE.test(record.subject) ||
      record.subject === requesterSubject || record.eligible !== true ||
      typeof record.amountDue !== 'string' || !AMOUNT_RE.test(record.amountDue) || Number(record.amountDue) <= 0 ||
      record.currency !== 'ETB') return false;
  return true;
}

function validName(value) {
  if (typeof value !== 'string' || CONTROL_RE.test(value)) return '';
  const trimmed = value.trim();
  return trimmed && [...trimmed].length <= 80 ? trimmed : '';
}

async function studentDto({ record, requesterSubject, studentProfileStore, validateProfileImage, prefix }) {
  if (!validBill(record, requesterSubject)) return null;
  const profile = await studentProfileStore.getStudentProfile(record.subject);
  if (!profile || typeof profile !== 'object') return null;
  const username = typeof profile.username === 'string' ? profile.username.trim() : '';
  const firstName = validName(profile.firstName);
  const lastName = validName(profile.lastName);
  if (!USERNAME_RE.test(username) || !firstName || !lastName ||
      (prefix && !username.toLowerCase().startsWith(prefix.toLowerCase()))) return null;
  return {
    billId: record.billId,
    username,
    firstName,
    lastName,
    amountDue: record.amountDue,
    currency: 'ETB',
    photoURL: `/api/friend-bills/${encodeURIComponent(record.billId)}/photo`,
    month: validMonth(record.month),
    dueDate: validDate(record.dueDate)
  };
}

function sendUnavailable(res) {
  return res.status(503).json({ error: 'Friend bill service is unavailable.' });
}

export function registerFriendBillsApi(app, {
  requireGoogleSession,
  studentProfileStore,
  friendBillStore = null,
  validateProfileImage
}) {
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      setPrivateNoStore(res);
      res.status(429).json({ error: 'Too many friend-bill requests. Please wait and try again.' });
    }
  });
  const secure = (req, res, next) => {
    setPrivateNoStore(res);
    return limiter(req, res, next);
  };
  const authenticate = (req, res, next) => requireGoogleSession(req, res, error => {
    if (error) return next(error);
    setPrivateNoStore(res);
    return next();
  });
  const auth = [secure, authenticate];

  app.get('/api/friend-bills', ...auth, async (req, res) => {
    const query = req.query?.username;
    const prefix = normalizedPrefix(query);
    if (prefix === null) return res.status(400).json({ error: 'A valid username prefix is required.' });
    if (!friendBillStore) return res.status(200).json({ students: [], unavailable: true });
    if (!studentProfileStore || typeof studentProfileStore.getStudentProfile !== 'function') return sendUnavailable(res);
    try {
      const records = await friendBillStore.searchEligibleBills({
        requesterSubject: req.session.stemmaUser.subject,
        username: prefix,
        limit: MAX_RESULTS
      });
      if (!Array.isArray(records)) return sendUnavailable(res);
      const students = [];
      for (const record of records.slice(0, MAX_SOURCE_SCAN)) {
        if (!validBill(record, req.session.stemmaUser.subject)) continue;
        const student = await studentDto({
          record,
          requesterSubject: req.session.stemmaUser.subject,
          studentProfileStore,
          validateProfileImage,
          prefix
        });
        if (student) students.push(student);
        if (students.length >= MAX_RESULTS) break;
      }
      return res.status(200).json({ students, unavailable: false });
    } catch {
      return sendUnavailable(res);
    }
  });

  async function getAuthorizedRecord(req, res) {
    const billId = req.params.billId;
    if (typeof billId !== 'string' || !BILL_ID_RE.test(billId)) {
      res.status(400).json({ error: 'A valid bill ID is required.' });
      return null;
    }
    if (!friendBillStore || typeof friendBillStore.getEligibleBill !== 'function') {
      res.status(404).json({ error: 'Friend bill not found.' });
      return null;
    }
    try {
      const record = await friendBillStore.getEligibleBill({
        requesterSubject: req.session.stemmaUser.subject,
        billId
      });
      if (!record || record.billId !== billId || !validBill(record, req.session.stemmaUser.subject)) {
        res.status(404).json({ error: 'Friend bill not found.' });
        return null;
      }
      return record;
    } catch {
      sendUnavailable(res);
      return null;
    }
  }

  app.get('/api/friend-bills/:billId/photo', ...auth, async (req, res) => {
    const record = await getAuthorizedRecord(req, res);
    if (!record) return;
    if (!studentProfileStore || typeof studentProfileStore.getStudentPhoto !== 'function') return sendUnavailable(res);
    try {
      const photo = await studentProfileStore.getStudentPhoto(record.subject);
      if (!photo || !Buffer.isBuffer(photo.data)) return res.status(404).json({ error: 'Friend photo not found.' });
      const validated = validateProfileImage(photo.data, photo.mimeType);
      if (!validated) return res.status(404).json({ error: 'Friend photo not found.' });
      res.set({
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': validated.mimeType
      });
      return res.status(200).send(validated.data);
    } catch {
      return sendUnavailable(res);
    }
  });

  app.get('/api/friend-bills/:billId', ...auth, async (req, res) => {
    const record = await getAuthorizedRecord(req, res);
    if (!record) return;
    if (!studentProfileStore || typeof studentProfileStore.getStudentProfile !== 'function') return sendUnavailable(res);
    try {
      const student = await studentDto({
        record,
        requesterSubject: req.session.stemmaUser.subject,
        studentProfileStore,
        validateProfileImage
      });
      if (!student) return res.status(404).json({ error: 'Friend bill not found.' });
      return res.status(200).json({ student });
    } catch {
      return sendUnavailable(res);
    }
  });
}
