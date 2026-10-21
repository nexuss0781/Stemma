type Student = { id: string; name: string };
type AttendanceState = { students: Student[]; presentIds: string[]; date: string };
type Operation = "load" | "save" | null;

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
  dateInput.disabled = value;
  openImportButton.disabled = value;
  emptyImportButton.disabled = value;
  roster.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((input) => {
    input.disabled = value;
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
  selectAll.disabled = busy;
  selectAll.addEventListener("change", () => {
    if (busy) return;
    state.presentIds = selectAll.checked ? students.map((student) => student.id) : [];
    render();
    void saveAttendance();
  });
  const selectAllLabel = document.createElement("label");
  selectAllLabel.htmlFor = selectAll.id;
  selectAllLabel.textContent = "All students";
  selectAllRow.append(selectAll, selectAllLabel);
  roster.append(selectAllRow);

  for (const student of students) {
    const row = document.createElement("label");
    row.className = "student-row";
    const checkbox = document.createElement("input");
    checkbox.className = "student-check";
    checkbox.type = "checkbox";
    checkbox.checked = present.has(student.id);
    checkbox.dataset.studentId = student.id;
    checkbox.disabled = busy;
    checkbox.setAttribute("aria-label", `Present: ${student.name}`);
    checkbox.addEventListener("change", () => {
      if (busy) return;
      const next = new Set(state.presentIds);
      if (checkbox.checked) next.add(student.id);
      else next.delete(student.id);
      state.presentIds = [...next];
      render();
      void saveAttendance();
    });
    const name = document.createElement("span");
    name.className = "student-name";
    name.textContent = student.name;
    const presentText = document.createElement("span");
    presentText.className = "present-label";
    presentText.textContent = present.has(student.id) ? "Present" : "";
    row.append(checkbox, name, presentText);
    roster.append(row);
  }

  if (activeStudentId !== undefined) {
    Array.from(roster.querySelectorAll<HTMLInputElement>(".student-check"))
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

async function loadDate(date: string): Promise<void> {
  if (busy) return;
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
  if (busy) return;
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
    render();
    setStatus("saved", "Saved");
  } catch (error) {
    displayRequestError(error, "save");
  } finally {
    setBusy(false);
    retryButton.disabled = false;
    render();
    if (focusedStudentId !== undefined) {
      Array.from(roster.querySelectorAll<HTMLInputElement>(".student-check"))
        .find((input) => input.dataset.studentId === focusedStudentId)?.focus();
    } else if (focusSelectAll) {
      roster.querySelector<HTMLInputElement>(".select-all-check")?.focus();
    }
  }
}

function openDialog(): void {
  if (busy || dialog.open) return;
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
    render();
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
  if (text.trim().length === 0) {
    showImportError("Enter at least one student name.");
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

dateInput.value = localISODate();
render();
void loadDate(dateInput.value);
