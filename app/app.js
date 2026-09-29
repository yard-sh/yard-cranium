// Cranium app shell: the sidebar, the document grid, the members page, the
// invite flow, and routing between them. A document itself is doc.js,
// loaded the first time one opens.
//
// Routes live in location.hash (relative URLs only; the app is served
// under /<slug>/app/):
//   #/w/<workspace>           the workspace's documents
//   #/w/<workspace>/members   who's in it, the invite link, owner controls
//   #/d/<document>            one document
//   anything else             the last workspace used, or the personal one

import { api } from "./api.js";
import {
  $,
  el,
  icon,
  avatar,
  glyph,
  toast,
  promptDialog,
  confirmDialog,
  showDialog,
  toggleMenu,
  closeMenu,
  ago,
  plural,
} from "./ui.js";

const SORTS = ["edited", "created", "title"];

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode or blocked storage: preferences just don't stick.
    }
  },
};

const state = {
  me: null,
  workspaces: [],
  current: null, // the workspace on screen (or the open document's)
  view: "", // grid | members | doc
  docs: [],
  docsFor: "", // which workspace state.docs belongs to
  sort: SORTS.includes(store.get("cranium.sort")) ? store.get("cranium.sort") : "edited",
  // Titles and previews seen in the editor, newer than the grid's copy: the
  // object writes them to the database a few seconds after typing stops.
  local: new Map(),
  doc: null, // { id, abort, handle } for the open document
  loadedAt: 0,
  routeSeq: 0,
};

/* ----------------------------------------------------------------- boot */

async function boot() {
  wireStatic();
  paintTheme();
  try {
    state.me = await api("api/me");
    await loadWorkspaces();
  } catch (err) {
    report(err);
    return;
  }
  renderAccount();
  const invite = takeInvite();
  window.addEventListener("hashchange", route);
  await route();
  if (invite) showInvite(invite);
}

function report(err) {
  if (err && err.status === 401) {
    toast(err.message, "error");
    setTimeout(() => location.reload(), 900);
    return;
  }
  toast((err && err.message) || "Something went wrong.", "error");
  if (err && !err.status) console.error(err);
}

// Wraps an event handler so a failure becomes a toast, not a silent reject.
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      report(err);
    }
  };
}

/* ---------------------------------------------------------------- route */

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "w" && parts[1]) return { view: parts[2] === "members" ? "members" : "grid", id: parts[1] };
  if (parts[0] === "d" && parts[1]) return { view: "doc", id: parts[1] };
  return { view: "home" };
}

async function route() {
  const seq = ++state.routeSeq;
  closeMenu();
  closeDrawer();
  const next = parseHash();
  if (next.view !== "doc") closeDoc();
  try {
    if (next.view === "home") return location.replace("#/w/" + pickWorkspace());
    if (next.view === "doc") return await showDoc(next.id);
    await showWorkspace(next.id, next.view, seq);
  } catch (err) {
    report(err);
  }
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function pickWorkspace() {
  const last = store.get("cranium.ws");
  if (last && state.workspaces.some((w) => w.id === last)) return last;
  return state.me.personal_workspace_id;
}

function show(view) {
  state.view = view;
  $("view-grid").hidden = view !== "grid";
  $("view-members").hidden = view !== "members";
  $("view-doc").hidden = view !== "doc";
  $("nav-docs").removeAttribute("aria-current");
  $("nav-members").removeAttribute("aria-current");
  if (view === "grid") $("nav-docs").setAttribute("aria-current", "page");
  if (view === "members") $("nav-members").setAttribute("aria-current", "page");
  if (view !== "doc") document.title = (state.current ? state.current.name + " · " : "") + "Cranium";
  window.scrollTo(0, 0);
}

/* ----------------------------------------------------------- workspaces */

async function loadWorkspaces() {
  state.workspaces = await api("api/workspaces");
  if (state.current) {
    const fresh = state.workspaces.find((w) => w.id === state.current.id);
    if (fresh) state.current = fresh;
  }
  renderSwitcher();
}

async function showWorkspace(id, view, seq) {
  let ws = state.workspaces.find((w) => w.id === id);
  if (!ws) {
    await loadWorkspaces();
    ws = state.workspaces.find((w) => w.id === id);
  }
  if (!ws) return lostWorkspace("That workspace isn't one of yours.");
  store.set("cranium.ws", ws.id);
  setCurrent(ws);
  show(view);
  try {
    if (view === "members") await loadMembers(ws, seq);
    else await loadDocs(ws, seq);
  } catch (err) {
    if (err.status === 404) return lostWorkspace("You're no longer in that workspace.");
    throw err;
  }
}

// Removed, left or deleted while looking at it: back to home base.
async function lostWorkspace(message) {
  toast(message, "error");
  await loadWorkspaces().catch(() => {});
  location.replace("#/w/" + state.me.personal_workspace_id);
}

function setCurrent(ws) {
  state.current = ws;
  glyph(ws, $("switcher-glyph"));
  $("switcher-name").textContent = ws.name;
  $("switcher-tag").textContent = tagOf(ws);
  $("nav-docs").href = "#/w/" + ws.id;
  $("nav-members").href = "#/w/" + ws.id + "/members";
  $("nav-docs-count").textContent = ws.doc_count || "";
  $("nav-members-count").textContent = ws.member_count || "";
  renderSwitcher();
}

function tagOf(ws) {
  if (ws.personal && ws.is_owner) return "Personal";
  return ws.is_owner ? "Owner" : "Member";
}

function renderSwitcher() {
  const items = [el("div", "menu__label mono", "Workspaces")];
  for (const ws of state.workspaces) {
    const item = el("button", "menu__item");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.append(glyph(ws), el("span", "menu__main", ws.name), el("span", "menu__tag mono", tagOf(ws)));
    if (state.current && state.current.id === ws.id) item.append(icon("check", "icon menu__check"));
    item.addEventListener("click", () => go("#/w/" + ws.id));
    items.push(item);
  }
  const create = el("button", "menu__item");
  create.type = "button";
  create.setAttribute("role", "menuitem");
  create.append(icon("plus"), el("span", "menu__main", "New workspace"));
  create.addEventListener("click", guard(createWorkspace));
  items.push(el("div", "menu__rule"), create);
  $("switcher-menu").replaceChildren(...items);
}

async function createWorkspace() {
  const name = await promptDialog({
    title: "New workspace",
    label: "Name",
    placeholder: "Book club, Q4 planning, …",
    confirm: "Create workspace",
  });
  if (!name) return;
  const ws = await api("api/workspaces", { method: "POST", body: { name } });
  await loadWorkspaces();
  go("#/w/" + ws.id);
  toast("Created. Invite people from Members.");
}

function kicker(ws) {
  const parts = [tagOf(ws)];
  if (!ws.personal || ws.member_count > 1) parts.push(plural(ws.member_count, "member"));
  parts.push(plural(ws.doc_count, "document"));
  return parts.join(" · ");
}

/* ------------------------------------------------------------ documents */

async function loadDocs(ws, seq) {
  $("grid-title").textContent = ws.name;
  $("grid-kicker").textContent = kicker(ws);
  paintSort();
  if (state.docsFor !== ws.id) {
    // Another workspace's cards would flash for a moment; show none instead.
    state.docs = [];
    $("grid").replaceChildren();
    $("grid-empty").hidden = true;
  }
  const docs = await api(`api/workspaces/${ws.id}/docs?sort=${state.sort}`);
  if (seq !== state.routeSeq) return;
  state.docs = docs;
  state.docsFor = ws.id;
  state.loadedAt = Date.now();
  if (ws.doc_count !== docs.length) {
    ws.doc_count = docs.length;
    $("grid-kicker").textContent = kicker(ws);
    $("nav-docs-count").textContent = docs.length || "";
  }
  renderGrid();
}

function renderGrid() {
  $("grid").replaceChildren(newCard(), ...state.docs.map(docCard));
  $("grid-empty").hidden = state.docs.length > 0;
}

function newCard() {
  const li = el("li", "cardwrap");
  const button = el("button", "card card--new");
  button.type = "button";
  button.append(icon("plus-drawn", "drawn"), el("span", "", "New document"));
  button.addEventListener("click", guard(createDoc));
  li.append(button);
  return li;
}

function docCard(doc) {
  const seen = state.local.get(doc.id);
  const fresh = seen && seen.at > doc.updated_at;
  const title = fresh ? seen.title : doc.title;
  const preview = fresh ? seen.preview : doc.preview;

  const li = el("li", "cardwrap");
  const card = el("a", "card");
  card.href = "#/d/" + doc.id;

  const when =
    state.sort === "created"
      ? "Created " + ago(doc.created_at)
      : "Edited " + ago(fresh ? seen.at : doc.updated_at);
  const heading = el("h3", "card__title" + (title ? "" : " is-untitled"), title || "Untitled");
  const foot = el("div", "card__foot");
  const mine = doc.author.user_id === state.me.user_id;
  foot.append(
    avatar({ user_id: doc.author.user_id, name: mine ? state.me.name : doc.author.name }, "sm"),
    el("span", "card__by", mine ? "by you" : "by " + (doc.author.name || "someone")),
  );
  card.append(el("p", "card__meta mono", when), heading, el("p", "card__preview", preview), foot);
  li.append(card);

  if (doc.can_delete) {
    const more = el("button", "iconbtn card__more");
    more.type = "button";
    more.setAttribute("aria-label", "More for " + (title || "Untitled"));
    more.setAttribute("aria-haspopup", "menu");
    more.append(icon("dots"));
    const menu = el("div", "menu card__menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    const del = el("button", "menu__item menu__item--danger");
    del.type = "button";
    del.setAttribute("role", "menuitem");
    del.append(icon("trash"), el("span", "", "Delete document"));
    del.addEventListener("click", guard(() => deleteDoc(doc, title)));
    menu.append(del);
    more.addEventListener("click", () => toggleMenu(menu, more));
    li.append(more, menu);
  }
  return li;
}

async function createDoc() {
  const ws = state.current;
  const doc = await api(`api/workspaces/${ws.id}/docs`, { method: "POST" });
  ws.doc_count += 1;
  go("#/d/" + doc.id);
}

async function deleteDoc(doc, title) {
  const { ok } = await confirmDialog({
    title: "Delete this document?",
    body: `“${title || "Untitled"}” goes for everyone in ${state.current.name}, including anyone who has it open. There's no undo.`,
    confirm: "Delete",
    danger: true,
  });
  if (!ok) return;
  await api(`api/docs/${doc.id}`, { method: "DELETE" });
  state.docs = state.docs.filter((d) => d.id !== doc.id);
  state.current.doc_count = Math.max(0, state.current.doc_count - 1);
  $("grid-kicker").textContent = kicker(state.current);
  $("nav-docs-count").textContent = state.current.doc_count || "";
  renderGrid();
  toast("Deleted.");
}

function paintSort() {
  for (const button of document.querySelectorAll("[data-sort]")) {
    button.setAttribute("aria-pressed", button.dataset.sort === state.sort ? "true" : "false");
  }
}

/* -------------------------------------------------------------- members */

async function loadMembers(ws, seq) {
  $("members-kicker").textContent = ws.name;
  const [members, invite] = await Promise.all([
    api(`api/workspaces/${ws.id}/members`),
    ws.is_owner ? api(`api/workspaces/${ws.id}/invite`) : null,
  ]);
  if (seq !== state.routeSeq) return;

  $("people").replaceChildren(...members.map((m) => personRow(ws, m)));
  if (ws.member_count !== members.length) {
    ws.member_count = members.length;
    $("nav-members-count").textContent = members.length;
  }

  $("invite-panel").hidden = !ws.is_owner;
  if (invite) $("invite-url").value = inviteURL(invite.token);

  $("settings-panel").hidden = !ws.is_owner;
  $("ws-delete").hidden = ws.personal;
  $("settings-text").textContent = ws.personal
    ? "Your personal workspace. You can rename it; it can't be deleted."
    : "Deleting it removes every document in it, for everyone.";
  $("leave-panel").hidden = ws.is_owner;
}

function personRow(ws, member) {
  const li = el("li", "person");
  const text = el("div", "person__text");
  text.append(
    el("span", "person__name", member.name + (member.is_you ? " (you)" : "")),
    el("span", "person__sub", member.email || "Joined " + ago(member.joined_at)),
  );
  li.append(
    avatar(member, "lg"),
    text,
    el("span", "tag" + (member.role === "owner" ? " tag--owner" : ""), member.role),
  );
  if (ws.is_owner && !member.is_you && member.role !== "owner") {
    const remove = el("button", "btn btn--ghost btn--sm", "Remove");
    remove.type = "button";
    remove.addEventListener("click", guard(() => removeMember(ws, member)));
    li.append(remove);
  }
  return li;
}

async function removeMember(ws, member) {
  const { ok, checked } = await confirmDialog({
    title: `Remove ${member.name}?`,
    body: `They lose access to everything in ${ws.name} right away, including documents they have open.`,
    confirm: "Remove",
    danger: true,
    check: { label: "Also reset the invite link, so the one they have stops working.", checked: true },
  });
  if (!ok) return;
  await api(`api/workspaces/${ws.id}/members/${encodeURIComponent(member.user_id)}`, {
    method: "DELETE",
    body: { reset_invite: checked },
  });
  toast(`${member.name} was removed.`);
  await loadWorkspaces();
  await loadMembers(state.current, state.routeSeq);
}

function inviteURL(token) {
  return location.origin + location.pathname + "?invite=" + encodeURIComponent(token);
}

async function copyInvite() {
  const input = $("invite-url");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand("copy");
  }
  toast("Invite link copied.");
}

async function resetInvite() {
  const ws = state.current;
  const { ok } = await confirmDialog({
    title: "Reset the invite link?",
    body: "The current link stops working at once. People already in the workspace stay in.",
    confirm: "Reset link",
  });
  if (!ok) return;
  const { token } = await api(`api/workspaces/${ws.id}/invite/reset`, { method: "POST" });
  $("invite-url").value = inviteURL(token);
  toast("New link ready. The old one no longer works.");
}

async function renameWorkspace() {
  const ws = state.current;
  const name = await promptDialog({ title: "Rename workspace", label: "Name", value: ws.name, confirm: "Rename" });
  if (!name || name === ws.name) return;
  await api(`api/workspaces/${ws.id}`, { method: "PATCH", body: { name } });
  await loadWorkspaces();
  setCurrent(state.workspaces.find((w) => w.id === ws.id) || ws);
  $("members-kicker").textContent = state.current.name;
  toast("Renamed.");
}

async function deleteWorkspace() {
  const ws = state.current;
  const { ok } = await confirmDialog({
    title: `Delete ${ws.name}?`,
    body: `This deletes ${plural(ws.doc_count, "document")} for all ${plural(ws.member_count, "member")}. There's no undo.`,
    confirm: "Delete workspace",
    danger: true,
  });
  if (!ok) return;
  await api(`api/workspaces/${ws.id}`, { method: "DELETE" });
  await loadWorkspaces();
  location.replace("#/w/" + state.me.personal_workspace_id);
  toast("Workspace deleted.");
}

async function leaveWorkspace() {
  const ws = state.current;
  const { ok } = await confirmDialog({
    title: `Leave ${ws.name}?`,
    body: "Its documents disappear from your list. The owner can invite you back.",
    confirm: "Leave",
    danger: true,
  });
  if (!ok) return;
  await api(`api/workspaces/${ws.id}/leave`, { method: "POST" });
  await loadWorkspaces();
  location.replace("#/w/" + state.me.personal_workspace_id);
  toast(`You left ${ws.name}.`);
}

/* -------------------------------------------------------------- invites */

// ?invite=<token> is read once and removed from the address bar, so a
// reload or a bookmark doesn't ask again.
function takeInvite() {
  const params = new URLSearchParams(location.search);
  const token = params.get("invite");
  if (!token) return null;
  params.delete("invite");
  const query = params.toString();
  history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + location.hash);
  return token;
}

async function showInvite(token) {
  let invite;
  try {
    invite = await api("api/invites/" + encodeURIComponent(token));
  } catch (err) {
    if (err.status === 404) return toast("That invite link is invalid or was reset. Ask for a new one.", "error");
    return report(err);
  }
  if (invite.already_member) {
    go("#/w/" + invite.workspace.id);
    return toast(`You're already in ${invite.workspace.name}.`);
  }
  glyph(invite.workspace, $("invite-glyph"));
  $("invite-name").textContent = invite.workspace.name;
  $("invite-meta").textContent =
    plural(invite.member_count, "member") + " · " + plural(invite.doc_count, "document");
  $("invite-body").textContent = `${invite.owner_name} invited you to write together here. It'll sit in your switcher next to your own workspace.`;
  if (!(await showDialog($("dlg-invite")))) return;
  try {
    const joined = await api(`api/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
    await loadWorkspaces();
    go("#/w/" + joined.workspace.id);
    toast(`Welcome to ${joined.workspace.name}.`);
  } catch (err) {
    report(err);
  }
}

/* ------------------------------------------------------------- the doc */

async function showDoc(id) {
  if (state.doc && state.doc.id === id) return;
  closeDoc();
  show("doc");
  const abort = new AbortController();
  const current = { id, abort, handle: null };
  state.doc = current;
  try {
    const { openDoc } = await import("./doc.js");
    const handle = await openDoc(id, {
      signal: abort.signal,
      onMeta: (docId, meta) => state.local.set(docId, { ...meta, at: Date.now() }),
      onWorkspace: (ws) => {
        const known = state.workspaces.find((w) => w.id === ws.id);
        if (known) {
          store.set("cranium.ws", ws.id);
          setCurrent(known);
        }
      },
    });
    if (abort.signal.aborted) {
      if (handle) handle.destroy();
      return;
    }
    current.handle = handle;
  } catch (err) {
    if (abort.signal.aborted) return;
    if (err.status === 404) {
      toast("That document was deleted, or you no longer have access to it.", "error");
      return location.replace("#/w/" + pickWorkspace());
    }
    report(err);
  }
}

function closeDoc() {
  const open = state.doc;
  if (!open) return;
  state.doc = null;
  open.abort.abort();
  if (open.handle) open.handle.destroy();
}

/* -------------------------------------------------------------- account */

function renderAccount() {
  const me = state.me;
  const face = avatar(me);
  face.id = "account-avatar";
  $("account-avatar").replaceWith(face);
  $("account-name").textContent = me.name;
  $("account-email").textContent = me.email || "Signed in";
}

async function renameMe() {
  const name = await promptDialog({
    title: "Your name",
    label: "Shown on your cursor and your documents",
    value: state.me.name,
    max: 40,
  });
  if (!name || name === state.me.name) return;
  state.me = { ...state.me, ...(await api("api/me", { method: "PATCH", body: { name } })) };
  renderAccount();
  toast("Name updated. Open documents pick it up next time you open them.");
}

/* ---------------------------------------------------------------- theme */

function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function paintTheme() {
  const dark = currentTheme() === "dark";
  $("theme-icon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
  $("theme").setAttribute("aria-label", dark ? "Switch to light" : "Switch to dark");
  $("theme").title = dark ? "Switch to light" : "Switch to dark";
}

function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store.set("cranium.theme", next);
  paintTheme();
}

/* --------------------------------------------------------------- drawer */

function openDrawer() {
  $("app").classList.add("is-drawer");
  $("scrim").hidden = false;
}

function closeDrawer() {
  $("app").classList.remove("is-drawer");
  $("scrim").hidden = true;
}

/* --------------------------------------------------------------- wiring */

function wireStatic() {
  $("switcher-btn").addEventListener("click", () => toggleMenu($("switcher-menu"), $("switcher-btn")));
  $("account-btn").addEventListener("click", () => toggleMenu($("account-menu"), $("account-btn")));
  $("account-rename").addEventListener("click", guard(renameMe));
  $("theme").addEventListener("click", toggleTheme);
  $("drawer-open").addEventListener("click", openDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  $("new-doc").addEventListener("click", guard(createDoc));
  $("invite-copy").addEventListener("click", guard(copyInvite));
  $("invite-reset").addEventListener("click", guard(resetInvite));
  $("ws-rename").addEventListener("click", guard(renameWorkspace));
  $("ws-delete").addEventListener("click", guard(deleteWorkspace));
  $("ws-leave").addEventListener("click", guard(leaveWorkspace));
  $("doc-banner-reload").addEventListener("click", () => location.reload());

  for (const button of document.querySelectorAll("[data-sort]")) {
    button.addEventListener(
      "click",
      guard(async () => {
        if (state.sort === button.dataset.sort) return;
        state.sort = button.dataset.sort;
        store.set("cranium.sort", state.sort);
        await loadDocs(state.current, state.routeSeq);
      }),
    );
  }

  // Coming back to the tab: the grid may be stale (someone else wrote).
  const refresh = () => {
    if (document.hidden || state.view !== "grid" || !state.current) return;
    if (Date.now() - state.loadedAt < 10 * 1000) return;
    loadDocs(state.current, state.routeSeq).catch(() => {});
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintTheme);
}

boot();
