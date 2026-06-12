"use strict";

const APP_VERSION = "v18";
const STORE_KEY = "stn-care-state-v1";
const PASS_KEY = "stn-care-pass-v1";
const DEFAULT_REMINDERS = { enabled: false, morning: "07:00", evening: "20:00" };
const DEFAULT_TRACKING = { adaptivePhases: true, adaptiveFrom: "", earnedBaseline: null };
const SESSION = { MORNING: "morning", EVENING: "evening" };
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const JS_DAY_TO_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

let routineData = null;
let appState = null;
let activeView = "today";
let sessionOverride = null;
let selectedProduct = null;
let passEntry = "";
let rememberDevice = false;
let passBusy = false;
let passError = "";
let clockTimer = null;
let lastAutoSession = null;
let lastClockDateKey = null;
let reminderTimer = null;

const app = document.getElementById("app");

function h(spec, props, ...children) {
  const parts = String(spec).split(/(?=[.#])/);
  const el = document.createElement(parts[0] || "div");
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i];
    if (part[0] === ".") el.classList.add(part.slice(1));
    if (part[0] === "#") el.id = part.slice(1);
  }
  if (props) {
    Object.entries(props).forEach(([key, value]) => {
      if (value === false || value == null) return;
      if (key === "class") String(value).split(/\s+/).forEach((c) => c && el.classList.add(c));
      else if (key === "text") el.textContent = value;
      else if (key === "style") el.style.cssText = value;
      else if (key === "on") Object.entries(value).forEach(([ev, fn]) => fn && el.addEventListener(ev, fn));
      else if (key === "data") Object.entries(value).forEach(([k, v]) => { el.dataset[k] = v; });
      else if (key === "checked") el.checked = Boolean(value);
      else if (key === "disabled") el.disabled = Boolean(value);
      else if (key === "value") el.value = value;
      else el.setAttribute(key, value);
    });
  }
  children.flat(Infinity).forEach((child) => {
    if (child === false || child == null || child === "") return;
    el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return el;
}

function mount(node) {
  app.replaceChildren(node);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(pass, salt, iter, usage) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  );
}

async function tryDecrypt(pass) {
  try {
    const enc = window.STN_ROUTINE_ENC;
    if (!enc) throw new Error("missing encrypted routine");
    const key = await deriveKey(pass, b64ToBytes(enc.salt), enc.iter || 310000, "decrypt");
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(enc.iv) }, key, b64ToBytes(enc.ct));
    routineData = JSON.parse(new TextDecoder().decode(clear));
    return true;
  } catch (err) {
    return false;
  }
}

function todayISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dateLabel(date = new Date()) {
  return new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function timeLabel(date = new Date()) {
  return new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function freshState() {
  return {
    startDate: todayISO(),
    todayMode: "wizard",
    controlsOpen: false,
    reminders: { ...DEFAULT_REMINDERS },
    tracking: { ...DEFAULT_TRACKING },
    checks: {}
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.startDate) parsed.startDate = todayISO();
    if (!parsed.todayMode) parsed.todayMode = "wizard";
    parsed.controlsOpen = Boolean(parsed.controlsOpen);
    parsed.reminders = { ...DEFAULT_REMINDERS, ...(parsed.reminders || {}) };
    parsed.tracking = { ...DEFAULT_TRACKING, ...(parsed.tracking || {}) };
    if (!parsed.checks) parsed.checks = {};
    return parsed;
  } catch (err) {
    return null;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(appState));
  } catch (err) {
    // localStorage may be unavailable in private contexts.
  }
}

function unlock(pass) {
  appState = loadState() || freshState();
  ensureTrackingBaseline();
  saveState();
  if (rememberDevice) {
    try { localStorage.setItem(PASS_KEY, pass); } catch (err) {}
  } else {
    try { localStorage.removeItem(PASS_KEY); } catch (err) {}
  }
  renderApp();
  startClock();
  scheduleReminder();
}

async function boot() {
  const saved = safeGet(PASS_KEY);
  if (saved && await tryDecrypt(saved)) {
    rememberDevice = true;
    unlock(saved);
    return;
  }
  renderLock();
}

function safeGet(key) {
  try { return localStorage.getItem(key); } catch (err) { return null; }
}

function ensureTrackingBaseline() {
  appState.tracking = { ...DEFAULT_TRACKING, ...(appState.tracking || {}) };
  if (appState.tracking.adaptiveFrom && appState.tracking.earnedBaseline != null) return;
  appState.tracking = baselineTracking(todayISO());
}

function baselineTracking(anchorIso) {
  const start = parseISODate(appState.startDate);
  const anchor = parseISODate(anchorIso);
  return {
    adaptivePhases: true,
    adaptiveFrom: anchorIso,
    earnedBaseline: Math.max(0, daysBetween(start, anchor))
  };
}

function daysBetween(start, end) {
  const a = parseISODate(todayISO(start));
  const b = parseISODate(todayISO(end));
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function maxDate(a, b) {
  return a.getTime() > b.getTime() ? a : b;
}

function earnedProgress(date = new Date()) {
  ensureTrackingBaseline();
  const start = parseISODate(appState.startDate);
  const target = parseISODate(todayISO(date));
  const tracking = appState.tracking;
  const adaptiveFrom = maxDate(start, parseISODate(tracking.adaptiveFrom || appState.startDate));
  const calendarDays = Math.max(0, daysBetween(start, target));
  let earnedDays = Math.min(calendarDays, Math.max(0, Number(tracking.earnedBaseline) || 0));

  if (target > adaptiveFrom) {
    let cursor = new Date(adaptiveFrom);
    while (cursor < target) {
      const phase = phaseForEarnedDays(earnedDays);
      const score = dayCompletion(todayISO(cursor), JS_DAY_TO_KEY[cursor.getDay()], phase);
      if (score.full) earnedDays += 1;
      cursor = addDays(cursor, 1);
    }
  }

  const nextThreshold = earnedDays < 14 ? 14 : earnedDays < 28 ? 28 : null;
  return {
    earnedDays,
    calendarDays,
    delayedDays: Math.max(0, calendarDays - earnedDays),
    effectiveWeek: Math.floor(earnedDays / 7) + 1,
    effectiveDay: earnedDays + 1,
    phase: phaseForEarnedDays(earnedDays),
    nextThreshold,
    daysToNextPhase: nextThreshold == null ? 0 : Math.max(0, nextThreshold - earnedDays)
  };
}

function sessionCompletion(dateKey, session, phase, day) {
  const ids = routineIdsFor(session, phase, day);
  const keyPhase = session === SESSION.MORNING ? "am" : phase;
  const checks = appState.checks[routineKeyFor(dateKey, session, keyPhase, day)] || [];
  const done = checks.slice(0, ids.length).filter(Boolean).length;
  const total = ids.length;
  return { done, total, pct: total ? done / total : 1 };
}

function dayCompletion(dateKey, day, phase) {
  const morning = sessionCompletion(dateKey, SESSION.MORNING, phase, day);
  const evening = sessionCompletion(dateKey, SESSION.EVENING, phase, day);
  const done = morning.done + evening.done;
  const total = morning.total + evening.total;
  const pct = total ? done / total : 1;
  return { dateKey, day, phase, morning, evening, done, total, pct, full: total > 0 && done === total };
}

function weekNumber(date = new Date()) {
  return earnedProgress(date).effectiveWeek;
}

function phaseForWeek(week) {
  if (week <= 2) return "phase1";
  if (week <= 4) return "phase2";
  return "phase3";
}

function phaseForEarnedDays(days) {
  if (days < 14) return "phase1";
  if (days < 28) return "phase2";
  return "phase3";
}

function autoSession(date = new Date()) {
  return date.getHours() < routineData.cutoverHour ? SESSION.MORNING : SESSION.EVENING;
}

function activeSession(date = new Date()) {
  return sessionOverride || autoSession(date);
}

function currentContext(date = new Date()) {
  const progress = earnedProgress(date);
  const week = progress.effectiveWeek;
  const phase = progress.phase;
  const session = activeSession(date);
  const day = JS_DAY_TO_KEY[date.getDay()];
  const dateKey = todayISO(date);
  const auto = autoSession(date);
  return { week, phase, session, day, dateKey, auto, manual: Boolean(sessionOverride), progress };
}

function routineIds(ctx) {
  return routineIdsFor(ctx.session, ctx.phase, ctx.day);
}

function routineIdsFor(session, phase, day) {
  if (session === SESSION.MORNING) return routineData.routines.morning[day] || [];
  return routineData.routines.evening[phase][day] || [];
}

function optionalEntries(ctx) {
  return optionalEntriesFor(ctx.session, ctx.phase, ctx.day);
}

function optionalEntriesFor(session, phase, day) {
  const optional = routineData.optionalRoutines || {};
  const dayEntries = session === SESSION.MORNING
    ? optional.morning?.[day]
    : optional.evening?.[phase]?.[day];
  return normalizeOptionalEntries(dayEntries);
}

function normalizeOptionalEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => typeof entry === "string" ? { id: entry } : entry)
    .filter((entry) => entry?.id && product(entry.id));
}

function product(id) {
  return routineData.products[id];
}

function routineKey(ctx) {
  const phase = ctx.session === SESSION.MORNING ? "am" : ctx.phase;
  return routineKeyFor(ctx.dateKey, ctx.session, phase, ctx.day);
}

function routineKeyFor(dateKey, session, phase, day) {
  return `${dateKey}:${session}:${phase}:${day}`;
}

function checksFor(ctx, count) {
  const key = routineKey(ctx);
  if (!appState.checks[key]) appState.checks[key] = Array(count).fill(false);
  if (appState.checks[key].length !== count) appState.checks[key] = Array(count).fill(false);
  return appState.checks[key];
}

function stepNote(ctx, id) {
  const keys = ctx.session === SESSION.MORNING
    ? [`morning:${ctx.day}:${id}`, `morning:${id}`]
    : [`${ctx.phase}:${ctx.day}:${id}`, `${ctx.phase}:${id}`];
  return keys.map((k) => routineData.stepOverrides[k]).find(Boolean) || "";
}

function sessionTitle(session) {
  return session === SESSION.MORNING ? "Morgenroutine" : "Abendroutine";
}

function phaseLabel(ctx) {
  return ctx.session === SESSION.MORNING ? "Jede Woche gleich" : routineData.phaseNames[ctx.phase];
}

function renderLock() {
  if (!window.STN_ROUTINE_ENC) {
    mount(h("section.lock-screen", null,
      h("div.lock-panel", null,
        h("div.brand-mark", null, "STN"),
        h("h1", null, "Login"),
        h("p", null, "Bitte später erneut versuchen.")
      )
    ));
    return;
  }
  const input = h("input.pass-input", {
    type: "password",
    placeholder: "Passwort",
    autocomplete: "current-password",
    value: passEntry
  });
  input.addEventListener("input", (event) => {
    passEntry = event.target.value;
    passError = "";
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitPassword();
    }
  });
  const remember = h("input", {
    type: "checkbox",
    checked: rememberDevice,
    on: { change: (event) => { rememberDevice = event.target.checked; } }
  });
  mount(h("section.lock-screen", null,
    h("form.lock-panel", { on: { submit: (event) => { event.preventDefault(); submitPassword(); } } },
      h("div.brand", null, h("div.brand-mark", null, "STN"), h("div.brand-copy", null, h("b", null, "STN Care"))),
      h("h1", null, "Login"),
      input,
      h("label.toggle", null, h("span", null, "Angemeldet bleiben"), remember),
      passError ? h("div.error", null, passError) : null,
      h("button.primary-btn", { type: "submit", disabled: passBusy }, passBusy ? "Prüfe..." : "Login")
    )
  ));
  setTimeout(() => input.focus(), 40);
}

async function submitPassword() {
  if (passBusy || !passEntry) return;
  passBusy = true;
  passError = "";
  renderLock();
  const ok = await tryDecrypt(passEntry);
  passBusy = false;
  if (ok) unlock(passEntry);
  else {
    passError = "Login fehlgeschlagen.";
    renderLock();
  }
}

function renderApp() {
  const ctx = currentContext();
  mount(h("div.app-shell", null,
    appHeader(ctx),
    tabs(),
    viewNode(ctx),
    selectedProduct ? productModal(ctx, selectedProduct) : null
  ));
  tickClockText();
}

function appHeader(ctx) {
  return h("header.app-header", null,
    h("div.brand", null,
      h("div.brand-mark", null, "STN"),
      h("div.brand-copy", null,
        h("b", null, routineData.appName || "STN Care"),
        h("span", null, `${routineData.dayNames[ctx.day]} · Woche ${ctx.week} · ${ctx.progress.earnedDays} Pflegetage`)
      )
    ),
    h("button.text-btn.soft", { on: { click: logout } }, "Sperren")
  );
}

function tabs() {
  const items = [
    ["today", "Heute"],
    ["month", "Monat"],
    ["week", "Plan"],
    ["products", "Shop"],
    ["rules", "Regeln"],
    ["settings", "Setup"]
  ];
  return h("nav.tabs", { "aria-label": "Navigation" },
    items.map(([id, label]) => h("button.tab", {
      class: activeView === id ? "is-active" : "",
      on: { click: () => { activeView = id; renderApp(); } }
    }, label))
  );
}

function viewNode(ctx) {
  if (activeView === "month") return monthView(ctx);
  if (activeView === "week") return weekView(ctx);
  if (activeView === "products") return productsView(ctx);
  if (activeView === "rules") return rulesView();
  if (activeView === "settings") return settingsView(ctx);
  return todayView(ctx);
}

function todayView(ctx) {
  const ids = routineIds(ctx);
  const checks = checksFor(ctx, ids.length);
  const done = checks.filter(Boolean).length;
  const pct = ids.length ? Math.round((done / ids.length) * 100) : 0;
  const dayScore = dayCompletion(ctx.dateKey, ctx.day, ctx.phase);
  const dayPct = Math.round(dayScore.pct * 100);
  const note = ctx.session === SESSION.MORNING ? routineData.routineNotes.morning : routineData.routineNotes[ctx.phase];
  const mode = appState.todayMode || "wizard";
  return h("section.view", null,
    h("div.today-hero", null,
      h("div.kicker", { data: { clock: "now" } }, `${dateLabel()} · ${timeLabel()}`),
      h("h1", null, sessionTitle(ctx.session)),
      h("p", null, `${phaseLabel(ctx)} · ${routineData.dayNames[ctx.day]}`),
      h("div.focus-strip", null, h("b", null, "Fokus heute"), h("span", null, todayFocus(ctx))),
      compactControlBar(ctx, mode),
      appState.controlsOpen ? h("div.controls-panel", null, sessionSwitch(ctx), todayModeSwitch(mode)) : null,
      h("div.status-grid", null,
        infoTile("Auswahl", ctx.manual ? `Manuell: ${sessionTitle(ctx.session).replace("routine", "")}` : `Auto: ${sessionTitle(ctx.auto).replace("routine", "")}`),
        infoTile("Planstand", `Woche ${ctx.week}`),
        infoTile("Heute", `${dayPct}%`),
        infoTile("Pflegetage", `${ctx.progress.earnedDays}/${ctx.progress.nextThreshold || "∞"}`)
      ),
      h("div.progress-wrap", null,
        h("div.progress-line", null, h("i", { style: `width:${pct}%` })),
        h("div.progress-label", null, h("span", null, `${pct}% erledigt`), h("span", null, nextChange(ctx)))
      )
    ),
    accountabilityNotice(ctx, dayScore),
    mode === "wizard"
      ? [
          nextStepPanel(ctx, ids, checks),
          optionalPanel(ctx),
          h("div.notice.clean", null, note),
          h("div.action-row", null,
            h("button.primary-btn", { on: { click: () => markAll(ctx, true) } }, "Alle erledigt"),
            h("button.ghost-btn", { on: { click: () => setTodayMode("plan") } }, "Tagesplan")
          )
        ]
      : [
          h("div.notice.clean", null, note),
          h("div.action-row", null,
            h("button.primary-btn", { on: { click: () => markAll(ctx, true) } }, "Alle erledigt"),
            h("button.ghost-btn", { on: { click: () => markAll(ctx, false) } }, "Zurücksetzen")
          ),
          h("div.step-list", null, ids.map((id, index) => stepCard(ctx, id, index, checks[index]))),
          optionalPanel(ctx)
        ]
  );
}

function compactControlBar(ctx, mode) {
  return h("div.focus-control-bar", null,
    h("span", null, `${ctx.manual ? "Manuell" : "Auto"} · ${sessionTitle(ctx.session)} · ${mode === "wizard" ? "Wizard" : "Tagesplan"}`),
    h("button.ghost-btn.small", {
      on: { click: () => {
        appState.controlsOpen = !appState.controlsOpen;
        saveState();
        renderApp();
      } }
    }, appState.controlsOpen ? "Optionen ausblenden" : "Optionen")
  );
}

function accountabilityNotice(ctx, score) {
  if (ctx.session !== SESSION.EVENING || score.morning.pct >= 1) return null;
  const missed = score.morning.done === 0
    ? "Du hast morgens noch nichts abgehakt."
    : `Morgens stehen nur ${score.morning.done}/${score.morning.total} Schritte.`;
  return h("div.notice.accountability", null,
    h("b", null, "Kurzer Reality-Check: "),
    `${missed} Wenn du es wirklich gemacht hast, trage es nach. Wenn nicht: heute zählt nicht als voller Pflegetag und die nächste Phase rückt nach hinten.`
  );
}

function todayModeSwitch(mode) {
  return h("div.session-switch.mode-switch", { "aria-label": "Ansicht auswählen" },
    h("button.segment", {
      class: mode === "wizard" ? "is-active" : "",
      on: { click: () => setTodayMode("wizard") }
    }, "Wizard"),
    h("button.segment", {
      class: mode === "plan" ? "is-active" : "",
      on: { click: () => setTodayMode("plan") }
    }, "Tagesplan")
  );
}

function setTodayMode(mode) {
  appState.todayMode = mode;
  saveState();
  renderApp();
}

function sessionSwitch(ctx) {
  return h("div.session-switch", { "aria-label": "Routine-Auswahl" },
    h("button.segment", {
      class: ctx.manual && ctx.session === SESSION.MORNING ? "is-active" : "",
      on: { click: () => setSession(SESSION.MORNING) }
    }, "Morgen"),
    h("button.segment", {
      class: !ctx.manual ? "is-active" : "",
      on: { click: () => { sessionOverride = null; renderApp(); } }
    }, `Auto: ${ctx.auto === SESSION.MORNING ? "Morgen" : "Abend"}`),
    h("button.segment", {
      class: ctx.manual && ctx.session === SESSION.EVENING ? "is-active" : "",
      on: { click: () => setSession(SESSION.EVENING) }
    }, "Abend")
  );
}

function infoTile(label, value) {
  return h("div.info-tile", null, h("span", null, label), h("b", null, value));
}

function nextStepPanel(ctx, ids, checks) {
  const nextIndex = checks.findIndex((done) => !done);
  if (nextIndex === -1) {
    return h("article.next-card.is-complete", null,
      h("div.next-copy", null,
        h("span.kicker", null, "Fertig"),
        h("h2", null, "Routine abgeschlossen"),
        h("p", null, ctx.session === SESSION.MORNING ? "SPF sitzt. Heute Abend öffnet die App automatisch die Abendroutine." : "Haut in Ruhe lassen. Morgen geht es wieder mit Reinigung, Serum und SPF weiter.")
      )
    );
  }
  const id = ids[nextIndex];
  const p = product(id);
  return h("article.next-card", null,
    h("div.next-image", null, productImg(p)),
    h("div.next-copy", null,
      h("span.kicker", null, `Nächster Schritt ${nextIndex + 1} von ${ids.length}`),
      h("h2", null, p.name),
      h("p", null, stepInstruction(ctx, id, nextIndex)),
      productWhy(p) ? h("div.why-now", null, h("b", null, "Warum: "), productWhy(p)) : null,
      h("div.step-tags", null,
        h("span.tag", null, p.amount),
        h("span.tag", null, p.zone),
        h("span.tag", null, p.type)
      ),
      h("div.action-row", null,
        h("button.primary-btn", { on: { click: () => toggleStep(ctx, nextIndex) } }, "Erledigt"),
        h("button.ghost-btn", { on: { click: () => openProduct(id) } }, "Details")
      )
    )
  );
}

function optionalPanel(ctx) {
  const entries = optionalEntries(ctx);
  if (!entries.length) return null;
  return h("section.optional-panel", null,
    h("div.optional-head", null,
      h("span.kicker", null, "Bei Bedarf"),
      h("h2", null, "Poren- und T-Zone-Schritte"),
      h("p", null, "Diese Karten zählen nicht zur Pflichtwertung. Swap heißt: ersetzen. Zusatz heißt: nur bei ruhiger Haut gezielt auf Stirn, Nase und Kinn einsetzen.")
    ),
    h("div.optional-grid", null, entries.map((entry) => optionalStepCard(entry)))
  );
}

function optionalStepCard(entry) {
  const p = product(entry.id);
  const label = entry.label || (entry.mode === "add" ? "geplanter Zusatz" : "Optional");
  return h("article.optional-card", null,
    productImg(p, "product-thumb"),
    h("div", null,
      h("div.step-tags", null,
        h("span.tag.warn", null, label),
        entry.replaces ? h("span.tag", null, `statt ${entry.replaces}`) : null,
        entry.timing ? h("span.tag", null, entry.timing) : null
      ),
      h("h3", null, p.name),
      h("p", null, entry.rule || p.whyShort || p.role)
    ),
    h("button.detail-btn", { title: "Produktdetails", on: { click: () => openProduct(entry.id) } }, "Details")
  );
}

function productWhy(p) {
  return p.whyShort || p.why || "";
}

function todayFocus(ctx) {
  const ids = routineIds(ctx);
  const optionals = optionalEntries(ctx).map((entry) => entry.id);
  if (ctx.session === SESSION.MORNING) return "Schützen, Feuchtigkeit aufbauen und den Tag matt starten.";
  if (ids.includes("retinol-03")) return "Retinol-Abend: Struktur, Poren und Linien langfristig verbessern.";
  if (ids.includes("glycolic-10") && optionalEntries(ctx).length) return "Flexibler Säureabend: Standard Glow, bei Mitessern Poren-Swap statt Glycolic 10.";
  if (ids.includes("glycolic-10")) return "Glow-Abend: alte Hautzellen lösen, danach Barriere pflegen.";
  if (ids.includes("blemish-age-defense")) return "Poren-Abend: T-Zone klären, Wangen nicht überfordern.";
  if (ids.includes("blemish-age-toner")) return "Toner-Abend: Poren sanft freiräumen, danach beruhigen.";
  if (ids.includes("clarifying-clay-mask")) return "Masken-Abend: T-Zone entlasten und Feuchtigkeit zurückgeben.";
  if (optionals.includes("clarifying-clay-mask")) return "Recovery mit optionalem T-Zone-Reset: Clay nur auf Stirn, Nase und Kinn, wenn die Haut ruhig ist.";
  return "Recovery-Abend: Feuchtigkeit, Ruhe und Hautbarriere stärken.";
}

function setSession(session) {
  sessionOverride = session;
  renderApp();
}

function markAll(ctx, value) {
  const ids = routineIds(ctx);
  appState.checks[routineKey(ctx)] = Array(ids.length).fill(value);
  saveState();
  renderApp();
}

function stepCard(ctx, id, index, isDone) {
  const p = product(id);
  const caution = stepCaution(ctx, id);
  return h("article.step-card", null,
    h("button.check", {
      class: isDone ? "is-done" : "",
      title: isDone ? "Erledigt" : "Als erledigt markieren",
      on: { click: () => toggleStep(ctx, index) }
    }, isDone ? "✓" : String(index + 1)),
    productImg(p, "product-thumb"),
    h("div.step-main", null,
      h("div.step-tags", null, h("span.tag", null, p.amount), h("span.tag", null, p.zone)),
      h("h2", null, p.name),
      h("p", null, stepInstruction(ctx, id, index)),
      caution ? h("div.step-tags", null, h("span.tag.warn", null, caution)) : null
    ),
    h("button.detail-btn", { title: "Produktdetails", on: { click: () => openProduct(id) } }, "Details")
  );
}

function stepInstruction(ctx, id) {
  const p = product(id);
  const override = stepNote(ctx, id);
  if (override) return override;
  if (p.use && p.use[ctx.session]) return p.use[ctx.session];
  if (p.use && p.use.default) return p.use.default;
  return p.how;
}

function stepCaution(ctx, id) {
  const p = product(id);
  if (p.cautions && p.cautions[ctx.session]) return p.cautions[ctx.session];
  if (!p.caution) return "";
  const text = p.caution;
  if (ctx.session === SESSION.EVENING && /morgens|Vitamin C|Sonnenschutz/i.test(text) && !/nächsten Morgen/i.test(text)) return "";
  if (ctx.session === SESSION.MORNING && /abends|Abend|Retinol|Säure/i.test(text) && !/SPF/i.test(text)) return "";
  return text;
}

function toggleStep(ctx, index) {
  const ids = routineIds(ctx);
  const checks = checksFor(ctx, ids.length);
  checks[index] = !checks[index];
  appState.checks[routineKey(ctx)] = checks;
  saveState();
  renderApp();
}

function productImg(p, extraClass = "") {
  const src = p.imageData || "";
  const img = h("img", {
    class: extraClass,
    src,
    alt: p.name,
    loading: "lazy",
    decoding: "async"
  });
  img.addEventListener("error", () => {
    if (img.dataset.fallbackDone) return;
    img.dataset.fallbackDone = "1";
    img.removeAttribute("src");
  });
  return img;
}

function weekView(ctx) {
  return h("section.view", null,
    h("div.plan-intro", null,
      h("span.kicker", null, "Planlogik"),
      h("h1", null, `Woche ${ctx.week}: ${routineData.phaseNames[ctx.phase]}`),
      h("p", null, `${ctx.progress.earnedDays} volle Pflegetage verdient. ${nextChange(ctx)}`)
    ),
    conceptPanel(),
    h("div.phase-rail", null, phaseCards(ctx)),
    phaseExplainer(ctx),
    poreStrategyPanel(),
    h("div.logic-panel", null,
      infoTile("Start Woche 1", formatISO(appState.startDate)),
      infoTile("Kalendertage", `${ctx.progress.calendarDays}`),
      infoTile("Verzögerung", ctx.progress.delayedDays ? `${ctx.progress.delayedDays} Tag(e)` : "keine"),
      infoTile("Automatik", `Morgen bis ${routineData.cutoverHour}:00`)
    ),
    h("div.schedule-panel", null,
      h("div.change-head", null,
        h("span.kicker", null, "Diese Woche"),
        h("h2", null, "Tagespläne mit voller Reihenfolge"),
        h("p", null, "Pflichtschritte zählen für den Fortschritt. Optionale Swaps sind sichtbar, ersetzen aber einen Wirkstoffabend statt neue Pflichtschritte zu erzeugen.")
      ),
      h("div.week-grid", null,
        DAY_ORDER.map((day) => weekCard(day, day === ctx.day, ctx.phase))
      )
    ),
    allPhaseSchedules(ctx)
  );
}

function conceptPanel() {
  const concepts = routineData.concepts || [
    {
      title: "T-Zone",
      text: "Stirn, Nase und Kinn. Dort sind Glanz, Mitesser und Poren oft stärker."
    },
    {
      title: "Pflicht",
      text: "Gehört zur Tageswertung und sollte abgehakt werden."
    },
    {
      title: "Bei Bedarf",
      text: "Sichtbar geplant, aber nur nutzen, wenn die Haut ruhig ist und der Bereich es braucht."
    },
    {
      title: "Swap",
      text: "Ersetzt einen Wirkstoff. Nicht zusätzlich obendrauf."
    }
  ];
  return h("section.concept-panel", null,
    concepts.map((item) => h("article.concept-card", null,
      h("b", null, item.title),
      h("p", null, item.text)
    ))
  );
}

function poreStrategyPanel() {
  const strategy = routineData.poreStrategy;
  if (!strategy) return null;
  return h("section.pore-panel", null,
    h("div", null,
      h("span.kicker", null, "Porenstrategie"),
      h("h2", null, strategy.title),
      h("p", null, strategy.text)
    ),
    h("ul.pore-list", null, (strategy.points || []).map((point) => h("li", null, point)))
  );
}

function allPhaseSchedules(ctx) {
  return h("div.schedule-panel.future-schedule", null,
    h("div.change-head", null,
      h("span.kicker", null, "Zukünftige Wochen"),
      h("h2", null, "So sieht der Abendplan je Phase aus"),
      h("p", null, "Morgens bleibt die Basis jede Woche gleich. Die eigentliche Rotation passiert abends.")
    ),
    h("div.phase-schedule-grid", null,
      phaseGuide().map((phase) => h("article.phase-schedule", { class: ctx.phase === phase.id ? "is-active" : "" },
        h("div.phase-schedule-head", null,
          h("span.kicker", null, phase.range),
          h("h3", null, phase.title),
          h("p", null, phase.short)
        ),
        h("div.day-plan-list", null,
          DAY_ORDER.map((day) => phaseDayPlan(day, phase.id))
        )
      ))
    )
  );
}

function phaseCards(ctx) {
  return phaseList().map((phase) => {
    const nextStart = phase.nextStart == null ? Infinity : phase.nextStart;
    const state = ctx.phase === phase.id ? "is-active" : ctx.week >= nextStart ? "is-done" : "";
    return h("article.phase-card", { class: state },
      h("span.kicker", null, phase.range),
      h("h2", null, phase.title),
      h("p", null, phase.text),
      h("div.step-tags", null, phase.products.map((item) => h("span.tag", null, item)))
    );
  });
}

function phaseList() {
  return phaseGuide().map((phase) => ({
    id: phase.id,
    range: phase.range,
    nextStart: phase.nextStart,
    title: phase.title,
    text: phase.short,
    products: phase.tags
  }));
}

function phaseGuide() {
  return routineData.phaseGuide || [
    {
      id: "phase1",
      range: "Woche 1-2",
      nextStart: 3,
      title: "Eingewöhnung",
      short: "Basis aufbauen, Porenbehandlung langsam starten.",
      tags: ["B+A Defense", "Recovery", "Masken"],
      starts: "ab Startdatum",
      adds: "Blemish + Age Defense 2x/Woche, Recovery-Abende, Clay/B5-Masken am Samstag.",
      changes: "Noch kein Toner, kein Glycolic 10, kein Retinol.",
      why: "Die Hautbarriere soll zuerst stabil bleiben, bevor stärkere Säuren und Retinol dazukommen."
    },
    {
      id: "phase2",
      range: "Woche 3-4",
      nextStart: 5,
      title: "Säure-Rotation",
      short: "Toner und Glycolic 10 kommen getrennt dazu.",
      tags: ["Toner", "Glycolic 10"],
      starts: "nach 14 Tagen",
      adds: "Blemish + Age Toner am Mittwoch und Glycolic 10 am Donnerstag.",
      changes: "Blemish + Age Defense sinkt auf Montag. Retinol bleibt weiter aus.",
      why: "Toner, Glycolic 10 und Blemish + Age Defense liegen auf getrennten Abenden."
    },
    {
      id: "phase3",
      range: "ab Woche 5",
      nextStart: Infinity,
      title: "Retinol integriert",
      short: "Retinol kommt dazu, Säure und Recovery bleiben getrennt.",
      tags: ["Retinol 0.3", "Dauerrotation"],
      starts: "nach 28 Tagen",
      adds: "Retinol am Dienstag und Freitag.",
      changes: "P-TIOX-Recovery wandert auf Mittwoch, Toner auf Sonntag. Kein Produkt fällt komplett raus.",
      why: "Retinol ersetzt Wirkstoffabende und wird nicht mit Säure oder Blemish + Age Defense gestapelt."
    }
  ];
}

function phaseExplainer(ctx) {
  return h("div.change-panel", null,
    h("div.change-head", null,
      h("span.kicker", null, "Was ändert sich?"),
      h("h2", null, "So greifen die Wochenphasen"),
      h("p", null, "Die App schaltet nicht nach bloßem Kalender um, sondern nach vollen Pflegetagen. 100% morgens und 100% abends ergeben einen verdienten Tag.")
    ),
    h("div.change-grid", null,
      phaseGuide().map((phase) => h("article.change-card", { class: ctx.phase === phase.id ? "is-active" : "" },
        h("span.kicker", null, `${phase.range} · ${phaseStartLabel(phase.id)}`),
        h("h3", null, phase.title),
        h("div.change-section", null, h("b", null, "Kommt dazu"), h("p", null, phase.adds)),
        h("div.change-section", null, h("b", null, "Ändert sich"), h("p", null, phase.changes)),
        h("div.change-section", null, h("b", null, "Warum"), h("p", null, phase.why))
      ))
    )
  );
}

function phaseStartLabel(id) {
  if (id === "phase1") return "ab Start";
  if (id === "phase2") return "nach 14 vollen Pflegetagen";
  return "nach 28 vollen Pflegetagen";
}

function nextChange(ctx) {
  if (ctx.progress.earnedDays < 14) return `Noch ${fullDayWord(ctx.progress.daysToNextPhase)}, dann kommen Toner und Glycolic 10 dazu.`;
  if (ctx.progress.earnedDays < 28) return `Noch ${fullDayWord(ctx.progress.daysToNextPhase)}, dann startet Retinol, wenn die Haut ruhig bleibt.`;
  return "Dauerrotation aktiv: Retinol, Säure und Recovery bleiben getrennt.";
}

function fullDayWord(count) {
  return count === 1 ? "1 voller Pflegetag" : `${count} volle Pflegetage`;
}

function weekCard(day, isToday, phase) {
  return h("article.week-card", { class: isToday ? "is-today" : "" },
    h("h2", null, routineData.dayNames[day]),
    routineBlock("Morgen", routineData.routines.morning[day]),
    routineBlock("Abend", routineData.routines.evening[phase][day]),
    optionalMini(SESSION.EVENING, phase, day)
  );
}

function phaseDayPlan(day, phase) {
  return h("div.day-plan-row", null,
    h("b", null, routineData.dayNames[day]),
    routineBlock("Abend", routineData.routines.evening[phase][day], true),
    optionalMini(SESSION.EVENING, phase, day)
  );
}

function routineBlock(label, ids = [], compact = false) {
  return h("div.routine-block", { class: compact ? "is-compact" : "" },
    h("span", null, label),
    h("ol", null, ids.map((id) => h("li", null, product(id).name)))
  );
}

function optionalMini(session, phase, day) {
  const entries = optionalEntriesFor(session, phase, day);
  if (!entries.length) return null;
  return h("div.optional-mini", null,
    h("span", null, "Bei Bedarf"),
    h("ul", null, entries.map((entry) => h("li", null,
      `${product(entry.id).name}${entry.replaces ? ` statt ${entry.replaces}` : ""}${entry.timing ? ` · ${entry.timing}` : ""}`
    )))
  );
}

function monthView(ctx) {
  const model = monthModel(new Date());
  return h("section.view", null,
    h("div.plan-intro", null,
      h("span.kicker", null, "Monatsübersicht"),
      h("h1", null, model.label),
      h("p", null, "Jeder Tag zeigt, wie viel der geplanten Morgen- und Abendroutine wirklich erledigt wurde. Nur 100% zählt als voller Pflegetag für neue Phasen.")
    ),
    h("div.score-board", null,
      infoTile("Ø Monat", `${model.average}%`),
      infoTile("100%-Tage", `${model.perfectDays}`),
      infoTile("0%-Tage", `${model.zeroDays}`),
      infoTile("Serie", `${model.streak} Tag(e)`)
    ),
    h("div.month-grid", null,
      ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((label) => h("div.month-head", null, label)),
      model.cells.map((cell) => monthCell(cell))
    ),
    h("div.legend-row", null,
      h("span.legend-dot.is-perfect", null), "100%",
      h("span.legend-dot.is-ok", null), "70-99%",
      h("span.legend-dot.is-low", null), "1-69%",
      h("span.legend-dot.is-zero", null), "0%"
    )
  );
}

function monthModel(referenceDate) {
  const monthStartDate = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
  const monthEndDate = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0);
  const label = new Intl.DateTimeFormat("de-DE", { month: "long", year: "numeric" }).format(referenceDate);
  const firstOffset = (monthStartDate.getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < firstOffset; i += 1) cells.push({ empty: true });

  const usableScores = [];
  for (let day = 1; day <= monthEndDate.getDate(); day += 1) {
    const date = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), day);
    const iso = todayISO(date);
    const isFuture = parseISODate(iso) > parseISODate(todayISO());
    const beforeStart = parseISODate(iso) < parseISODate(appState.startDate);
    const progress = earnedProgress(date);
    const score = dayCompletion(iso, JS_DAY_TO_KEY[date.getDay()], progress.phase);
    const pct = Math.round(score.pct * 100);
    const usable = !isFuture && !beforeStart;
    if (usable) usableScores.push(score);
    cells.push({
      day,
      iso,
      pct,
      score,
      isToday: iso === todayISO(),
      isFuture,
      beforeStart,
      className: dayScoreClass(score, isFuture, beforeStart)
    });
  }

  const average = usableScores.length
    ? Math.round((usableScores.reduce((sum, score) => sum + score.pct, 0) / usableScores.length) * 100)
    : 0;
  return {
    label,
    cells,
    average,
    perfectDays: usableScores.filter((score) => score.full).length,
    zeroDays: usableScores.filter((score) => score.done === 0).length,
    streak: fullDayStreak()
  };
}

function dayScoreClass(score, isFuture, beforeStart) {
  if (isFuture || beforeStart) return "is-muted";
  if (score.full) return "is-perfect";
  if (score.pct >= 0.7) return "is-ok";
  if (score.pct > 0) return "is-low";
  return "is-zero";
}

function monthCell(cell) {
  if (cell.empty) return h("div.month-cell.is-empty", null);
  const title = cell.beforeStart
    ? "Vor Planstart"
    : cell.isFuture
      ? "Zukünftig"
      : `${cell.score.done}/${cell.score.total} Schritte`;
  return h("article.month-cell", { class: `${cell.className} ${cell.isToday ? "is-today" : ""}` },
    h("b", null, String(cell.day)),
    h("span", null, cell.beforeStart || cell.isFuture ? "–" : `${cell.pct}%`),
    h("small", null, title)
  );
}

function fullDayStreak() {
  let streak = 0;
  let cursor = parseISODate(todayISO());
  const todayProgress = earnedProgress(cursor);
  const todayScore = dayCompletion(todayISO(cursor), JS_DAY_TO_KEY[cursor.getDay()], todayProgress.phase);
  if (!todayScore.full) cursor = addDays(cursor, -1);
  while (cursor >= parseISODate(appState.startDate)) {
    const progress = earnedProgress(cursor);
    const score = dayCompletion(todayISO(cursor), JS_DAY_TO_KEY[cursor.getDay()], progress.phase);
    if (!score.full) break;
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function productsView(ctx) {
  const products = Object.entries(routineData.products);
  const activeIds = new Set(routineIds(ctx));
  return h("section.view", null,
    h("div.plan-intro", null,
      h("span.kicker", null, "Produktbibliothek"),
      h("h1", null, "Produkte im Plan"),
      h("p", null, "Entscheidend ist, ab wann ein Produkt im Plan auftaucht und wie es in der aktuellen Routine angewendet wird.")
    ),
    h("div.grid", null,
      products.map(([id, p]) => h("article.product-card", null,
        h("div.product-media", null, productImg(p)),
        h("div.step-tags", null,
          h("span.tag", null, introductionLabel(id)),
          p.planRole ? h("span.tag", null, p.planRole) : null,
          h("span.tag", null, p.frequency),
          activeIds.has(id) ? h("span.tag.active", null, "heute") : null
        ),
        h("h2", null, p.name),
        h("p", null, p.longTerm || p.whyShort || p.role),
        h("footer", null,
          h("button.ghost-btn", { on: { click: () => openProduct(id) } }, "Details"),
          h("a.buy-btn", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, "Nachbestellen ↗")
        )
      ))
    )
  );
}

function introductionLabel(id) {
  const week = introducedWeek(id);
  if (week <= 1) return "ab Woche 1";
  if (week === 3) return "ab Woche 3";
  if (week === 5) return "ab Woche 5";
  return `ab Woche ${week}`;
}

function introducedWeek(id) {
  if (product(id).introducedWeek) return product(id).introducedWeek;
  if (Object.values(routineData.routines.morning).some((ids) => ids.includes(id))) return 1;
  if (Object.values(routineData.routines.evening.phase1).some((ids) => ids.includes(id))) return 1;
  if (Object.values(routineData.routines.evening.phase2).some((ids) => ids.includes(id))) return 3;
  if (Object.values(routineData.routines.evening.phase3).some((ids) => ids.includes(id))) return 5;
  return 1;
}

function rulesView() {
  return h("section.view", null,
    h("div.plan-intro", null,
      h("span.kicker", null, "Regeln"),
      h("h1", null, "Klartext für die Routine"),
      h("p", null, "Die Regeln verhindern vor allem, dass starke Wirkstoffe am selben Abend übereinander liegen.")
    ),
    h("div.rule-list", null,
      clearRules().map((rule, index) => h("article.rule-card", null,
        h("div.rule-number", null, String(index + 1)),
        h("h2", null, rule.title),
        h("p", null, rule.text),
        h("div.rule-meaning", null, h("b", null, "Bedeutet für dich: "), rule.meaning)
      ))
    ),
    h("div.notice", null, "Sicherheitsnotiz: Dieser Plan ersetzt keine dermatologische Diagnose. Bei anhaltendem Brennen, Schwellung, Ekzem, Rosazea-Verdacht oder starker Akne pausieren und dermatologisch klären.")
  );
}

function clearRules() {
  return routineData.rulesDetailed || [
    {
      title: "Nur ein starker Wirkstoff pro Abend",
      text: "Blemish + Age Defense, Blemish + Age Toner, Glycolic 10 und Retinol werden nicht kombiniert.",
      meaning: "Wenn heute Retinol dran ist, gibt es keinen Toner und kein Glycolic 10."
    },
    {
      title: "Morgens bleibt die Basis stabil",
      text: "Reinigung, Vitamin-C-Wechsel, P-TIOX, H.A., Daily Moisture und SPF bleiben jede Woche gleich.",
      meaning: "Die Wochenphasen verändern vor allem den Abendplan."
    },
    {
      title: "Retinol erst ab Woche 5",
      text: "Retinol startet nur, wenn Woche 1-4 ohne dauerhaftes Brennen, Schuppen oder starke Spannung liefen.",
      meaning: "Bei Stresshaut Retinol auf einen Abend reduzieren oder pausieren."
    },
    {
      title: "T-Zone und Wangen dürfen unterschiedlich sein",
      text: "Säuren und Clay-Maske eher auf T-Zone, trockene Wangen eher Recovery.",
      meaning: "Du musst trockene Partien nicht mit jedem Wirkstoff mitnehmen."
    },
    {
      title: "SPF ist Pflicht",
      text: "Nach Vitamin C, Säuren und Retinol ist Oil Shield morgens der letzte Schritt.",
      meaning: "Ohne SPF verliert der Plan seinen Sinn und Irritationen werden wahrscheinlicher."
    },
    {
      title: "Reset bei Irritation",
      text: "Bei Brennen, roten Flecken oder starker Trockenheit drei Tage nur Reinigung plus Barrierepflege.",
      meaning: "Dann keine Säure, kein Retinol, kein Blemish + Age Defense."
    }
  ];
}

function settingsView(ctx) {
  const dateInput = h("input", {
    type: "date",
    value: appState.startDate,
    "aria-label": "Startdatum Woche 1",
    on: { change: (event) => updateStartDate(event.target.value) }
  });
  return h("section.view", null,
    h("div.settings-panel", null,
      h("span.kicker", null, "Setup"),
      h("h1", null, "Startdatum & Wochenlogik"),
      h("p", null, "Woche 1 beginnt an diesem Datum. Die App rechnet daraus automatisch Woche, Phase, Wochentag und Morgen- oder Abendroutine."),
      h("div.field", null, h("label", null, "Startdatum Woche 1"), dateInput),
      h("div.logic-panel", null,
        infoTile("Aktuell", `Woche ${ctx.week}`),
        infoTile("Phase", routineData.phaseNames[ctx.phase]),
        infoTile("Nächste Änderung", nextChange(ctx))
      ),
      h("div.phase-dates", null,
        phaseDateRow("Woche 1-2", "0 bis 13", "volle Pflegetage"),
        phaseDateRow("Woche 3-4", "14 bis 27", "volle Pflegetage"),
        phaseDateRow("ab Woche 5", "ab 28", "volle Pflegetage")
      ),
      reminderPanel(),
      h("div.settings-actions", null,
        h("button.ghost-btn", { on: { click: forgetDevice } }, "Gerät abmelden"),
        h("button.ghost-btn", { on: { click: resetProgress } }, "Fortschritt löschen"),
        h("button.ghost-btn", { on: { click: logout } }, "Sperren")
      )
    )
  );
}

function reminderPanel() {
  const reminders = appState.reminders || DEFAULT_REMINDERS;
  const supported = "Notification" in window;
  const granted = supported && Notification.permission === "granted";
  const status = !supported
    ? "Nicht verfügbar"
    : reminders.enabled && granted
      ? `Aktiv · ${nextReminderLabel()}`
      : Notification.permission === "denied"
        ? "Blockiert"
        : "Aus";
  return h("div.reminder-panel", null,
    h("div.reminder-head", null,
      h("span.kicker", null, "Erinnerungen"),
      h("h2", null, "Routine-Ping"),
      h("p", null, status)
    ),
    h("div.reminder-times", null,
      timeField("Morgen", reminders.morning, (value) => updateReminderTime("morning", value)),
      timeField("Abend", reminders.evening, (value) => updateReminderTime("evening", value))
    ),
    h("div.action-row", null,
      h("button.primary-btn", {
        disabled: !supported || (reminders.enabled && granted),
        on: { click: enableReminders }
      }, reminders.enabled && granted ? "Aktiviert" : "Aktivieren"),
      h("button.ghost-btn", {
        disabled: !supported || !reminders.enabled,
        on: { click: disableReminders }
      }, "Deaktivieren"),
      h("button.ghost-btn", {
        disabled: !supported || !granted,
        on: { click: () => showRoutineNotification(activeSession()) }
      }, "Test")
    )
  );
}

function timeField(label, value, onChange) {
  return h("div.field", null,
    h("label", null, label),
    h("input", {
      type: "time",
      value,
      on: { change: (event) => onChange(event.target.value) }
    })
  );
}

async function enableReminders() {
  if (!("Notification" in window)) return;
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") {
    renderApp();
    return;
  }
  appState.reminders = { ...DEFAULT_REMINDERS, ...(appState.reminders || {}), enabled: true };
  saveState();
  scheduleReminder();
  renderApp();
}

function disableReminders() {
  appState.reminders = { ...DEFAULT_REMINDERS, ...(appState.reminders || {}), enabled: false };
  saveState();
  clearReminderTimer();
  renderApp();
}

function updateReminderTime(kind, value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return;
  appState.reminders = { ...DEFAULT_REMINDERS, ...(appState.reminders || {}), [kind]: value };
  saveState();
  scheduleReminder();
  renderApp();
}

function nextReminderLabel() {
  const next = nextReminder();
  if (!next) return "";
  return `${next.kind === SESSION.MORNING ? "Morgen" : "Abend"} ${next.time}`;
}

function nextReminder(now = new Date()) {
  const reminders = appState?.reminders || DEFAULT_REMINDERS;
  const candidates = [
    reminderCandidate(SESSION.MORNING, reminders.morning, now),
    reminderCandidate(SESSION.EVENING, reminders.evening, now)
  ].filter(Boolean).sort((a, b) => a.at - b.at);
  return candidates[0] || null;
}

function reminderCandidate(kind, time, now) {
  if (!/^\d{2}:\d{2}$/.test(time || "")) return null;
  const [hours, minutes] = time.split(":").map(Number);
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return { kind, time, at };
}

function scheduleReminder() {
  clearReminderTimer();
  const reminders = appState?.reminders;
  if (!reminders?.enabled || !("Notification" in window) || Notification.permission !== "granted") return;
  const next = nextReminder();
  if (!next) return;
  const delay = Math.max(1000, Math.min(next.at.getTime() - Date.now(), 2147483647));
  reminderTimer = setTimeout(async () => {
    await showRoutineNotification(next.kind);
    scheduleReminder();
  }, delay);
}

function clearReminderTimer() {
  if (!reminderTimer) return;
  clearTimeout(reminderTimer);
  reminderTimer = null;
}

async function showRoutineNotification(kind) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const isMorning = kind === SESSION.MORNING;
  const title = isMorning ? "Morgenroutine" : "Abendroutine";
  const body = isMorning
    ? "Zeit für Reinigung, Vitamin C, Feuchtigkeit und SPF."
    : "Zeit für die Abendrotation. Die App zeigt dir den heutigen Plan.";
  const options = {
    body,
    icon: "icon-192.png",
    badge: "icon-180.png",
    tag: `stn-care-${kind}`,
    renotify: true
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) {
      await reg.showNotification(title, options);
      return;
    }
  } catch (err) {}
  new Notification(title, options);
}

function phaseDateRow(label, from, to) {
  const joiner = to === "Dauerrotation" ? " · " : to.startsWith("volle") ? " " : " bis ";
  return h("div.date-row", null,
    h("b", null, label),
    h("span", null, `${from}${joiner}${to}`)
  );
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function updateStartDate(value) {
  if (!value) return;
  appState.startDate = value;
  appState.tracking = baselineTracking(todayISO());
  saveState();
  renderApp();
}

function resetProgress() {
  if (!confirm("Fortschritt wirklich löschen?")) return;
  appState.checks = {};
  appState.tracking = baselineTracking(todayISO());
  saveState();
  renderApp();
}

function forgetDevice() {
  try { localStorage.removeItem(PASS_KEY); } catch (err) {}
  rememberDevice = false;
  logout();
}

function logout() {
  stopClock();
  clearReminderTimer();
  routineData = null;
  selectedProduct = null;
  passEntry = "";
  passError = "";
  passBusy = false;
  renderLock();
}

function startClock() {
  if (clockTimer) return;
  lastAutoSession = routineData ? autoSession() : null;
  lastClockDateKey = todayISO();
  clockTimer = setInterval(() => {
    tickClockText();
    if (!routineData || !appState || sessionOverride) return;
    const nextSession = autoSession();
    const nextDateKey = todayISO();
    if (nextSession !== lastAutoSession || nextDateKey !== lastClockDateKey) {
      lastAutoSession = nextSession;
      lastClockDateKey = nextDateKey;
      renderApp();
    }
  }, 1000);
}

function stopClock() {
  if (!clockTimer) return;
  clearInterval(clockTimer);
  clockTimer = null;
  lastAutoSession = null;
  lastClockDateKey = null;
}

function tickClockText() {
  document.querySelectorAll("[data-clock='now']").forEach((node) => {
    node.textContent = `${dateLabel()} · ${timeLabel()}`;
  });
}

function openProduct(id) {
  selectedProduct = id;
  renderApp();
}

function closeProduct() {
  selectedProduct = null;
  renderApp();
}

function productModal(ctx, id) {
  const p = product(id);
  const ids = routineIds(ctx);
  const stepIndex = ids.indexOf(id);
  const currentUse = stepIndex >= 0 ? stepInstruction(ctx, id, stepIndex) : "";
  const caution = stepCaution(ctx, id);
  return h("div.modal-backdrop", { on: { click: (event) => { if (event.target.classList.contains("modal-backdrop")) closeProduct(); } } },
    h("article.modal", { role: "dialog", "aria-modal": "true", "aria-label": p.name },
      h("button.icon-btn.modal-close", { title: "Schließen", on: { click: closeProduct } }, "×"),
      h("header.modal-head", null,
        productImg(p),
        h("div", null,
          h("div.eyebrow", null, p.type),
          h("h2", null, p.name),
          h("p", null, p.role)
        )
      ),
      h("div.modal-body", null,
        h("div.info-grid", null,
          h("div.info-cell", null, h("b", null, "Menge"), p.amount),
          h("div.info-cell", null, h("b", null, "Zone"), p.zone),
          h("div.info-cell", null, h("b", null, "Im Plan"), introductionLabel(id)),
          h("div.info-cell", null, h("b", null, "Rolle"), p.planRole || p.type || "Pflege")
        ),
        productUsageOverview(id, p),
        productSchedulePanel(id, p),
        productInsight(p),
        currentUse
          ? h("div.notice.clean", null, h("b", null, `Jetzt in der ${ctx.session === SESSION.MORNING ? "Morgenroutine" : "Abendroutine"}: `), currentUse)
          : h("div.notice.clean", null, `Dieses Produkt ist heute in der aktuellen ${ctx.session === SESSION.MORNING ? "Morgenroutine" : "Abendroutine"} nicht dran.`),
        caution ? h("div.notice", null, caution) : null,
        h("div.action-row", null,
          h("a.buy-btn", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, "Produkt öffnen ↗"),
          h("button.ghost-btn", { on: { click: closeProduct } }, "Schließen")
        )
      )
    )
  );
}

function productUsageOverview(id, p) {
  const longTerm = p.longTerm || longTermLabel(id);
  const phase3Req = countProductInPhase(id, "phase3", false);
  const phase3Opt = countProductInPhase(id, "phase3", true);
  return h("section.usage-overview", null,
    h("article.usage-card.is-main", null,
      h("span.kicker", null, "Langfristig"),
      h("p", null, longTerm)
    ),
    h("article.usage-card", null,
      h("b", null, "Ab Woche 5"),
      h("p", null, [
        phase3Req ? `Pflicht: ${phase3Req}` : "",
        phase3Opt ? `${optionalModeLabel(id, "phase3")}: ${phase3Opt}` : "",
        !phase3Req && !phase3Opt ? "Nicht fest geplant" : ""
      ].filter(Boolean).join(" · "))
    )
  );
}

function optionalModeLabel(id, phase) {
  const modes = new Set();
  DAY_ORDER.forEach((day) => {
    optionalEntriesFor(SESSION.MORNING, phase, day).forEach((entry) => {
      if (entry.id === id) modes.add(entry.mode || "optional");
    });
    optionalEntriesFor(SESSION.EVENING, phase, day).forEach((entry) => {
      if (entry.id === id) modes.add(entry.mode || "optional");
    });
  });
  if (modes.has("swap") && modes.has("add")) return "Bei Bedarf/Swap";
  if (modes.has("swap")) return "Swap";
  return "Bei Bedarf";
}

function countProductInPhase(id, phase, optionalOnly) {
  let morning = 0;
  let evening = 0;
  let optional = 0;
  DAY_ORDER.forEach((day) => {
    if (!optionalOnly && routineIdsFor(SESSION.MORNING, phase, day).includes(id)) morning += 1;
    if (!optionalOnly && routineIdsFor(SESSION.EVENING, phase, day).includes(id)) evening += 1;
    if (optionalOnly && optionalEntriesFor(SESSION.MORNING, phase, day).some((entry) => entry.id === id)) optional += 1;
    if (optionalOnly && optionalEntriesFor(SESSION.EVENING, phase, day).some((entry) => entry.id === id)) optional += 1;
  });
  const parts = [];
  if (morning) parts.push(`${morning}x morgens`);
  if (evening) parts.push(`${evening}x abends`);
  if (optional) parts.push(`${optional}x sichtbar bei Bedarf`);
  return parts.join(", ");
}

function longTermLabel(id) {
  const required = countProductInPhase(id, "phase3", false);
  const optional = countProductInPhase(id, "phase3", true);
  if (required && optional) return `Bleibt langfristig fest eingeplant (${required}) und zusätzlich sichtbar bei Bedarf (${optional}).`;
  if (required) return `Bleibt langfristig fest eingeplant: ${required}.`;
  if (optional) return `Bleibt langfristig als sichtbarer Bedarfsschritt: ${optional}.`;
  return "Wird vor allem in der Aufbauphase genutzt oder nur bei besonderem Bedarf.";
}

function productSchedulePanel(id, p) {
  return h("section.product-timeline", null,
    h("div.product-timeline-head", null,
      h("span.kicker", null, "Einsatz im Plan"),
      h("h3", null, "Wann du es verwendest")
    ),
    phaseGuide().map((phase) => productScheduleRow(id, p, phase))
  );
}

function productScheduleRow(id, p, phase) {
  const morningDays = daysWithProduct(SESSION.MORNING, phase.id, id);
  const eveningDays = daysWithProduct(SESSION.EVENING, phase.id, id);
  const optionalDays = optionalDaysWithProduct(SESSION.EVENING, phase.id, id);
  const hasAny = morningDays.length || eveningDays.length || optionalDays.length;
  return h("article.timeline-row", { class: hasAny ? "" : "is-muted" },
    h("b", null, phase.range),
    h("div", null,
      morningDays.length ? h("p", null, `Morgens Pflicht (${morningDays.length}x/Woche): ${formatDayList(morningDays)}`) : null,
      eveningDays.length ? h("p", null, `Abends Pflicht (${eveningDays.length}x/Woche): ${formatDayList(eveningDays)}`) : null,
      optionalDays.length ? h("p", null, `Bei Bedarf/Swap (${optionalDays.length}x/Woche sichtbar): ${formatDayList(optionalDays)}`) : null,
      !hasAny ? h("p", null, "Nicht fest geplant.") : null,
      p.phaseUse?.[phase.id] ? h("small", null, p.phaseUse[phase.id]) : null
    )
  );
}

function daysWithProduct(session, phase, id) {
  return DAY_ORDER.filter((day) => routineIdsFor(session, phase, day).includes(id));
}

function optionalDaysWithProduct(session, phase, id) {
  return DAY_ORDER.filter((day) => optionalEntriesFor(session, phase, day).some((entry) => entry.id === id));
}

function formatDayList(days) {
  return days.map((day) => routineData.dayNames[day]).join(", ");
}

function productInsight(p) {
  return h("div.product-insight", null,
    h("article.insight-card.is-main", null,
      h("span.kicker", null, "Warum du es nimmst"),
      h("p", null, p.why || p.role)
    ),
    h("div.insight-grid", null,
      p.effect ? h("article.insight-card", null, h("b", null, "Wie es wirkt"), h("p", null, p.effect)) : null,
      p.result ? h("article.insight-card", null, h("b", null, "Woran du es merkst"), h("p", null, p.result)) : null,
      p.remember ? h("article.insight-card", null, h("b", null, "Merksatz"), h("p", null, p.remember)) : null
    ),
    h("p.product-detail-text", null, p.details)
  );
}

function formatISO(iso) {
  const date = iso instanceof Date ? iso : parseISODate(iso);
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

let swApplying = false;

function showUpdate(reg) {
  const box = document.getElementById("update");
  if (!box || box.firstChild) return;
  const button = h("button.primary-btn", { on: { click: () => applyUpdate(reg, button) } }, "Aktualisieren");
  box.appendChild(h("div.updatebar", null, h("span", null, "Neue Version verfügbar"), button));
}

function cacheBustedUrl() {
  const url = new URL(location.href);
  url.searchParams.set("app", APP_VERSION);
  url.searchParams.set("refresh", Date.now());
  return url.href;
}

async function clearAppCaches() {
  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith("stn-care-")).map((key) => caches.delete(key)));
}

function waitForControllerChange(ms = 900) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      navigator.serviceWorker.removeEventListener("controllerchange", finish);
      resolve();
    };
    navigator.serviceWorker.addEventListener("controllerchange", finish);
    setTimeout(finish, ms);
  });
}

async function applyUpdate(reg, button) {
  if (swApplying) return;
  swApplying = true;
  button.disabled = true;
  button.textContent = "Aktualisiere...";
  try {
    const freshReg = await navigator.serviceWorker.getRegistration() || reg;
    const worker = freshReg.waiting || freshReg.installing;
    if (worker) worker.postMessage({ type: "SKIP_WAITING" });
    if (freshReg.update) await freshReg.update().catch(() => {});
    await waitForControllerChange();
    await clearAppCaches();
  } catch (err) {
    // The hard reload below is the important fallback.
  }
  location.replace(cacheBustedUrl());
}

function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!swApplying) location.reload();
  });
  navigator.serviceWorker.register("service-worker.js").then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg);
    reg.addEventListener("updatefound", () => {
      const next = reg.installing;
      if (!next) return;
      next.addEventListener("statechange", () => {
        if (next.state === "installed" && navigator.serviceWorker.controller) showUpdate(reg);
      });
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) reg.update().catch(() => {});
    });
    setTimeout(() => reg.update().catch(() => {}), 1500);
    setInterval(() => {
      if (!document.hidden) reg.update().catch(() => {});
    }, 600000);
  }).catch(() => {});
}

if (document.readyState === "complete") setupServiceWorker();
else window.addEventListener("load", setupServiceWorker);

boot();
