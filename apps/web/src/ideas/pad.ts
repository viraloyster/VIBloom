// A sheet to write or sketch on (mouse, pen or finger) or to drop a photo of
// paper. It hands back a picture for Muse to read; nothing is kept.

import { el } from "../dom";

const MAX_SIDE = 1024;

export function openPad(opts: {
  title: string;
  hint: string;
  action: string;
  onRead: (image: string) => Promise<void>;
}) {
  const canvas = el("canvas", { class: "pad-canvas", width: 1200, height: 700 });
  const g = canvas.getContext("2d");
  if (!g) return;
  const paper = () => {
    g.fillStyle = "#fbfaf6";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#11161f";
  };
  paper();
  let drawn = false;
  let last: { x: number; y: number } | undefined;
  const at = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.width,
      y: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    last = at(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!last) return;
    const p = at(e);
    g.lineWidth = 2 + 4 * (e.pressure || 0.5);
    g.beginPath();
    g.moveTo(last.x, last.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last = p;
    drawn = true;
  });
  const lift = () => {
    last = undefined;
  };
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", lift);

  const file = el("input", { type: "file", accept: "image/*", hidden: true });
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      paper();
      const k = Math.min(canvas.width / img.width, canvas.height / img.height);
      const w = img.width * k;
      const h = img.height * k;
      g.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      URL.revokeObjectURL(img.src);
      drawn = true;
    };
    img.src = URL.createObjectURL(f);
  });

  const status = el("p", { class: "fine pad-status" });
  const clear = el("button", { class: "ghost-btn" }, "Clear");
  const photo = el("button", { class: "ghost-btn" }, "Use a photo");
  const cancel = el("button", { class: "ghost-btn" }, "Cancel");
  const read = el("button", { class: "primary" }, opts.action);
  const sheet = el(
    "div",
    { class: "pad", role: "dialog", "aria-label": opts.title },
    el(
      "div",
      { class: "pad-card" },
      el("h3", {}, opts.title),
      el("p", { class: "fine" }, opts.hint),
      canvas,
      status,
      el("div", { class: "row" }, clear, photo, el("span", { class: "spacer" }), cancel, read),
      file,
    ),
  );
  const close = () => {
    sheet.remove();
  };
  clear.addEventListener("click", () => {
    paper();
    drawn = false;
  });
  photo.addEventListener("click", () => {
    file.click();
  });
  cancel.addEventListener("click", close);
  read.addEventListener("click", () => {
    if (!drawn) {
      status.textContent = "Write or draw something first, or use a photo.";
      return;
    }
    read.disabled = true;
    status.textContent = "Muse is reading it...";
    void opts.onRead(picture(canvas)).then(close, (e: unknown) => {
      read.disabled = false;
      status.textContent = e instanceof Error ? e.message : String(e);
    });
  });
  document.body.append(sheet);
}

// Downscaled JPEG: enough for handwriting, a fraction of the tokens.
function picture(canvas: HTMLCanvasElement): string {
  const k = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height));
  const out = el("canvas", {
    width: Math.round(canvas.width * k),
    height: Math.round(canvas.height * k),
  });
  out.getContext("2d")?.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.9);
}
