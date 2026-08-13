"use strict";

/*
 * Decompi control-plane dashboard (M4 web UI).
 *
 * Minimal, dependency-free single-page dashboard for the M4 control-plane
 * API (src/server/api.ts). Every endpoint requires
 * `Authorization: Bearer <token>`; the token is persisted in localStorage.
 *
 * Endpoints used (contract from src/server/api.ts):
 *   GET /api/runs                       -> { runs: RunRecord[] }
 *   POST /api/runs                      -> 201 { run }   body: { pipeline, model, selector?, budgetMicroUsd? }
 *   GET /api/events?runId=&after=&limit= -> { events: EventRow[] }  (EventRow: seq, ts, runId, workItemId, type, level, data)
 *   GET /api/metrics                    -> { totalRuns, activeRuns, spendMicroUsd }
 *
 * Serve index.html + app.js from the same origin as the API (default bind
 * 127.0.0.1). An optional ?api=http://host:port override is honored ONLY
 * when it resolves to the page's OWN origin: the bearer token must never
 * leave the origin (SPEC §16 — a cross-origin ?api would exfiltrate the
 * token in the Authorization header).
 */

/**
 * Resolve the API base URL. Same-origin by default; a ?api= override is
 * accepted only when it resolves to `window.location.origin` (a different
 * host, port, or scheme is ignored, never used cross-origin).
 */
function resolveApiBase() {
  const raw = new URLSearchParams(window.location.search).get("api");
  if (!raw) return "";
  try {
    const api = new URL(raw, window.location.href);
    if (api.origin === window.location.origin) {
      return api.href.replace(/\/$/, ""); // no trailing slash: API_BASE + "/api/..."
    }
  } catch (e) {
    /* malformed override: fall back to same-origin */
  }
  return "";
}

const API_BASE = resolveApiBase();
const TOKEN_KEY = "decompi.token";
const POLL_MS = 2000;            // runs + metrics + event tail poll cadence
const EVENT_LIMIT = 1000;        // rows per /api/events page (server caps at 10k)
const MAX_RENDERED_EVENTS = 500; // keep the DOM bounded for long runs

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let refs = {};

const state = {
  runs: [],
  selectedId: null,
  cursors: new Map(), // runId -> last seq consumed from /api/events
  events: new Map(),  // runId -> EventRow[] (grows; render is capped)
  busy: { runs: false, metrics: false, events: false },
  bannerTimer: null,
};

// ---------------------------------------------------------------- utilities

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtNum(n) {
  return n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US");
}

function fmtTs(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

/** fetch + bearer auth + JSON; throws ApiError (401 on bad token) or Error (network). */
async function request(path, options) {
  const headers = { Authorization: "Bearer " + refs.tokenInput.value.trim() };
  if (options && options.body !== undefined) headers["Content-Type"] = "application/json";
  const opts = Object.assign({}, options, { headers });
  let res;
  try {
    res = await fetch(API_BASE + path, opts);
  } catch (err) {
    throw new Error("network error: " + err.message);
  }
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    /* non-JSON body — fall through to status check */
  }
  if (!res.ok) {
    throw new ApiError(res.status, body && body.error ? body.error : "HTTP " + res.status);
  }
  return body;
}

function showBanner(text, isAuth) {
  refs.banner.textContent = text;
  refs.banner.classList.remove("hidden");
  refs.banner.classList.toggle("is-auth", Boolean(isAuth));
  if (isAuth) refs.tokenInput.classList.add("bad-token");
  clearTimeout(state.bannerTimer);
  state.bannerTimer = setTimeout(() => refs.banner.classList.add("hidden"), 8000);
}

function handleError(err) {
  const isAuth = err instanceof ApiError && err.status === 401;
  showBanner(
    isAuth ? "401 unauthorized — check the token" : String(err.message || err),
    isAuth,
  );
}

// ---------------------------------------------------------------- rendering

function renderRuns() {
  const tbody = refs.runsTbody;
  tbody.textContent = "";
  refs.runsCount.textContent = state.runs.length + " total";
  for (const run of state.runs) {
    const tr = el("tr", run.id === state.selectedId ? "selected" : "");
    const cells = [run.id, run.pipeline, run.model];
    for (let i = 0; i < cells.length; i++) {
      tr.appendChild(el("td", "muted", cells[i]));
    }
    const tdStatus = el("td");
    const badge = el("span", "badge status-" + run.status, run.status);
    tdStatus.appendChild(badge);
    tr.appendChild(tdStatus);
    tr.appendChild(el("td", "muted", run.budgetMicroUsd === null ? "∞" : fmtNum(run.budgetMicroUsd)));
    tr.appendChild(el("td", "muted", fmtTs(run.createdAt)));
    tr.appendChild(el("td", "muted", fmtTs(run.finishedAt)));
    tr.addEventListener("click", () => selectRun(run.id));
    tbody.appendChild(tr);
  }
}

function renderMetrics(m) {
  const host = refs.metrics;
  host.textContent = "";
  const spans = [
    [fmtNum(m.activeRuns), " active"],
    [fmtNum(m.totalRuns), " total runs"],
    [fmtNum(m.spendMicroUsd), " µUSD spent"],
  ];
  for (const [value, label] of spans) {
    const s = el("span", "metric");
    s.appendChild(el("strong", "", value));
    s.appendChild(document.createTextNode(label));
    host.appendChild(s);
  }
}

function renderRunMeta() {
  const host = refs.runMeta;
  host.textContent = "";
  const run = state.runs.find((r) => r.id === state.selectedId);
  if (!run) return;
  const items = [
    ["run", run.id],
    ["pipeline", run.pipeline],
    ["model", run.model],
    ["status", run.status],
    ["budget", run.budgetMicroUsd === null ? "unlimited" : fmtNum(run.budgetMicroUsd) + " µUSD"],
    ["created", fmtTs(run.createdAt)],
    ["started", fmtTs(run.startedAt)],
    ["finished", fmtTs(run.finishedAt)],
  ];
  for (const [label, value] of items) {
    const item = el("span", "dim", label + " ");
    item.appendChild(el("strong", "", String(value)));
    host.appendChild(item);
  }
}

function renderEvents() {
  const host = refs.events;
  host.textContent = "";
  const id = state.selectedId;
  const list = state.events.get(id) || [];
  if (list.length === 0) {
    host.appendChild(el("div", "placeholder", "no events yet for this run"));
    return;
  }
  const shown = list.slice(-MAX_RENDERED_EVENTS);
  for (const ev of shown) {
    const row = el("div", "event level-" + (ev.level || "info"));
    const head = el("div", "event-head");
    let headText =
      "[" + fmtTs(ev.ts) + "] " + (ev.level || "info") + " " + ev.type + "  seq=" + ev.seq;
    if (ev.workItemId) headText += "  workItem=" + ev.workItemId;
    head.textContent = headText;
    row.appendChild(head);
    if (ev.data && Object.keys(ev.data).length > 0) {
      const pre = el("pre", "event-data", JSON.stringify(ev.data, null, 2));
      row.appendChild(pre);
    }
    host.appendChild(row);
  }
  if (list.length > shown.length) {
    host.appendChild(
      el("div", "dim", "… " + (list.length - shown.length) + " older events hidden"),
    );
  }
}

// ---------------------------------------------------------------- polling

async function refreshRuns() {
  if (state.busy.runs) return;
  state.busy.runs = true;
  try {
    const data = await request("/api/runs");
    state.runs = (data && data.runs) || [];
    renderRuns();
    renderRunMeta();
  } catch (err) {
    handleError(err);
  } finally {
    state.busy.runs = false;
  }
}

async function refreshMetrics() {
  if (state.busy.metrics) return;
  state.busy.metrics = true;
  try {
    const data = await request("/api/metrics");
    renderMetrics(data || { totalRuns: 0, activeRuns: 0, spendMicroUsd: 0 });
  } catch (err) {
    handleError(err);
  } finally {
    state.busy.metrics = false;
  }
}

/** Full backfill of a run's event history (after=0, paged to EVENT_LIMIT). */
async function loadEvents(runId) {
  const list = state.events.get(runId) || [];
  list.length = 0;
  let after = 0;
  try {
    for (;;) {
      const data = await request(
        "/api/events?runId=" + encodeURIComponent(runId) + "&after=" + after + "&limit=" + EVENT_LIMIT,
      );
      const evs = (data && data.events) || [];
      if (evs.length === 0) break;
      list.push.apply(list, evs);
      after = evs[evs.length - 1].seq;
      if (evs.length < EVENT_LIMIT) break;
    }
    state.cursors.set(runId, after);
    renderEvents();
  } catch (err) {
    handleError(err);
  }
}

/** Incremental tail poll for the selected run (only rows with seq > cursor). */
async function pollEvents() {
  const id = state.selectedId;
  if (!id || state.busy.events) return;
  state.busy.events = true;
  try {
    const after = state.cursors.get(id) || 0;
    const data = await request(
      "/api/events?runId=" + encodeURIComponent(id) + "&after=" + after + "&limit=" + EVENT_LIMIT,
    );
    if (state.selectedId !== id) return; // user switched runs mid-flight
    const evs = (data && data.events) || [];
    if (evs.length > 0) {
      const list = state.events.get(id) || [];
      list.push.apply(list, evs);
      state.cursors.set(id, evs[evs.length - 1].seq);
      renderEvents();
    }
    renderRunMeta();
  } catch (err) {
    handleError(err);
  } finally {
    state.busy.events = false;
  }
}

// ---------------------------------------------------------------- actions

async function selectRun(id) {
  state.selectedId = id;
  if (!state.events.has(id)) {
    state.events.set(id, []);
    state.cursors.set(id, 0);
  }
  renderRuns();
  renderRunMeta();
  await loadEvents(id);
}

async function onSubmitRun(event) {
  event.preventDefault();
  const pipeline = refs.pipelineInput.value.trim();
  const model = refs.modelInput.value.trim();
  if (!pipeline || !model) {
    showBanner("pipeline and model are required");
    return;
  }
  const body = { pipeline, model };

  const selectorRaw = refs.selectorInput.value.trim();
  if (selectorRaw !== "") {
    let parsed;
    try {
      parsed = JSON.parse(selectorRaw);
    } catch (err) {
      showBanner("selector is not valid JSON: " + err.message);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      showBanner("selector must be a JSON object");
      return;
    }
    body.selector = parsed;
  }

  const budgetRaw = refs.budgetInput.value.trim();
  if (budgetRaw !== "") {
    const budget = Number(budgetRaw);
    if (!Number.isInteger(budget) || budget < 0) {
      showBanner("budget must be a non-negative integer (micro-USD)");
      return;
    }
    body.budgetMicroUsd = budget;
  }

  try {
    await request("/api/runs", { method: "POST", body: JSON.stringify(body) });
    refs.selectorInput.value = "";
    refs.budgetInput.value = "";
    refreshRuns();
    refreshMetrics();
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------- init

function init() {
  refs = {
    tokenInput: document.getElementById("token"),
    banner: document.getElementById("banner"),
    metrics: document.getElementById("metrics"),
    runForm: document.getElementById("run-form"),
    pipelineInput: document.getElementById("pipeline"),
    modelInput: document.getElementById("model"),
    selectorInput: document.getElementById("selector"),
    budgetInput: document.getElementById("budget"),
    runsTbody: document.getElementById("runs-tbody"),
    runsCount: document.getElementById("runs-count"),
    runMeta: document.getElementById("run-meta"),
    events: document.getElementById("events"),
  };

  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) refs.tokenInput.value = saved;

  refs.tokenInput.addEventListener("input", () => {
    refs.tokenInput.classList.remove("bad-token");
    try {
      localStorage.setItem(TOKEN_KEY, refs.tokenInput.value);
    } catch (err) {
      /* storage unavailable — token still applies to this session */
    }
  });

  refs.runForm.addEventListener("submit", onSubmitRun);

  refreshRuns();
  refreshMetrics();
  setInterval(() => {
    refreshRuns();
    refreshMetrics();
    pollEvents();
  }, POLL_MS);
}

init();
