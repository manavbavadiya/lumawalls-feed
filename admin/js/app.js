// Live Wallpapers 4K - admin panel. Plain ES modules, no build step; served from the wallpaper site (GitHub Pages)
// at /admin/. Reads feed.json + admin.json, edits admin.json, publishes through the GitHub API.
import { GitHub } from "./github.js?v=ecf40a71f5";
import { Model, KINDS, KIND_LABEL, TAGS, DEFAULT_CONFIG } from "./model.js?v=ecf40a71f5";
import { processPhoto, processVideo, posterFromUrl, MAX_VIDEO_MB } from "./media.js?v=ecf40a71f5";
import { LOGIN_FILE, lock, unlock, fetchLogin } from "./login.js?v=ecf40a71f5";

const STORE_KEY = "lw4k_admin";
const DEFAULT_REPO = "manavbavadiya/lumawalls-feed";
const DEFAULT_DATA_REPO = "manavbavadiya/lumawalls-admin-data";
const SITE = new URL("../", location.href).href; // the wallpaper site this panel is served from
const MOCK = new URLSearchParams(location.search).has("mock"); // local testing: publish shows the files instead
// One-time owner setup (admin/?setup): GitHub token + admin ID and password. The normal login page asks only for ID and password.
const SETUP = new URLSearchParams(location.search).has("setup");
const NEW_FOR_SEC = 14 * 24 * 3600;
const PAGE = 120;

const state = {
  gh: null, repo: DEFAULT_REPO, dataRepo: DEFAULT_DATA_REPO, branch: "main", user: "", readOnly: false,
  model: null, page: "dashboard",
  filters: { kind: "", category: "", pro: "", status: "", q: "", sort: "recommended" },
  shown: PAGE, selected: new Set(),
  buyers: undefined, buyersError: null,
  upload: null,
  login: null, // the site's encrypted ID + password sign-in (admin-login.json), null = not set up
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
  state.login = await fetchLogin(SITE);
  if (MOCK) { state.readOnly = false; state.user = "local test"; return loadData(); }
  const saved = store.load();
  if (saved.repo) state.repo = saved.repo;
  if (saved.dataRepo) state.dataRepo = saved.dataRepo;
  if (saved.token) {
    try { await signIn(saved.token); return; } catch (e) { toast(e.message, true); }
  }
  renderLogin();
}

async function signIn(token) {
  const gh = new GitHub(token);
  const r = await gh.repo(state.repo).catch((e) => {
    throw new Error(e.status === 401 ? "That token is not valid (or has expired)." : e.status === 404
      ? `The token cannot see ${state.repo}. Give it access to that repository.` : e.message);
  });
  if (!r.canPush) throw new Error(`The token can read ${state.repo} but not write to it. Give it "Contents: Read and write".`);
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
  return SETUP ? renderSetup(error) : renderPasswordLogin(error);
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
      if (id.value.trim().length < 3) { msg.textContent = "The ID needs at least 3 characters."; return; }
      if (pw.value.length < 8) { msg.textContent = "The password needs at least 8 characters."; return; }
      if (pw.value !== pw2.value) { msg.textContent = "The two passwords are different."; return; }
      go.disabled = true; msg.style.color = ""; msg.textContent = "Checking the token…";
      state.repo = repo.value.trim(); state.dataRepo = dataRepo.value.trim();
      try {
        await signIn(token.value.trim());
      } catch (e) { msg.style.color = "#ffb4ad"; msg.textContent = e.message; go.disabled = false; return; }
      try {
        const text = await lock(id.value, pw.value, { token: state.gh.token, repo: state.repo, dataRepo: state.dataRepo });
        await saveLoginFile(text, "Admin: sign-in ID and password updated");
        state.login = JSON.parse(text);
        store.save({ token: state.gh.token, repo: state.repo, dataRepo: state.dataRepo, id: id.value.trim(), remember: false }, false);
        history.replaceState(null, "", location.pathname);
        toast("Saved. From now on sign in with this ID and password (the website takes about a minute to update).");
      } catch (e) { toast("Could not save the ID and password: " + e.message, true); }
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
      try {
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
    h("label", { class: "check", style: { marginBottom: "14px" } }, remember, "Remember on this browser"),
    msg,
    h("div", { class: "row" }, go));
  loginCard(form);
  (id.value ? password : id).focus();
}

function signOut() {
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
  ["premium", "Premium & Ads", "crown"],
  ["buyers", "Buyers", "buyers"],
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
    h("div", { class: "who" }, state.readOnly ? "Read-only (not signed in)" : MOCK ? "Local test mode" : `Signed in · ${state.repo}`),
    state.gh || state.readOnly ? h("button", { class: "nav signout", onclick: signOut }, icon("out"), state.readOnly ? "Sign in" : "Sign out") : null,
  );
  topBar = h("div", { class: "top" });
  const content = h("div", { class: "content" });
  document.getElementById("app").replaceChildren(h("div", { class: "shell" }, side, h("main", { class: "main" }, topBar, content)));
  updateTop();
  const page = { dashboard: pageDashboard, categories: pageCategories, wallpapers: pageWallpapers, upload: pageUpload, premium: pagePremium, buyers: pageBuyers }[state.page];
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
      } else {
        await state.gh.commit(state.repo, state.branch, message, files, (s) => steps.append(h("div", {}, s)));
      }
      m.markPublished();
      w.remove();
      toast("Published");
      renderApp();
    } catch (e) {
      steps.append(h("div", { style: { color: "#ffb4ad" } }, e.message));
      ok.disabled = false;
    }
  };
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
        h("button", { class: "btn", onclick: () => go("wallpapers", { pro: "pro", kind: "", category: "", status: "", q: "" }) }, "See Pro wallpapers"),
        h("button", { class: "btn", onclick: () => go("wallpapers", { status: "hidden", kind: "", category: "", pro: "", q: "" }) }, "See hidden"))),
  );
}

function signInCard() {
  const canSet = !!state.gh || MOCK;
  return h("div", { class: "card" }, h("h2", {}, "Admin sign-in"),
    h("p", {}, "ID and password sign-in: ", h("b", {}, state.login ? "on" : "not set up")),
    h("p", { class: "hint" }, "The login page asks only for the admin ID and password, on any computer or phone. They unlock the GitHub key saved (encrypted) on the wallpaper site, so pick a password nobody can guess."),
    canSet ? h("div", { class: "row" },
      h("button", { class: "btn", onclick: setLoginDialog }, state.login ? "Change ID or password" : "Set ID and password")) : null,
    // The sidebar's Sign out is hidden on phones; this one is always there.
    state.gh || state.readOnly ? h("div", { class: "row", style: { marginTop: "10px" } },
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
      r.group ? null : h("label", { class: "check" },
        h("input", { type: "checkbox", checked: r.hidden, onchange: (e) => { m.editCategory(r.kind, r.key, { hidden: e.target.checked }); changed(); renderApp(); } }), "Hidden"),
      h("button", { class: "btn small", onclick: () => go("wallpapers", { kind: r.kind, category: r.special ? "" : r.key, status: "", pro: "", q: r.special ? "tag:editors" : "" }) }, "Wallpapers"),
      r.isNew ? h("button", { class: "btn small danger", onclick: () => { m.deleteNewCategory(r.kind, r.key); changed(); renderApp(); } }, "Delete") : null),
  );
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
  const byRec = (a, b) => (b.wall.pinned - a.wall.pinned) || (isNew(b.wall) - isNew(a.wall)) || (a.wall.rank - b.wall.rank);
  const sorts = {
    recommended: byRec,
    latest: (a, b) => (b.wall.addedAt || 0) - (a.wall.addedAt || 0) || byRec(a, b),
    views: (a, b) => ((b.wall.hits || [])[3] || -1) - ((a.wall.hits || [])[3] || -1),
    title: (a, b) => (a.wall.title || "").localeCompare(b.wall.title || ""),
  };
  return vs.sort(sorts[f.sort] || byRec);
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
    h("select", { onchange: (e) => set({ pro: e.target.value }) },
      [["", "Pro and free"], ["pro", "Pro only"], ["free", "Free only"]].map(([v, l]) => h("option", { value: v, selected: f.pro === v }, l))),
    h("select", { onchange: (e) => set({ status: e.target.value }) },
      [["", "Any status"], ["visible", "Visible"], ["hidden", "Hidden"], ["edited", "Edited here"], ["uploaded", "Uploaded here"], ["pinned", "Pinned"], ["new", "NEW badge"]]
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
  const shown = list.slice(0, state.shown);
  renderBulk(list);
  grid.replaceChildren(
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
      v.hidden ? h("span", { class: "badge hid" }, "HIDDEN") : null,
      isNew(w) ? h("span", { class: "badge new" }, "NEW") : null,
      w.pinned ? h("span", { class: "badge edit" }, "PINNED") : null,
      v.uploaded ? h("span", { class: "badge edit" }, "UPLOADED") : v.edited ? h("span", { class: "badge edit" }, "EDITED") : null),
    h("div", { class: "tr", onclick: (e) => e.stopPropagation() },
      h("input", { type: "checkbox", checked: sel, "aria-label": "Select", onchange: () => toggleSel(w.id) })),
    h("div", { class: "cap" }, h("b", {}, w.title || w.id), `${KIND_LABEL[w.kind]} · ${w.category}`));
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
    const title = h("input", { type: "text", value: w.title, onchange: () => { m.editWall(id, { title: title.value.trim() }); changed(); draw(); refresh(); } });
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
      (w.kind === "LIVE" || w.kind === "STATIC") ? h("button", { class: "btn small", onclick: () => {
        m.editCategory(w.kind, w.category, { cover: w.id }); changed(); toast(`Cover of ${w.category} set`);
      } }, "Use as category cover") : null,
      h("div", { class: "row", style: { marginTop: "20px" } },
        v.edited ? h("button", { class: "btn", onclick: () => { m.resetWall(id); changed(); draw(); refresh(); } }, "Undo my changes") : null,
        v.uploaded ? h("button", { class: "btn danger", onclick: () => {
          if (!confirm("Delete this uploaded wallpaper? Its files are removed on the next publish.")) return;
          m.deleteUpload(id); changed(); scrim.remove(); refresh();
        } }, "Delete upload") : null));
    scrim.replaceChildren(panel);
  };
  const scrim = h("div", { class: "scrim", onclick: () => scrim.remove() });
  document.body.append(scrim);
  draw();
}

// ---- upload --------------------------------------------------------------------------------------------------

function pageUpload(root) {
  const m = state.model;
  const u = state.upload || (state.upload = { type: "STATIC", file: null, link: "", processed: null, focusX: 0.5, title: "", category: "", pro: false, author: "", license: "", source: "" });
  const kindOf = { STATIC: "STATIC", GLITTER: "GLITTER", VIDEO: "LIVE" };
  const cats = m.categoriesFor(kindOf[u.type]);
  if (!cats.some((c) => c.key === u.category)) u.category = cats[0] ? cats[0].key : "";
  const rerender = () => { root.replaceChildren(); pageUpload(root); };

  const input = h("input", { type: "file", accept: u.type === "VIDEO" ? "video/mp4,video/webm" : "image/*", style: { display: "none" }, onchange: (e) => pick(e.target.files[0]) });
  const drop = h("div", {
    class: "drop", onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); },
    ondragleave: () => drop.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); pick(e.dataTransfer.files[0]); },
  }, u.file ? `${u.file.name} · ${(u.file.size / 1e6).toFixed(1)} MB (click to change)` : u.type === "VIDEO"
    ? `Drop an MP4 / WebM video here or click to choose (up to ${MAX_VIDEO_MB} MB)` : "Drop a picture here or click to choose (portrait or landscape, ideally 2160 px or more)");

  async function pick(file) {
    if (!file) return;
    u.file = file; u.link = "";
    u.title = u.title || file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    await processNow();
  }
  async function processNow() {
    try {
      u.processed = null; rerender();
      if (u.type === "VIDEO" && u.link) u.processed = await posterFromUrl(u.link, u.focusX);
      else if (u.type === "VIDEO") u.processed = await processVideo(u.file, u.focusX);
      else if (u.file) u.processed = await processPhoto(u.file, u.focusX);
    } catch (e) { toast(e.message, true); u.file = null; }
    rerender();
  }

  const link = u.type === "VIDEO" ? h("label", { class: "field" }, h("span", {}, "…or a direct link to an MP4 / WebM file"),
    h("div", { class: "row" }, h("input", { type: "url", placeholder: "https://…/video.mp4", value: u.link, oninput: (e) => { u.link = e.target.value.trim(); } }),
      h("button", { class: "btn", onclick: () => { if (u.link) { u.file = null; u.title = u.title || "Video"; processNow(); } } }, "Use link"))) : null;

  const p = u.processed;
  const preview = p ? h("div", { class: "preview-pair" },
    h("div", { class: "ph" }, h("img", { src: p.thumbUrl, alt: "Preview" })),
    h("div", { class: "grow" },
      h("p", {}, `${p.width} × ${p.height}`, p.duration ? ` · ${p.duration.toFixed(1)} s` : "",
        Math.min(p.width, p.height) >= 2160 ? " · 4K" : Math.min(p.width, p.height) < 1080 ? " · small: may look soft on phones" : ""),
      h("label", { class: "field" }, h("span", {}, "Crop position (what the phone shows)"),
        h("input", { type: "range", min: 0, max: 1, step: 0.01, value: u.focusX, style: { width: "100%" }, onchange: (e) => { u.focusX = +e.target.value; processNow(); } })))) : null;

  const fields = h("div", { class: "grid2", style: { marginTop: "16px" } },
    h("div", {},
      h("label", { class: "field" }, h("span", {}, "Title"), h("input", { type: "text", value: u.title, oninput: (e) => { u.title = e.target.value; } })),
      h("label", { class: "field" }, h("span", {}, "Category"),
        categorySelect(kindOf[u.type], u.category, (key) => { const added = !cats.some((c) => c.key === key); u.category = key; if (added) rerender(); })),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: u.pro, onchange: (e) => { u.pro = e.target.checked; } }), "Pro wallpaper: only people who bought Pro can set, download or share it")),
    h("div", {},
      h("label", { class: "field" }, h("span", {}, "Author (shown in the app)"), h("input", { type: "text", value: u.author, oninput: (e) => { u.author = e.target.value; } })),
      h("label", { class: "field" }, h("span", {}, "Licence"),
        h("select", { onchange: (e) => { u.license = e.target.value; } },
          ["", "Own work", "Public domain", "CC0", "CC BY 4.0", "CC BY-SA 4.0", "Licensed for this app"].map((l) => h("option", { value: l, selected: u.license === l }, l || "Choose…")))),
      h("label", { class: "field" }, h("span", {}, "Source link (optional)"), h("input", { type: "url", value: u.source, oninput: (e) => { u.source = e.target.value.trim(); } }))));

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
      drop, input, link, preview, fields,
      h("div", { class: "row end" }, add)),
    pending.length ? h("div", { class: "card" }, h("h2", {}, `Waiting to be published (${pending.length})`),
      h("div", { class: "walls" }, pending.map((w) => wallCard(m.view(w))))) : null,
    h("p", { class: "hint" }, "Uploads are stored on the wallpaper site (uploads/). Only upload your own work or files whose licence allows use in an app; the author and licence are shown with the wallpaper."),
  ].filter(Boolean));
}

function addUpload(u) {
  const m = state.model;
  const p = u.processed;
  const id = "up_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const [owner, name] = state.repo.split("/");
  const pages = `https://${owner.toLowerCase()}.github.io/${name}/`;
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
    const video = { id, category: u.category, file: "", ...credit, width: p.width, height: p.height, duration: p.duration || 0, focusX: u.focusX, uhd: Math.min(p.width, p.height) >= 2160, urls: { [String(Math.min(p.width, p.height) || 1080)]: url }, thumb: thumbPath };
    m.addUpload({ wall: { ...wall, kind: "LIVE", category: u.category, video: id }, video, files });
  } else {
    const path = `uploads/${id}.jpg`;
    files.push({ path, bytes: p.full, url: p.previewUrl });
    const photo = { id, category: u.category, file: "", ...credit, width: p.width, height: p.height, focusX: u.focusX, focusY: 0.5, uhd: Math.min(p.width, p.height) >= 2160, url: pages + path, thumb: thumbPath };
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
        num("interstitialMinGapSec", "At most one full-screen ad every … seconds", 30, 3600, "Google recommends not showing full-screen ads too often; 60 s or more."),
        h("p", { class: "hint" }, "Pro users never see ads. Ad unit IDs are set in the app (Ads.kt) and the manifest."))),
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
    root.append(h("div", { class: "card" }, h("h2", {}, "Sign in to see buyers"), h("p", { class: "hint" }, "The list of orders is private and needs your GitHub token.")));
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
