type Student = { id: string; name: string };
type AttendanceState = { students: Student[]; presentIds: string[]; date: string };
type Operation = "load" | "save" | null;

type MonthState = { month: string; students: Student[]; days: { date: string; presentIds: string[] }[] };
const monthInput = document.querySelector<HTMLSelectElement>("#attendance-month")!;
const monthlyGrid = document.querySelector<HTMLTableElement>("#monthly-grid")!;
const gridWrap = document.querySelector<HTMLElement>("#monthly-grid-wrap")!;
let monthState: MonthState = { month: "", students: [], days: [] };
let monthLoaded = false;

const API = "/api/system-apps/attendance";
const dateInput = document.querySelector<HTMLInputElement>("#attendance-date")!;
const roster = document.querySelector<HTMLDivElement>("#roster")!;
const emptyState = document.querySelector<HTMLElement>("#empty-state")!;
const presentCount = document.querySelector<HTMLElement>("#present-count")!;
const studentCount = document.querySelector<HTMLElement>("#student-count")!;
const progressRing = document.querySelector<HTMLElement>("#progress-ring")!;
const statusLine = document.querySelector<HTMLElement>("#status-line")!;
const statusMessage = document.querySelector<HTMLElement>("#status-message")!;
const retryButton = document.querySelector<HTMLButtonElement>("#retry-button")!;
const signInLink = document.querySelector<HTMLAnchorElement>("#sign-in-link")!;
const dialog = document.querySelector<HTMLDialogElement>("#import-dialog")!;
const importForm = document.querySelector<HTMLFormElement>("#import-form")!;
const studentListInput = document.querySelector<HTMLTextAreaElement>("#student-list")!;
const importError = document.querySelector<HTMLElement>("#import-error")!;
const submitImport = document.querySelector<HTMLButtonElement>("#submit-import")!;
const closeImportButton = document.querySelector<HTMLButtonElement>("#close-import")!;
const cancelImportButton = document.querySelector<HTMLButtonElement>("#cancel-import")!;
const openImportButton = document.querySelector<HTMLButtonElement>("#open-import")!;
const emptyImportButton = document.querySelector<HTMLButtonElement>("#empty-import")!;

const saveButton = document.querySelector<HTMLButtonElement>("#save-attendance")!;
const viewReportButton = document.querySelector<HTMLButtonElement>("#view-report")!;
const reportView = document.querySelector<HTMLElement>("#report-view")!;
const closeReportButton = document.querySelector<HTMLButtonElement>("#close-report")!;
const exportPDFButton = document.querySelector<HTMLButtonElement>("#export-pdf")!;
const saveToast = document.querySelector<HTMLElement>("#save-toast")!;
const appShell = document.querySelector<HTMLElement>(".app-shell")!;
let dirty = false;
let savedPresentIds: string[] = [];
let loaded = false;
let toastTimer: number | undefined;

let state: AttendanceState = { students: [], presentIds: [], date: "" };
let busy = false;
let retryOperation: Operation = null;
let authFailure = false;
let dialogReturnFocus: HTMLElement | null = null;

function localISODate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setBusy(value: boolean): void {
  busy = value;
  saveButton.disabled = value || !loaded || !dirty;
  viewReportButton.disabled = value || !loaded;
  dateInput.disabled = value;
  monthInput.disabled = value;
  openImportButton.disabled = value;
  emptyImportButton.disabled = value;
  document.querySelectorAll<HTMLInputElement>("#roster input[type=checkbox], #monthly-grid input[type=checkbox]").forEach((input) => {
    input.disabled = value || !loaded;
  });
  closeImportButton.disabled = value;
  cancelImportButton.disabled = value;
  submitImport.disabled = value;
  if (value) {
    retryButton.hidden = true;
    signInLink.hidden = true;
  }
}

function setStatus(
  kind: "loading" | "saving" | "saved" | "error" | null,
  message = "",
  retry: Operation = null,
  requireAuth = false,
): void {
  statusLine.hidden = kind === null;
  statusLine.dataset.kind = kind ?? "";
  statusMessage.textContent = message;
  retryOperation = retry;
  authFailure = requireAuth;
  retryButton.hidden = retry === null;
  signInLink.hidden = !requireAuth;
  retryButton.disabled = busy;
}

function showImportError(message: string, requireAuth = false): void {
  importError.replaceChildren(document.createTextNode(message));
  if (requireAuth) {
    importError.append(document.createTextNode(" "));
    const signIn = document.createElement("a");
    signIn.href = "/#apps";
    signIn.textContent = "Sign in";
    importError.append(signIn);
  }
  importError.hidden = false;
}

function clearImportError(): void {
  importError.replaceChildren();
  importError.hidden = true;
}

function parseState(value: unknown, expectedDate: string): AttendanceState {
  if (typeof value !== "object" || value === null) throw new Error("The server returned an invalid attendance record.");
  const response = value as Record<string, unknown>;
  if (response.date !== expectedDate || !Array.isArray(response.students) || !Array.isArray(response.presentIds)) {
    throw new Error("The attendance response did not match the selected date. Please try again.");
  }
  const students: Student[] = [];
  const knownIds = new Set<string>();
  for (const item of response.students) {
    if (typeof item !== "object" || item === null) throw new Error("The server returned an invalid student record.");
    const student = item as Record<string, unknown>;
    if (typeof student.id !== "string" || typeof student.name !== "string") {
      throw new Error("The server returned an invalid student record.");
    }
    if (knownIds.has(student.id)) continue;
    knownIds.add(student.id);
    students.push({ id: student.id, name: student.name });
  }
  const presentIds = response.presentIds.filter((id): id is string => typeof id === "string" && knownIds.has(id));
  return { students, presentIds: [...new Set(presentIds)], date: expectedDate };
}

async function requestState(url: string, init: RequestInit, expectedDate: string): Promise<AttendanceState> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "same-origin", headers: { Accept: "application/json", ...init.headers } });
  } catch {
    throw new Error("Could not reach attendance. Check your connection and try again.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("Your session has expired. Sign in to continue.");
  }
  if (!response.ok) {
    throw new Error(response.status >= 500 ? "Attendance is temporarily unavailable. Please try again." : "Could not update attendance. Please try again.");
  }
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch {
    throw new Error("The attendance response could not be read. Please try again.");
  }
  return parseState(payload, expectedDate);
}

function render(): void {
  const activeInput = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
  const activeStudentId = activeInput?.dataset.studentId;
  const activeSelectAll = activeInput?.classList.contains("select-all-check") ?? false;
  roster.replaceChildren();
  const students = state.students;
  const present = new Set(state.presentIds);
  const count = students.filter((student) => present.has(student.id)).length;
  presentCount.textContent = String(count);
  studentCount.textContent = String(students.length);
  const percentage = students.length === 0 ? 0 : Math.round((count / students.length) * 100);
  progressRing.style.setProperty("--progress", `${percentage}%`);
  emptyState.hidden = students.length > 0;
  roster.hidden = students.length === 0;

  if (students.length === 0) return;

  const selectAllRow = document.createElement("div");
  selectAllRow.className = "select-all-row";
  const selectAll = document.createElement("input");
  selectAll.className = "student-check select-all-check";
  selectAll.type = "checkbox";
  selectAll.id = "select-all-students";
  selectAll.checked = count === students.length;
  selectAll.indeterminate = count > 0 && count < students.length;
  selectAll.setAttribute("aria-label", "Mark all students present");
  selectAll.disabled = busy || !loaded;
  selectAll.addEventListener("change", () => {
    if (busy || !loaded) return;
    state.presentIds = selectAll.checked ? students.map((student) => student.id) : [];
    markDirty();
    render();
  });
  const selectAllLabel = document.createElement("label");
  selectAllLabel.htmlFor = selectAll.id;
  selectAllLabel.textContent = "All students";
  selectAllRow.append(selectAll, selectAllLabel);
  roster.append(selectAllRow);

  students.forEach(student => {
    const row = document.createElement("label"); row.className = "student-row";
    const input = document.createElement("input"); input.type = "checkbox"; input.className = "student-check"; input.dataset.studentId = student.id;
    input.setAttribute("aria-label", `Present: ${student.name}`); input.checked = present.has(student.id); input.disabled = busy || !loaded;
    input.addEventListener("change", () => {
      if (busy || !loaded) return;
      const next = new Set(state.presentIds);
      input.checked ? next.add(student.id) : next.delete(student.id);
      state.presentIds = [...next]; markDirty(); render();
    });
    const name = document.createElement("span"); name.className = "student-name"; name.textContent = student.name;
    const hint = document.createElement("span"); hint.className = "present-label"; hint.textContent = "Present";
    row.append(input, name, hint); roster.append(row);
  });

  if (activeStudentId !== undefined) {
    Array.from(document.querySelectorAll<HTMLInputElement>("#roster .student-check"))
      .find((input) => input.dataset.studentId === activeStudentId)?.focus();
  } else if (activeSelectAll) {
    roster.querySelector<HTMLInputElement>(".select-all-check")?.focus();
  }
}

function displayRequestError(error: unknown, action: "load" | "save" | "import"): void {
  const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  const needsAuth = message.startsWith("Your session has expired");
  if (action === "import") {
    showImportError(needsAuth ? "Your session has expired." : message, needsAuth);
  }
  setStatus("error", message, action === "import" ? null : action, needsAuth);
}

function markDirty(): void {
  const saved = new Set(savedPresentIds);
  dirty = state.presentIds.length !== saved.size || state.presentIds.some((id) => !saved.has(id));
  saveToast.hidden = true;
  saveButton.disabled = busy || !loaded || !dirty;
  setStatus("saved", dirty ? "Unsaved changes — click Save to keep them." : "No unsaved changes");
  statusLine.dataset.kind = dirty ? "unsaved" : "saved";
}

function showSavedToast(): void {
  window.clearTimeout(toastTimer);
  saveToast.hidden = false;
  toastTimer = window.setTimeout(() => { saveToast.hidden = true; }, 2800);
}

async function loadDate(date: string): Promise<void> {
  if (busy) return;
  if (dirty) {
    dateInput.value = state.date;
    setStatus("error", "Save your attendance changes before changing the date.");
    saveButton.focus();
    return;
  }
  loaded = false;
  saveToast.hidden = true;
  const restoreDateFocus = document.activeElement === dateInput;
  setBusy(true);
  if (state.date !== date) {
    state = { students: [], presentIds: [], date };
    render();
  }
  setStatus("loading", "Loading attendance…");
  try {
    const next = await requestState(`${API}?date=${encodeURIComponent(date)}`, { method: "GET" }, date);
    state = next;
    savedPresentIds = [...next.presentIds];
    loaded = true;
    render();
    setStatus("saved", "Attendance loaded");
  } catch (error) {
    displayRequestError(error, "load");
  } finally {
    setBusy(false);
    retryButton.disabled = false;
    if (restoreDateFocus) dateInput.focus();
  }
}

async function saveAttendance(): Promise<void> {
  if (busy || !loaded || !dirty) return;
  const focusedInput = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
  const focusedStudentId = focusedInput?.dataset.studentId;
  const focusSelectAll = focusedInput?.classList.contains("select-all-check") ?? false;
  const date = state.date;
  const snapshot = [...state.presentIds];
  setBusy(true);
  setStatus("saving", "Saving…");
  try {
    const next = await requestState(API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, presentIds: snapshot }),
    }, date);
    state = next;
    savedPresentIds = [...next.presentIds];
    monthLoaded = false;
    dirty = false;
    render();
    setStatus("saved", "Saved");
    showSavedToast();
  } catch (error) {
    displayRequestError(error, "save");
  } finally {
    setBusy(false);
    retryButton.disabled = false;
    render();
    if (focusedStudentId !== undefined) {
      Array.from(document.querySelectorAll<HTMLInputElement>("#roster .student-check"))
        .find((input) => input.dataset.studentId === focusedStudentId)?.focus();
    } else if (focusSelectAll) {
      roster.querySelector<HTMLInputElement>(".select-all-check")?.focus();
    }
  }
}

function openDialog(): void {
  if (busy || dialog.open) return;
  if (dirty) {
    setStatus("error", "Save your attendance changes before importing students.");
    saveButton.focus();
    return;
  }
  dialogReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : openImportButton;
  clearImportError();
  dialog.showModal();
  window.requestAnimationFrame(() => studentListInput.focus());
}

function closeDialog(): void {
  if (busy || !dialog.open) return;
  dialog.close();
}

async function importStudents(text: string): Promise<void> {
  if (busy) return;
  setBusy(true);
  clearImportError();
  setStatus("saving", "Importing students…");
  try {
    const date = dateInput.value;
    const next = await requestState(`${API}/import?date=${encodeURIComponent(date)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }, date);
    state = next;
    monthLoaded = false;
    savedPresentIds = [...next.presentIds];
    render();
    loaded = true;
    setStatus("saved", "Students imported");
    studentListInput.value = "";
    dialog.close();
    dialogReturnFocus?.focus();
  } catch (error) {
    displayRequestError(error, "import");
  } finally {
    setBusy(false);
    if (!dialog.open && dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
  }
}

openImportButton.addEventListener("click", openDialog);
emptyImportButton.addEventListener("click", openDialog);
closeImportButton.addEventListener("click", closeDialog);
cancelImportButton.addEventListener("click", closeDialog);
dialog.addEventListener("cancel", (event: Event) => {
  if (busy) event.preventDefault();
});
dialog.addEventListener("close", () => {
  if (dialogReturnFocus?.isConnected) dialogReturnFocus.focus();
});
dialog.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key !== "Tab") return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href]:not([hidden])"))
    .filter((element) => !element.hasAttribute("hidden"));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
importForm.addEventListener("submit", (event: SubmitEvent) => {
  event.preventDefault();
  const text = studentListInput.value;
  if (!text.split(/\r?\n/u).some((line) => /^\s*-\s+\S/u.test(line))) {
    showImportError("Add at least one student on a line beginning with a hyphen (-) and a space.");
    studentListInput.focus();
    return;
  }
  void importStudents(text);
});
studentListInput.addEventListener("input", clearImportError);
retryButton.addEventListener("click", () => {
  if (busy) return;
  if (retryOperation === "load") void loadDate(dateInput.value);
  else if (retryOperation === "save") void saveAttendance();
});
dateInput.addEventListener("change", () => {
  if (dateInput.value) void loadDate(dateInput.value);
  else dateInput.value = state.date || localISODate();
});

function monthLabel(month: string): string {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function monthDates(month: string): string[] {
  if (!month) return [];
  const [year, number] = month.split("-").map(Number);
  const count = new Date(year, number, 0).getDate();
  return Array.from({ length: count }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
}
function selectMonth(month: string): void {
  const year = month.slice(0, 4);
  monthInput.replaceChildren();
  for (let index = 1; index <= 12; index++) {
    const value = `${year}-${String(index).padStart(2, "0")}`;
    const option = document.createElement("option"); option.value = value; option.textContent = monthLabel(value); monthInput.append(option);
  }
  monthInput.value = month;
}
function cellStatus(id: string, date: string): "present" | "unmarked" | "neutral" | "unknown" {
  const saved = monthState.days.find(day => day.date === date);
  const ids = saved?.presentIds;
  if (ids?.includes(id)) return "present";
  // A missing snapshot is unknown, not an invented absence or a no-class day.
  return saved?.presentIds.length ? "unmarked" : saved ? "neutral" : "unknown";
}
function renderMonthGrid(): void {
  monthlyGrid.replaceChildren();
  if (!monthLoaded || !monthState.students.length) return;
  const dates = monthDates(monthState.month);
  const thead = document.createElement("thead"); const header = document.createElement("tr");
  const names = document.createElement("th"); names.scope = "col"; names.textContent = "Student"; header.append(names);
  dates.forEach(date => {
    const th = document.createElement("th"); th.scope = "col"; th.dataset.date = date;
    th.append(document.createTextNode(String(Number(date.slice(-2)))));
    const weekday = document.createElement("small"); weekday.textContent = new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1); th.append(weekday);
    if (date === localISODate()) th.classList.add("today"); header.append(th);
  });
  thead.append(header); monthlyGrid.append(thead);
  const body = document.createElement("tbody");
  monthState.students.forEach(student => {
    const row = document.createElement("tr"); const name = document.createElement("th"); name.scope = "row"; name.textContent = student.name; row.append(name);
    dates.forEach(date => {
      const cell = document.createElement("td"); const status = cellStatus(student.id, date); cell.className = `day-cell is-${status}`;
      const marker = document.createElement("span"); marker.className = "day-marker";
      marker.textContent = status === "present" ? "P" : status === "unmarked" ? "–" : status === "neutral" ? "·" : "?";
      marker.setAttribute("role", "img"); marker.setAttribute("aria-label", `${student.name}, ${date}: ${status === "unknown" ? "No record" : status === "neutral" ? "No saved present marks" : status === "present" ? "Present" : "Not marked on a date with saved presence"}`);
      marker.title = marker.getAttribute("aria-label")!; cell.append(marker); row.append(cell);
    }); body.append(row);
  }); monthlyGrid.append(body);
}
function scrollToCurrentWeek(): void {
  gridWrap.scrollLeft = 0;
  if (monthState.month !== localISODate().slice(0, 7)) return;
  const today = new Date();
  const monday = Math.max(1, today.getDate() - (today.getDay() + 6) % 7);
  const day = monthlyGrid.querySelector<HTMLElement>(`[data-date="${monthState.month}-${String(monday).padStart(2, "0")}"]`);
  const nameWidth = monthlyGrid.querySelector("th")?.getBoundingClientRect().width ?? 120;
  if (day) gridWrap.scrollLeft = Math.max(0, day.offsetLeft - nameWidth);
}
async function loadMonth(month: string): Promise<void> {
  if (busy) return;
  monthLoaded = false;
  selectMonth(month);
  monthState = { month, students: [], days: [] };
  renderMonthGrid();
  document.getElementById("report-grid-sections")!.replaceChildren();
  document.getElementById("report-empty")!.hidden = true;
  setBusy(true);
  exportPDFButton.disabled = true;
  reportText("report-date", monthLabel(month));
  if (!reportView.hidden) document.title = `Roll — Monthly attendance — ${month}`;
  reportText("report-month-summary", "Loading month…");
  try {
    const response = await fetch(`${API}/month?month=${encodeURIComponent(month)}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (response.status === 401 || response.status === 403) throw new Error("Your session has expired. Return to attendance to sign in.");
    if (!response.ok) throw new Error("Could not load this month. Return to attendance and open View to retry.");
    const payload = await response.json() as MonthState;
    if (payload.month !== month || !Array.isArray(payload.days) || !Array.isArray(payload.students)) throw new Error("Invalid monthly report. Return to attendance and open View to retry.");
    monthState = payload;
    monthLoaded = true;
    renderReport();
    window.requestAnimationFrame(scrollToCurrentWeek);
  } catch (error) {
    reportText("report-month-summary", error instanceof Error ? error.message : "Could not load this month.");
  } finally { setBusy(false); }
}
monthInput.addEventListener("change", () => { void loadMonth(monthInput.value); });

dateInput.value = localISODate();
render();
void loadDate(dateInput.value);

function reportText(id: string, text: string): void {
  document.getElementById(id)!.textContent = text;
}

function renderReport(): void {
  reportText("report-date", monthLabel(monthState.month));
  reportText("report-month-summary", `${monthState.students.length} students · ${monthState.days.length} saved ${monthState.days.length === 1 ? "date" : "dates"} · Saved records only`);
  document.getElementById("report-draft")!.hidden = !dirty;
  exportPDFButton.disabled = dirty || !loaded || !monthLoaded;
  const sections = document.getElementById("report-grid-sections")!;
  sections.replaceChildren();
  renderMonthGrid();
  const dates = monthDates(monthState.month);
  // Split the wide grid into readable date bands; repeat every student in every band.
  for (let start = 0; start < dates.length; start += 11) {
    const band = dates.slice(start, start + 11);
    const section = document.createElement("section");
    section.className = "report-date-band";
    const heading = document.createElement("h2");
    heading.textContent = `${monthLabel(monthState.month)} · ${Number(band[0].slice(-2))}–${Number(band[band.length - 1].slice(-2))}`;
    const wrap = document.createElement("div"); wrap.className = "report-table-wrap";
    const table = document.createElement("table"); table.className = "report-table month-print-table";
    const head = document.createElement("thead"); const header = document.createElement("tr");
    const studentHeading = document.createElement("th"); studentHeading.scope = "col"; studentHeading.textContent = "Student name"; header.append(studentHeading);
    band.forEach(date => { const th = document.createElement("th"); th.scope = "col"; th.textContent = String(Number(date.slice(-2))); header.append(th); });
    head.append(header); table.append(head);
    const body = document.createElement("tbody");
    monthState.students.forEach(student => {
      const row = document.createElement("tr"); const name = document.createElement("th"); name.scope = "row"; name.textContent = student.name; row.append(name);
      band.forEach(date => { const cell = document.createElement("td"); const status = cellStatus(student.id, date); cell.textContent = status === "present" ? "P" : status === "unmarked" ? "–" : status === "neutral" ? "·" : "?"; cell.className = `print-${status}`; row.append(cell); });
      body.append(row);
    });
    table.append(body); wrap.append(table); section.append(heading, wrap); sections.append(section);
  }
  document.getElementById("report-empty")!.hidden = monthState.students.length > 0;
}

saveButton.addEventListener("click", () => { void saveAttendance(); });
viewReportButton.addEventListener("click", () => {
  if (busy || !loaded) return;
  saveToast.hidden = true;
  reportView.hidden = false;
  appShell.hidden = true;
  window.scrollTo(0, 0);
  closeReportButton.focus();
  void loadMonth(state.date.slice(0, 7));
});
function closeReport(): void {
  reportView.hidden = true;
  appShell.hidden = false;
  document.title = "Teacher Attendance";
  viewReportButton.focus();
}
closeReportButton.addEventListener("click", closeReport);
document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.key === "Escape" && !reportView.hidden) closeReport();
});
exportPDFButton.addEventListener("click", () => {
  if (dirty || !loaded || !monthLoaded || busy || reportView.hidden) return;
  window.print();
});
window.addEventListener("beforeunload", (event: BeforeUnloadEvent) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
