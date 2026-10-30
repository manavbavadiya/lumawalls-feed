// Image / video processing for uploads, all in the browser: the full-size picture the app downloads, and the
// 300 x 533 WebP preview the grids show (same size as the bundled thumbs).

export const THUMB_W = 300;
export const THUMB_H = 533;
const MAX_LONG_SIDE = 3840;
export const MAX_VIDEO_MB = 40;

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file is not a picture this browser can read")); };
    img.src = url;
  });
}

/** Full-size JPEG (long side at most 3840 px) and the portrait WebP thumb cropped around [focusX]. */
export async function processPhoto(file, focusX = 0.5, focusY = 0.5) {
  const { img, url } = await loadImage(file);
  const w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, MAX_LONG_SIDE / Math.max(w, h));
  const fw = Math.round(w * s), fh = Math.round(h * s);
  // Always re-encode: the browser draws phone photos upright (EXIF rotation), Android's decoder would not.
  const full = await canvasBytes(fw, fh, (c) => c.drawImage(img, 0, 0, fw, fh), "image/jpeg", 0.92);
  const thumb = await coverThumb(img, w, h, focusX, focusY);
  return { width: fw, height: fh, full, thumb: thumb.bytes, thumbUrl: thumb.url, previewUrl: url, src: img, srcW: w, srcH: h, viewUrl: url };
}

/** A copy of the current video frame at full size (the crop editor shows it; the thumb is cut from it). */
async function frameOf(v) {
  const c = document.createElement("canvas");
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
  return { canvas: c, url: blob ? URL.createObjectURL(blob) : "" };
}

/** New grid preview (thumb) for another crop point, without processing the whole file again. */
export async function rethumb(p, focusX, focusY) {
  const t = await coverThumb(p.src, p.srcW, p.srcH, focusX, focusY);
  p.thumb = t.bytes;
  p.thumbUrl = t.url;
  return p;
}

/** The picture at [url] (same site) ready for the crop editor and rethumb(). */
export function loadSource(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ src: img, srcW: img.naturalWidth, srcH: img.naturalHeight, viewUrl: url, width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not load that picture"));
    img.src = url;
  });
}

/** Category cover picture: 1080 x 386 WebP (the app shows covers as wide 2.8 : 1 banners), cropped around [focusY]. */
export async function processCover(file, focusY = 0.5) {
  const { img, url } = await loadImage(file);
  const W = 1080, H = 386;
  const w = img.naturalWidth, h = img.naturalHeight;
  const cw = w / h > W / H ? h * (W / H) : w;
  const ch = w / h > W / H ? h : w / (W / H);
  const sx = (w - cw) / 2;
  const sy = Math.min(Math.max(0, focusY * h - ch / 2), h - ch);
  const bytes = await canvasBytes(W, H, (c) => c.drawImage(img, sx, sy, cw, ch, 0, 0, W, H), "image/webp", 0.85);
  URL.revokeObjectURL(url);
  return { bytes, url: URL.createObjectURL(new Blob([bytes], { type: "image/webp" })) };
}

/** Reads size and duration, grabs a frame (about 1 s in) for the poster. */
export function processVideo(file, focusX = 0.5, focusY = 0.5) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_VIDEO_MB * 1e6) return reject(new Error(`Videos up to ${MAX_VIDEO_MB} MB can be uploaded; use a link for bigger files`));
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.onerror = () => reject(new Error("This browser cannot play that video. Use MP4 (H.264) or WebM"));
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = async () => {
      try {
        const thumb = await coverThumb(v, v.videoWidth, v.videoHeight, focusX, focusY);
        const frame = await frameOf(v);
        resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, bytes: new Uint8Array(await file.arrayBuffer()), thumb: thumb.bytes, thumbUrl: thumb.url, previewUrl: url,
          src: frame.canvas, srcW: v.videoWidth, srcH: v.videoHeight, viewUrl: frame.url });
      } catch (e) { reject(e); }
    };
    v.src = url;
  });
}

/** Poster from a video at a URL (link instead of upload). Needs the server to allow cross-origin reads. */
export function posterFromUrl(src, focusX = 0.5, focusY = 0.5) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.onerror = () => reject(new Error("Could not load that video link (it must be a direct .mp4 / .webm file)"));
    v.onloadedmetadata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = async () => {
      try {
        const thumb = await coverThumb(v, v.videoWidth, v.videoHeight, focusX, focusY);
        const frame = await frameOf(v);
        resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration, thumb: thumb.bytes, thumbUrl: thumb.url,
          src: frame.canvas, srcW: v.videoWidth, srcH: v.videoHeight, viewUrl: frame.url });
      } catch (e) { reject(new Error("The video loaded, but its site does not allow taking a poster frame. Upload a poster picture instead.")); }
    };
    v.src = src;
  });
}

async function coverThumb(source, w, h, fx, fy) {
  const target = THUMB_W / THUMB_H;
  const cw = w / h > target ? h * target : w;
  const ch = w / h > target ? h : w / target;
  const sx = Math.min(Math.max(0, fx * w - cw / 2), w - cw);
  const sy = Math.min(Math.max(0, fy * h - ch / 2), h - ch);
  const bytes = await canvasBytes(THUMB_W, THUMB_H, (c) => c.drawImage(source, sx, sy, cw, ch, 0, 0, THUMB_W, THUMB_H), "image/webp", 0.82);
  return { bytes, url: URL.createObjectURL(new Blob([bytes], { type: "image/webp" })) };
}

function canvasBytes(w, h, draw, type, quality) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  draw(ctx);
  return new Promise((resolve, reject) => c.toBlob(async (b) => {
    if (!b) return reject(new Error("Could not encode the picture"));
    resolve(new Uint8Array(await b.arrayBuffer()));
  }, type, quality));
}
