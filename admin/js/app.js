// Live Wallpapers 4K - admin panel. Plain ES modules, no build step; served from the wallpaper site (GitHub Pages)
// at /admin/. Reads feed.json + admin.json, edits admin.json, publishes through the GitHub API.
import { GitHub } from "./github.js?v=23a2a00d47";
import { Model, KINDS, KIND_LABEL, TAGS, DEFAULT_CONFIG, DEFAULT_BANNERS, ORDER_LISTS } from "./model.js?v=23a2a00d47";
import { processPhoto, processVideo, posterFromUrl, processCover, rethumb, loadSource, MAX_VIDEO_MB } from "./media.js?v=23a2a00d47";
import { LOGIN_FILE, lock, unlock, fetchLogin } from "./login.js?v=23a2a00d47";

const STORE_KEY = "lw4k_admin";
const DEFAULT_REPO = "manavbavadiya/lumawalls-feed";
const DEFAULT_DATA_REPO = "manavbavadiya/lumawalls-admin-data";
const SITE = new URL("../", location.href).href; // the wallpaper site this panel is served from
const MOCK = new URLSearchParams(location.search).has("mock"); // local testing: publish shows the files instead
// One-time owner setup (admin/?setup): GitHub token + admin ID and password. The normal login page asks only for ID and password.
const SETUP = new URLSearchParams(location.search).has("setup");
const NEW_FOR_SEC = 14 * 24 * 3600;
const PAGE = 120;
const LICENCES = ["", "Own work", "Public domain", "CC0", "CC BY 4.0", "CC BY-SA 4.0", "Licensed for this app"];
const titleFrom = (name) => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();

const state = {
  gh: null, repo: DEFAULT_REPO, dataRepo: DEFAULT_DATA_REPO, branch: "main", user: "", readOnly: false,
  model: null, page: "dashboard",
  filters: { kind: "", category: "", list: "", pro: "", status: "", q: "", sort: "recommended" },
  shown: PAGE, selected: new Set(),
  buyers: undefined, buyersError: null,
  upload: null,
  bulkUpload: null, // several files picked at once on the Upload page
  reorder: null, // {key, ids} while dragging a list into order on the Wallpapers page
  history: undefined, historyError: null,
  login: null, // the site's encrypted ID + password sign-in (admin-login.json), null = not set up
  local: false, // served by backend/tools/admin_server.py on this computer: it checks the login and publishes
};

// ---- tiny DOM helpers ---------------------------------------------------------------------------------------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  const after = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected") after[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  Object.assign(el, after);
  return el;
}

const ICONS = {
  dash: "M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z",
  cats: "M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z",
  walls: "M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z",
  up: "M5 20h14v-2H5zm7-16l-6 6h4v6h4v-6h4z",
  crown: "M3 18h18v2.5H3zm.2-1.5L2 6.5l5.6 4.3L12 3.5l4.4 7.3L22 6.5l-1.2 10z",
  buyers: "M16 11c1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 3-1.34 3-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05C16.19 13.89 17 15.02 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
  eye: "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z",
  eyeOff: "M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z",
  banner: "M3 5h18v6H3zm0 8h11v6H3zm13 0h5v6h-5z",
  chart: "M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z",
  history: "M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.1L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8z",
  gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z",
  out: "M10 17l1.4-1.4L8.8 13H20v-2H8.8l2.6-2.6L10 7l-5 5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4z",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICONS[name]);
  svg.append(p);
  return svg;
}

function toast(msg, err = false) {
  const t = h("div", { class: "toast" + (err ? " err" : "") }, msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), err ? 7000 : 3500);
}

/** A password input with an eye button that shows / hides what was typed. */
function withEye(input) {
  const eye = h("button", { type: "button", class: "eye", "aria-label": "Show password", title: "Show password" }, icon("eye"));
  eye.onclick = () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.replaceChildren(icon(show ? "eyeOff" : "eye"));
    const label = show ? "Hide password" : "Show password";
    eye.setAttribute("aria-label", label); eye.title = label;
    input.focus();
  };
  return h("div", { class: "pw" }, input, eye);
}

function seg(options, value, onPick) {
  return h("div", { class: "seg" }, options.map(([v, label, cls]) =>
    h("button", { type: "button", class: (v === value ? "on " : "") + (cls || ""), onclick: () => onPick(v) }, label)));
}

const fmtDate = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : "never");
const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const store = {
  load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY) || "{}"); } catch (_) { return {}; } },
  save(v, remember) {
    try {
      localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY);
      (remember ? localStorage : sessionStorage).setItem(STORE_KEY, JSON.stringify(v));
    } catch (_) { /* private mode: keep it in memory only */ }
  },
  clear() { try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ } },
};

// ---- start / sign in ---------------------------------------------------------------------------------------

async function start() {
  // Local mode: backend/tools/admin_server.py answers /api/status; sign-in and publishing go through it (no token).
  const local = MOCK ? null : await fetch(SITE + "api/status", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (local && local.local) {
    state.local = true;
    if (local.repo) state.repo = local.repo;
    state.user = "this computer";
    return local.signedIn ? loadData() : renderPasswordLogin();
  }
  state.login = await fetchLogin(SITE, MOCK ? null : DEFAULT_REPO);
  if (MOCK) { state.readOnly = false; state.user = "local test"; return loadData(); }
  const saved = store.load();
  if (saved.repo) state.repo = saved.repo;
  if (saved.dataRepo) state.dataRepo = saved.dataRepo;
  if (saved.token) {
    try { await signIn(saved.token); return; } catch (e) { toast(e.message, true); }
  }
  renderLogin();
}

/** Checks that [gh]'s token can open and change the wallpaper site; returns the repo info or throws a plain message. */
async function checkToken(gh) {
  const owner = state.repo.split("/")[0], name = state.repo.split("/")[1];
  const r = await gh.repo(state.repo).catch((e) => {
    throw new Error(e.status === 401 ? "GitHub did not accept this token: copy the whole token again (it starts with github_pat_) and check it has not expired." : e.status === 404
      ? `This token cannot open ${state.repo}. Create the token while signed in to GitHub as ${state.repo.split("/")[0]}, with Repository access → ${state.repo.split("/")[1]}.` : e.message);
  });
  if (!r.canPush) throw new Error(`This token cannot change ${state.repo}. Create the token while signed in to GitHub as ${owner}, with Repository access → ${name} and Permissions → Contents → Read and write.`);
  return r;
}

async function signIn(token) {
  const gh = new GitHub(token);
  const r = await checkToken(gh);
  state.gh = gh;
  state.branch = r.defaultBranch;
  state.readOnly = false;
  state.user = state.repo.split("/")[0];
  await loadData();
}

async function loadData() {
  document.getElementById("app").replaceChildren(h("div", { class: "boot" }, "Loading the wallpaper list…"));
  try {
    let feedText, adminText;
    if (state.gh) {
      [feedText, adminText] = await Promise.all([
        state.gh.readText(state.repo, "feed.json", state.branch),
        state.gh.readText(state.repo, "admin.json", state.branch),
      ]);
    } else {
      const get = async (p) => { const r = await fetch(SITE + p, { cache: "no-store" }); return r.ok ? r.text() : null; };
      [feedText, adminText] = await Promise.all([get("feed.json"), get("admin.json")]);
    }
    if (!feedText) throw new Error("feed.json was not found on the wallpaper site.");
    state.model = new Model(JSON.parse(feedText), adminText ? JSON.parse(adminText) : null);
    renderApp();
  } catch (e) {
    document.getElementById("app").replaceChildren(h("div", { class: "boot" }, "Could not load: " + e.message));
  }
}

function renderLogin(error) {
  return SETUP && !state.local ? renderSetup(error) : renderPasswordLogin(error);
}

/** One-time setup: sign in with the GitHub token and save the admin ID + password (the token, encrypted with them). */
function renderSetup(error) {
  const saved = store.load();
  const token = h("input", { type: "password", placeholder: "github_pat_…", autocomplete: "off", value: "" });
  const id = h("input", { type: "text", autocomplete: "username", autocapitalize: "off", spellcheck: "false", value: saved.id || "admin" });
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { type: "password", autocomplete: "new-password" });
  const repo = h("input", { type: "text", value: state.repo });
  const dataRepo = h("input", { type: "text", value: state.dataRepo });
  const msg = h("div", { class: "hint", style: { color: "#ffb4ad", minHeight: "20px" } }, error || "");
  const go = h("button", { class: "btn primary", type: "submit" }, "Save and sign in");
  const form = h("form", {
    onsubmit: async (ev) => {
      ev.preventDefault();
      msg.style.color = "#ffb4ad";
      if (!token.value.trim()) { msg.textContent = "Paste your GitHub token first: create it with the link below, copy it, and paste it in the GitHub token box."; token.focus(); return; }
      if (id.value.trim().length < 3) { msg.textContent = "The ID needs at least 3 characters."; return; }
      if (pw.value.length < 8) { msg.textContent = "The password needs at least 8 characters."; return; }
      if (pw.value !== pw2.value) { msg.textContent = "The two passwords are different."; return; }
      go.disabled = true; msg.style.color = ""; msg.textContent = "Checking the token…";
      state.repo = repo.value.trim(); state.dataRepo = dataRepo.value.trim();
      const key = token.value.trim();
      let text;
      try {
        const gh = new GitHub(key);
        const r = await checkToken(gh);
        msg.textContent = "Saving the ID and password…";
        text = await lock(id.value, pw.value, { token: key, repo: state.repo, dataRepo: state.dataRepo });
        await gh.commit(state.repo, r.defaultBranch, "Admin: sign-in ID and password updated", [{ path: LOGIN_FILE, text }]);
      } catch (e) {
        msg.style.color = "#ffb4ad";
        msg.textContent = e.status === 403 || e.status === 404
          ? "This token can read the site but cannot save to it. On GitHub, edit the token: Permissions → Contents → Read and write (and Repository access → lumawalls-feed), then press Save again."
          : e.message;
        go.disabled = false;
        return;
      }
      state.login = JSON.parse(text);
      store.save({ token: key, repo: state.repo, dataRepo: state.dataRepo, id: id.value.trim(), remember: false }, false);
      history.replaceState(null, "", location.pathname);
      toast("Saved. From now on sign in with this ID and password (the website takes about a minute to update).");
      try { await signIn(key); } catch (e) { renderPasswordLogin(e.message); }
    },
  },
    h("label", { class: "field" }, h("span", {}, "GitHub token"), withEye(token)),
    h("label", { class: "field" }, h("span", {}, "Admin ID"), id),
    h("label", { class: "field" }, h("span", {}, "Password (8 or more characters)"), withEye(pw)),
    h("label", { class: "field" }, h("span", {}, "Repeat the password"), withEye(pw2)),
    h("details", {}, h("summary", {}, "Repositories"),
      h("label", { class: "field" }, h("span", {}, "Wallpaper site (public)"), repo),
      h("label", { class: "field" }, h("span", {}, "Buyers data (private)"), dataRepo)),
    msg,
    h("div", { class: "row" }, go),
  );
  loginCard(h("h2", { style: { margin: "0 0 12px" } }, "One-time setup"), form,
    h("p", { class: "hint", style: { marginTop: "18px" } },
      "The panel saves your changes to GitHub, so it needs a GitHub key once. Create a token at ",
      h("a", { href: "https://github.com/settings/personal-access-tokens/new", target: "_blank", rel: "noopener" }, "GitHub › Fine-grained tokens"),
      ": Repository access → only ", h("b", {}, "lumawalls-feed"), " (and ", h("b", {}, "lumawalls-admin-data"), " once it exists); Permissions → Contents: Read and write. ",
      "It is saved encrypted with the ID and password; after this, the login page asks only for the ID and password. Do this again only if the token expires."));
}

function loginCard(...kids) {
  document.getElementById("app").replaceChildren(h("div", { class: "login" }, h("div", { class: "card" },
    h("div", { class: "brand" }, h("img", { src: "icon.png", alt: "" }), h("div", {}, h("b", {}, "Live Wallpapers 4K"), h("span", {}, "Admin panel"))),
    ...kids)));
}

function renderPasswordLogin(error) {
  const saved = store.load();
  const id = h("input", { type: "text", autocomplete: "username", autocapitalize: "off", spellcheck: "false", value: saved.id || "" });
  const password = h("input", { type: "password", autocomplete: "current-password", value: "" });
  const remember = h("input", { type: "checkbox", checked: !!saved.remember });
  const msg = h("div", { class: "hint", style: { color: "#ffb4ad", minHeight: "20px" } }, error || "");
  const go = h("button", { class: "btn primary", type: "submit" }, "Sign in");
  const form = h("form", {
    onsubmit: async (ev) => {
      ev.preventDefault();
      go.disabled = true; msg.textContent = "Checking…"; msg.style.color = "";
      if (state.local) {
        try {
          const r = await fetch(SITE + "api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: id.value, password: password.value }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || "Could not sign in.");
          store.save({ id: id.value.trim() }, true);
          await loadData();
        } catch (e) { msg.style.color = "#ffb4ad"; msg.textContent = e.message; go.disabled = false; }
        return;
      }
      try {
        if (!state.login) state.login = await fetchLogin(SITE, DEFAULT_REPO);
        if (!state.login) throw new Error("Sign-in is not set up yet: the owner opens this page with ?setup at the end of the address once.");
        const p = await unlock(state.login, id.value, password.value);
        if (p.repo) state.repo = p.repo;
        if (p.dataRepo) state.dataRepo = p.dataRepo;
        await signIn(p.token).catch((e) => {
          throw new Error(e.message + " The owner opens this page with ?setup at the end of the address once, with a new GitHub token.");
        });
        store.save({ token: p.token, repo: state.repo, dataRepo: state.dataRepo, id: id.value.trim(), remember: remember.checked }, remember.checked);
      } catch (e) { msg.style.color = "#ffb4ad"; msg.textContent = e.message; go.disabled = false; }
    },
  },
    h("label", { class: "field" }, h("span", {}, "Admin ID"), id),
    h("label", { class: "field" }, h("span", {}, "Password"), withEye(password)),
    state.local ? null : h("label", { class: "check", style: { marginBottom: "14px" } }, remember, "Remember on this browser"),
    msg,
    h("div", { class: "row" }, go));
  loginCard(form);
  (id.value ? password : id).focus();
}

function signOut() {
  if (state.local) fetch(SITE + "api/logout", { method: "POST" }).catch(() => {});
  const id = store.load().id;
  store.clear();
  if (id) store.save({ id }, false);
  state.gh = null; state.model = null; state.buyers = undefined;
  renderLogin();
}

// ---- shell -------------------------------------------------------------------------------------------------

const PAGES = [
  ["dashboard", "Dashboard", "dash"],
  ["categories", "Categories", "cats"],
  ["wallpapers", "Wallpapers", "walls"],
  ["upload", "Upload", "up"],
  ["banners", "Home banners", "banner"],
  ["premium", "Premium & Ads", "crown"],
  ["stats", "Statistics", "chart"],
  ["history", "History", "history"],
  ["buyers", "Buyers", "buyers"],
  ["settings", "Settings", "gear"],
];

let topBar;
let renderedPage = null;
function renderApp() {
  // Stay where you were after an edit; only a new page starts at the top.
  const keepScroll = renderedPage === state.page ? window.scrollY : 0;
  renderedPage = state.page;
  const side = h("nav", { class: "side" },
    h("div", { class: "brand" }, h("img", { src: "icon.png", alt: "" }), h("div", {}, h("b", {}, "Live Wallpapers 4K"), h("span", {}, "Admin"))),
    PAGES.map(([id, label, ic]) => h("button", { class: "nav" + (state.page === id ? " on" : ""), onclick: () => go(id) }, icon(ic), label)),
    h("div", { class: "grow" }),
    h("div", { class: "who" }, state.readOnly ? "Read-only (not signed in)" : MOCK ? "Local test mode" : state.local ? `This computer · ${state.repo}` : `Signed in · ${state.repo}`),
    state.gh || state.local || state.readOnly ? h("button", { class: "nav signout", onclick: signOut }, icon("out"), state.readOnly ? "Sign in" : "Sign out") : null,
  );
  topBar = h("div", { class: "top" });
  const content = h("div", { class: "content" });
  document.getElementById("app").replaceChildren(h("div", { class: "shell" }, side, h("main", { class: "main" }, topBar, content)));
  updateTop();
  const page = {
    dashboard: pageDashboard, categories: pageCategories, wallpapers: pageWallpapers, upload: pageUpload, banners: pageBanners,
    premium: pagePremium, stats: pageStats, history: pageHistory, buyers: pageBuyers, settings: pageSettings,
  }[state.page];
  page(content);
  window.scrollTo(0, keepScroll);
}

function go(page, filters) {
  state.page = page;
  if (filters) { state.filters = { ...state.filters, ...filters }; state.shown = PAGE; state.selected.clear(); }
  renderApp();
}

function updateTop() {
  if (!topBar) return;
  const m = state.model;
  const n = m.changes().length;
  const title = PAGES.find((p) => p[0] === state.page)[1];
  topBar.replaceChildren(
    h("h1", {}, title),
    m.dirty ? h("span", { class: "hint" }, m.changes().join(" · ")) : h("span", { class: "hint" }, "No unpublished changes"),
    h("button", { class: "btn primary", disabled: !m.dirty, onclick: publish }, n ? `Publish (${n})` : "Publish"),
  );
}

function changed() {
  updateTop();
}

window.addEventListener("beforeunload", (e) => { if (state.model && state.model.dirty) { e.preventDefault(); e.returnValue = ""; } });

// ---- publish -----------------------------------------------------------------------------------------------

function modal(...kids) {
  const wrap = h("div", { class: "modal-wrap", onclick: (e) => { if (e.target === wrap) wrap.remove(); } }, h("div", { class: "modal" }, ...kids));
  document.body.append(wrap);
  return wrap;
}

function publish() {
  const m = state.model;
  const list = m.changes();
  if (state.readOnly) {
    const w = modal(h("h2", {}, "Sign in to publish"),
      h("p", {}, "You are viewing read-only. Sign in with a GitHub token to publish, or download admin.json and commit it yourself."),
      m.uploads.size ? h("p", { class: "hint" }, `${m.uploads.size} uploaded file(s) can only be published when signed in.`) : null,
      h("div", { class: "row end" },
        h("button", { class: "btn", onclick: () => { downloadAdmin(); w.remove(); } }, "Download admin.json"),
        h("button", { class: "btn primary", onclick: () => { w.remove(); signOut(); } }, "Sign in")));
    return;
  }
  const steps = h("div", { class: "steps" });
  const ok = h("button", { class: "btn primary" }, "Publish now");
  const w = modal(h("h2", {}, "Publish changes"),
    h("ul", {}, list.map((c) => h("li", {}, c))),
    h("p", { class: "hint" }, "Phones pick this up within an hour, or straight away when the user taps Reload. The website itself can take a few minutes to update."),
    steps,
    h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => w.remove() }, "Cancel"), ok));
  ok.onclick = async () => {
    ok.disabled = true;
    const files = m.publishFiles();
    const message = `Admin: ${list.join(", ")}`;
    try {
      if (MOCK) {
        console.log("MOCK publish", message, files.map((f) => f.path + (f.delete ? " (delete)" : f.bytes ? ` (${f.bytes.length} bytes)` : ` (${f.text.length} chars)`)));
        window.__lastPublish = { message, files };
        steps.append(h("div", {}, `Test mode: ${files.length} file(s) prepared, nothing sent.`));
      } else if (state.local) {
        steps.append(h("div", {}, "Saving and pushing to GitHub…"));
        await localPublish(message, files);
      } else {
        await state.gh.commit(state.repo, state.branch, message, files, (s) => steps.append(h("div", {}, s)));
      }
      m.markPublished();
      state.history = undefined;
      w.remove();
      toast("Published");
      renderApp();
    } catch (e) {
      steps.append(h("div", { style: { color: "#ffb4ad" } }, e.message));
      ok.disabled = false;
    }
  };
}

/** Sends the files to backend/tools/admin_server.py, which commits and pushes them with this computer's git login. */
async function localPublish(message, files) {
  const b64 = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  };
  const body = JSON.stringify({ message, files: files.map((f) => (f.delete ? { path: f.path, delete: true } : f.bytes ? { path: f.path, b64: b64(f.bytes) } : { path: f.path, text: f.text })) });
  const r = await fetch(SITE + "api/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { signOut(); throw new Error("Signed out: sign in again, then publish."); }
  if (!r.ok) throw new Error(d.error || `Publish failed (${r.status})`);
  return d.commit;
}

function downloadAdmin() {
  const files = state.model.publishFiles();
  const blob = new Blob([files[0].text], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: "admin.json" });
  document.body.append(a); a.click(); a.remove();
}

// ---- dashboard ---------------------------------------------------------------------------------------------

function pageDashboard(root) {
  const m = state.model;
  const vs = m.views();
  const live = vs.filter((v) => !v.hidden);
  const stat = (n, label) => h("div", { class: "stat" }, h("b", {}, n.toLocaleString()), h("span", {}, label));
  root.append(
    h("div", { class: "stats" },
      stat(live.length, "wallpapers on phones"),
      ...KINDS.map((k) => stat(live.filter((v) => v.wall.kind === k).length, KIND_LABEL[k])),
      stat(live.filter((v) => v.wall.pro).length, "Pro"),
      stat(vs.filter((v) => v.hidden).length, "hidden"),
      stat(m.admin.added.walls.length, "uploaded here")),
    h("div", { class: "grid2" },
      h("div", { class: "card" }, h("h2", {}, "Status"),
        h("p", {}, "Wallpaper list built: ", h("b", {}, fmtDate(m.feed.generatedAt))),
        h("p", {}, "Admin settings last published: ", h("b", {}, fmtDate(m.admin.updatedAt))),
        h("p", {}, "Popularity numbers: ", h("b", {}, m.feed.statsDay || "not yet")),
        h("p", { class: "hint" }, "Phones download changes within an hour of publishing, or at once with the Reload button in the app.")),
      h("div", { class: "card" }, h("h2", {}, "Pro and ads"),
        h("p", {}, "Prices shown before Google Play loads: ", h("b", {}, `${m.admin.config.weeklyPrice}/week`), " (", m.admin.config.trialDays, "-day trial), ", h("b", {}, m.admin.config.lifetimePrice), " once"),
        h("p", {}, "Ads: ", h("b", {}, m.admin.config.adsEnabled ? "on" : "off"),
          m.admin.config.adsEnabled ? ` · full-screen ad every ${m.admin.config.interstitialEveryPreviews || "–"} wallpapers opened, at most one per ${m.admin.config.interstitialMinGapSec}s` : ""),
        h("div", { class: "row" }, h("button", { class: "btn", onclick: () => go("premium") }, "Edit"), h("button", { class: "btn", onclick: () => go("buyers") }, "Buyers")))),
    signInCard(),
    h("div", { class: "card" }, h("h2", {}, "Quick actions"),
      h("div", { class: "row" },
        h("button", { class: "btn", onclick: () => go("upload") }, "Upload a wallpaper"),
        h("button", { class: "btn", onclick: () => go("categories") }, "Manage categories"),
        h("button", { class: "btn", onclick: () => go("banners") }, "Home banners"),
        h("button", { class: "btn", onclick: () => go("stats") }, "Statistics"),
        h("button", { class: "btn", onclick: () => go("wallpapers", { pro: "pro", kind: "", category: "", status: "", q: "" }) }, "See Pro wallpapers"),
        h("button", { class: "btn", onclick: () => go("wallpapers", { status: "hidden", kind: "", category: "", pro: "", q: "" }) }, "See hidden"))),
  );
}

function signInCard() {
  if (state.local) {
    return h("div", { class: "card" }, h("h2", {}, "Admin sign-in"),
      h("p", {}, "Running on this computer: the ID and password are checked here and Publish pushes with this computer's GitHub login."),
      h("p", { class: "hint" }, "Change the ID or password: stop the server, run  python3 backend/tools/admin_server.py --set-login , then start it again."),
      h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { class: "btn ghost", onclick: signOut }, "Sign out")));
  }
  const canSet = !!state.gh || MOCK;
  return h("div", { class: "card" }, h("h2", {}, "Admin sign-in"),
    h("p", {}, "ID and password sign-in: ", h("b", {}, state.login ? "on" : "not set up")),
    h("p", { class: "hint" }, "The login page asks only for the admin ID and password, on any computer or phone. They unlock the GitHub key saved (encrypted) on the wallpaper site, so pick a password nobody can guess."),
    canSet ? h("div", { class: "row" },
      h("button", { class: "btn", onclick: setLoginDialog }, state.login ? "Change ID or password" : "Set ID and password")) : null,
    // The sidebar's Sign out is hidden on phones; this one is always there.
    state.gh || state.local || state.readOnly ? h("div", { class: "row", style: { marginTop: "10px" } },
      h("button", { class: "btn ghost", onclick: signOut }, state.readOnly ? "Sign in" : "Sign out")) : null);
}

/** Commit (or, in test mode, only prepare) the login file. */
async function saveLoginFile(text, message) {
  if (MOCK) { window.__lastLogin = text; return; }
  await state.gh.commit(state.repo, state.branch, message, [text == null ? { path: LOGIN_FILE, delete: true } : { path: LOGIN_FILE, text }]);
}

function setLoginDialog() {
  const id = h("input", { type: "text", autocomplete: "username", autocapitalize: "off", spellcheck: "false", value: store.load().id || "admin" });
  const pw = h("input", { type: "password", autocomplete: "new-password" });
  const pw2 = h("input", { type: "password", autocomplete: "new-password" });
  const err = h("div", { class: "hint", style: { color: "#ffb4ad", minHeight: "18px" } });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save");
  const w = modal(h("h2", {}, "Admin ID and password"),
    h("form", {
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = "";
        if (id.value.trim().length < 3) { err.textContent = "The ID needs at least 3 characters."; return; }
        if (pw.value.length < 8) { err.textContent = "The password needs at least 8 characters."; return; }
        if (pw.value !== pw2.value) { err.textContent = "The two passwords are different."; return; }
        save.disabled = true; err.style.color = ""; err.textContent = "Saving…";
        try {
          const text = await lock(id.value, pw.value, { token: state.gh ? state.gh.token : "mock-token", repo: state.repo, dataRepo: state.dataRepo });
          await saveLoginFile(text, "Admin: sign-in ID and password updated");
          state.login = JSON.parse(text);
          const saved = store.load();
          if (saved.token) store.save({ ...saved, id: id.value.trim() }, !!saved.remember);
          w.remove(); toast("Saved. Sign in with this ID and password from now on (the website takes about a minute to update)."); renderApp();
        } catch (e) { err.style.color = "#ffb4ad"; err.textContent = e.message; save.disabled = false; }
      },
    },
      h("label", { class: "field" }, h("span", {}, "Admin ID"), id),
      h("label", { class: "field" }, h("span", {}, "New password (8 or more characters)"), withEye(pw)),
      h("label", { class: "field" }, h("span", {}, "Repeat the password"), withEye(pw2)),
      h("p", { class: "hint" }, "Anyone who knows this ID and password can change the app's wallpapers, prices and ads. If the GitHub token expires, sign in with a new token and save the ID and password again."),
      err,
      h("div", { class: "row end" }, h("button", { class: "btn", type: "button", onclick: () => w.remove() }, "Cancel"), save)));
  id.focus();
}

// ---- categories ---------------------------------------------------------------------------------------------

function coverStyle(row) {
  const m = state.model;
  let path = row.coverImage;
  if (!path && row.cover) { const w = m.baseById.get(row.cover); path = w && m.thumbPath(w); }
  return path ? { backgroundImage: `url("${imageUrl(path)}")` } : {};
}

function pageCategories(root) {
  const m = state.model;
  const rows = m.categoryRows();
  const add = h("button", { class: "btn primary", onclick: () => addCategoryDialog() }, "Add category");
  root.append(h("div", { class: "row" }, h("p", { class: "hint grow" },
    "Rename, hide or reorder categories, and make every wallpaper in a category Pro or free. A single wallpaper's own setting (Wallpapers page) always wins."), add));
  const groups = [["LIVE", "Live categories"], ["STATIC", "4K Static categories"], ["GLITTER", "Glitter & Live Clock"]];
  for (const [kind, title] of groups) {
    const list = rows.filter((r) => (kind === "GLITTER" ? r.group : r.kind === kind && !r.group));
    root.append(h("div", { class: "section-title" }, title, h("span", { class: "badge" }, list.length)));
    root.append(h("div", { class: "cat-list" }, list.map((r, i) => categoryRow(r, list, i))));
  }
}

function categoryRow(r, list, i) {
  const m = state.model;
  const name = h("input", {
    type: "text", value: r.name, disabled: !!r.group, "aria-label": "Category name",
    onchange: () => { m.editCategory(r.kind, r.key, { name: name.value.trim() || null }); changed(); toast("Renamed"); },
  });
  const move = (d) => {
    const keys = list.map((x) => x.key);
    const j = i + d;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    m.reorder(r.kind, keys); changed(); renderApp();
  };
  const proValue = r.edit.pro === true ? "pro" : r.edit.pro === false ? "free" : "default";
  return h("div", { class: "cat" + (r.hidden ? " hidden-row" : "") },
    r.group ? h("span", {}) : h("div", { class: "move" }, h("button", { title: "Move up", onclick: () => move(-1) }, "▲"), h("button", { title: "Move down", onclick: () => move(1) }, "▼")),
    h("div", { class: "cover", style: coverStyle(r) }),
    h("div", { class: "name" }, name,
      h("div", { class: "meta" }, `${r.visible}/${r.total} shown · ${r.pro} Pro`, r.isNew ? " · new" : "", r.special ? " · wallpapers tagged Editor's Choice" : "")),
    h("div", { class: "acts" },
      r.special ? h("span", { class: "hint" }, "Pro: per wallpaper") :
        seg([["default", "As published"], ["pro", "All Pro", "pro"], ["free", "All Free", "free"]], proValue, (v) => {
          m.editCategory(r.kind, r.key, { pro: v === "pro" ? true : v === "free" ? false : null }); changed(); renderApp();
        }),
      r.group ? null : coverPicker(r),
      r.group ? null : h("label", { class: "check" },
        h("input", { type: "checkbox", checked: r.hidden, onchange: (e) => { m.editCategory(r.kind, r.key, { hidden: e.target.checked }); changed(); renderApp(); } }), "Hidden"),
      h("button", { class: "btn small", onclick: () => go("wallpapers", { kind: r.kind, category: r.special ? "" : r.key, status: "", pro: "", q: r.special ? "tag:editors" : "" }) }, "Wallpapers"),
      r.isNew ? h("button", { class: "btn small danger", onclick: () => { m.deleteNewCategory(r.kind, r.key); changed(); renderApp(); } }, "Delete") : null),
  );
}

/** Upload / change / remove a category's own cover picture (wide banner in the app's Categories tab). */
function coverPicker(r) {
  const m = state.model;
  const input = h("input", { type: "file", accept: "image/*", style: { display: "none" }, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const c = await processCover(file);
      const path = `uploads/covers/${r.kind.toLowerCase()}_${r.key}_${Date.now().toString(36)}.webp`;
      m.setCategoryImage(r.kind, r.key, { path, bytes: c.bytes, url: c.url });
      changed(); toast("Cover picture set. Publish to send it to phones."); renderApp();
    } catch (err) { toast(err.message, true); }
  } });
  const has = !!(r.edit && r.edit.coverImage);
  return h("span", { class: "row", style: { gap: "6px" } }, input,
    h("button", { class: "btn small", title: "Wide picture, ideally 1080 × 386 or bigger", onclick: () => input.click() }, has ? "Change picture" : "Cover picture"),
    has ? h("button", { class: "btn small ghost", onclick: () => { m.clearCategoryImage(r.kind, r.key); changed(); renderApp(); } }, "Remove picture") : null);
}

/** Add a LIVE or STATIC category. `fixedKind` locks the type (when called from a picker), `onAdded(key)` runs after. */
function addCategoryDialog(fixedKind, onAdded) {
  const m = state.model;
  const kind = h("select", { disabled: !!fixedKind }, h("option", { value: "STATIC", selected: fixedKind === "STATIC" }, "4K Static"), h("option", { value: "LIVE", selected: fixedKind === "LIVE" }, "Live"));
  const name = h("input", { type: "text", placeholder: "e.g. Cars" });
  const err = h("div", { class: "hint", style: { color: "#ffb4ad" } });
  const w = modal(h("h2", {}, "Add category"),
    h("label", { class: "field" }, h("span", {}, "Type"), kind),
    h("label", { class: "field" }, h("span", {}, "Name"), name),
    h("p", { class: "hint" }, "It appears in the app once it has at least one wallpaper: upload some, or move wallpapers into it."),
    err,
    h("div", { class: "row end" }, h("button", { class: "btn", onclick: () => w.remove() }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => {
        const n = name.value.trim(); const key = slug(n);
        if (!key) { err.textContent = "Enter a name"; return; }
        try { m.addCategory(kind.value, key, n); } catch (e) { err.textContent = e.message; return; }
        changed(); w.remove();
        if (onAdded) onAdded(key); else renderApp();
      } }, "Add")));
  name.focus();
}

const NEW_CATEGORY = "__new__";

/** Category <select> for one kind; for Live / 4K Static it ends with "+ New category…", which opens the add dialog
 *  and picks the new category. `first` is an optional leading placeholder option. */
function categorySelect(kind, value, onPick, first) {
  const canAdd = kind === "LIVE" || kind === "STATIC";
  const sel = h("select", { onchange: () => {
    if (sel.value !== NEW_CATEGORY) { onPick(sel.value); return; }
    sel.value = value ?? "";
    addCategoryDialog(kind, (key) => { toast("Category added"); onPick(key); });
  } },
    first ? h("option", { value: "" }, first) : null,
    state.model.categoriesFor(kind).map((c) => h("option", { value: c.key, selected: c.key === value }, c.name)),
    canAdd ? h("option", { value: NEW_CATEGORY }, "+ New category…") : null);
  return sel;
}

// ---- wallpapers ---------------------------------------------------------------------------------------------

function imageUrl(path) {
  const up = state.model.uploads.get(path);
  return up ? up.url : SITE + path;
}

function isNew(w) {
  const now = Date.now() / 1000;
  return w.addedAt > (state.model.feed.cutoff || 0) && now - w.addedAt < NEW_FOR_SEC;
}

function filtered() {
  const m = state.model;
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  let vs = m.views().filter((v) => {
    const w = v.wall;
    if (v.deleted !== (f.status === "deleted")) return false;
    if (f.list && !(w.tags || []).includes(f.list)) return false;
    if (f.kind && w.kind !== f.kind) return false;
    if (f.category && w.category !== f.category) return false;
    if (f.pro === "pro" && !w.pro) return false;
    if (f.pro === "free" && w.pro) return false;
    if (f.status === "visible" && v.hidden) return false;
    if (f.status === "hidden" && !v.hidden) return false;
    if (f.status === "edited" && !v.edited) return false;
    if (f.status === "uploaded" && !v.uploaded) return false;
    if (f.status === "pinned" && !w.pinned) return false;
    if (f.status === "new" && !isNew(w)) return false;
    if (q.startsWith("tag:")) return (w.tags || []).includes(q.slice(4));
    if (q && !(w.title || "").toLowerCase().includes(q) && !w.id.toLowerCase().includes(q)) return false;
    return true;
  });
  // Same order as the app: the dragged order of this list first, then pinned, NEW, rank.
  const okey = currentOrderKey();
  const opos = new Map(okey ? m.getOrder(okey).map((id, i) => [id, i]) : []);
  const posOf = (v) => (opos.has(v.wall.id) ? opos.get(v.wall.id) : 1e9);
  const byRec = (a, b) => (posOf(a) - posOf(b)) || (b.wall.pinned - a.wall.pinned) || (isNew(b.wall) - isNew(a.wall)) || (a.wall.rank - b.wall.rank);
  const sorts = {
    recommended: byRec,
    latest: (a, b) => (b.wall.addedAt || 0) - (a.wall.addedAt || 0) || byRec(a, b),
    views: (a, b) => ((b.wall.hits || [])[3] || -1) - ((a.wall.hits || [])[3] || -1),
    title: (a, b) => (a.wall.title || "").localeCompare(b.wall.title || ""),
  };
  return vs.sort(sorts[f.sort] || byRec);
}

/** The list the current filters show, if phones show it as one list that can be put in order (a category or a list). */
function currentOrderKey() {
  const f = state.filters;
  if (f.list && !f.category) return Object.keys(ORDER_LISTS).find((k) => ORDER_LISTS[k] === f.list) || null;
  if (f.category && !f.list && (f.kind === "LIVE" || f.kind === "STATIC")) return Model.orderKey(f.kind, f.category);
  return null;
}

function pageWallpapers(root) {
  const m = state.model;
  const f = state.filters;
  const set = (patch) => { state.filters = { ...state.filters, ...patch }; state.shown = PAGE; renderGrid(); };
  const cats = f.kind ? m.categoriesFor(f.kind) : [...new Map(m.views().map((v) => [v.wall.category, { key: v.wall.category, name: v.wall.category }])).values()];
  const catSel = h("select", { onchange: (e) => set({ category: e.target.value }) },
    h("option", { value: "" }, "All categories"),
    cats.sort((a, b) => a.name.localeCompare(b.name)).map((c) => h("option", { value: c.key, selected: f.category === c.key }, c.name)));
  const search = h("input", { type: "text", placeholder: "Search title or id", value: f.q, oninput: (e) => set({ q: e.target.value }) });
  root.append(h("div", { class: "filters" },
    h("select", { onchange: (e) => { state.filters.category = ""; set({ kind: e.target.value }); renderApp(); } },
      h("option", { value: "" }, "All kinds"), KINDS.map((k) => h("option", { value: k, selected: f.kind === k }, KIND_LABEL[k]))),
    catSel,
    h("select", { onchange: (e) => set({ list: e.target.value }) },
      [["", "All lists"], ["editors", "Editor's Choice"], ["top", "Top Picks"], ["exclusive", "Exclusive"]].map(([v, l]) => h("option", { value: v, selected: f.list === v }, l))),
    h("select", { onchange: (e) => set({ pro: e.target.value }) },
      [["", "Pro and free"], ["pro", "Pro only"], ["free", "Free only"]].map(([v, l]) => h("option", { value: v, selected: f.pro === v }, l))),
    h("select", { onchange: (e) => set({ status: e.target.value }) },
      [["", "Any status"], ["visible", "Visible"], ["hidden", "Hidden"], ["edited", "Edited here"], ["uploaded", "Uploaded here"], ["pinned", "Pinned"], ["new", "NEW badge"], ["deleted", "Deleted"]]
        .map(([v, l]) => h("option", { value: v, selected: f.status === v }, l))),
    h("select", { onchange: (e) => set({ sort: e.target.value }) },
      [["recommended", "Recommended order"], ["latest", "Latest"], ["views", "Most viewed"], ["title", "Title"]].map(([v, l]) => h("option", { value: v, selected: f.sort === v }, l))),
    search));
  root.append(h("div", { id: "bulk" }), h("div", { id: "grid" }));
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById("grid");
  if (!grid) return;
  const list = filtered();
  const m = state.model;
  const okey = currentOrderKey();
  if (state.reorder && state.reorder.key === okey) return renderReorder(grid);
  state.reorder = null;
  const shown = list.slice(0, state.shown);
  renderBulk(list);
  grid.replaceChildren(
    okey && state.filters.sort === "recommended" && state.filters.status !== "deleted" ? h("div", { class: "order-bar" },
      h("span", { class: "grow" }, m.getOrder(okey).length ? "Phones show this list in your own order." : "Phones show this list in the automatic order (pinned, new, best first)."),
      h("button", { class: "btn small", onclick: () => { state.reorder = { key: okey, ids: list.filter((v) => !v.hidden).map((v) => v.wall.id) }; renderGrid(); } }, "Change order")) : null,
    h("p", { class: "hint" }, `${list.length.toLocaleString()} wallpapers`, list.length ? " · tick wallpapers to change several at once" : ""),
    h("div", { class: "walls" }, shown.map((v) => wallCard(v))),
    list.length > shown.length ? h("div", { class: "more" }, h("button", { class: "btn", onclick: () => { state.shown += PAGE; renderGrid(); } }, `Show more (${list.length - shown.length})`)) : null,
  );
  void m;
}

function wallCard(v) {
  const m = state.model;
  const w = v.wall;
  const path = m.thumbPath(w);
  const sel = state.selected.has(w.id);
  const pic = path ? h("img", { src: imageUrl(path), loading: "lazy", alt: "" })
    : h("div", { class: "drawn", style: { background: drawnBackground(w) } }, (w.scene || "drawn").toLowerCase().replace(/_/g, " "));
  return h("div", { class: "wall" + (sel ? " sel" : "") + (v.hidden ? " off" : ""), onclick: () => (state.selected.size ? toggleSel(w.id) : openWall(w.id)) },
    pic,
    h("div", { class: "tl" },
      h("span", { class: "badge " + (w.pro ? "pro" : "free") }, w.pro ? "PRO" : "FREE"),
      v.deleted ? h("span", { class: "badge hid" }, "DELETED") : v.hidden ? h("span", { class: "badge hid" }, "HIDDEN") : null,
      isNew(w) ? h("span", { class: "badge new" }, "NEW") : null,
      w.pinned ? h("span", { class: "badge edit" }, "PINNED") : null,
      v.uploaded ? h("span", { class: "badge edit" }, "UPLOADED") : v.edited ? h("span", { class: "badge edit" }, "EDITED") : null),
    h("div", { class: "tr", onclick: (e) => e.stopPropagation() },
      h("input", { type: "checkbox", checked: sel, "aria-label": "Select", onchange: () => toggleSel(w.id) })),
    h("div", { class: "cap" }, h("b", {}, w.title || w.id), `${KIND_LABEL[w.kind]} · ${w.category}`));
}

/** Drag (or ◀ ▶) the wallpapers of one list into the order phones show; saved as admin.json "order". */
function renderReorder(grid) {
  const m = state.model;
  const r = state.reorder;
  const bulk = document.getElementById("bulk");
  if (bulk) bulk.replaceChildren();
  const move = (from, to) => {
    if (to < 0 || to >= r.ids.length || from === to) return;
    const [x] = r.ids.splice(from, 1);
    r.ids.splice(to, 0, x);
    renderGrid();
  };
  let dragFrom = -1;
  const cards = r.ids.map((id, i) => {
    const w = m.view(m.baseById.get(id)).wall;
    const path = m.thumbPath(w);
    return h("div", {
      class: "wall reo", draggable: "true",
      ondragstart: (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); },
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add("over"); },
      ondragleave: (e) => e.currentTarget.classList.remove("over"),
      ondrop: (e) => { e.preventDefault(); const from = dragFrom >= 0 ? dragFrom : +e.dataTransfer.getData("text/plain"); dragFrom = -1; move(from, i); },
    },
      path ? h("img", { src: imageUrl(path), alt: "", draggable: "false" }) : h("div", { class: "drawn", style: { background: drawnBackground(w) } }),
      h("div", { class: "num" }, String(i + 1)),
      h("div", { class: "reo-acts" },
        h("button", { title: "Move to the start", onclick: () => move(i, 0) }, "⇤"),
        h("button", { title: "Move earlier", onclick: () => move(i, i - 1) }, "◀"),
        h("button", { title: "Move later", onclick: () => move(i, i + 1) }, "▶")),
      h("div", { class: "cap" }, h("b", {}, w.title || w.id)));
  });
  grid.replaceChildren(
    h("div", { class: "order-bar" },
      h("b", { class: "grow" }, "Drag the pictures into the order phones should show them (number 1 = top-left)."),
      h("button", { class: "btn small ghost", onclick: () => { state.reorder = null; renderGrid(); } }, "Cancel"),
      m.getOrder(r.key).length ? h("button", { class: "btn small", onclick: () => { m.setOrder(r.key, null); state.reorder = null; changed(); toast("Back to the automatic order"); renderGrid(); } }, "Automatic order") : null,
      h("button", { class: "btn small primary", onclick: () => { m.setOrder(r.key, [...r.ids]); state.reorder = null; changed(); toast("Order saved. Publish to send it to phones."); renderGrid(); } }, "Save order")),
    h("p", { class: "hint" }, "Hidden wallpapers are left out. Wallpapers added later come after these."),
    h("div", { class: "walls" }, cards));
}

function drawnBackground(w) {
  const p = (w.palette || []).slice(0, 3);
  return p.length ? `linear-gradient(160deg, ${p.join(", ")})` : "linear-gradient(160deg, #1a2c37, #0b3550)";
}

function toggleSel(id) {
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  renderGrid();
}

function renderBulk(list) {
  const bar = document.getElementById("bulk");
  const m = state.model;
  const n = state.selected.size;
  if (!n) return bar.replaceChildren();
  const apply = (patch, label) => { state.selected.forEach((id) => m.editWall(id, patch)); changed(); toast(`${label}: ${n} wallpaper${n === 1 ? "" : "s"}`); renderGrid(); };
  const kinds = new Set([...state.selected].map((id) => m.baseById.get(id).kind));
  const moveSel = kinds.size === 1 ? categorySelect([...kinds][0], "", (key) => { if (key) apply({ category: key }, "Moved"); }, "Move to…") : null;
  bar.replaceChildren(h("div", { class: "bulk" },
    h("b", {}, `${n} selected`),
    h("button", { class: "btn small pro", onclick: () => apply({ pro: true }, "Made Pro") }, "Make Pro"),
    h("button", { class: "btn small", onclick: () => apply({ pro: false }, "Made free") }, "Make Free"),
    h("button", { class: "btn small", onclick: () => apply({ pro: null }, "Pro as published") }, "Pro as published"),
    h("button", { class: "btn small", onclick: () => apply({ hidden: true }, "Hidden") }, "Hide"),
    h("button", { class: "btn small", onclick: () => apply({ hidden: false }, "Shown") }, "Show"),
    state.filters.status === "deleted"
      ? h("button", { class: "btn small", onclick: () => apply({ deleted: null, hidden: null }, "Restored") }, "Restore")
      : h("button", { class: "btn small danger", onclick: () => {
        if (!confirm(`Delete ${n} wallpaper${n === 1 ? "" : "s"}? Phones stop showing them after the next publish. Published ones can be restored from the Deleted filter; uploads are removed with their files.`)) return;
        [...state.selected].forEach((id) => m.deleteWall(id)); state.selected.clear(); changed(); toast(`Deleted: ${n}`); renderGrid();
      } }, "Delete"),
    moveSel,
    h("span", { class: "grow" }),
    h("button", { class: "btn small ghost", onclick: () => { list.slice(0, state.shown).forEach((v) => state.selected.add(v.wall.id)); renderGrid(); } }, "Select all shown"),
    h("button", { class: "btn small ghost", onclick: () => { state.selected.clear(); renderGrid(); } }, "Clear")));
}

function openWall(id) {
  const m = state.model;
  // The editor opens from the Wallpapers grid and from the Upload page's "Waiting to be published" list.
  const refresh = () => (document.getElementById("grid") ? renderGrid() : renderApp());
  const draw = () => {
    const v = m.view(m.baseById.get(id));
    const w = v.wall;
    const base = m.baseById.get(id);
    const e = m.admin.walls[id] || {};
    const path = m.thumbPath(w);
    const photo = w.photo && m.photos.get(w.photo);
    const video = w.video && m.videos.get(w.video);
    const credit = photo || video;
    const rec = v.uploaded ? m.uploadRecord(id) : null;
    const title = h("input", { type: "text", value: w.title, onchange: () => {
      if (rec) m.editUpload(id, { title: title.value }); else m.editWall(id, { title: title.value.trim() });
      changed(); draw(); refresh();
    } });
    const cat = categorySelect(w.kind, w.category, (key) => { m.editWall(id, { category: key }); changed(); draw(); refresh(); });
    const proValue = e.pro === true ? "pro" : e.pro === false ? "free" : "default";
    const inherited = v.proFrom === "category" ? `category says ${w.pro ? "Pro" : "free"}` : `published as ${base.pro ? "Pro" : "free"}`;
    const panel = h("div", { class: "drawer", onclick: (ev) => ev.stopPropagation() },
      h("div", { class: "row" }, h("h2", { class: "grow", style: { margin: 0 } }, w.title || w.id), h("button", { class: "btn small", onclick: () => scrim.remove() }, "Close")),
      h("p", { class: "hint" }, `${KIND_LABEL[w.kind]} · ${w.id}`, v.uploaded ? " · uploaded here" : ""),
      h("div", { class: "hero" },
        h("div", { class: "pic" }, path ? h("img", { src: imageUrl(path), alt: "" }) : h("div", { class: "drawn", style: { background: drawnBackground(w), height: "100%" } })),
        h("div", {},
          h("div", { class: "row", style: { marginBottom: "8px" } }, h("span", { class: "badge " + (w.pro ? "pro" : "free") }, w.pro ? "PRO" : "FREE"), v.hidden ? h("span", { class: "badge hid" }, v.hiddenBy === "category" ? "HIDDEN BY CATEGORY" : "HIDDEN") : null),
          (w.hits || []).length ? h("p", { class: "hint" }, `Views on Wikimedia: ${w.hits[0]} today · ${w.hits[1]} week · ${w.hits[2]} month · ${w.hits[3]} year`) : null,
          credit ? h("p", { class: "hint" }, `${credit.author || "Unknown author"} · ${credit.license || "licence not set"}`, credit.source ? h("br") : null,
            credit.source ? h("a", { href: credit.source, target: "_blank", rel: "noopener" }, "Source page") : null) : null)),
      h("label", { class: "field" }, h("span", {}, "Title"), title),
      h("label", { class: "field" }, h("span", {}, "Category"), cat),
      h("label", { class: "field" }, h("span", {}, `Pro (default: ${inherited})`),
        seg([["default", "Default"], ["pro", "Pro", "pro"], ["free", "Free", "free"]], proValue, (val) => {
          m.editWall(id, { pro: val === "pro" ? true : val === "free" ? false : null }); changed(); draw(); refresh();
        })),
      h("div", { class: "field" }, h("span", { class: "hint" }, "Lists"),
        h("div", { class: "row" }, TAGS.map(([tag, label]) => h("label", { class: "check" },
          h("input", { type: "checkbox", checked: (w.tags || []).includes(tag), onchange: (ev) => {
            const tags = new Set(w.tags || []); if (ev.target.checked) tags.add(tag); else tags.delete(tag);
            m.editWall(id, { tags: [...tags] }); changed(); draw(); refresh();
          } }), label)))),
      h("div", { class: "row", style: { margin: "6px 0 16px" } },
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!e.hidden, onchange: (ev) => { m.editWall(id, { hidden: ev.target.checked }); changed(); draw(); refresh(); } }), "Hidden"),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!e.pinned, onchange: (ev) => { m.editWall(id, { pinned: ev.target.checked }); changed(); draw(); refresh(); } }), "Pinned to the top of Recommended")),
      rec ? h("div", { class: "card inset" },
        h("h3", {}, "Upload details"),
        h("label", { class: "field" }, h("span", {}, "Author (shown in the app)"),
          h("input", { type: "text", value: rec.author || "", onchange: (ev) => { m.editUpload(id, { author: ev.target.value.trim() }); changed(); draw(); } })),
        h("label", { class: "field" }, h("span", {}, "Licence"),
          h("select", { onchange: (ev) => { m.editUpload(id, { license: ev.target.value }); changed(); draw(); } },
            LICENCES.filter(Boolean).map((l) => h("option", { value: l, selected: rec.license === l }, l)))),
        h("label", { class: "field" }, h("span", {}, "Source link"),
          h("input", { type: "url", value: rec.source || "", onchange: (ev) => { m.editUpload(id, { source: ev.target.value.trim() }); changed(); draw(); } })),
        h("div", { class: "row" },
          replaceButton(id, w, rec, () => { draw(); refresh(); }),
          w.photo && rec.url ? h("button", { class: "btn small", onclick: () => changeCrop(id, rec, () => { draw(); refresh(); }) }, "Change crop") : null)) : null,
      (w.kind === "LIVE" || w.kind === "STATIC") ? h("button", { class: "btn small", onclick: () => {
        m.editCategory(w.kind, w.category, { cover: w.id }); changed(); toast(`Cover of ${w.category} set`);
      } }, "Use as category cover") : null,
      h("div", { class: "row", style: { marginTop: "20px" } },
        v.edited ? h("button", { class: "btn", onclick: () => { m.resetWall(id); changed(); draw(); refresh(); } }, "Undo my changes") : null,
        v.deleted ? h("button", { class: "btn", onclick: () => { m.restoreWall(id); changed(); draw(); refresh(); } }, "Restore wallpaper")
          : h("button", { class: "btn danger", onclick: () => {
            if (!confirm(v.uploaded ? "Delete this uploaded wallpaper? Its files are removed on the next publish."
              : "Delete this wallpaper? Phones stop showing it after the next publish. You can restore it from the Deleted filter.")) return;
            m.deleteWall(id); changed(); scrim.remove(); refresh();
          } }, "Delete wallpaper")));
    scrim.replaceChildren(panel);
  };
  const scrim = h("div", { class: "scrim", onclick: () => scrim.remove() });
  document.body.append(scrim);
  draw();
}

// ---- home banners --------------------------------------------------------------------------------------------

/** Where a banner can lead (the app's HomeScreen understands these targets). */
function bannerTargets() {
  const m = state.model;
  const opts = [
    ["changer", "Auto wallpaper changer settings"], ["pro", "Pro screen"],
    ["tab:categories", "Tab: Categories"], ["tab:live", "Tab: Live"], ["tab:glitter", "Tab: Glitter"], ["tab:clock", "Tab: Live Clock"], ["tab:static", "Tab: 4K Static"],
    ["list:top", "List: Top Picks"], ["list:exclusive", "List: Exclusive"], ["list:editors", "List: Editor's Choice"],
  ];
  m.categoryRows().filter((r) => (r.kind === "LIVE" || r.kind === "STATIC") && !r.special && !r.group && !r.hidden)
    .forEach((r) => opts.push([`category:${r.kind}/${r.key}`, `Category: ${r.name} (${KIND_LABEL[r.kind]})`]));
  opts.push(["wall:", "One wallpaper (choose below)"]);
  return opts;
}

/** The pictures a banner shows: the chosen ones, else the first six of what it opens (same rule as the app). */
function bannerPictures(b) {
  const m = state.model;
  const vs = m.views().filter((v) => !v.hidden).map((v) => v.wall);
  const byId = new Map(vs.map((w) => [w.id, w]));
  const chosen = (b.walls || []).map((id) => byId.get(id)).filter(Boolean);
  if (chosen.length) return chosen.slice(0, 6);
  const t = b.target || "";
  let pool;
  if (t === "tab:glitter") pool = vs.filter((w) => w.kind === "GLITTER");
  else if (t === "tab:clock") pool = vs.filter((w) => w.kind === "CLOCK");
  else if (t === "tab:static") pool = vs.filter((w) => w.kind === "STATIC");
  else if (t.startsWith("category:")) { const [k, key] = t.slice(9).split("/"); pool = vs.filter((w) => w.kind === k && w.category === key); }
  else if (t.startsWith("list:")) { const tag = t.slice(5); pool = vs.filter((w) => (w.tags || []).includes(tag)); }
  else if (t.startsWith("wall:")) pool = vs.filter((w) => w.id === t.slice(5));
  else pool = vs.filter((w) => w.kind === "LIVE" && (w.photo || w.video));
  return pool.sort((a, c) => a.rank - c.rank).slice(0, 6);
}

/** A small copy of the app's banner strip: slanted pictures with the title over them. */
function bannerPreview(b) {
  const m = state.model;
  return h("div", { class: "strip" },
    h("div", { class: "strip-pics" }, bannerPictures(b).map((w) => {
      const path = m.thumbPath(w);
      return h("div", { class: "slant" }, path ? h("img", { src: imageUrl(path), alt: "" }) : h("div", { class: "drawn", style: { background: drawnBackground(w) } }));
    })),
    h("div", { class: "strip-title" }, (b.title || "").toUpperCase()));
}

function pageBanners(root) {
  const m = state.model;
  const custom = m.admin.banners.length > 0;
  const list = custom ? m.admin.banners : DEFAULT_BANNERS;
  const redraw = () => { changed(); renderApp(); };
  root.append(h("p", { class: "hint" },
    "The strip at the top of the app's home screen. Phones show the banners in turn, 4 seconds each; tapping one opens what it points to."));
  if (!custom) {
    root.append(h("div", { class: "card" }, h("h2", {}, "Using the app's own banners"),
      h("div", { class: "banner-list" }, list.map((b) => bannerPreview(b))),
      h("div", { class: "row", style: { marginTop: "14px" } },
        h("button", { class: "btn primary", onclick: () => { m.admin.banners = JSON.parse(JSON.stringify(DEFAULT_BANNERS)); redraw(); } }, "Customise banners"))));
    return;
  }
  const targets = bannerTargets();
  list.forEach((b, i) => {
    const title = h("input", { type: "text", maxlength: 40, value: b.title, oninput: (e) => { b.title = e.target.value; prev.replaceWith(prev = bannerPreview(b)); changed(); } });
    const isWall = (b.target || "").startsWith("wall:");
    const target = h("select", { onchange: (e) => { b.target = e.target.value; if (b.target === "wall:") pickWalls({ max: 1, selected: [], title: "Which wallpaper should it open?", onDone: (ids) => { b.target = ids[0] ? `wall:${ids[0]}` : "changer"; redraw(); } }); else redraw(); } },
      targets.map(([v, l]) => h("option", { value: v, selected: v === b.target || (v === "wall:" && isWall) }, l)));
    let prev = bannerPreview(b);
    const move = (d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; redraw(); };
    root.append(h("div", { class: "card banner-card" },
      prev,
      h("div", { class: "grid2", style: { marginTop: "12px" } },
        h("label", { class: "field" }, h("span", {}, "Title (shown in capitals)"), title),
        h("label", { class: "field" }, h("span", {}, "Opens"), target)),
      isWall ? h("p", { class: "hint" }, `Opens: ${(m.baseById.get(b.target.slice(5)) || {}).title || b.target.slice(5)}`) : null,
      h("div", { class: "row" },
        h("span", { class: "hint grow" }, (b.walls || []).length ? `${b.walls.length} chosen picture${b.walls.length === 1 ? "" : "s"}` : "Pictures: automatic (from what it opens)"),
        h("button", { class: "btn small", onclick: () => pickWalls({ max: 6, selected: b.walls || [], title: "Pictures for this banner (up to 6)", onDone: (ids) => { b.walls = ids; redraw(); } }) }, "Choose pictures"),
        (b.walls || []).length ? h("button", { class: "btn small ghost", onclick: () => { b.walls = []; redraw(); } }, "Automatic pictures") : null,
        h("button", { class: "btn small", title: "Move up", onclick: () => move(-1) }, "▲"),
        h("button", { class: "btn small", title: "Move down", onclick: () => move(1) }, "▼"),
        h("button", { class: "btn small danger", onclick: () => { list.splice(i, 1); redraw(); } }, "Delete"))));
  });
  root.append(h("div", { class: "row", style: { marginTop: "16px" } },
    h("button", { class: "btn primary", onclick: () => { list.push({ title: "NEW WALLPAPERS", target: "tab:live", walls: [] }); redraw(); } }, "Add banner"),
    h("button", { class: "btn ghost", onclick: () => { if (confirm("Go back to the app's own three banners?")) { m.admin.banners = []; redraw(); } } }, "Use the app's banners")));
}

/** Choose up to [max] wallpapers from a searchable grid; [onDone] gets the ids in the order picked. */
function pickWalls({ max, selected, title, onDone }) {
  const m = state.model;
  const sel = [...selected];
  let q = "";
  const grid = h("div", { class: "walls picker" });
  const count = h("span", { class: "hint grow" });
  const draw = () => {
    const ql = q.trim().toLowerCase();
    const vs = m.views().filter((v) => !v.hidden && m.thumbPath(v.wall) &&
      (!ql || (v.wall.title || "").toLowerCase().includes(ql) || v.wall.id.toLowerCase().includes(ql) || (v.wall.category || "").includes(ql)));
    vs.sort((a, b) => (sel.includes(b.wall.id) - sel.includes(a.wall.id)) || a.wall.rank - b.wall.rank);
    grid.replaceChildren(...vs.slice(0, 150).map((v) => {
      const w = v.wall;
      const at = sel.indexOf(w.id);
      return h("div", { class: "wall" + (at >= 0 ? " sel" : ""), onclick: () => {
        if (at >= 0) sel.splice(at, 1);
        else { if (max === 1) sel.length = 0; if (sel.length < max) sel.push(w.id); else toast(`Up to ${max}`); }
        draw();
      } },
        h("img", { src: imageUrl(m.thumbPath(w)), loading: "lazy", alt: "" }),
        at >= 0 ? h("div", { class: "num" }, String(at + 1)) : null,
        h("div", { class: "cap" }, h("b", {}, w.title || w.id), `${KIND_LABEL[w.kind]} · ${w.category}`));
    }));
    count.textContent = `${sel.length} of ${max} chosen`;
  };
  const w = modal(h("h2", {}, title),
    h("input", { type: "text", placeholder: "Search title, category or id", oninput: (e) => { q = e.target.value; draw(); } }),
    grid,
    h("div", { class: "row", style: { marginTop: "12px" } }, count,
      h("button", { class: "btn", onclick: () => w.remove() }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => { w.remove(); onDone(sel); } }, "Done")));
  w.classList.add("wide");
  draw();
}

// ---- statistics ----------------------------------------------------------------------------------------------

const STAT_PRO = "#c98500"; // validated against the panel's dark surface next to the brand blue (Free)
const STAT_FREE = "#079be5";

/** Horizontal bars, one hue, value printed beside each bar (it doubles as the table). */
function barList(rows, color = STAT_FREE) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h("div", { class: "bars" }, rows.map((r) => h("div", { class: "bar-row", title: `${r.label}: ${r.value.toLocaleString()}` },
    h("span", { class: "bar-label" }, r.thumb ? h("img", { src: r.thumb, alt: "" }) : null, r.label),
    h("span", { class: "bar-track" }, r.value > 0 ? h("span", { class: "bar-fill", style: { width: `${(r.value / max) * 100}%`, background: color } }) : null),
    h("span", { class: "bar-val" }, r.value.toLocaleString()))));
}

/** Pro / free per type: two segments with a 2 px gap, legend above, both numbers printed. */
function proFreeBars(rows) {
  const max = Math.max(1, ...rows.map((r) => r.pro + r.free));
  return h("div", {},
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "key", style: { background: STAT_PRO } }), "Pro"), h("span", {}, h("i", { class: "key", style: { background: STAT_FREE } }), "Free")),
    h("div", { class: "bars" }, rows.map((r) => h("div", { class: "bar-row", title: `${r.label}: ${r.pro} Pro, ${r.free} free` },
      h("span", { class: "bar-label" }, r.label),
      h("span", { class: "bar-track stack" },
        r.pro ? h("span", { class: "bar-fill", style: { width: `${(r.pro / max) * 100}%`, background: STAT_PRO } }) : null,
        r.free ? h("span", { class: "bar-fill", style: { width: `${(r.free / max) * 100}%`, background: STAT_FREE } }) : null),
      h("span", { class: "bar-val" }, `${r.pro} / ${r.free}`)))));
}

function pageStats(root) {
  const m = state.model;
  const vs = m.views();
  const live = vs.filter((v) => !v.hidden);
  const stat = (n, label) => h("div", { class: "stat" }, h("b", {}, n), h("span", {}, label));
  const pro = live.filter((v) => v.wall.pro).length;
  root.append(h("div", { class: "stats" },
    stat(live.length.toLocaleString(), "wallpapers on phones"),
    stat(`${Math.round((pro / Math.max(1, live.length)) * 100)}%`, `Pro (${pro.toLocaleString()})`),
    stat(m.categoryRows().filter((r) => !r.group && !r.special && !r.hidden && r.visible > 0).length, "categories with wallpapers"),
    stat(m.admin.added.walls.length, "uploaded here"),
    stat(vs.filter((v) => v.hidden && !v.deleted).length, "hidden"),
    stat(vs.filter((v) => v.deleted).length, "deleted")));

  const byKind = KINDS.map((k) => ({ label: KIND_LABEL[k], pro: live.filter((v) => v.wall.kind === k && v.wall.pro).length, free: live.filter((v) => v.wall.kind === k && !v.wall.pro).length }));
  const cats = m.categoryRows().filter((r) => !r.group && !r.special && r.visible > 0)
    .map((r) => ({ label: `${r.name} · ${KIND_LABEL[r.kind]}`, value: r.visible })).sort((a, b) => b.value - a.value).slice(0, 15);
  const top = (i) => live.filter((v) => (v.wall.hits || [])[i] > 0).sort((a, b) => b.wall.hits[i] - a.wall.hits[i]).slice(0, 10)
    .map((v) => ({ label: v.wall.title || v.wall.id, value: v.wall.hits[i], thumb: m.thumbPath(v.wall) ? imageUrl(m.thumbPath(v.wall)) : null }));
  const months = new Map();
  const now = new Date();
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.set(`${d.getFullYear()}-${d.getMonth()}`, { label: d.toLocaleString(undefined, { month: "short", year: "numeric" }), value: 0 }); }
  vs.filter((v) => !v.deleted && v.wall.addedAt).forEach((v) => { const d = new Date(v.wall.addedAt * 1000); const e = months.get(`${d.getFullYear()}-${d.getMonth()}`); if (e) e.value++; });
  // Start at the first month that has wallpapers (empty months before the app existed say nothing).
  const monthRows = [...months.values()];
  const firstMonth = monthRows.findIndex((r) => r.value > 0);

  root.append(h("div", { class: "grid2" },
    h("div", { class: "card" }, h("h2", {}, "Pro and free by type"), proFreeBars(byKind)),
    h("div", { class: "card" }, h("h2", {}, "Added per month"), firstMonth >= 0 ? barList(monthRows.slice(firstMonth)) : h("p", { class: "hint" }, "Nothing added in the last 12 months.")),
    h("div", { class: "card" }, h("h2", {}, "Biggest categories"), barList(cats)),
    h("div", { class: "card" }, h("h2", {}, "Most viewed this month (views on Wikimedia)"),
      top(2).length ? barList(top(2)) : h("p", { class: "hint" }, "No view numbers yet.")),
    h("div", { class: "card" }, h("h2", {}, "Most viewed this year (views on Wikimedia)"),
      top(3).length ? barList(top(3)) : h("p", { class: "hint" }, "No view numbers yet."))),
    h("p", { class: "hint", style: { marginTop: "12px" } },
      `View numbers: ${m.feed.statsDay ? `updated daily, last ${m.feed.statsDay}` : "not yet"}. The app has no analytics of its own, so downloads and favourites stay on each phone.`));
}

// ---- history & undo --------------------------------------------------------------------------------------------

async function loadHistory() {
  state.history = null;
  state.historyError = null;
  try {
    if (state.local) {
      const r = await fetch(SITE + "api/history", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `History failed (${r.status})`);
      state.history = d.versions;
    } else {
      state.history = await state.gh.history(state.repo, "admin.json", state.branch);
    }
  } catch (e) { state.historyError = e.message; state.history = []; }
}

/** Upload / cover files an admin.json points to (a restore brings back any that were deleted since). */
function adminFiles(a) {
  const out = new Set();
  const add = (v) => { if (!v) return; const i = v.indexOf("/uploads/"); const p = i >= 0 ? v.slice(i + 1) : v; if (p.startsWith("uploads/")) out.add(p); };
  const ad = a.added || {};
  [...(ad.photos || []), ...(ad.videos || [])].forEach((r) => { add(r.thumb); add(r.url); Object.values(r.urls || {}).forEach(add); });
  (a.categories || []).forEach((c) => add(c.coverImage));
  return [...out];
}

async function restoreVersion(v) {
  const m = state.model;
  if (m.dirty && !confirm("You have changes that are not published yet; restoring throws them away. Continue?")) return;
  if (!confirm(`Restore the settings of ${fmtDate(v.time)}?\n\n"${v.message}"\n\nPhones get them within an hour, or at once with Reload.`)) return;
  try {
    if (state.local) {
      const r = await fetch(SITE + "api/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sha: v.sha }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Restore failed (${r.status})`);
    } else {
      const gh = state.gh;
      const old = JSON.parse(await gh.readText(state.repo, "admin.json", v.sha));
      old.updatedAt = Math.floor(Date.now() / 1000);
      const files = [{ path: "admin.json", text: JSON.stringify(old, null, 1) + "\n" }];
      const tree = await gh.call("GET", `/repos/${state.repo}/git/trees/${encodeURIComponent(state.branch)}?recursive=1`);
      const have = new Set(tree.tree.map((t) => t.path));
      for (const p of adminFiles(old).filter((x) => !have.has(x))) {
        const bytes = await gh.readBytes(state.repo, p, v.sha);
        if (bytes) files.push({ path: p, bytes });
      }
      await gh.commit(state.repo, state.branch, `Admin: restored the settings of ${fmtDate(v.time)}`, files);
    }
    toast("Restored. Phones get it within an hour.");
    state.history = undefined;
    await loadData();
  } catch (e) { toast(e.message, true); }
}

function pageHistory(root) {
  if (MOCK || state.readOnly) {
    root.append(h("div", { class: "card" }, h("h2", {}, "History"), h("p", { class: "hint" }, MOCK ? "Not available in test mode." : "Sign in to see the history.")));
    return;
  }
  if (state.history === undefined) { loadHistory().then(() => { if (state.page === "history") renderApp(); }); }
  if (!state.history) { root.append(h("p", { class: "hint" }, "Loading the history…")); return; }
  const list = state.history;
  root.append(h("p", { class: "hint" }, "Every publish of the admin settings, newest first. Restore brings back that version's categories, wallpaper settings, uploads, banners, prices and ads, as a new publish (nothing is lost: you can restore the newer one again)."));
  if (state.historyError) root.append(h("div", { class: "card" }, h("p", { class: "hint", style: { color: "#ffb4ad" } }, state.historyError)));
  root.append(h("div", { class: "card hist" }, list.length ? list.map((v, i) => h("div", { class: "hist-row" },
    h("div", { class: "grow" }, h("b", {}, v.message.replace(/^Admin:\s*/, "") || "Update"), h("div", { class: "hint" }, `${fmtDate(v.time)} · ${v.author}`)),
    i === 0 ? h("span", { class: "badge free" }, "LIVE NOW") : h("button", { class: "btn small", onclick: () => restoreVersion(v) }, "Restore"))) : h("p", { class: "hint" }, "Nothing published yet."),
  h("div", { class: "row end", style: { marginTop: "10px" } }, h("button", { class: "btn small ghost", onclick: () => { state.history = undefined; renderApp(); } }, "Refresh"))));
}

// ---- settings --------------------------------------------------------------------------------------------------

function pageSettings(root) {
  const cards = [];
  if (state.local) {
    const cur = h("input", { type: "password", autocomplete: "current-password" });
    const id = h("input", { type: "text", autocomplete: "username", autocapitalize: "off", spellcheck: "false", value: store.load().id || "admin" });
    const pw = h("input", { type: "password", autocomplete: "new-password" });
    const pw2 = h("input", { type: "password", autocomplete: "new-password" });
    const msg = h("div", { class: "hint", style: { minHeight: "18px" } });
    const save = h("button", { class: "btn primary", type: "submit" }, "Save");
    cards.push(h("div", { class: "card" }, h("h2", {}, "Admin ID and password"),
      h("form", { onsubmit: async (ev) => {
        ev.preventDefault();
        msg.style.color = "#ffb4ad";
        if (id.value.trim().length < 3) { msg.textContent = "The ID needs at least 3 characters."; return; }
        if (pw.value.length < 8) { msg.textContent = "The new password needs at least 8 characters."; return; }
        if (pw.value !== pw2.value) { msg.textContent = "The two new passwords are different."; return; }
        save.disabled = true; msg.style.color = ""; msg.textContent = "Saving…";
        try {
          const r = await fetch(SITE + "api/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current: cur.value, id: id.value.trim(), password: pw.value }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `Could not save (${r.status})`);
          store.save({ id: id.value.trim() }, true);
          cur.value = pw.value = pw2.value = "";
          msg.style.color = "#7fe0a9"; msg.textContent = "Saved. Use the new ID and password from now on.";
        } catch (e) { msg.style.color = "#ffb4ad"; msg.textContent = e.message; }
        save.disabled = false;
      } },
        h("label", { class: "field" }, h("span", {}, "Current password"), withEye(cur)),
        h("label", { class: "field" }, h("span", {}, "Admin ID"), id),
        h("label", { class: "field" }, h("span", {}, "New password (8 or more characters)"), withEye(pw)),
        h("label", { class: "field" }, h("span", {}, "Repeat the new password"), withEye(pw2)),
        msg, h("div", { class: "row end" }, save))));
  } else if (state.gh) {
    cards.push(signInCard());
  } else {
    cards.push(h("div", { class: "card" }, h("h2", {}, "Admin ID and password"), h("p", { class: "hint" }, MOCK ? "Not available in test mode." : "Sign in to change the ID and password.")));
  }
  cards.push(h("div", { class: "card" }, h("h2", {}, "This panel"),
    h("p", {}, "Wallpaper site: ", h("b", {}, state.repo), state.branch ? ` (${state.branch})` : ""),
    h("p", {}, "Running: ", h("b", {}, MOCK ? "test mode (nothing is published)" : state.local ? "on this computer; Publish pushes with this computer's GitHub login" : "online; Publish uses the saved GitHub key")),
    state.gh || state.local ? h("div", { class: "row" }, h("button", { class: "btn ghost", onclick: signOut }, "Sign out")) : null));
  root.append(h("div", { class: "grid2" }, cards));
}

// ---- upload --------------------------------------------------------------------------------------------------

function pageUpload(root) {
  if (state.bulkUpload) return pageBulkUpload(root);
  const m = state.model;
  const u = state.upload || (state.upload = { type: "STATIC", file: null, link: "", processed: null, focusX: 0.5, focusY: 0.5, title: "", category: "", pro: false, author: "", license: "", source: "" });
  const kindOf = { STATIC: "STATIC", GLITTER: "GLITTER", VIDEO: "LIVE" };
  const cats = m.categoriesFor(kindOf[u.type]);
  if (!cats.some((c) => c.key === u.category)) u.category = cats[0] ? cats[0].key : "";
  const rerender = () => { root.replaceChildren(); pageUpload(root); };

  const input = h("input", { type: "file", multiple: true, accept: u.type === "VIDEO" ? "video/mp4,video/webm" : "image/*", style: { display: "none" }, onchange: (e) => picks(e.target.files) });
  const drop = h("div", {
    class: "drop" + (u.file || u.link ? " compact" : ""), onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); picks(e.dataTransfer.files); },
  }, u.file ? `${u.file.name} · ${(u.file.size / 1e6).toFixed(1)} MB · click or drop to change` : u.type === "VIDEO"
    ? `Drop MP4 / WebM videos here or click to choose (up to ${MAX_VIDEO_MB} MB each; several at once is fine)`
    : "Drop pictures here or click to choose (one, or many at once; ideally 2160 px or more)");

  /** One file: the form below. Several: the bulk list (same settings for all, a title each). */
  function picks(files) {
    const list = [...(files || [])];
    if (list.length > 1) {
      state.bulkUpload = { type: u.type, items: list.map((f) => ({ file: f, title: titleFrom(f.name) })), category: u.category, pro: u.pro, author: u.author, license: u.license, source: u.source };
      rerender();
      return;
    }
    pick(list[0]);
  }

  async function pick(file) {
    if (!file) return;
    u.file = file; u.link = "";
    // A title taken from the previous file's name follows the new file; one typed by hand is kept.
    const auto = titleFrom(file.name);
    if (!u.title || u.title === u.autoTitle) u.title = auto;
    u.autoTitle = auto;
    await processNow();
  }
  async function processNow() {
    try {
      u.processed = null; rerender();
      u.focusX = 0.5; u.focusY = 0.5; // a new file starts centred
      if (u.type === "VIDEO" && u.link) u.processed = await posterFromUrl(u.link, u.focusX, u.focusY);
      else if (u.type === "VIDEO") u.processed = await processVideo(u.file, u.focusX, u.focusY);
      else if (u.file) u.processed = await processPhoto(u.file, u.focusX, u.focusY);
    } catch (e) { toast(e.message, true); u.file = null; }
    rerender();
  }

  const link = u.type === "VIDEO" ? h("label", { class: "field" }, h("span", {}, "…or a direct link to an MP4 / WebM file"),
    h("div", { class: "row" }, h("input", { type: "url", placeholder: "https://…/video.mp4", value: u.link, oninput: (e) => { u.link = e.target.value.trim(); } }),
      h("button", { class: "btn", onclick: () => { if (u.link) { u.file = null; u.title = u.title || "Video"; processNow(); } } }, "Use link"))) : null;

  // Left: the crop editor (drag the point anywhere; previews for every phone shape), with the picture's size.
  const p = u.processed;
  const short = p ? Math.min(p.width, p.height) : 0;
  const phone = h("div", { class: "phone-prev" },
    p && p.src ? cropEditor(p, u, async () => { await rethumb(p, u.focusX, u.focusY); })
      : h("div", { class: "phone-screen" }, p ? h("img", { src: p.thumbUrl, alt: "What phones show" })
        : h("div", { class: "phone-empty" }, u.file || u.link ? "Preparing the preview…" : u.type === "VIDEO" ? "Your video appears here" : "Your picture appears here")),
    p ? h("div", { class: "phone-info" }, `${p.width} × ${p.height}`, p.duration ? ` · ${p.duration.toFixed(1)} s` : "",
      short >= 2160 ? h("span", { class: "badge free", style: { marginLeft: "6px" } }, "4K") : null,
      short < 1080 ? h("div", { class: "warn" }, "Small picture: it may look soft on phones. 1080 px wide or more is best.") : null) : null);

  // Right: everything to fill in, in one column, ending with the Add button.
  const fields = h("div", { class: "upload-form" },
    h("label", { class: "field" }, h("span", {}, "Title"), h("input", { type: "text", value: u.title, oninput: (e) => { u.title = e.target.value; } })),
    h("label", { class: "field" }, h("span", {}, "Category"),
      categorySelect(kindOf[u.type], u.category, (key) => { const added = !cats.some((c) => c.key === key); u.category = key; if (added) rerender(); })),
    h("label", { class: "check", style: { marginBottom: "16px" } }, h("input", { type: "checkbox", checked: u.pro, onchange: (e) => { u.pro = e.target.checked; } }),
      "Pro wallpaper: only people who bought Pro can set, download or share it"),
    h("label", { class: "field" }, h("span", {}, "Author (shown in the app)"), h("input", { type: "text", value: u.author, oninput: (e) => { u.author = e.target.value; } })),
    h("label", { class: "field" }, h("span", {}, "Licence"),
      h("select", { onchange: (e) => { u.license = e.target.value; } },
        LICENCES.map((l) => h("option", { value: l, selected: u.license === l }, l || "Choose…")))),
    h("label", { class: "field" }, h("span", {}, "Source link (optional)"), h("input", { type: "url", value: u.source, oninput: (e) => { u.source = e.target.value.trim(); } })));

  const add = h("button", { class: "btn primary", disabled: !p, onclick: () => {
    if (!u.license) { toast("Choose the licence: only upload pictures and videos you are allowed to use", true); return; }
    try { addUpload(u); } catch (e) { toast(e.message, true); return; }
    state.upload = null; changed(); toast("Added. Publish to send it to phones."); rerender();
  } }, "Add wallpaper");

  const pending = m.admin.added.walls.filter((w) => [...m.uploads.keys()].some((k) => k.includes(w.id)));
  root.append(...[
    h("div", { class: "card" },
      h("div", { class: "row", style: { marginBottom: "14px" } },
        seg([["STATIC", "4K photo"], ["GLITTER", "Glitter photo"], ["VIDEO", "Live video"]], u.type, (t) => { state.upload = { ...u, type: t, file: null, link: "", processed: null }; rerender(); })),
      drop, input, link,
      h("div", { class: "upload-grid" }, phone, h("div", {}, fields, h("div", { class: "row end" }, add)))),
    pending.length ? h("div", { class: "card" }, h("h2", {}, `Waiting to be published (${pending.length})`),
      h("div", { class: "walls" }, pending.map((w) => wallCard(m.view(w))))) : null,
    h("p", { class: "hint" }, "Uploads are stored on the wallpaper site (uploads/). Only upload your own work or files whose licence allows use in an app; the author and licence are shown with the wallpaper."),
  ].filter(Boolean));
}

/** Several pictures / videos at once: shared category, Pro, author and licence; a title each; centre crop. */
function pageBulkUpload(root) {
  const m = state.model;
  const b = state.bulkUpload;
  const kindOf = { STATIC: "STATIC", GLITTER: "GLITTER", VIDEO: "LIVE" };
  const cats = m.categoriesFor(kindOf[b.type]);
  if (!cats.some((c) => c.key === b.category)) b.category = cats[0] ? cats[0].key : "";
  const rerender = () => { root.replaceChildren(); pageUpload(root); };
  const status = h("span", { class: "hint grow" });
  const add = h("button", { class: "btn primary" }, `Add ${b.items.length} wallpaper${b.items.length === 1 ? "" : "s"}`);
  add.onclick = async () => {
    if (!b.license) { toast("Choose the licence: only upload pictures and videos you are allowed to use", true); return; }
    add.disabled = true;
    let ok = 0;
    const failed = [];
    for (let i = 0; i < b.items.length; i++) {
      const it = b.items[i];
      status.textContent = `Adding ${i + 1} of ${b.items.length}: ${it.file.name}…`;
      try {
        const processed = b.type === "VIDEO" ? await processVideo(it.file, 0.5) : await processPhoto(it.file, 0.5);
        addUpload({ type: b.type, file: it.file, link: "", processed, focusX: 0.5, title: it.title || titleFrom(it.file.name),
          category: b.category, pro: b.pro, author: b.author, license: b.license, source: b.source });
        ok++;
      } catch (e) { failed.push(`${it.file.name}: ${e.message}`); }
    }
    state.bulkUpload = null;
    changed();
    toast(`Added ${ok} wallpaper${ok === 1 ? "" : "s"}. Publish to send them to phones.` + (failed.length ? ` ${failed.length} could not be added.` : ""), !ok);
    if (failed.length) alert("These could not be added:\n\n" + failed.join("\n"));
    rerender();
  };
  const label = { STATIC: "4K photos", GLITTER: "glitter photos", VIDEO: "live videos" }[b.type];
  root.append(h("div", { class: "card" },
    h("div", { class: "row" }, h("h2", { class: "grow", style: { margin: 0 } }, `${b.items.length} ${label} to add`),
      h("button", { class: "btn small ghost", onclick: () => { state.bulkUpload = null; rerender(); } }, "Cancel")),
    h("p", { class: "hint" }, "These settings apply to all of them. Check each title below. Pictures are cropped around the centre; change one later in the Wallpapers page if needed."),
    h("div", { class: "grid2", style: { marginTop: "12px" } },
      h("div", {},
        h("label", { class: "field" }, h("span", {}, "Category"),
          categorySelect(kindOf[b.type], b.category, (key) => { const isNewCat = !cats.some((c) => c.key === key); b.category = key; if (isNewCat) rerender(); })),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: b.pro, onchange: (e) => { b.pro = e.target.checked; } }),
          "Pro wallpapers: only people who bought Pro can set, download or share them")),
      h("div", {},
        h("label", { class: "field" }, h("span", {}, "Author (shown in the app)"), h("input", { type: "text", value: b.author, oninput: (e) => { b.author = e.target.value; } })),
        h("label", { class: "field" }, h("span", {}, "Licence"),
          h("select", { onchange: (e) => { b.license = e.target.value; } }, LICENCES.map((l) => h("option", { value: l, selected: b.license === l }, l || "Choose…")))),
        h("label", { class: "field" }, h("span", {}, "Source link (optional)"), h("input", { type: "url", value: b.source, oninput: (e) => { b.source = e.target.value.trim(); } })))),
    h("div", { class: "bulk-list" }, b.items.map((it, i) => h("div", { class: "bulk-item" },
      h("span", { class: "bulk-name" }, `${i + 1}. ${it.file.name} · ${(it.file.size / 1e6).toFixed(1)} MB`),
      h("input", { type: "text", value: it.title, "aria-label": "Title", oninput: (e) => { it.title = e.target.value; } }),
      h("button", { class: "btn small ghost", title: "Leave this one out", onclick: () => { b.items.splice(i, 1); if (!b.items.length) state.bulkUpload = null; rerender(); } }, "✕")))),
    h("div", { class: "row", style: { marginTop: "14px" } }, status, add)));
}

/** Phone screen shapes (height : width) people use, oldest to tallest. */
const SCREENS = [["16:9", 16 / 9, "older"], ["18:9", 18 / 9, ""], ["19.5:9", 19.5 / 9, "most"], ["20:9", 20 / 9, "most Android"], ["21:9", 21 / 9, "tall"]];

/** The part of a W x H picture a screen of [ratio] (height / width) shows around the point fx, fy (same rule as the app). */
function cropBox(W, H, fx, fy, ratio) {
  const target = 1 / ratio;
  const cw = W / H > target ? H * target : W;
  const ch = W / H > target ? H : W / target;
  return { x: Math.min(Math.max(0, fx * W - cw / 2), W - cw), y: Math.min(Math.max(0, fy * H - ch / 2), H - ch), w: cw, h: ch };
}

/**
 * Crop in every direction: the whole picture with the point phones centre on (drag it anywhere), the frame a 20:9
 * phone keeps, and small phones of every screen shape showing exactly what they get. [o] holds focusX / focusY;
 * [onDone] runs when a drag ends (to cut a new grid preview).
 */
function cropEditor(p, o, onDone) {
  const W = p.srcW, H = p.srcH;
  const MAXW = 300, MAXH = 440;
  const sc = Math.min(MAXW / W, MAXH / H);
  const bw = Math.round(W * sc), bh = Math.round(H * sc);
  const rect = h("div", { class: "crop-rect" });
  const dot = h("div", { class: "crop-dot" });
  const box = h("div", { class: "crop-edit", style: { width: `${bw}px`, height: `${bh}px` }, title: "Drag to choose the middle of the wallpaper" },
    h("img", { src: p.viewUrl, alt: "", draggable: "false" }), rect, dot);
  const minis = SCREENS.map(([label, r, note]) => {
    const fw = 50, fh = Math.round(50 * r);
    const im = h("img", { src: p.viewUrl, alt: "", draggable: "false" });
    return { r, fw, fh, im, el: h("div", { class: "rp", title: `${label} screen` }, h("div", { class: "rp-frame", style: { width: `${fw}px`, height: `${fh}px` } }, im), h("b", {}, label), note ? h("small", {}, note) : null) };
  });
  const layout = () => {
    const b = cropBox(W, H, o.focusX, o.focusY, 20 / 9);
    Object.assign(rect.style, { left: `${b.x * sc}px`, top: `${b.y * sc}px`, width: `${b.w * sc}px`, height: `${b.h * sc}px` });
    Object.assign(dot.style, { left: `${o.focusX * bw}px`, top: `${o.focusY * bh}px` });
    for (const m of minis) {
      const c = cropBox(W, H, o.focusX, o.focusY, m.r);
      const s2 = m.fw / c.w;
      Object.assign(m.im.style, { width: `${W * s2}px`, height: `${H * s2}px`, transform: `translate(${-c.x * s2}px, ${-c.y * s2}px)` });
    }
  };
  let dragging = false;
  const setFrom = (e) => {
    const r = box.getBoundingClientRect();
    o.focusX = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 1000) / 1000;
    o.focusY = Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 1000) / 1000;
    layout();
  };
  box.addEventListener("pointerdown", (e) => { dragging = true; try { box.setPointerCapture(e.pointerId); } catch (_) { /* no capture: the drag still works inside the picture */ } setFrom(e); });
  box.addEventListener("pointermove", (e) => { if (dragging) setFrom(e); });
  const end = () => { if (!dragging) return; dragging = false; onDone && onDone(); };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", end);
  layout();
  return h("div", { class: "crop-wrap" },
    h("div", { class: "hint crop-title" }, "Crop: drag the dot to choose the middle of the wallpaper (left, right, up or down)"),
    box,
    h("div", { class: "row", style: { justifyContent: "center", marginTop: "6px" } },
      h("button", { class: "btn small ghost", type: "button", onclick: () => { o.focusX = 0.5; o.focusY = 0.5; layout(); onDone && onDone(); } }, "Centre")),
    h("div", { class: "hint", style: { textAlign: "center", marginTop: "8px" } }, "What each phone shows:"),
    h("div", { class: "ratio-previews" }, minis.map((m) => m.el)));
}

/** "Change crop" for an uploaded photo: the editor in a dialog; saving cuts a new grid preview. */
async function changeCrop(id, rec, after) {
  const m = state.model;
  let src;
  try { src = await loadSource(imageUrl(sitePathOf(rec.url))); } catch (e) { toast(e.message, true); return; }
  const o = { focusX: rec.focusX != null ? rec.focusX : 0.5, focusY: rec.focusY != null ? rec.focusY : 0.5 };
  const w = modal(h("h2", {}, "Change crop"), cropEditor(src, o, null),
    h("div", { class: "row end", style: { marginTop: "14px" } },
      h("button", { class: "btn", onclick: () => w.remove() }, "Cancel"),
      h("button", { class: "btn primary", onclick: async () => {
        await rethumb(src, o.focusX, o.focusY);
        const thumbPath = `uploads/thumbs/${id}_${Date.now().toString(36)}.webp`;
        m.setUploadCrop(id, o.focusX, o.focusY, { path: thumbPath, bytes: src.thumb, url: src.thumbUrl });
        w.remove(); changed(); toast("Crop changed. Publish to send it to phones."); after();
      } }, "Save crop")));
}

/** "https://x.github.io/repo/uploads/a.jpg" -> "uploads/a.jpg". */
function sitePathOf(url) {
  const i = (url || "").indexOf("/uploads/");
  return i >= 0 ? url.slice(i + 1) : url;
}

/** "Replace picture / video" for an uploaded wallpaper: new files, the old ones go on the next publish. */
function replaceButton(id, w, rec, after) {
  const m = state.model;
  const isVideo = !!w.video;
  const input = h("input", { type: "file", accept: isVideo ? "video/mp4,video/webm" : "image/*", style: { display: "none" }, onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const stamp = Date.now().toString(36);
      const thumbPath = `uploads/thumbs/${id}_${stamp}.webp`;
      const fx = rec.focusX != null ? rec.focusX : 0.5;
      if (isVideo) {
        const p = await processVideo(file, fx);
        const path = `uploads/${id}_${stamp}.${file.type === "video/webm" ? "webm" : "mp4"}`;
        m.replaceUploadFiles(id, { width: p.width, height: p.height, duration: p.duration || 0, uhd: Math.min(p.width, p.height) >= 2160,
          urls: { [String(Math.min(p.width, p.height) || 1080)]: sitePagesUrl() + path }, thumb: thumbPath },
        [{ path: thumbPath, bytes: p.thumb, url: p.thumbUrl }, { path, bytes: p.bytes, url: p.previewUrl }]);
      } else {
        const p = await processPhoto(file, fx);
        const path = `uploads/${id}_${stamp}.jpg`;
        m.replaceUploadFiles(id, { width: p.width, height: p.height, uhd: Math.min(p.width, p.height) >= 2160, url: sitePagesUrl() + path, thumb: thumbPath },
          [{ path: thumbPath, bytes: p.thumb, url: p.thumbUrl }, { path, bytes: p.full, url: p.previewUrl }]);
      }
      changed(); toast("Replaced. Publish to send it to phones."); after();
    } catch (err) { toast(err.message, true); }
  } });
  return h("span", {}, input, h("button", { class: "btn small", onclick: () => input.click() }, isVideo ? "Replace video" : "Replace picture"));
}

/** The wallpaper site's public address, e.g. https://owner.github.io/repo/ (uploads are linked from there). */
function sitePagesUrl() {
  const [owner, name] = state.repo.split("/");
  return `https://${owner.toLowerCase()}.github.io/${name}/`;
}

function addUpload(u) {
  const m = state.model;
  const p = u.processed;
  const id = "up_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pages = sitePagesUrl();
  const now = Math.floor(Date.now() / 1000);
  const thumbPath = `uploads/thumbs/${id}.webp`;
  const files = [{ path: thumbPath, bytes: p.thumb, url: p.thumbUrl }];
  const credit = { title: u.title.trim() || "Wallpaper", author: u.author.trim(), license: u.license, licenseUrl: "", source: u.source };
  const wall = { id, title: credit.title, tags: [], pro: !!u.pro, rank: 0, addedAt: now, seed: 1 + Math.floor(Math.random() * 9999) };
  if (u.type === "VIDEO") {
    let url = u.link;
    if (!url) {
      const ext = u.file.type === "video/webm" ? "webm" : "mp4";
      const path = `uploads/${id}.${ext}`;
      files.push({ path, bytes: p.bytes, url: p.previewUrl });
      url = pages + path;
    }
    const video = { id, category: u.category, file: "", ...credit, width: p.width, height: p.height, duration: p.duration || 0, focusX: u.focusX, focusY: u.focusY != null ? u.focusY : 0.5, uhd: Math.min(p.width, p.height) >= 2160, urls: { [String(Math.min(p.width, p.height) || 1080)]: url }, thumb: thumbPath };
    m.addUpload({ wall: { ...wall, kind: "LIVE", category: u.category, video: id }, video, files });
  } else {
    const path = `uploads/${id}.jpg`;
    files.push({ path, bytes: p.full, url: p.previewUrl });
    const photo = { id, category: u.category, file: "", ...credit, width: p.width, height: p.height, focusX: u.focusX, focusY: u.focusY != null ? u.focusY : 0.5, uhd: Math.min(p.width, p.height) >= 2160, url: pages + path, thumb: thumbPath };
    const extra = u.type === "GLITTER" ? { effect: "GLITTER", fx: ["#fff3c4", "#ffd36b", "#ffffff"], amount: 1.0 } : {};
    m.addUpload({ wall: { ...wall, kind: u.type, category: u.category, photo: id, ...extra }, photo, files });
  }
}

// ---- premium & ads -----------------------------------------------------------------------------------------------

function pagePremium(root) {
  const m = state.model;
  const c = m.admin.config;
  const setC = (k, v) => { c[k] = v; changed(); drawPreview(); };
  const text = (k, label, hint) => h("label", { class: "field" }, h("span", {}, label),
    h("input", { type: "text", value: c[k], oninput: (e) => setC(k, e.target.value.trim() || DEFAULT_CONFIG[k]) }), hint ? h("div", { class: "hint" }, hint) : null);
  const num = (k, label, min, max, hint) => h("label", { class: "field" }, h("span", {}, label),
    h("input", { type: "number", min, max, value: c[k], oninput: (e) => { const n = Math.round(+e.target.value); if (!Number.isNaN(n)) setC(k, Math.max(min, Math.min(max, n))); } }),
    hint ? h("div", { class: "hint" }, hint) : null);
  const unitField = (k, label) => {
    const warn = h("div", { class: "hint", style: { color: "#ffb4ad", minHeight: "16px" } });
    const check = (v) => { warn.textContent = v && !/^ca-app-pub-\d{16}\/\d{10}$/.test(v) ? "That does not look like an ad unit ID (ca-app-pub-0000000000000000/0000000000). Phones ignore it." : ""; };
    const input = h("input", { type: "text", placeholder: "ca-app-pub-0000000000000000/0000000000", value: c[k] || "", spellcheck: "false",
      oninput: (e) => { const v = e.target.value.trim(); check(v); setC(k, v); } });
    check(c[k] || "");
    return h("label", { class: "field" }, h("span", {}, label), input, warn);
  };
  const tog = (k, label) => h("label", { class: "check", style: { margin: "6px 0 12px", display: "flex" } },
    h("input", { type: "checkbox", checked: !!c[k], onchange: (e) => setC(k, e.target.checked) }), label);
  const preview = h("div", { class: "phone" });
  function drawPreview() {
    const sym = (c.weeklyPrice.match(/^\D+/) || [""])[0].trim();
    preview.replaceChildren(
      h("div", { class: "plan on" }, c.trialDays > 0 ? h("span", { class: "tag" }, "FREE TRIAL") : null, h("div", { class: "t" }, "Weekly"),
        h("div", { class: "p" }, c.trialDays > 0 ? h("small", {}, `${sym ? sym + "0" : "FREE"} for first ${c.trialDays} days, then`) : null, `${c.weeklyPrice}/week`)),
      h("div", { class: "plan" }, h("span", { class: "tag r" }, "BEST VALUE"), h("div", { class: "t" }, "Once"), h("div", { class: "p" }, c.lifetimePrice)),
      h("button", { class: "btn pro", style: { width: "100%", marginTop: "16px", padding: "14px" } }, c.trialDays > 0 ? "START FREE TRIAL →" : "CONTINUE →"));
  }
  drawPreview();
  root.append(h("div", { class: "grid2" },
    h("div", {},
      h("div", { class: "card" }, h("h2", {}, "Pro prices on the upgrade screen"),
        h("p", { class: "hint" }, "Google Play's real prices replace these as soon as they load; checkout always charges Play's price. Set the same prices in Play Console for ",
          h("b", {}, "pro_weekly"), " (subscription with a free-trial offer) and ", h("b", {}, "pro_lifetime"), " (one-time product)."),
        text("weeklyPrice", "Weekly price", "As shown, with the currency symbol, e.g. ₹50.00"),
        text("lifetimePrice", "One-time price"),
        num("trialDays", "Free trial days (0 = no trial)", 0, 30)),
      h("div", { class: "card" }, h("h2", {}, "Ads"),
        tog("adsEnabled", "Show ads to free users"),
        tog("rewardedEnabled", "Also let free users unlock one Pro wallpaper by watching an ad (off: only people who bought Pro can use Pro wallpapers)"),
        tog("interstitialAfterSet", "Full-screen ad after a wallpaper is set"),
        num("interstitialEveryPreviews", "Full-screen ad on every Nth wallpaper opened (0 = never)", 0, 50),
        tog("interstitialAfterDownload", "Full-screen ad after a wallpaper is downloaded"),
        num("interstitialMinGapSec", "At most one full-screen ad every … seconds", 30, 3600, "Google recommends not showing full-screen ads too often; 60 s or more."),
        h("p", { class: "hint" }, "Pro users never see ads.")),
      h("div", { class: "card" }, h("h2", {}, "AdMob ad unit IDs"),
        h("p", { class: "hint" }, "From AdMob › Apps › Ad units. Leave empty to use the IDs built into the app (Google's test ads in this build). Phones use new IDs from their next ad."),
        unitField("interstitialUnitId", "Full-screen (interstitial) ad unit ID"),
        unitField("rewardedUnitId", "Rewarded ad unit ID (Watch an ad to unlock)"),
        h("p", { class: "hint" }, "The AdMob App ID (ca-app-pub-…~…) cannot be changed from here: Android reads it from the app itself. Put it in frontend/local.properties as ",
          h("code", {}, "admob.appId=ca-app-pub-…~…"), " before building the release."))),
    h("div", { class: "card" }, h("h2", {}, "Preview"), preview,
      h("p", { class: "hint", style: { marginTop: "14px" } }, "Which wallpapers are Pro: set it per category on the Categories page, or per wallpaper on the Wallpapers page."),
      h("div", { class: "row" }, h("button", { class: "btn", onclick: () => go("categories") }, "Categories"), h("button", { class: "btn", onclick: () => go("wallpapers", { pro: "pro", kind: "", category: "", status: "", q: "" }) }, "Pro wallpapers")))));
}

// ---- buyers ------------------------------------------------------------------------------------------------------

async function loadBuyers() {
  state.buyers = null; state.buyersError = null;
  try {
    const r = await state.gh.repo(state.dataRepo).catch((e) => { if (e.status === 404) return null; throw e; });
    if (!r) { state.buyersError = "missing-repo"; return; }
    const text = await state.gh.readText(state.dataRepo, "buyers.json", r.defaultBranch);
    if (!text) { state.buyersError = "not-connected"; return; }
    state.buyers = JSON.parse(text);
  } catch (e) { state.buyersError = e.message; }
}

function pageBuyers(root) {
  if (!state.gh) {
    root.append(h("div", { class: "card" }, h("h2", {}, state.local ? "Buyers" : "Sign in to see buyers"), h("p", { class: "hint" }, state.local
      ? "The list of orders comes from the private repository lumawalls-admin-data (Google Play sales reports), which is not set up yet. See backend/admin-data/README.md."
      : "The list of orders is private and needs your GitHub token.")));
    return;
  }
  if (state.buyers === undefined) {
    root.append(h("p", { class: "hint" }, "Loading orders…"));
    loadBuyers().then(() => { if (state.page === "buyers") renderApp(); });
    return;
  }
  if (state.buyersError) { root.append(buyersSetup(state.buyersError)); return; }
  const b = state.buyers;
  const orders = b.orders || [];
  const q = h("input", { type: "text", placeholder: "Search order, product, country" });
  const body = h("tbody");
  const fill = () => {
    const s = q.value.trim().toLowerCase();
    body.replaceChildren(...orders.filter((o) => !s || JSON.stringify(o).toLowerCase().includes(s)).slice(0, 500).map((o) => h("tr", {},
      h("td", {}, o.date), h("td", {}, o.order), h("td", {}, o.product === "pro_lifetime" ? "Lifetime" : o.product === "pro_weekly" ? "Weekly" : o.product),
      h("td", {}, h("span", { class: "badge " + (/refund|cancel/i.test(o.status) ? "hid" : "free") }, o.status)),
      h("td", {}, `${o.amount} ${o.currency}`), h("td", {}, o.country))));
  };
  q.oninput = fill;
  fill();
  const sum = b.summary || {};
  const stat = (n, label) => h("div", { class: "stat" }, h("b", {}, n), h("span", {}, label));
  root.append(
    h("div", { class: "stats" },
      stat((sum.orders || 0).toLocaleString(), "orders"),
      stat((sum.weekly || 0).toLocaleString(), "weekly charges"),
      stat((sum.lifetime || 0).toLocaleString(), "lifetime purchases"),
      stat((sum.refunds || 0).toLocaleString(), "refunds"),
      ...Object.entries(sum.revenue || {}).map(([cur, amt]) => stat(`${Number(amt).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${cur}`, "charged"))),
    h("div", { class: "card" },
      h("div", { class: "row" }, h("h2", { class: "grow", style: { margin: 0 } }, "Orders"), h("span", { class: "hint" }, `Updated ${b.updated || "?"} from Google Play sales reports`),
        h("button", { class: "btn small", onclick: () => { state.buyers = undefined; renderApp(); } }, "Refresh")),
      h("div", { style: { margin: "12px 0" } }, q),
      h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Date", "Order", "Product", "Status", "Amount", "Country"].map((t) => h("th", {}, t)))), body)),
      h("p", { class: "hint" }, "Google does not share buyers' names or e-mail addresses with developers; orders are identified by their Google Play order number.")));
}

function buyersSetup(err) {
  const known = err === "missing-repo" || err === "not-connected";
  return h("div", { class: "card" },
    h("h2", {}, err === "missing-repo" ? `Private data repository ${state.dataRepo} not found` : known ? "Buyers are not connected yet" : "Could not load buyers"),
    known ? null : h("p", { style: { color: "#ffb4ad" } }, err),
    h("p", {}, "A daily GitHub Action in the private repository reads Google Play's sales reports and writes buyers.json there. To connect it once:"),
    h("ol", {},
      h("li", {}, "Play Console › Download reports › Financial: copy the Cloud Storage URI (", h("code", {}, "gs://pubsite_prod_rev_…"), ")."),
      h("li", {}, "Google Cloud console: create a service account and a JSON key."),
      h("li", {}, "Play Console › Users and permissions › Invite new users: add the service account's e-mail with “View financial data”."),
      h("li", {}, `In GitHub › ${state.dataRepo} › Settings › Secrets › Actions add `, h("code", {}, "PLAY_SERVICE_ACCOUNT"), " (the whole JSON key) and ",
        h("code", {}, "PLAY_REPORTS_BUCKET"), " (the pubsite_prod_rev_… name)."),
      h("li", {}, "Run the “Buyers from Play sales reports” workflow once (Actions tab), or wait for the daily run.")),
    h("p", { class: "hint" }, "Sales reports appear once the app has orders, and Google updates them about once a day."),
    h("button", { class: "btn", onclick: () => { state.buyers = undefined; renderApp(); } }, "Check again"));
}

start();
