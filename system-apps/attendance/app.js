"use strict";
const API = "/api/system-apps/attendance";
const dateInput = document.querySelector("#attendance-date");
const roster = document.querySelector("#roster");
const emptyState = document.querySelector("#empty-state");
const presentCount = document.querySelector("#present-count");
const studentCount = document.querySelector("#student-count");
const progressRing = document.querySelector("#progress-ring");
const statusLine = document.querySelector("#status-line");
const statusMessage = document.querySelector("#status-message");
const retryButton = document.querySelector("#retry-button");
const signInLink = document.querySelector("#sign-in-link");
const dialog = document.querySelector("#import-dialog");
const importForm = document.querySelector("#import-form");
const studentListInput = document.querySelector("#student-list");
const importError = document.querySelector("#import-error");
const submitImport = document.querySelector("#submit-import");
const closeImportButton = document.querySelector("#close-import");
const cancelImportButton = document.querySelector("#cancel-import");
const openImportButton = document.querySelector("#open-import");
const emptyImportButton = document.querySelector("#empty-import");
const saveButton = document.querySelector("#save-attendance");
const viewReportButton = document.querySelector("#view-report");
const reportView = document.querySelector("#report-view");
const closeReportButton = document.querySelector("#close-report");
const exportPDFButton = document.querySelector("#export-pdf");
const saveToast = document.querySelector("#save-toast");
const appShell = document.querySelector(".app-shell");
let dirty = false;
let savedPresentIds = [];
let loaded = false;
let toastTimer;
let state = { students: [], presentIds: [], date: "" };
let busy = false;
let retryOperation = null;
let authFailure = false;
let dialogReturnFocus = null;
function localISODate(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
function setBusy(value) {
    busy = value;
    saveButton.disabled = value || !loaded || !dirty;
    viewReportButton.disabled = value || !loaded;
    dateInput.disabled = value;
    openImportButton.disabled = value;
    emptyImportButton.disabled = value;
    roster.querySelectorAll("input[type=checkbox]").forEach((input) => {
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
function setStatus(kind, message = "", retry = null, requireAuth = false) {
    statusLine.hidden = kind === null;
    statusLine.dataset.kind = kind ?? "";
    statusMessage.textContent = message;
    retryOperation = retry;
    authFailure = requireAuth;
    retryButton.hidden = retry === null;
    signInLink.hidden = !requireAuth;
    retryButton.disabled = busy;
}
function showImportError(message, requireAuth = false) {
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
function clearImportError() {
    importError.replaceChildren();
    importError.hidden = true;
}
function parseState(value, expectedDate) {
    if (typeof value !== "object" || value === null)
        throw new Error("The server returned an invalid attendance record.");
    const response = value;
    if (response.date !== expectedDate || !Array.isArray(response.students) || !Array.isArray(response.presentIds)) {
        throw new Error("The attendance response did not match the selected date. Please try again.");
    }
    const students = [];
    const knownIds = new Set();
    for (const item of response.students) {
        if (typeof item !== "object" || item === null)
            throw new Error("The server returned an invalid student record.");
        const student = item;
        if (typeof student.id !== "string" || typeof student.name !== "string") {
            throw new Error("The server returned an invalid student record.");
        }
        if (knownIds.has(student.id))
            continue;
        knownIds.add(student.id);
        students.push({ id: student.id, name: student.name });
    }
    const presentIds = response.presentIds.filter((id) => typeof id === "string" && knownIds.has(id));
    return { students, presentIds: [...new Set(presentIds)], date: expectedDate };
}
async function requestState(url, init, expectedDate) {
    let response;
    try {
        response = await fetch(url, { ...init, credentials: "same-origin", headers: { Accept: "application/json", ...init.headers } });
    }
    catch {
        throw new Error("Could not reach attendance. Check your connection and try again.");
    }
    if (response.status === 401 || response.status === 403) {
        throw new Error("Your session has expired. Sign in to continue.");
    }
    if (!response.ok) {
        throw new Error(response.status >= 500 ? "Attendance is temporarily unavailable. Please try again." : "Could not update attendance. Please try again.");
    }
    let payload;
    try {
        payload = await response.json();
    }
    catch {
        throw new Error("The attendance response could not be read. Please try again.");
    }
    return parseState(payload, expectedDate);
}
function render() {
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
    if (students.length === 0)
        return;
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
        if (busy)
            return;
        state.presentIds = selectAll.checked ? students.map((student) => student.id) : [];
        render();
        markDirty();
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
            if (busy)
                return;
            const next = new Set(state.presentIds);
            if (checkbox.checked)
                next.add(student.id);
            else
                next.delete(student.id);
            state.presentIds = [...next];
            render();
            markDirty();
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
        Array.from(roster.querySelectorAll(".student-check"))
            .find((input) => input.dataset.studentId === activeStudentId)?.focus();
    }
    else if (activeSelectAll) {
        roster.querySelector(".select-all-check")?.focus();
    }
}
function displayRequestError(error, action) {
    const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
    const needsAuth = message.startsWith("Your session has expired");
    if (action === "import") {
        showImportError(needsAuth ? "Your session has expired." : message, needsAuth);
    }
    setStatus("error", message, action === "import" ? null : action, needsAuth);
}
function markDirty() {
    const saved = new Set(savedPresentIds);
    dirty = state.presentIds.length !== saved.size || state.presentIds.some((id) => !saved.has(id));
    saveToast.hidden = true;
    saveButton.disabled = busy || !loaded || !dirty;
    setStatus("saved", dirty ? "Unsaved changes — click Save to keep them." : "No unsaved changes");
    statusLine.dataset.kind = dirty ? "unsaved" : "saved";
}
function showSavedToast() {
    window.clearTimeout(toastTimer);
    saveToast.hidden = false;
    toastTimer = window.setTimeout(() => { saveToast.hidden = true; }, 2800);
}
async function loadDate(date) {
    if (busy)
        return;
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
    }
    catch (error) {
        displayRequestError(error, "load");
    }
    finally {
        setBusy(false);
        retryButton.disabled = false;
        if (restoreDateFocus)
            dateInput.focus();
    }
}
async function saveAttendance() {
    if (busy || !loaded || !dirty)
        return;
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
        render();
        dirty = false;
        setStatus("saved", "Saved");
        showSavedToast();
    }
    catch (error) {
        displayRequestError(error, "save");
    }
    finally {
        setBusy(false);
        retryButton.disabled = false;
        render();
        if (focusedStudentId !== undefined) {
            Array.from(roster.querySelectorAll(".student-check"))
                .find((input) => input.dataset.studentId === focusedStudentId)?.focus();
        }
        else if (focusSelectAll) {
            roster.querySelector(".select-all-check")?.focus();
        }
    }
}
function openDialog() {
    if (busy || dialog.open)
        return;
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
function closeDialog() {
    if (busy || !dialog.open)
        return;
    dialog.close();
}
async function importStudents(text) {
    if (busy)
        return;
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
        savedPresentIds = [...next.presentIds];
        render();
        loaded = true;
        setStatus("saved", "Students imported");
        studentListInput.value = "";
        dialog.close();
        dialogReturnFocus?.focus();
    }
    catch (error) {
        displayRequestError(error, "import");
    }
    finally {
        setBusy(false);
        if (!dialog.open && dialogReturnFocus?.isConnected)
            dialogReturnFocus.focus();
    }
}
openImportButton.addEventListener("click", openDialog);
emptyImportButton.addEventListener("click", openDialog);
closeImportButton.addEventListener("click", closeDialog);
cancelImportButton.addEventListener("click", closeDialog);
dialog.addEventListener("cancel", (event) => {
    if (busy)
        event.preventDefault();
});
dialog.addEventListener("close", () => {
    if (dialogReturnFocus?.isConnected)
        dialogReturnFocus.focus();
});
dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab")
        return;
    const focusable = Array.from(dialog.querySelectorAll("button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href]:not([hidden])"))
        .filter((element) => !element.hasAttribute("hidden"));
    if (focusable.length === 0)
        return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    }
    else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
});
importForm.addEventListener("submit", (event) => {
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
    if (busy)
        return;
    if (retryOperation === "load")
        void loadDate(dateInput.value);
    else if (retryOperation === "save")
        void saveAttendance();
});
dateInput.addEventListener("change", () => {
    if (dateInput.value)
        void loadDate(dateInput.value);
    else
        dateInput.value = state.date || localISODate();
});
dateInput.value = localISODate();
render();
void loadDate(dateInput.value);
function reportText(id, text) {
    document.getElementById(id).textContent = text;
}
function renderReport() {
    const total = state.students.length;
    const present = new Set(state.presentIds);
    const count = state.students.filter((student) => present.has(student.id)).length;
    const date = new Date(`${state.date}T12:00:00`);
    reportText("report-date", date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }));
    reportText("report-total", String(total));
    reportText("report-present", String(count));
    reportText("report-unmarked", String(total - count));
    reportText("report-rate", total ? `${Math.round(count / total * 100)}%` : "—");
    reportText("report-record-label", dirty ? "Unsaved draft" : "Saved attendance");
    document.getElementById("report-draft").hidden = !dirty;
    exportPDFButton.disabled = dirty || !loaded;
    const rows = document.getElementById("report-rows");
    rows.replaceChildren();
    state.students.forEach((student, index) => {
        const row = document.createElement("tr");
        const number = document.createElement("td");
        number.textContent = String(index + 1).padStart(2, "0");
        const name = document.createElement("td");
        name.textContent = student.name;
        const status = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = present.has(student.id) ? "attendance-badge is-present" : "attendance-badge";
        badge.textContent = present.has(student.id) ? "Present" : "Not marked";
        status.append(badge);
        row.append(number, name, status);
        rows.append(row);
    });
    document.getElementById("report-empty").hidden = total > 0;
}
saveButton.addEventListener("click", () => { void saveAttendance(); });
viewReportButton.addEventListener("click", () => {
    if (busy || !loaded)
        return;
    renderReport();
    reportView.hidden = false;
    appShell.hidden = true;
    document.title = `Roll — Attendance report — ${state.date}`;
    window.scrollTo(0, 0);
    closeReportButton.focus();
});
function closeReport() {
    reportView.hidden = true;
    appShell.hidden = false;
    document.title = "Teacher Attendance";
    viewReportButton.focus();
}
closeReportButton.addEventListener("click", closeReport);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !reportView.hidden)
        closeReport();
});
exportPDFButton.addEventListener("click", () => {
    if (dirty || !loaded || reportView.hidden)
        return;
    window.print();
});
window.addEventListener("beforeunload", (event) => {
    if (!dirty)
        return;
    event.preventDefault();
    event.returnValue = "";
});
