// One open document: a Y.Doc, its connection (sync.js), and a TipTap editor
// bound to it. Loaded on demand by app.js, so the document grid never
// downloads the editor bundle.

import {
  Editor,
  Node,
  mergeAttributes,
  Document,
  StarterKit,
  TaskList,
  TaskItem,
  Placeholder,
  Collaboration,
  CollaborationCaret,
  Y,
  Awareness,
  fromBase64,
} from "./vendor/editor.js";
import { connectDoc, REMOTE, SEED } from "./sync.js";
import { api } from "./api.js";
import { $, el, avatar, colorOf, toast, promptDialog } from "./ui.js";

// FROZEN. Every document starts from these exact bytes: an empty title and
// an empty paragraph, written by Yjs client 0 at clocks 0 and 1. Yjs names
// content by (client, clock), so any number of tabs applying this get one
// copy, even when two people open a brand-new document at the same moment.
// It also means the editor never sees an empty document, which the title
// schema below does not allow. Changing these bytes would add a second
// title to every document that already exists.
const SEED_UPDATE = "AQIAAAcBB2RlZmF1bHQDBXRpdGxlhwAAAwlwYXJhZ3JhcGgA";

// The first line of every document is its title: a node of its own, so no
// toolbar button or markdown shortcut can turn it into something else.
const Title = Node.create({
  name: "title",
  content: "text*",
  marks: "",
  defining: true,
  parseHTML() {
    return [{ tag: "h1.doc-title", priority: 60 }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["h1", mergeAttributes(HTMLAttributes, { class: "doc-title" }), 0];
  },
  // Enter at the end of the title steps into the empty line below it (every
  // document starts with one) instead of stacking another above it.
  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if ($from.parent.type.name !== "title" || !empty) return false;
        if ($from.parentOffset !== $from.parent.content.size) return false;
        const after = $from.after();
        const next = editor.state.doc.nodeAt(after);
        if (!next || !next.isTextblock || next.content.size) return false;
        return editor.commands.setTextSelection(after + 1);
      },
    };
  },
});

const Page = Document.extend({ content: "title block*" });

const MAX_PASTE = 512 * 1024;
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
  Y.applyUpdate(ydoc, fromBase64(SEED_UPDATE), SEED);
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
      $("toolbar").inert = true;
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

  // Created only after the first sync, so a keystroke can never land in
  // a document that is still loading.
  editor = new Editor({
    element: $("editor"),
    extensions: [
      Page,
      Title,
      StarterKit.configure({
        document: false,
        // Collaboration brings its own undo, which only undoes your edits.
        undoRedo: false,
        // These two write to the document on their own after any change,
        // remote ones included: every open tab would add its own copy.
        trailingNode: false,
        link: { openOnClick: false, autolink: false, defaultProtocol: "https" },
        heading: { levels: [2, 3] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        includeChildren: false,
        showOnlyCurrent: false,
        placeholder: ({ node, pos, editor: ed }) => {
          if (node.type.name === "title") return "Untitled";
          const first = ed.state.doc.firstChild;
          return ed.state.doc.childCount <= 2 && pos === first.nodeSize ? "Start writing…" : "";
        },
      }),
      Collaboration.configure({ document: ydoc }),
      CollaborationCaret.configure({
        provider: { awareness },
        user: { name: you.name, color: colorOf(you.user_id) },
        render: flagCaret,
        selectionRender: (user) => ({ style: `background-color: ${user.color}2e` }),
      }),
    ],
    editorProps: {
      attributes: { class: "prose", spellcheck: "true", "aria-label": "Document" },
      handlePaste: (_view, event) => tooBig(event.clipboardData),
      handleDrop: (_view, event) => tooBig(event.dataTransfer),
    },
  });

  $("doc-sheet").classList.remove("is-loading");
  $("doc-loading").hidden = true;
  view.bindToolbar(editor);

  // Title and preview: shown here straight away, sent to the object (which
  // writes them to the grid) when this tab has been editing.
  const reportMeta = () => {
    metaTimer = 0;
    const next = deriveMeta(editor.state.doc);
    showTitle(next.title);
    if (onMeta) onMeta(docId, next);
    if (Date.now() - lastLocalEdit > LOCAL_EDIT_WINDOW_MS) return;
    if (next.title === lastSent.title && next.preview === lastSent.preview) return;
    if (sync.sendMeta(next)) lastSent = next;
  };
  editor.on("update", () => {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(reportMeta, META_DEBOUNCE_MS);
    showTitle(editor.state.doc.firstChild.textContent);
  });
  showTitle(editor.state.doc.firstChild.textContent);

  // A new, empty document opens with the cursor in the title.
  if (!editor.state.doc.firstChild.textContent) editor.commands.focus("start");

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

// Clears whatever the last document left behind and returns the toolbar
// binding for this one.
function resetView() {
  $("editor").replaceChildren();
  $("doc-sheet").classList.add("is-loading");
  $("doc-loading").hidden = false;
  $("doc-banner").hidden = true;
  $("doc-peers").replaceChildren();
  $("toolbar").inert = false;
  $("doc-status").dataset.state = "connecting";
  $("doc-status").textContent = STATUS_TEXT.connecting;
  showTitle("");

  let unbind = () => {};
  return {
    bindToolbar(editor) {
      const toolbar = $("toolbar");
      const onClick = (event) => {
        const button = event.target.closest("[data-cmd]");
        if (button) run(editor, button.dataset.cmd);
      };
      const refresh = () => paintToolbar(editor);
      toolbar.addEventListener("click", onClick);
      editor.on("transaction", refresh);
      refresh();
      unbind = () => {
        toolbar.removeEventListener("click", onClick);
        editor.off("transaction", refresh);
      };
    },
    unbind: () => unbind(),
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

// A collaborator's caret: a thin pole and a pennant with their name. The
// name is drawn by CSS (::after, from data-name), so the widget holds no
// text at all: with text inside, Chrome can put the local caret in the
// widget when you click past the end of a line, and the next keystrokes
// vanish into it.
function flagCaret(user) {
  const caret = el("span", "cr-caret");
  caret.style.setProperty("--c", user.color);
  caret.dataset.name = user.name || "Someone";
  return caret;
}

/* --------------------------------------------------------------- toolbar */

const COMMANDS = {
  h2: (c) => c.toggleHeading({ level: 2 }),
  h3: (c) => c.toggleHeading({ level: 3 }),
  bold: (c) => c.toggleBold(),
  italic: (c) => c.toggleItalic(),
  strike: (c) => c.toggleStrike(),
  code: (c) => c.toggleCode(),
  bullet: (c) => c.toggleBulletList(),
  ordered: (c) => c.toggleOrderedList(),
  task: (c) => c.toggleTaskList(),
  quote: (c) => c.toggleBlockquote(),
  codeblock: (c) => c.toggleCodeBlock(),
  undo: (c) => c.undo(),
  redo: (c) => c.redo(),
};

const ACTIVE = {
  h2: ["heading", { level: 2 }],
  h3: ["heading", { level: 3 }],
  bold: ["bold"],
  italic: ["italic"],
  strike: ["strike"],
  code: ["code"],
  link: ["link"],
  bullet: ["bulletList"],
  ordered: ["orderedList"],
  task: ["taskList"],
  quote: ["blockquote"],
  codeblock: ["codeBlock"],
};

async function run(editor, cmd) {
  if (cmd === "link") return editLink(editor);
  const command = COMMANDS[cmd];
  if (command) command(editor.chain().focus()).run();
}

async function editLink(editor) {
  const current = editor.getAttributes("link").href || "";
  const href = await promptDialog({
    title: current ? "Edit link" : "Add a link",
    label: "Address (leave empty to remove)",
    value: current,
    confirm: "Save link",
    max: 2000,
    placeholder: "https://",
  });
  const chain = editor.chain().focus().extendMarkRange("link");
  if (href === null) {
    if (current) chain.unsetLink().run();
    return;
  }
  chain.setLink({ href }).run();
}

function paintToolbar(editor) {
  const inTitle = editor.state.selection.$from.parent.type.name === "title";
  for (const button of $("toolbar").querySelectorAll("[data-cmd]")) {
    const cmd = button.dataset.cmd;
    const active = ACTIVE[cmd] ? editor.isActive(...ACTIVE[cmd]) : false;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    let enabled;
    if (cmd === "link") enabled = !inTitle && !editor.state.selection.empty;
    else if (cmd === "undo" || cmd === "redo") enabled = COMMANDS[cmd](editor.can().chain()).run();
    else enabled = !inTitle && COMMANDS[cmd](editor.can().chain()).run();
    button.disabled = !enabled;
  }
}

/* ------------------------------------------------------------------ meta */

// The title is the first line; the preview is the first few lines of body
// text, which is what the grid prints on each card.
function deriveMeta(doc) {
  const first = doc.firstChild;
  const title = first && first.type.name === "title" ? first.textContent.replace(/\s+/g, " ").trim() : "";
  const lines = [];
  let length = 0;
  doc.forEach((node, offset, index) => {
    if (index === 0 && node.type.name === "title") return;
    if (lines.length >= 8 || length >= 400) return;
    node.descendants((child) => {
      if (lines.length >= 8 || length >= 400) return false;
      if (!child.isTextblock) return true;
      const text = child.textContent.replace(/\s+/g, " ").trim();
      if (text) {
        lines.push(text);
        length += text.length;
      }
      return false;
    });
    if (node.isTextblock) {
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (text) {
        lines.push(text);
        length += text.length;
      }
    }
  });
  return { title: title.slice(0, 200), preview: lines.join("\n").slice(0, 400) };
}

function tooBig(data) {
  if (!data) return false;
  const size = (data.getData("text/html") || "").length + (data.getData("text/plain") || "").length;
  if (size <= MAX_PASTE) return false;
  toast("That's too much to paste at once. Try it in smaller pieces.", "error");
  return true;
}
