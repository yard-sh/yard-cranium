// Small DOM helpers shared by app.js and doc.js. Text always goes in as
// textContent: names, titles and previews come from other people.

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

/* --------------------------------------------------------------- colours */

// Eight flag colours, shared by cursors, avatars and workspace glyphs. Hex
// only: the caret extension rejects anything else.
export const FLAG_COLORS = [
  "#E8431F", // tomato
  "#2D5BFF", // cobalt
  "#3C8D2F", // moss
  "#C99A06", // mustard
  "#0E9384", // teal
  "#8E3FAF", // plum
  "#D6457A", // pink
  "#52606D", // slate
];

// The same person gets the same colour everywhere: in every document, on
// every device, for everyone looking.
export function colorOf(id) {
  let h = 0;
  for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FLAG_COLORS[h % FLAG_COLORS.length];
}

export function initial(name) {
  const first = String(name || "").trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}

export function avatar(user, size) {
  const node = el("span", "avatar" + (size ? " avatar--" + size : ""), initial(user.name));
  node.style.setProperty("--c", colorOf(user.user_id));
  node.title = user.name || "";
  return node;
}

export function glyph(workspace, node = el("span", "ws-glyph")) {
  node.textContent = initial(workspace.name);
  node.style.setProperty("--c", colorOf(workspace.id));
  return node;
}

/* ----------------------------------------------------------------- toast */

let toastTimer = 0;

export function toast(message, tone) {
  const node = $("toast");
  node.textContent = message;
  node.dataset.tone = tone || "";
  node.hidden = false;
  // Restart the entrance animation for back-to-back toasts.
  node.style.animation = "none";
  void node.offsetWidth;
  node.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), tone === "error" ? 4200 : 2800);
}

/* --------------------------------------------------------------- dialogs */

// Every dialog is a <dialog> holding a method="dialog" form: Escape and
// Cancel close it with returnValue "cancel", the primary button with "ok".
export function showDialog(dialog, focus) {
  return new Promise((resolve) => {
    dialog.returnValue = "";
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
    if (focus) {
      focus.focus();
      if (focus.select) focus.select();
    }
  });
}

export async function promptDialog({ title, label, value = "", confirm = "Save", max = 60, placeholder = "" }) {
  $("prompt-title").textContent = title;
  $("prompt-label").textContent = label;
  $("prompt-ok").textContent = confirm;
  const input = $("prompt-input");
  input.value = value;
  input.maxLength = max;
  input.placeholder = placeholder;
  const ok = await showDialog($("dlg-prompt"), input);
  const clean = input.value.replace(/\s+/g, " ").trim();
  return ok && clean ? clean : null;
}

export async function confirmDialog({ title, body, confirm = "OK", danger = false, check }) {
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  const ok = $("confirm-ok");
  ok.textContent = confirm;
  ok.className = "btn " + (danger ? "btn--tomato" : "btn--ink");
  const row = $("confirm-check-row");
  row.hidden = !check;
  if (check) {
    $("confirm-check-label").textContent = check.label;
    $("confirm-check").checked = !!check.checked;
  }
  const accepted = await showDialog($("dlg-confirm"), ok);
  return { ok: accepted, checked: !!check && $("confirm-check").checked };
}

/* ----------------------------------------------------------------- menus */

// One open menu at a time; any click outside it, or Escape, closes it.
let openMenu = null;

export function toggleMenu(menu, button) {
  if (openMenu && openMenu.menu === menu) return closeMenu();
  closeMenu();
  menu.hidden = false;
  if (button) button.setAttribute("aria-expanded", "true");
  openMenu = { menu, button };
  const first = menu.querySelector("button, a");
  if (first) first.focus({ preventScroll: true });
}

export function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.hidden = true;
  if (openMenu.button) openMenu.button.setAttribute("aria-expanded", "false");
  openMenu = null;
}

document.addEventListener("click", (event) => {
  if (!openMenu) return;
  if (openMenu.menu.contains(event.target)) {
    if (event.target.closest("a, button")) closeMenu();
    return;
  }
  if (openMenu.button && openMenu.button.contains(event.target)) return;
  closeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openMenu) {
    const button = openMenu.button;
    closeMenu();
    if (button) button.focus();
  }
});

/* ------------------------------------------------------------------ time */

export function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return Math.round(s / 86400) + "d ago";
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

export function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}
