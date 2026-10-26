// The panel's data: feed.json (owned by the content tools, read-only here) + admin.json (the panel's edits).
// effective() applies admin.json exactly like the app does (AdminOverlay.kt), so what you see is what phones get.

export const KINDS = ["LIVE", "GLITTER", "CLOCK", "STATIC"];
export const KIND_LABEL = { LIVE: "Live", GLITTER: "Glitter", CLOCK: "Live Clock", STATIC: "4K Static" };
export const TAGS = [["editors", "Editor's Choice"], ["top", "Top Pick"], ["exclusive", "Exclusive"]];

export const DEFAULT_CONFIG = {
  weeklyPrice: "₹50.00",
  lifetimePrice: "₹299.00",
  trialDays: 3,
  adsEnabled: true,
  rewardedEnabled: true,
  interstitialAfterSet: true,
  interstitialEveryPreviews: 3,
  interstitialMinGapSec: 60,
};

export function emptyAdmin() {
  return { schema: 1, updatedAt: 0, config: { ...DEFAULT_CONFIG }, categories: [], walls: {}, added: { walls: [], photos: [], videos: [] } };
}

/** Fills missing parts so the rest of the panel can rely on every field existing. */
export function normalizeAdmin(a) {
  const out = emptyAdmin();
  if (!a) return out;
  out.updatedAt = a.updatedAt || 0;
  out.config = { ...DEFAULT_CONFIG, ...(a.config || {}) };
  out.categories = Array.isArray(a.categories) ? a.categories : [];
  out.walls = a.walls && typeof a.walls === "object" ? a.walls : {};
  const ad = a.added || {};
  out.added = { walls: ad.walls || [], photos: ad.photos || [], videos: ad.videos || [] };
  return out;
}

export class Model {
  constructor(feed, admin) {
    this.feed = feed;
    this.admin = normalizeAdmin(admin);
    this.saved = JSON.stringify(this.admin);
    /** path -> {bytes, url} for files uploaded since the last publish (url = local preview). */
    this.uploads = new Map();
    /** paths of uploaded files to delete on publish. */
    this.deletions = new Set();
    this.rebuild();
  }

  get dirty() {
    return JSON.stringify(this.admin) !== this.saved || this.uploads.size > 0 || this.deletions.size > 0;
  }

  /** Short list of what changed since the last publish, for the commit message and the publish dialog. */
  changes() {
    const before = normalizeAdmin(JSON.parse(this.saved));
    const out = [];
    const cfgKeys = Object.keys(DEFAULT_CONFIG).filter((k) => before.config[k] !== this.admin.config[k]);
    if (cfgKeys.length) out.push(`settings: ${cfgKeys.join(", ")}`);
    const cat = (list) => new Map(list.map((c) => [`${c.kind}/${c.key}`, JSON.stringify(c)]));
    const cb = cat(before.categories), ca = cat(this.admin.categories);
    const catChanged = [...new Set([...cb.keys(), ...ca.keys()])].filter((k) => cb.get(k) !== ca.get(k));
    if (catChanged.length) out.push(`${catChanged.length} categor${catChanged.length === 1 ? "y" : "ies"}`);
    const wb = before.walls, wa = this.admin.walls;
    const wallChanged = [...new Set([...Object.keys(wb), ...Object.keys(wa)])].filter((k) => JSON.stringify(wb[k]) !== JSON.stringify(wa[k]));
    if (wallChanged.length) out.push(`${wallChanged.length} wallpaper edit${wallChanged.length === 1 ? "" : "s"}`);
    const ids = (l) => new Set(l.map((w) => w.id));
    const added = [...ids(this.admin.added.walls)].filter((id) => !ids(before.added.walls).has(id));
    const removed = [...ids(before.added.walls)].filter((id) => !ids(this.admin.added.walls).has(id));
    if (added.length) out.push(`${added.length} uploaded`);
    if (removed.length) out.push(`${removed.length} upload${removed.length === 1 ? "" : "s"} deleted`);
    return out;
  }

  markPublished() {
    this.saved = JSON.stringify(this.admin);
    this.uploads.clear();
    this.deletions.clear();
  }

  // ---- reading -------------------------------------------------------------------------------------------

  rebuild() {
    const photos = new Map(this.feed.photos.map((p) => [p.id, p]));
    const videos = new Map(this.feed.videos.map((v) => [v.id, v]));
    this.admin.added.photos.forEach((p) => photos.set(p.id, p));
    this.admin.added.videos.forEach((v) => videos.set(v.id, v));
    this.photos = photos;
    this.videos = videos;
    this.addedIds = new Set(this.admin.added.walls.map((w) => w.id));
    const all = new Map();
    this.feed.walls.forEach((w) => all.set(w.id, w));
    this.admin.added.walls.forEach((w) => all.set(w.id, w));
    this.base = [...all.values()];
    this.baseById = all;
  }

  catEdit(kind, key) {
    return this.admin.categories.find((c) => c.kind === kind && c.key === key);
  }

  /** The wallpaper as phones will see it, plus why: {wall, hidden, proFrom: "wall"|"category"|"published"}. */
  view(w) {
    const e = this.admin.walls[w.id] || {};
    const category = e.category || w.category;
    const c = this.catEdit(w.kind, category) || {};
    const pro = e.pro != null ? e.pro : c.pro != null ? c.pro : !!w.pro;
    const proFrom = e.pro != null ? "wall" : c.pro != null ? "category" : "published";
    return {
      wall: { ...w, category, pro, title: e.title || w.title, tags: e.tags || w.tags || [], pinned: !!e.pinned },
      hidden: !!e.hidden || !!c.hidden,
      hiddenBy: e.hidden ? "wall" : c.hidden ? "category" : null,
      proFrom,
      edited: !!this.admin.walls[w.id],
      uploaded: this.addedIds.has(w.id),
    };
  }

  views() {
    return this.base.map((w) => this.view(w));
  }

  /**
   * Category rows per kind as the app shows them (LIVE / STATIC have pages), plus one row each for the glitter
   * and clock sets so they can be made Pro / free as a whole. New categories from the panel come last.
   */
  categoryRows() {
    const rows = [];
    const seen = new Set();
    this.feed.categories.forEach((c, i) => {
      seen.add(`${c.kind}/${c.key}`);
      rows.push({ key: c.key, kind: c.kind, name: c.name, cover: c.cover, coverImage: c.coverImage || "", index: i, special: c.key === "editors" });
    });
    for (const kind of ["GLITTER", "CLOCK"]) {
      const keys = [...new Set(this.base.filter((w) => w.kind === kind).map((w) => w.category))];
      keys.forEach((key) => { seen.add(`${kind}/${key}`); rows.push({ key, kind, name: KIND_LABEL[kind], cover: "", index: 1000, group: true }); });
    }
    this.admin.categories.forEach((e) => {
      if (!seen.has(`${e.kind}/${e.key}`)) rows.push({ key: e.key, kind: e.kind, name: e.name || e.key, cover: e.cover || "", index: 5000, isNew: true });
    });
    const vs = this.views();
    return rows.map((r) => {
      const e = this.catEdit(r.kind, r.key) || {};
      const inCat = vs.filter((v) => v.wall.kind === r.kind && (r.special ? (v.wall.tags || []).includes("editors") : v.wall.category === r.key));
      return {
        ...r,
        edit: e,
        name: e.name || r.name,
        cover: e.cover || r.cover,
        coverImage: e.cover ? "" : r.coverImage,
        hidden: !!e.hidden,
        order: e.order != null ? e.order : 10000 + r.index,
        total: inCat.length,
        visible: inCat.filter((v) => !v.hidden).length,
        pro: inCat.filter((v) => !v.hidden && v.wall.pro).length,
      };
    }).sort((a, b) => (a.kind === b.kind ? a.order - b.order : KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)));
  }

  /** Categories a wallpaper of [kind] can be moved to. */
  categoriesFor(kind) {
    if (kind === "GLITTER" || kind === "CLOCK") return [...new Set(this.base.filter((w) => w.kind === kind).map((w) => w.category))].map((k) => ({ key: k, name: k }));
    return this.categoryRows().filter((r) => r.kind === kind && !r.special && !r.group);
  }

  thumbPath(w) {
    if (w.video) { const v = this.videos.get(w.video); return (v && v.thumb) || `vthumbs/${w.video}.webp`; }
    if (w.photo) { const p = this.photos.get(w.photo); return (p && p.thumb) || `thumbs/${w.photo}.webp`; }
    return null; // drawn wallpaper: no picture on the site
  }

  // ---- editing ---------------------------------------------------------------------------------------------

  /** Merges [patch] into the wallpaper's edit; keys set to undefined/null/false-default are removed. */
  editWall(id, patch) {
    const e = { ...(this.admin.walls[id] || {}), ...patch };
    const w = this.baseById.get(id);
    for (const k of Object.keys(e)) {
      if (e[k] === undefined || e[k] === null) delete e[k];
      else if ((k === "hidden" || k === "pinned") && e[k] === false) delete e[k];
      else if (k === "title" && (e[k] === "" || e[k] === w.title)) delete e[k];
      else if (k === "category" && e[k] === w.category) delete e[k];
      else if (k === "tags" && sameSet(e[k], w.tags || [])) delete e[k];
    }
    if (Object.keys(e).length) this.admin.walls[id] = e; else delete this.admin.walls[id];
  }

  resetWall(id) {
    delete this.admin.walls[id];
  }

  editCategory(kind, key, patch) {
    let e = this.catEdit(kind, key);
    if (!e) { e = { key, kind }; this.admin.categories.push(e); }
    Object.assign(e, patch);
    for (const k of Object.keys(e)) {
      if (k === "key" || k === "kind") continue;
      if (e[k] === undefined || e[k] === null || e[k] === "" || (k === "hidden" && e[k] === false)) delete e[k];
    }
    const original = this.feed.categories.find((c) => c.kind === kind && c.key === key);
    if (original && e.name === original.name) delete e.name;
    if (Object.keys(e).length === 2 && original) this.admin.categories = this.admin.categories.filter((c) => c !== e);
  }

  /** Writes an explicit order for every category of [kind] (after drag / up-down). */
  reorder(kind, keys) {
    keys.forEach((key, i) => this.editCategory(kind, key, { order: i }));
  }

  addCategory(kind, key, name) {
    if (this.categoryRows().some((r) => r.kind === kind && r.key === key)) throw new Error("A category with that key already exists");
    this.admin.categories.push({ key, kind, name });
  }

  deleteNewCategory(kind, key) {
    this.admin.categories = this.admin.categories.filter((c) => !(c.kind === kind && c.key === key));
  }

  // ---- uploads ---------------------------------------------------------------------------------------------

  addUpload({ wall, photo, video, files }) {
    if (photo) this.admin.added.photos.push(photo);
    if (video) this.admin.added.videos.push(video);
    this.admin.added.walls.push(wall);
    files.forEach((f) => { this.uploads.set(f.path, f); this.deletions.delete(f.path); });
    this.rebuild();
  }

  deleteUpload(id) {
    const w = this.admin.added.walls.find((x) => x.id === id);
    if (!w) return;
    const paths = [];
    if (w.photo) {
      const p = this.admin.added.photos.find((x) => x.id === w.photo);
      if (p) { paths.push(p.thumb, sitePath(p.url)); this.admin.added.photos = this.admin.added.photos.filter((x) => x !== p); }
    }
    if (w.video) {
      const v = this.admin.added.videos.find((x) => x.id === w.video);
      if (v) { paths.push(v.thumb, ...Object.values(v.urls || {}).map(sitePath)); this.admin.added.videos = this.admin.added.videos.filter((x) => x !== v); }
    }
    this.admin.added.walls = this.admin.added.walls.filter((x) => x !== w);
    delete this.admin.walls[id];
    for (const p of paths.filter(Boolean)) {
      if (this.uploads.has(p)) this.uploads.delete(p); else if (p.startsWith("uploads/")) this.deletions.add(p);
    }
    this.rebuild();
  }

  /** Files for one publish commit. */
  publishFiles() {
    this.admin.updatedAt = Math.floor(Date.now() / 1000);
    const files = [{ path: "admin.json", text: JSON.stringify(this.admin, null, 1) + "\n" }];
    this.uploads.forEach((f, path) => files.push({ path, bytes: f.bytes }));
    this.deletions.forEach((path) => files.push({ path, delete: true }));
    return files;
  }
}

/** "https://x.github.io/repo/uploads/a.jpg" -> "uploads/a.jpg" (files inside this site only). */
export function sitePath(url) {
  if (!url) return null;
  const i = url.indexOf("/uploads/");
  return i >= 0 ? url.slice(i + 1) : null;
}

function sameSet(a, b) {
  return a.length === b.length && a.every((x) => b.includes(x));
}
