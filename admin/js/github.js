// GitHub REST client for the admin panel: read files, and publish several files (and deletions) as ONE commit
// with the Git Data API. The token never leaves the browser except to api.github.com.

const API = "https://api.github.com";

export class GitHub {
  constructor(token) {
    this.token = token;
  }

  async call(method, path, body, accept = "application/vnd.github+json") {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try { msg = (await res.json()).message || msg; } catch (_) { /* not JSON */ }
      const err = new Error(`GitHub: ${msg}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return accept.includes("raw") ? res.text() : res.json();
  }

  /** {defaultBranch, canPush, private} or throws (401 bad token, 404 no access). */
  async repo(fullName) {
    const r = await this.call("GET", `/repos/${fullName}`);
    return { defaultBranch: r.default_branch, canPush: !!(r.permissions && r.permissions.push), private: r.private };
  }

  /** Commits that changed [path], newest first: [{sha, author, time, message}]. */
  async history(fullName, path, ref, limit = 60) {
    const list = await this.call("GET", `/repos/${fullName}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=${limit}`);
    return list.map((c) => ({ sha: c.sha, author: (c.commit.author || {}).name || "", time: Math.floor(Date.parse((c.commit.author || {}).date || 0) / 1000), message: c.commit.message.split("\n")[0] }));
  }

  /** File bytes at [ref], or null when it does not exist there. */
  async readBytes(fullName, path, ref) {
    const res = await fetch(`${API}/repos/${fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github.raw+json", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** File text, or null when it does not exist. */
  async readText(fullName, path, ref) {
    try {
      return await this.call("GET", `/repos/${fullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, null,
        "application/vnd.github.raw+json");
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /**
   * One commit on [branch]: files = [{path, text}|{path, bytes: Uint8Array}|{path, delete: true}].
   * Retries on a moving branch (the daily stats Action may commit at the same time).
   */
  async commit(fullName, branch, message, files, onStep = () => {}) {
    const blobs = new Map();
    for (const f of files) {
      if (f.delete) continue;
      onStep(`Uploading ${f.path}`);
      const content = f.bytes ? bytesToBase64(f.bytes) : utf8ToBase64(f.text);
      const b = await this.call("POST", `/repos/${fullName}/git/blobs`, { content, encoding: "base64" });
      blobs.set(f.path, b.sha);
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      onStep("Creating commit");
      const ref = await this.call("GET", `/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`);
      const head = ref.object.sha;
      const headCommit = await this.call("GET", `/repos/${fullName}/git/commits/${head}`);
      const existing = await this.paths(fullName, headCommit.tree.sha, files.filter((f) => f.delete).map((f) => f.path));
      const tree = files
        .filter((f) => !f.delete || existing.has(f.path))
        .map((f) => ({ path: f.path, mode: "100644", type: "blob", sha: f.delete ? null : blobs.get(f.path) }));
      const t = await this.call("POST", `/repos/${fullName}/git/trees`, { base_tree: headCommit.tree.sha, tree });
      const c = await this.call("POST", `/repos/${fullName}/git/commits`, { message, tree: t.sha, parents: [head] });
      try {
        await this.call("PATCH", `/repos/${fullName}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: c.sha, force: false });
        return c.sha;
      } catch (e) {
        if (e.status !== 422 || attempt === 3) throw e; // 422 = branch moved; build on the new head
      }
    }
  }

  /** Which of [paths] exist in the tree (deleting a missing path would fail the commit). */
  async paths(fullName, treeSha, paths) {
    if (!paths.length) return new Set();
    const t = await this.call("GET", `/repos/${fullName}/git/trees/${treeSha}?recursive=1`);
    const all = new Set(t.tree.map((e) => e.path));
    return new Set(paths.filter((p) => all.has(p)));
  }
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function utf8ToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function bytesToBase64(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
