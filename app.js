"use strict";

const STORAGE_KEY = "mi-agenda.entries.v1";
const BACKUP_KEY = "mi-agenda.last-backup";
const MAX_ENTRIES = 5000;
const TYPE_LABELS = { event: "Evento", reminder: "Recordatorio", note: "Nota" };
const SAVED_LABELS = { event: "Evento guardado", reminder: "Recordatorio guardado", note: "Nota guardada" };
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MONTH_INDEX = Object.fromEntries(MONTHS.map((month, index) => [month, index]));
const SPANISH_NUMBERS = {
  una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28,
  veintinueve: 29, treinta: 30, treinta_y_uno: 31,
};
const NUMBER_TOKEN_PATTERN = "(?:\\d{1,2}|una?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte|veintiuno|veintidos|veintitres|veinticuatro|veinticinco|veintiseis|veintisiete|veintiocho|veintinueve|treinta(?:\\s+y\\s+uno)?)";

const state = {
  entries: loadEntries(),
  currentView: "home",
  selectedDate: toISODate(new Date()),
  calendarMonth: startOfMonth(new Date()),
  creationType: "event",
  captureMode: "voice",
  deleteId: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const entryDialog = $("#entry-dialog");
const backupDialog = $("#backup-dialog");
const confirmDialog = $("#confirm-dialog");

function safeEntries(value) {
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) return [];
  return value.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (!["event", "reminder", "note"].includes(entry.type)) return false;
    if (typeof entry.id !== "string" || typeof entry.title !== "string") return false;
    if (entry.title.length > 160 || String(entry.details || "").length > 2000) return false;
    if (entry.date && !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return false;
    if (entry.time && !/^\d{2}:\d{2}$/.test(entry.time)) return false;
    return true;
  }).map((entry) => ({
    id: entry.id,
    type: entry.type,
    title: entry.title.trim(),
    details: String(entry.details || "").trim(),
    date: entry.type === "note" ? "" : String(entry.date || ""),
    time: entry.type === "note" ? "" : String(entry.time || ""),
    annual: Boolean(entry.annual),
    completed: entry.type === "reminder" ? Boolean(entry.completed) : false,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
  })).filter((entry) => entry.title);
}

function loadEntries() {
  try {
    return safeEntries(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.entries));
}

function toISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromISODate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function normalizeText(text) {
  return text.toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function parseSpanishNumber(token) {
  const normalized = normalizeText(String(token)).trim().replace(/\s+y\s+/g, "_y_");
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return SPANISH_NUMBERS[normalized];
}

function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase("es") + text.slice(1) : "";
}

function formatDate(value, options = {}) {
  if (!value) return "Sin fecha";
  return new Intl.DateTimeFormat("es-ES", options).format(fromISODate(value));
}

function formatTime(value) {
  return value || "Todo el día";
}

function parseDateFromSpeech(raw) {
  const normalized = normalizeText(raw);
  const today = new Date();
  if (/\bpasado manana\b/.test(normalized)) return toISODate(addDays(today, 2));
  const morningTime = new RegExp(`\\ba\\s+las?\\s+${NUMBER_TOKEN_PATTERN}(?:[:.,]\\d{2})?(?:\\s*(?:h|horas))?\\s+(?:de\\s+la\\s+|por\\s+la\\s+)?manana\\b`).test(normalized);
  if (/\bmanana\b/.test(normalized) && !morningTime) return toISODate(addDays(today, 1));
  if (/\bhoy\b/.test(normalized)) return toISODate(today);

  const weekdayNames = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
  for (let index = 0; index < weekdayNames.length; index += 1) {
    if (new RegExp(`\\b(?:el\\s+)?${weekdayNames[index]}\\b`).test(normalized)) {
      let distance = (index - today.getDay() + 7) % 7;
      if (distance === 0 && !normalized.includes("hoy")) distance = 7;
      return toISODate(addDays(today, distance));
    }
  }

  const monthPattern = MONTHS.join("|");
  const namedDate = normalized.match(new RegExp(`\\b(?:el\\s+)?(${NUMBER_TOKEN_PATTERN})\\s+de\\s+(${monthPattern})(?:\\s+de\\s+(\\d{4}))?\\b`));
  if (namedDate) {
    const day = parseSpanishNumber(namedDate[1]);
    const month = MONTH_INDEX[namedDate[2]];
    let year = namedDate[3] ? Number(namedDate[3]) : today.getFullYear();
    const candidate = new Date(year, month, day);
    if (!namedDate[3] && candidate < new Date(today.getFullYear(), today.getMonth(), today.getDate())) year += 1;
    const verified = new Date(year, month, day);
    if (verified.getMonth() === month && verified.getDate() === day) return toISODate(verified);
  }

  const numericDate = normalized.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (numericDate) {
    const day = Number(numericDate[1]);
    const month = Number(numericDate[2]) - 1;
    let year = numericDate[3] ? Number(numericDate[3]) : today.getFullYear();
    if (year < 100) year += 2000;
    const candidate = new Date(year, month, day);
    if (!numericDate[3] && candidate < new Date(today.getFullYear(), today.getMonth(), today.getDate())) candidate.setFullYear(year + 1);
    if (candidate.getMonth() === month && candidate.getDate() === day) return toISODate(candidate);
  }
  return "";
}

function parseTimeFromSpeech(raw) {
  const normalized = normalizeText(raw);
  const match = normalized.match(new RegExp(`\\ba\\s+las?\\s+(${NUMBER_TOKEN_PATTERN})(?:[:.,](\\d{2}))?(?:\\s*(?:h|horas))?(?:\\s+(?:de\\s+la\\s+|por\\s+la\\s+)?(manana|tarde|noche|madrugada))?\\b`));
  if (!match) return "";
  let hour = parseSpanishNumber(match[1]);
  const minute = Number(match[2] || 0);
  const period = match[3] || "";
  if ((period === "tarde" || period === "noche") && hour < 12) hour += 12;
  if (period === "manana" && hour === 12) hour = 0;
  if (period === "madrugada" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function cleanSpokenTitle(raw) {
  let title = raw.trim();
  const patterns = [
    /\bpasado mañana\b/gi,
    new RegExp(`\\ba\\s+las?\\s+${NUMBER_TOKEN_PATTERN}(?:[:.,]\\d{2})?(?:\\s*(?:h|horas))?(?:\\s+(?:de\\s+la\\s+|por\\s+la\\s+)?(?:mañana|tarde|noche|madrugada))?\\b`, "gi"),
    /\bmañana\b/gi,
    /\bhoy\b/gi,
    /\b(?:el\s+)?(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b/gi,
    new RegExp(`\\b(?:el\\s+)?${NUMBER_TOKEN_PATTERN}\\s+de\\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\\s+de\\s+\\d{4})?\\b`, "gi"),
    /\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g,
    /\b(?:recuérdame|recuerdame|apunta|anota|añade|crea|tengo|que)\b/gi,
  ];
  patterns.forEach((pattern) => { title = title.replace(pattern, " "); });
  title = title.replace(/\s+/g, " ").replace(/^[,.;:\-\s]+|[,.;:\-\s]+$/g, "").trim();
  return capitalize(title || raw.trim());
}

function parseSpokenEntry(raw, type) {
  const trimmed = raw.trim();
  if (type === "note") {
    const firstBreak = trimmed.search(/[.!?\n]/);
    const shortTitle = firstBreak > 0 ? trimmed.slice(0, firstBreak) : trimmed;
    const title = capitalize(shortTitle.slice(0, 90).trim());
    return { title, details: trimmed.length > title.length ? trimmed : "", date: "", time: "", annual: false };
  }
  const normalized = normalizeText(trimmed);
  const birthday = /\bcumpleanos?\b|\bcumple\b/.test(normalized);
  return {
    title: cleanSpokenTitle(trimmed).slice(0, 160),
    details: "",
    date: parseDateFromSpeech(trimmed),
    time: parseTimeFromSpeech(trimmed),
    annual: birthday,
  };
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function emptyState(title, message) {
  const box = document.createElement("div");
  box.className = "empty-state";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const text = document.createElement("span");
  text.textContent = message;
  box.append(strong, text);
  return box;
}

function effectiveDate(entry, reference = new Date()) {
  if (!entry.date || !entry.annual) return entry.date;
  const source = fromISODate(entry.date);
  let candidate = new Date(reference.getFullYear(), source.getMonth(), source.getDate());
  if (candidate < new Date(reference.getFullYear(), reference.getMonth(), reference.getDate())) {
    candidate = new Date(reference.getFullYear() + 1, source.getMonth(), source.getDate());
  }
  return toISODate(candidate);
}

function entryOccursOn(entry, date) {
  if (!entry.date) return false;
  if (!entry.annual) return entry.date === date;
  return entry.date.slice(5) === date.slice(5);
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const first = `${effectiveDate(a) || "9999-99-99"}T${a.time || "23:59"}`;
    const second = `${effectiveDate(b) || "9999-99-99"}T${b.time || "23:59"}`;
    return first.localeCompare(second);
  });
}

function makeEntryItem(entry, options = {}) {
  const item = document.createElement("article");
  item.className = `entry-item${entry.completed ? " done-entry" : ""}`;
  const marker = document.createElement("span");
  marker.className = `entry-marker ${entry.type}`;
  const main = document.createElement("div");
  main.className = "entry-main";
  const title = document.createElement("strong");
  title.textContent = entry.title;
  const meta = document.createElement("p");
  meta.className = "entry-meta";
  const metaBits = [];
  if (entry.type === "note") metaBits.push("Nota");
  else {
    if (!options.hideDate) metaBits.push(formatDate(effectiveDate(entry), { day: "numeric", month: "short" }));
    metaBits.push(formatTime(entry.time));
    if (entry.annual) metaBits.push("Cada año");
    if (entry.completed) metaBits.push("Hecho");
  }
  meta.textContent = metaBits.join(" · ");
  main.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  const more = document.createElement("button");
  more.className = "more-button";
  more.type = "button";
  more.dataset.menuFor = entry.id;
  more.setAttribute("aria-label", `Opciones de ${entry.title}`);
  more.textContent = "•••";
  actions.append(more);
  item.append(marker, main, actions);
  return item;
}

function openEntryMenu(button, entry) {
  $$(".entry-menu").forEach((menu) => menu.remove());
  const menu = document.createElement("div");
  menu.className = "entry-menu";
  if (entry.type === "reminder") {
    const done = document.createElement("button");
    done.type = "button";
    done.dataset.action = "toggle";
    done.dataset.id = entry.id;
    done.textContent = entry.completed ? "Marcar pendiente" : "Marcar como hecho";
    menu.append(done);
  }
  const edit = document.createElement("button");
  edit.type = "button";
  edit.dataset.action = "edit";
  edit.dataset.id = entry.id;
  edit.textContent = "Editar";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "delete";
  remove.dataset.id = entry.id;
  remove.className = "delete-option";
  remove.textContent = "Eliminar";
  menu.append(edit, remove);
  button.parentElement.append(menu);
}

function renderHome() {
  const today = toISODate(new Date());
  const todayEntries = sortEntries(state.entries.filter((entry) => entry.type !== "note" && entryOccursOn(entry, today)));
  const list = $("#today-list");
  list.replaceChildren();
  if (!todayEntries.length) list.append(emptyState("Día despejado", "No tienes eventos ni recordatorios para hoy."));
  else todayEntries.forEach((entry) => list.append(makeEntryItem(entry, { hideDate: true })));

  const due = state.entries.filter((entry) => entry.type === "reminder" && !entry.completed && entry.date && effectiveDate(entry) <= today);
  const panel = $("#due-panel");
  panel.replaceChildren();
  panel.hidden = due.length === 0;
  if (due.length) {
    const heading = document.createElement("h3");
    heading.textContent = due.length === 1 ? "Tienes 1 recordatorio pendiente" : `Tienes ${due.length} recordatorios pendientes`;
    const intro = document.createElement("p");
    intro.textContent = "Puedes marcarlos como hechos desde aquí.";
    const items = document.createElement("div");
    items.className = "due-items";
    due.slice(0, 3).forEach((entry) => {
      const row = document.createElement("div");
      row.className = "due-item";
      const text = document.createElement("span");
      text.textContent = entry.title;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = "toggle";
      button.dataset.id = entry.id;
      button.textContent = "Hecho";
      row.append(text, button);
      items.append(row);
    });
    panel.append(heading, intro, items);
  }
}

function renderCalendar() {
  const month = state.calendarMonth;
  $("#month-label").textContent = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric" }).format(month);
  $("#selected-date-label").textContent = capitalize(formatDate(state.selectedDate, { weekday: "long", day: "numeric", month: "long" }));
  const grid = $("#calendar-grid");
  grid.replaceChildren();
  const mondayOffset = (month.getDay() + 6) % 7;
  const first = addDays(month, -mondayOffset);
  const today = toISODate(new Date());
  for (let index = 0; index < 42; index += 1) {
    const date = addDays(first, index);
    const iso = toISODate(date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "calendar-day";
    if (date.getMonth() !== month.getMonth()) button.classList.add("outside");
    if (iso === today) button.classList.add("today");
    if (iso === state.selectedDate) button.classList.add("selected");
    if (state.entries.some((entry) => entry.type !== "note" && entryOccursOn(entry, iso))) button.classList.add("has-entry");
    button.dataset.date = iso;
    button.setAttribute("aria-label", formatDate(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" }));
    button.textContent = String(date.getDate());
    grid.append(button);
  }

  const selected = sortEntries(state.entries.filter((entry) => entry.type !== "note" && entryOccursOn(entry, state.selectedDate)));
  const selectedList = $("#selected-day-list");
  selectedList.replaceChildren();
  if (!selected.length) selectedList.append(emptyState("Nada para este día", "Puedes añadir un evento o un recordatorio."));
  else selected.forEach((entry) => selectedList.append(makeEntryItem(entry, { hideDate: true })));

  const todayDate = toISODate(new Date());
  const upcoming = sortEntries(state.entries.filter((entry) => entry.type !== "note" && effectiveDate(entry) >= todayDate)).slice(0, 8);
  const upcomingList = $("#upcoming-list");
  upcomingList.replaceChildren();
  if (!upcoming.length) upcomingList.append(emptyState("Sin próximas fechas", "Tus próximos eventos aparecerán aquí."));
  else upcoming.forEach((entry) => upcomingList.append(makeEntryItem(entry)));
}

function renderNotes() {
  const query = normalizeText($("#note-search").value.trim());
  const notes = state.entries
    .filter((entry) => entry.type === "note" && (!query || normalizeText(`${entry.title} ${entry.details}`).includes(query)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const list = $("#notes-list");
  list.replaceChildren();
  if (!notes.length) {
    list.append(emptyState(query ? "No hay coincidencias" : "Aún no tienes notas", query ? "Prueba con otras palabras." : "Dicta o escribe tu primera nota."));
    return;
  }
  notes.forEach((entry) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "note-tile";
    tile.dataset.edit = entry.id;
    const title = document.createElement("strong");
    title.textContent = entry.title;
    const details = document.createElement("p");
    details.textContent = entry.details || "Toca para ver o editar";
    const time = document.createElement("time");
    time.textContent = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" }).format(new Date(entry.updatedAt));
    tile.append(title, details, time);
    list.append(tile);
  });
}

function renderAll() {
  renderHome();
  renderCalendar();
  renderNotes();
  updateLastBackup();
}

function switchView(view) {
  state.currentView = view;
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `${view}-view`));
  $$(".nav-item[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  if (view === "agenda") renderCalendar();
  if (view === "notes") renderNotes();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showStep(step) {
  $$(".dialog-step", entryDialog).forEach((section) => section.classList.toggle("active", section.id === `${step}-step`));
}

function openCreate(type, presetDate = "") {
  state.creationType = type;
  const label = TYPE_LABELS[type];
  $("#dialog-title").textContent = `Añadir ${label.toLocaleLowerCase("es")}`;
  $("#dialog-eyebrow").textContent = "NUEVA ENTRADA";
  $("#raw-input").value = "";
  $("#editing-id").value = "";
  $("#entry-title").value = "";
  $("#entry-details").value = "";
  $("#entry-date").value = presetDate || (type === "reminder" ? toISODate(new Date()) : "");
  $("#entry-time").value = "";
  $("#entry-annual").checked = false;
  $("#date-row").hidden = type === "note";
  $("#annual-field").hidden = type !== "event";
  $("#input-hint").textContent = type === "note" ? "Puedes dictar un apunte tan largo como necesites." : "Incluye la fecha y la hora si las conoces.";
  $("#raw-input").placeholder = type === "note" ? "Ejemplo: Ideas para el viaje..." : type === "reminder" ? "Ejemplo: Mañana comprar pan" : "Ejemplo: Dentista mañana a las cinco de la tarde";
  showStep("mode");
  entryDialog.showModal();
}

function openEdit(entry) {
  state.creationType = entry.type;
  $("#dialog-title").textContent = `Editar ${TYPE_LABELS[entry.type].toLocaleLowerCase("es")}`;
  $("#dialog-eyebrow").textContent = "CAMBIAR ENTRADA";
  $("#editing-id").value = entry.id;
  $("#entry-title").value = entry.title;
  $("#entry-details").value = entry.details;
  $("#entry-date").value = entry.date;
  $("#entry-time").value = entry.time;
  $("#entry-annual").checked = entry.annual;
  $("#date-row").hidden = entry.type === "note";
  $("#annual-field").hidden = entry.type !== "event";
  showStep("review");
  entryDialog.showModal();
}

function chooseMode(mode) {
  state.captureMode = mode;
  $("#voice-help").hidden = mode !== "voice";
  $("#raw-label").textContent = mode === "voice" ? "Tu frase dictada" : "Escribe lo que quieres guardar";
  showStep("capture");
  setTimeout(() => $("#raw-input").focus(), 80);
}

function interpretInput() {
  const raw = $("#raw-input").value.trim();
  if (!raw) {
    showToast(state.captureMode === "voice" ? "Dicta una frase antes de continuar" : "Escribe algo antes de continuar");
    $("#raw-input").focus();
    return;
  }
  const parsed = parseSpokenEntry(raw, state.creationType);
  $("#entry-title").value = parsed.title;
  $("#entry-details").value = parsed.details;
  if (state.creationType !== "note") {
    $("#entry-date").value = parsed.date || $("#entry-date").value;
    $("#entry-time").value = parsed.time;
    $("#entry-annual").checked = parsed.annual;
  }
  showStep("review");
  $("#entry-title").focus();
}

function saveForm(event) {
  event.preventDefault();
  const title = $("#entry-title").value.trim();
  if (!title) {
    showToast("Escribe un título");
    $("#entry-title").focus();
    return;
  }
  const id = $("#editing-id").value;
  const existing = state.entries.find((entry) => entry.id === id);
  const now = new Date().toISOString();
  const entry = {
    id: id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type: state.creationType,
    title: title.slice(0, 160),
    details: $("#entry-details").value.trim().slice(0, 2000),
    date: state.creationType === "note" ? "" : $("#entry-date").value,
    time: state.creationType === "note" ? "" : $("#entry-time").value,
    annual: state.creationType === "event" && $("#entry-annual").checked,
    completed: existing?.completed || false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (existing) state.entries = state.entries.map((item) => item.id === id ? entry : item);
  else state.entries.push(entry);
  saveEntries();
  entryDialog.close();
  renderAll();
  showToast(existing ? "Cambios guardados" : SAVED_LABELS[entry.type]);
}

function toggleReminder(id) {
  const entry = state.entries.find((item) => item.id === id && item.type === "reminder");
  if (!entry) return;
  entry.completed = !entry.completed;
  entry.updatedAt = new Date().toISOString();
  saveEntries();
  renderAll();
  showToast(entry.completed ? "Recordatorio completado" : "Recordatorio pendiente");
}

function requestDelete(id) {
  state.deleteId = id;
  confirmDialog.showModal();
}

function confirmDelete() {
  if (!state.deleteId) return;
  state.entries = state.entries.filter((entry) => entry.id !== state.deleteId);
  saveEntries();
  state.deleteId = null;
  confirmDialog.close();
  renderAll();
  showToast("Entrada eliminada");
}

function exportBackup() {
  const payload = { app: "Mi Agenda", version: 1, exportedAt: new Date().toISOString(), entries: state.entries };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = `mi-agenda-${toISODate(new Date())}.json`;
  link.click();
  URL.revokeObjectURL(url);
  localStorage.setItem(BACKUP_KEY, new Date().toISOString());
  updateLastBackup();
  showToast("Copia guardada");
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 2_000_000) {
    showToast("El archivo es demasiado grande");
    return;
  }
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || payload.app !== "Mi Agenda" || payload.version !== 1 || !Array.isArray(payload.entries)) throw new Error("invalid");
    const imported = safeEntries(payload.entries);
    if (imported.length !== payload.entries.length) throw new Error("invalid");
    const currentIds = new Set(state.entries.map((entry) => entry.id));
    const additions = imported.filter((entry) => !currentIds.has(entry.id));
    state.entries = [...state.entries, ...additions];
    saveEntries();
    renderAll();
    backupDialog.close();
    showToast(additions.length ? `${additions.length} entradas recuperadas` : "Ya tenías todos esos datos");
  } catch {
    showToast("Esta copia no es válida");
  } finally {
    $("#import-input").value = "";
  }
}

function updateLastBackup() {
  const value = localStorage.getItem(BACKUP_KEY);
  $("#last-backup").textContent = value
    ? `Última copia: ${new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}`
    : "Todavía no has guardado ninguna copia.";
}

function openBackup() {
  updateLastBackup();
  backupDialog.showModal();
}

function handleAction(action, id) {
  $$(".entry-menu").forEach((menu) => menu.remove());
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  if (action === "toggle") toggleReminder(id);
  if (action === "edit") openEdit(entry);
  if (action === "delete") requestDelete(id);
}

function registerWebMCP() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const schema = {
    type: "object",
    properties: {
      type: { type: "string", enum: ["event", "reminder", "note"] },
      phrase: { type: "string", minLength: 1, maxLength: 1000 },
    },
    required: ["type", "phrase"],
    additionalProperties: false,
  };
  try {
    void Promise.resolve(context.registerTool({
      name: "create_agenda_entry",
      title: "Crear entrada en Mi Agenda",
      description: "Crea un evento, recordatorio o nota a partir de una frase en español y actualiza la agenda visible.",
      inputSchema: schema,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        if (!input || !["event", "reminder", "note"].includes(input.type) || typeof input.phrase !== "string" || !input.phrase.trim() || input.phrase.length > 1000) {
          throw new Error("Entrada no válida");
        }
        const parsed = parseSpokenEntry(input.phrase, input.type);
        const now = new Date().toISOString();
        const entry = {
          id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: input.type,
          title: parsed.title.slice(0, 160),
          details: parsed.details.slice(0, 2000),
          date: parsed.date,
          time: parsed.time,
          annual: parsed.annual,
          completed: false,
          createdAt: now,
          updatedAt: now,
        };
        state.entries.push(entry);
        saveEntries();
        renderAll();
        return { id: entry.id, type: entry.type, title: entry.title, date: entry.date, time: entry.time };
      },
    }));
  } catch {
    // La aplicación sigue funcionando aunque el navegador no admita esta función opcional.
  }
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) switchView(viewButton.dataset.view);
    const createButton = event.target.closest("[data-create]");
    if (createButton) openCreate(createButton.dataset.create, state.currentView === "agenda" ? state.selectedDate : "");
    const modeButton = event.target.closest("[data-mode]");
    if (modeButton) chooseMode(modeButton.dataset.mode);
    const stepButton = event.target.closest("[data-step]");
    if (stepButton) showStep(stepButton.dataset.step);
    const menuButton = event.target.closest("[data-menu-for]");
    if (menuButton) {
      event.stopPropagation();
      const entry = state.entries.find((item) => item.id === menuButton.dataset.menuFor);
      if (entry) openEntryMenu(menuButton, entry);
    } else if (!event.target.closest(".entry-menu")) {
      $$(".entry-menu").forEach((menu) => menu.remove());
    }
    const actionButton = event.target.closest("[data-action]");
    if (actionButton) handleAction(actionButton.dataset.action, actionButton.dataset.id);
    const editTile = event.target.closest("[data-edit]");
    if (editTile) {
      const entry = state.entries.find((item) => item.id === editTile.dataset.edit);
      if (entry) openEdit(entry);
    }
    const day = event.target.closest("[data-date]");
    if (day) {
      state.selectedDate = day.dataset.date;
      state.calendarMonth = startOfMonth(fromISODate(state.selectedDate));
      renderCalendar();
    }
  });

  $("#interpret-button").addEventListener("click", interpretInput);
  $("#entry-form").addEventListener("submit", saveForm);
  $$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => entryDialog.close()));
  $$('[data-close-backup]').forEach((button) => button.addEventListener("click", () => backupDialog.close()));
  $("#backup-button").addEventListener("click", openBackup);
  $("#nav-backup").addEventListener("click", openBackup);
  $("#export-button").addEventListener("click", exportBackup);
  $("#import-input").addEventListener("change", (event) => importBackup(event.target.files[0]));
  $("#note-search").addEventListener("input", renderNotes);
  $("#prev-month").addEventListener("click", () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
    state.selectedDate = toISODate(state.calendarMonth);
    renderCalendar();
  });
  $("#next-month").addEventListener("click", () => {
    state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
    state.selectedDate = toISODate(state.calendarMonth);
    renderCalendar();
  });
  $("#cancel-delete").addEventListener("click", () => { state.deleteId = null; confirmDialog.close(); });
  $("#confirm-delete").addEventListener("click", confirmDelete);
  entryDialog.addEventListener("click", (event) => { if (event.target === entryDialog) entryDialog.close(); });
  backupDialog.addEventListener("click", (event) => { if (event.target === backupDialog) backupDialog.close(); });
}

function init() {
  const now = new Date();
  $("#today-label").textContent = capitalize(new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" }).format(now));
  bindEvents();
  renderAll();
  registerWebMCP();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init();
