// One open document: a Y.Doc, its connection (sync.js), its title, and the
// editor bound to it (editing.js). Loaded on demand by app.js, so the document grid never
// downloads the editor bundle.

import { Y, Awareness, fromBase64 } from "./vendor/editor.js";
import { connectDoc, REMOTE, SEED } from "./sync.js";
import { api } from "./api.js";
import { createEditor, bindChrome, resetChrome } from "./editing.js";
import { $, el, avatar } from "./ui.js";

// FROZEN, both of them. A document starts from one of these exact byte
// strings. Yjs names content by (client, clock), so any number of tabs
// applying the same seed get one copy, even when two people open a
// brand-new document at the same moment. The seed is never sent: every tab
// applies it locally (see seed below), and every edit hangs off it.
//
// SEED_UPDATE is one empty paragraph from client 1 at clock 0.
// LEGACY_SEED is an empty title and an empty paragraph from client 0: what
// documents started from when the first line was a separate title.
// Changing either would duplicate or orphan the content of every document
// that started from it.
const SEED_UPDATE = "AQEBAAcBB2RlZmF1bHQDCXBhcmFncmFwaAA=";
const LEGACY_SEED = "AQIAAAcBB2RlZmF1bHQDBXRpdGxlhwAAAwlwYXJhZ3JhcGgA";
const SEED_CLIENT = 1;
const LEGACY_CLIENT = 0;

// Where a renamed document keeps its name. Unset, the title is the first
// line of text.
const NAME_KEY = "title";

const MAX_TITLE = 200; // the object's limit too
const META_DEBOUNCE_MS = 1500;
const LOCAL_EDIT_WINDOW_MS = 30 * 1000;

const STOP_TEXT = {
  removed: "You were removed from this workspace, so this document closed.",
  deleted: "This document was deleted.",
  gone: "This document was deleted, or you no longer have access to it.",
  full: "Too many people are in this document right now. Try again in a bit.",
  rejected: "This tab fell out of step with the document. Reload to keep editing.",
  too_big: "That change was too large to sync. Reload to keep editing.",
};

const STATUS_TEXT = {
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  offline: "Offline · edits kept",
  saving: "Saving",
  saved: "Saved",
  stopped: "Closed",
};

// openDoc(id, { signal, onMeta, onWorkspace }) → { destroy }, or null when
// `signal` aborted first (the person moved on while it was loading). Throws
// when the document can't be opened (404 and friends); app.js handles that.
export async function openDoc(docId, { signal, onMeta, onWorkspace } = {}) {
  const view = resetView();
  const meta = await api(`api/docs/${encodeURIComponent(docId)}`);
  if (signal && signal.aborted) return null;
  // Callbacks from this document stop reaching the page once it's left.
  const live = (fn) => (...args) => {
    if (!(signal && signal.aborted)) fn(...args);
  };
  if (onWorkspace) onWorkspace(meta.workspace);
  $("doc-back").href = "#/w/" + meta.workspace.id;
  $("doc-back-label").textContent = meta.workspace.name;
  $("doc-banner-back").href = "#/w/" + meta.workspace.id;
  showTitle(meta.title);

  const ydoc = new Y.Doc();
  const names = ydoc.getMap("meta");
  const awareness = new Awareness(ydoc);

  let editor = null;
  let saved = true;
  let status = "connecting";
  let lastLocalEdit = 0;
  let lastSent = { title: meta.title, preview: meta.preview };
  let metaTimer = 0;

  const renderStatus = () => {
    const state = status === "connected" ? (saved ? "saved" : "saving") : status;
    const node = $("doc-status");
    node.dataset.state = state;
    node.textContent = STATUS_TEXT[state] || state;
  };

  const sync = connectDoc(docId, ydoc, awareness, {
    onStatus: live((next) => {
      status = next;
      renderStatus();
    }),
    onSaved: live((value) => {
      saved = value;
      renderStatus();
    }),
    onPeers: live(renderPeers),
    onStop: live((reason) => {
      if (editor) editor.setEditable(false);
      view.stop();
      $("doc-banner-text").textContent = STOP_TEXT[reason] || "This document closed.";
      $("doc-banner-reload").hidden = reason === "removed" || reason === "deleted" || reason === "gone";
      $("doc-banner").hidden = false;
      $("doc-sheet").classList.remove("is-loading");
      $("doc-loading").hidden = true;
    }),
  });

  // Every edit made in this tab (not received, not the seed) counts as
  // local; only tabs that edited recently report the title and preview.
  ydoc.on("update", (_update, origin) => {
    if (origin !== REMOTE && origin !== SEED) lastLocalEdit = Date.now();
  });

  let you;
  try {
    ({ you } = await sync.firstSync);
  } catch {
    // Stopped before the first sync: the banner already explains why.
    if (signal && signal.aborted) return sync.close(), null;
    return { destroy: () => sync.close() };
  }
  if (signal && signal.aborted) return sync.close(), null;
  seed(ydoc);

  // Created only after the first sync, so a keystroke can never land in
  // a document that is still loading.
  editor = createEditor({ element: $("editor"), ydoc, awareness, you });

  $("doc-sheet").classList.remove("is-loading");
  $("doc-loading").hidden = true;

  // Title and preview: shown here straight away, sent to the object (which
  // writes them to the grid) when this tab has been editing. A rename is a
  // change to the Y.Doc like any other, so it reaches everyone's top bar
  // the same way typing does.
  const titleNow = () => names.get(NAME_KEY) || firstLine(editor.state.doc);
  const reportMeta = () => {
    metaTimer = 0;
    const next = deriveMeta(editor.state.doc, names.get(NAME_KEY));
    showTitle(next.title);
    if (onMeta) onMeta(docId, next);
    if (Date.now() - lastLocalEdit > LOCAL_EDIT_WINDOW_MS) return;
    if (next.title === lastSent.title && next.preview === lastSent.preview) return;
    if (sync.sendMeta(next)) lastSent = next;
  };
  const changed = () => {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(reportMeta, META_DEBOUNCE_MS);
    showTitle(titleNow());
  };
  editor.on("update", changed);
  names.observe(changed);
  showTitle(titleNow());
  const rename = view.bindRename({
    current: titleNow,
    fallback: () => firstLine(editor.state.doc),
    rename: (name) => (name ? names.set(NAME_KEY, name) : names.delete(NAME_KEY)),
    done: () => editor.commands.focus(),
  });
  view.bindChrome(editor, { rename, title: titleNow });

  // A new, empty document opens with the cursor on its first line.
  if (!editor.state.doc.textContent) editor.commands.focus("start");

  return {
    destroy() {
      if (metaTimer) reportMeta();
      clearTimeout(metaTimer);
      view.unbind();
      if (editor) editor.destroy();
      sync.close();
      document.title = "Cranium";
    },
  };
}

/* ------------------------------------------------------------------ view */

// Clears whatever the last document left behind and returns the bindings
// for this one: the editing chrome and the rename box.
function resetView() {
  $("editor").replaceChildren();
  $("doc-sheet").classList.add("is-loading");
  $("doc-loading").hidden = false;
  $("doc-banner").hidden = true;
  $("doc-peers").replaceChildren();
  resetChrome();
  $("doc-status").dataset.state = "connecting";
  $("doc-status").textContent = STATUS_TEXT.connecting;
  showTitle("");
  $("doc-title").hidden = false;
  $("doc-title").disabled = true;
  $("doc-rename").hidden = true;

  let chrome = null;
  let unrename = () => {};
  return {
    bindChrome(editor, options) {
      chrome = bindChrome(editor, options);
    },
    // The name in the top bar turns into a text box on click (or File >
    // Rename, which calls what this returns). Enter or clicking away saves,
    // Escape doesn't, and saving an empty name goes back to the first line.
    bindRename({ current, rename, fallback, done }) {
      const button = $("doc-title");
      const input = $("doc-rename");
      const abort = new AbortController();
      const on = { signal: abort.signal };
      let editing = false;
      const open = () => {
        editing = true;
        input.value = current();
        input.placeholder = fallback() || "Untitled";
        button.hidden = true;
        input.hidden = false;
        input.focus();
        input.select();
      };
      const close = (save) => {
        if (!editing) return false;
        editing = false;
        input.hidden = true;
        button.hidden = false;
        const name = input.value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
        if (save && name !== current()) rename(name);
        return true;
      };
      button.disabled = false;
      button.addEventListener("click", open, on);
      input.addEventListener(
        "keydown",
        (event) => {
          if (event.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
          event.preventDefault();
          if (close(event.key === "Enter")) done();
        },
        on,
      );
      input.addEventListener("blur", () => close(true), on);
      unrename = () => {
        abort.abort();
        close(false);
        button.disabled = true;
      };
      return () => !button.disabled && open();
    },
    // The document closed under this tab: nothing edits it any more.
    stop() {
      unrename();
      if (chrome) chrome.stop();
    },
    unbind() {
      unrename();
      if (chrome) chrome.unbind();
      chrome = null;
    },
  };
}

function showTitle(title) {
  const node = $("doc-title");
  const clean = (title || "").trim();
  node.textContent = clean || "Untitled";
  node.classList.toggle("is-untitled", !clean);
  document.title = (clean || "Untitled") + " · Cranium";
}

// Everyone else who's here, once each (two tabs of one person are one face).
function renderPeers(peers) {
  const stack = $("doc-peers");
  const seen = new Set();
  const faces = [];
  for (const peer of peers) {
    if (seen.has(peer.user_id)) continue;
    seen.add(peer.user_id);
    faces.push(avatar(peer, "sm"));
  }
  stack.replaceChildren(...faces.slice(0, 6));
  if (faces.length > 6) stack.append(el("span", "mono muted", " +" + (faces.length - 6)));
  stack.title = faces.length ? faces.map((f) => f.title).join(", ") + " here now" : "";
}

/* ------------------------------------------------------------------ seed */

// Applies whichever seed this document's edits hang off. Until it is
// applied they sit in Yjs's pending queue, waiting for the seed's client:
// 0 for a document that started with a title line, 1 for one that didn't.
// A document nobody has typed in yet gets the current seed. One whose seed
// is already in the log (a compaction snapshot holds everything) needs none.
function seed(ydoc) {
  const pending = ydoc.store.pendingStructs;
  const missing = pending ? pending.missing : new Map();
  const empty = ydoc.getXmlFragment("default").length === 0;
  if (missing.has(LEGACY_CLIENT)) Y.applyUpdate(ydoc, fromBase64(LEGACY_SEED), SEED);
  if (missing.has(SEED_CLIENT) || (empty && !missing.has(LEGACY_CLIENT))) {
    Y.applyUpdate(ydoc, fromBase64(SEED_UPDATE), SEED);
  }
}

/* ------------------------------------------------------------------ meta */

// The title is the document's name if someone set one, or else its first
// line of text. The preview is the next few lines, which is what the grid
// prints on each card.
function deriveMeta(doc, name) {
  const lines = textLines(doc, 9, 600);
  const title = name || lines.shift() || "";
  return { title: title.slice(0, MAX_TITLE), preview: lines.slice(0, 8).join("\n").slice(0, 400) };
}

function firstLine(doc) {
  return (textLines(doc, 1, 1)[0] || "").slice(0, MAX_TITLE);
}

// The non-empty text blocks, in order, whitespace collapsed, until there
// are `count` of them or `chars` characters.
function textLines(doc, count, chars) {
  const lines = [];
  let length = 0;
  doc.descendants((node) => {
    if (lines.length >= count || length >= chars) return false;
    if (!node.isTextblock) return true;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    if (text) {
      lines.push(text);
      length += text.length;
    }
    return false;
  });
  return lines;
}
