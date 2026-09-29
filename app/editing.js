// The editing surface: the schema, the Docs-style menu bar and toolbar,
// keyboard shortcuts, and everything Markdown (download, import, paste and
// the source view). doc.js owns the connection and the title; this module
// owns what happens on the page.
//
// Every document stays expressible as Markdown: headings 1 to 3, bold,
// italic, strikethrough, code, links, lists, checklists, quotes, code
// blocks and horizontal lines. Nothing here adds fonts, sizes, colours or
// alignment.

import {
  Editor,
  Extension,
  Mark,
  Node,
  mergeAttributes,
  Document,
  StarterKit,
  TaskList,
  TaskItem,
  Placeholder,
  Collaboration,
  CollaborationCaret,
  Markdown,
} from "./vendor/editor.js";
import { $, el, colorOf, toast, promptDialog, showDialog, toggleMenu } from "./ui.js";

const MAX_PASTE = 512 * 1024;

/* ---------------------------------------------------------------- schema */

// The old title line. New documents never get one, but documents that
// started from doc.js's LEGACY_SEED still open with it as their first line.
// Nothing parses into it, so no paste or shortcut can make another; the
// style menu turns it into a heading or plain text.
const Title = Node.create({
  name: "title",
  content: "text*",
  marks: "",
  defining: true,
  renderHTML({ HTMLAttributes }) {
    return ["h1", mergeAttributes(HTMLAttributes, { class: "doc-title" }), 0];
  },
  renderMarkdown: (node, h) => (node.content ? "# " + h.renderChildren(node.content) : ""),
  // Enter at the end of the title steps into the empty line below it (every
  // such document starts with one) instead of stacking another above it.
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

const Page = Document.extend({ content: "title? block+" });

// Underline isn't Markdown, so nothing makes it any more: no shortcut, no
// button, and pasted <u> comes in plain. The mark stays in the schema for
// text that already has it, because y-tiptap deletes text carrying a mark
// the schema doesn't know, for everyone. Exported, it's plain text.
const Underline = Mark.create({
  name: "underline",
  renderHTML({ HTMLAttributes }) {
    return ["u", HTMLAttributes, 0];
  },
  renderMarkdown: (node, h) => h.renderChildren(node),
});

// The Google Docs shortcuts TipTap doesn't already have. It does have
// Mod-Alt-0 to 3 (text styles), Mod-Shift-7, 8 and 9 (lists), Mod-e (code)
// and Mod-Alt-c (code block).
const DocsKeys = Extension.create({
  name: "docsKeys",
  addKeyboardShortcuts() {
    const count = () => (wordCount(this.editor), true);
    return {
      "Mod-k": () => (editLink(this.editor), true),
      "Mod-\\": () => COMMANDS.clear(this.editor.chain()).run(),
      "Alt-Shift-5": () => this.editor.commands.toggleStrike(),
      "Mod-Shift-c": count,
      "Mod-Shift-C": count,
    };
  },
});

// createEditor({ element, ydoc, awareness, you }) → a TipTap editor bound
// to the Y.Doc, with the caret flags of everyone else in it.
export function createEditor({ element, ydoc, awareness, you }) {
  let editor;
  editor = new Editor({
    element,
    extensions: [
      Page,
      Title,
      Underline,
      StarterKit.configure({
        document: false,
        underline: false,
        // Collaboration brings its own undo, which only undoes your edits.
        undoRedo: false,
        // These two write to the document on their own after any change,
        // remote ones included: every open tab would add its own copy.
        trailingNode: false,
        link: { openOnClick: false, autolink: false, defaultProtocol: "https" },
        heading: { levels: [1, 2, 3] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
      DocsKeys,
      Placeholder.configure({
        includeChildren: false,
        showOnlyCurrent: false,
        placeholder: ({ node, pos, editor: ed }) => {
          if (node.type.name === "title") return "";
          const doc = ed.state.doc;
          const start = doc.firstChild.type.name === "title" ? doc.firstChild.nodeSize : 0;
          return doc.childCount <= (start ? 2 : 1) && pos === start ? "Start writing…" : "";
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
      handlePaste: (_view, event) => tooBig(event.clipboardData) || pasteMarkdown(editor, event.clipboardData),
      handleDrop: (_view, event) => tooBig(event.dataTransfer),
    },
  });
  return editor;
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

/* -------------------------------------------------------------- commands */

// Everything the menus, toolbar and style picker can do to the text. The
// same functions answer "can I?" when given editor.can().chain().
const COMMANDS = {
  p: (c) => c.setParagraph(),
  h1: (c) => c.setHeading({ level: 1 }),
  h2: (c) => c.setHeading({ level: 2 }),
  h3: (c) => c.setHeading({ level: 3 }),
  bold: (c) => c.toggleBold(),
  italic: (c) => c.toggleItalic(),
  strike: (c) => c.toggleStrike(),
  code: (c) => c.toggleCode(),
  bullet: (c) => c.toggleBulletList(),
  ordered: (c) => c.toggleOrderedList(),
  task: (c) => c.toggleTaskList(),
  quote: (c) => c.toggleBlockquote(),
  codeblock: (c) => c.toggleCodeBlock(),
  hr: (c) => c.setHorizontalRule(),
  clear: (c) => c.unsetAllMarks().clearNodes(),
  undo: (c) => c.undo(),
  redo: (c) => c.redo(),
  selectall: (c) => c.selectAll(),
};

const ACTIVE = {
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

// Available even when the document can't be edited: they only read it.
const READ_ONLY = new Set(["download", "wordcount"]);

// The block the cursor is in, as the style picker names it.
function styleOf(editor) {
  const block = editor.state.selection.$from.parent;
  if (block.type.name === "heading") return "h" + block.attrs.level;
  if (block.type.name === "paragraph") return "p";
  if (block.type.name === "title") return "title";
  if (block.type.name === "codeBlock") return "codeblock";
  return "";
}

/* ---------------------------------------------------------------- chrome */

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const KEY_NAMES = MAC ? { Mod: "⌘", Alt: "⌥", Shift: "⇧" } : { Mod: "Ctrl", Alt: "Alt", Shift: "Shift" };

function keyLabel(keys) {
  return keys
    .split("-")
    .map((k) => KEY_NAMES[k] || k.toUpperCase())
    .join(MAC ? "" : "+");
}

// The menu bar opens on click and, once one menu is open, follows the
// pointer across File, Edit, View… like a desktop menu bar. Wired once: it
// only opens and closes menus, and the buttons inside go through
// bindChrome's handler for whichever document is open.
let wired = false;

function wireMenubar() {
  if (wired) return;
  wired = true;
  const bar = $("menubar");
  bar.addEventListener("click", (event) => {
    const button = event.target.closest(".menubar__btn");
    if (button) toggleMenu(button.nextElementSibling, button);
  });
  bar.addEventListener("mouseover", (event) => {
    const button = event.target.closest(".menubar__btn");
    const open = bar.querySelector('.menubar__btn[aria-expanded="true"]');
    if (button && open && open !== button) toggleMenu(button.nextElementSibling, button);
  });
  for (const node of $("doc-chrome").querySelectorAll("[data-keys]")) {
    const label = keyLabel(node.dataset.keys);
    if (node.classList.contains("menu__key")) node.textContent = label;
    else node.title = node.dataset.tip + " (" + label + ")";
  }
  for (const node of $("doc-chrome").querySelectorAll("[data-tip]:not([data-keys])")) node.title = node.dataset.tip;
}

// bindChrome(editor, { rename, title }) → { unbind, stop }. Connects the
// menu bar, toolbar, style picker, source view and import to one editor.
// `rename` opens the rename box in the top bar; `title` is the document's
// current title, for the downloaded file's name.
export function bindChrome(editor, { rename, title }) {
  wireMenubar();
  const chrome = $("doc-chrome");
  const pick = $("style-pick");
  const sheet = $("doc-sheet");
  const box = $("doc-source");
  const text = $("doc-source-text");
  const file = $("doc-import");
  const abort = new AbortController();
  const on = { signal: abort.signal };

  let source = null; // { dirty } while the Markdown source is showing
  const editable = () => editor.isEditable && !source;

  const actions = {
    link: () => editLink(editor),
    rename: () => rename(),
    import: () => file.click(),
    download: () => download(editor, title()),
    source: () => (source ? closeSource() : openSource()),
    wordcount: () => wordCount(editor),
  };

  function run(cmd) {
    if (actions[cmd]) return actions[cmd]();
    const command = COMMANDS[cmd];
    if (command && editable()) command(editor.chain().focus()).run();
  }

  function paint() {
    for (const node of chrome.querySelectorAll("[data-cmd]")) {
      const cmd = node.dataset.cmd;
      let enabled;
      if (READ_ONLY.has(cmd)) enabled = true;
      else if (cmd === "source") enabled = editor.isEditable;
      else if (!editable()) enabled = false;
      else if (cmd === "link") enabled = editor.can().setLink({ href: "https://example.com" });
      else if (actions[cmd]) enabled = true;
      else enabled = COMMANDS[cmd](editor.can().chain()).run();
      node.disabled = !enabled;
      if (node.classList.contains("iconbtn") && ACTIVE[cmd]) {
        node.setAttribute("aria-pressed", editor.isActive(...ACTIVE[cmd]) ? "true" : "false");
      }
    }
    chrome.querySelector('[data-cmd="source"]').setAttribute("aria-checked", source ? "true" : "false");
    pick.value = styleOf(editor);
    pick.disabled = !editable();
  }

  /* source view */

  // Sized to its text, so the page scrolls instead of the box.
  const fit = () => {
    text.style.height = "auto";
    text.style.height = text.scrollHeight + "px";
  };

  function openSource() {
    source = { dirty: false };
    text.value = editor.getMarkdown();
    text.readOnly = false;
    sheet.classList.add("is-source");
    box.hidden = false;
    fit();
    text.focus();
    text.setSelectionRange(0, 0);
    paint();
  }

  // Leaving the source view applies what was typed there, if anything was.
  function closeSource(apply = true) {
    if (!source) return;
    if (apply && source.dirty && editor.isEditable) applyMarkdown(editor, text.value);
    source = null;
    box.hidden = true;
    sheet.classList.remove("is-source");
    paint();
    if (apply) editor.commands.focus();
  }

  // Other people's edits show up in the source until you type in it; from
  // then on, your version wins the parts you changed when you leave.
  const refreshSource = () => {
    if (!source || source.dirty) return;
    const { selectionStart, selectionEnd } = text;
    text.value = editor.getMarkdown();
    text.setSelectionRange(selectionStart, selectionEnd);
    fit();
  };

  /* click to type */

  // A click anywhere on the page types there, as in Docs: in a margin, on
  // the nearest line; below the text, at the end. Clicks on the text itself
  // are ProseMirror's.
  function clickToType(event) {
    const dom = editor.view.dom;
    if (event.button !== 0 || source || !editor.isEditable || dom.contains(event.target)) return;
    event.preventDefault();
    const rect = dom.getBoundingClientRect();
    const hit =
      event.clientY > rect.bottom
        ? null
        : editor.view.posAtCoords({
            left: Math.min(Math.max(event.clientX, rect.left + 1), rect.right - 1),
            top: Math.max(event.clientY, rect.top + 1),
          });
    editor
      .chain()
      .focus()
      .setTextSelection(hit ? hit.pos : editor.state.doc.content.size)
      .scrollIntoView()
      .run();
  }

  /* wiring */

  sheet.addEventListener("mousedown", clickToType, on);
  chrome.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("[data-cmd]");
      if (button && !button.disabled) run(button.dataset.cmd);
    },
    on,
  );
  pick.addEventListener("change", () => pick.value && run(pick.value), on);
  text.addEventListener(
    "input",
    () => {
      if (source) source.dirty = true;
      fit();
    },
    on,
  );
  text.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") closeSource();
    },
    on,
  );
  $("doc-source-done").addEventListener("click", () => closeSource(), on);
  file.addEventListener("change", () => importFile(editor, file), on);
  editor.on("transaction", paint);
  editor.on("update", refreshSource);
  paint();

  return {
    // The document closed under this tab (removed, deleted…).
    stop() {
      text.readOnly = true;
      paint();
    },
    unbind() {
      closeSource(true);
      abort.abort();
      editor.off("transaction", paint);
      editor.off("update", refreshSource);
    },
  };
}

// Puts the chrome back the way a document that's still loading expects it.
export function resetChrome() {
  $("doc-source").hidden = true;
  $("doc-sheet").classList.remove("is-source");
  $("style-pick").value = "p";
  for (const node of $("doc-chrome").querySelectorAll("[data-cmd]")) node.disabled = true;
  $("style-pick").disabled = true;
}

/* -------------------------------------------------------------- markdown */

// Replaces the document with `markdown`, touching only the part that
// differs: someone typing further down keeps their edit, and their cursor.
function applyMarkdown(editor, markdown) {
  if (markdown.length > MAX_PASTE) {
    toast("That's too much Markdown to apply at once.", "error");
    return;
  }
  const { schema, state } = editor;
  let next = null;
  try {
    const json = editor.markdown.parse(markdown);
    const parsed = schema.nodeFromJSON({ type: "doc", content: (json && json.content) || [] });
    next = schema.topNodeType.createAndFill(null, parsed.content);
  } catch {
    next = null;
  }
  if (!next) {
    toast("That Markdown couldn't be applied.", "error");
    return;
  }
  const doc = state.doc;
  const start = doc.content.findDiffStart(next.content);
  if (start === null) return;
  let { a: endA, b: endB } = doc.content.findDiffEnd(next.content);
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  try {
    editor.view.dispatch(state.tr.replace(start, endA, next.slice(start, endB)));
  } catch {
    editor.view.dispatch(state.tr.replaceWith(0, doc.content.size, next.content));
  }
}

function download(editor, title) {
  const name = (title || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").trim().slice(0, 100) || "Untitled";
  const blob = new Blob([editor.getMarkdown()], { type: "text/markdown;charset=utf-8" });
  const link = el("a");
  link.href = URL.createObjectURL(blob);
  link.download = name + ".md";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10 * 1000);
}

// A Markdown file goes in at the cursor, formatted.
async function importFile(editor, input) {
  const picked = input.files && input.files[0];
  input.value = "";
  if (!picked || !editor.isEditable) return;
  if (picked.size > MAX_PASTE) {
    toast("That file is too big to import. Try splitting it up.", "error");
    return;
  }
  const markdown = await picked.text();
  editor.chain().focus().insertContent(markdown, { contentType: "markdown" }).run();
  toast("Imported " + picked.name);
}

// Markdown syntax at the start of a line, or inline: headings, lists,
// quotes, fences, bold, strikethrough, code and links.
const MARKDOWN_RE =
  /^ {0,3}(#{1,6} |[-*+] |\d+[.)] |> ?|```|~~~)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/m;

// Formatting tags that mean the clipboard already holds formatted text.
// Code editors put plain styled <span>s on the clipboard with Markdown in
// the text, and that should still paste as Markdown.
const RICH_RE = /<(h[1-6]|strong|b|em|i|s|del|ul|ol|li|a|blockquote|pre|code|table|hr)\b/i;

function pasteMarkdown(editor, data) {
  if (!data || !editor) return false;
  const plain = data.getData("text/plain");
  const html = data.getData("text/html");
  if (!plain || (html && RICH_RE.test(html)) || !MARKDOWN_RE.test(plain)) return false;
  if (editor.isActive("codeBlock")) return false;
  return editor.commands.insertContent(plain, { contentType: "markdown" });
}

function tooBig(data) {
  if (!data) return false;
  const size = (data.getData("text/html") || "").length + (data.getData("text/plain") || "").length;
  if (size <= MAX_PASTE) return false;
  toast("That's too much to paste at once. Try it in smaller pieces.", "error");
  return true;
}

/* ----------------------------------------------------------- small tools */

// Ctrl+K: edits the link under the cursor, links the selection, or, with
// nothing selected, inserts the address as a link.
async function editLink(editor) {
  if (!editor.isEditable || !editor.can().setLink({ href: "https://example.com" })) return;
  const current = editor.getAttributes("link").href || "";
  const insert = editor.state.selection.empty && !current;
  const href = await promptDialog({
    title: current ? "Edit link" : "Add a link",
    label: current ? "Address (leave empty to remove)" : "Address",
    value: current,
    confirm: "Save link",
    max: 2000,
    placeholder: "https://",
  });
  if (insert) {
    if (href) editor.chain().focus().insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] }).run();
    return;
  }
  const chain = editor.chain().focus().extendMarkRange("link");
  if (href === null) {
    if (current) chain.unsetLink().run();
    return;
  }
  chain.setLink({ href }).run();
}

function counts(text) {
  return {
    words: (text.match(/\S+/g) || []).length,
    chars: [...text.replace(/\n/g, "")].length,
    solid: [...text.replace(/\s/g, "")].length,
  };
}

function wordCount(editor) {
  const { doc, selection } = editor.state;
  const all = counts(doc.textBetween(0, doc.content.size, "\n", " "));
  const part = selection.empty ? null : counts(doc.textBetween(selection.from, selection.to, "\n", " "));
  const rows = [
    ["Words", "words"],
    ["Characters", "chars"],
    ["Characters excluding spaces", "solid"],
  ].map(([label, key]) => {
    const row = el("tr");
    const cells = [el("th", "", label), el("td", "mono", part ? part[key].toLocaleString() : ""), el("td", "mono", all[key].toLocaleString())];
    cells[1].hidden = !part;
    row.append(...cells);
    return row;
  });
  $("count-sel-head").hidden = !part;
  $("count-rows").replaceChildren(...rows);
  showDialog($("dlg-count")).then(() => editor.commands.focus());
}
