// Cranium backend.
//
// No ports, no listen(): Yard runs this as a fetch handler. Requests arrive
// with the app path rooted at "/" and, for signed-in visitors, trusted
// identity headers the edge verified:
//   X-Yard-User-Id, X-Yard-Email, X-Yard-Entitlement, X-Yard-Tier, X-Yard-Sandbox
// Clients can never spoof these: the edge strips inbound X-Yard-* first, and
// `yard dev` stamps the same headers locally from the persona you pick.
//
// Two things live in this file. The default export is the fetch handler:
// workspaces, members, invites, the document list, and the one route that
// hands a WebSocket to a document. The Doc class is an object: one instance
// per document, declared under "objects" in .yard/settings.json and reached
// through env.DOCS. It holds every open connection to that document and the
// document's content, as an ordered log of Yjs updates.
//
// The object never parses Yjs. Updates are opaque base64 strings that it
// numbers, stores and relays; the CRDT lives in the browsers, which is what
// lets this file stay one plain module with no bundler.

const OWNER = "owner";
const MEMBER = "member";

// Guardrails for a free tier. The client reads nothing from here; it just
// explains the error codes these produce.
const LIMITS = {
  ownedWorkspaces: 20, // workspaces one person can own
  members: 50, // people in one workspace
  docs: 500, // documents in one workspace
  peers: 50, // connections to one document at once
};

const MAX_NAME = 40;
const MAX_WORKSPACE_NAME = 60;
const MAX_TITLE = 200;
const MAX_PREVIEW = 400;

// A ticket is a one-use pass for the next WebSocket upgrade (see openSession).
const TICKET_MS = 60 * 1000;
// A connection never outlives 24 hours, so a session opened longer ago than
// this cannot still be holding one. The five minutes cover clock skew.
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000 + 5 * 60 * 1000;
const KICK_LIMIT = 100;
const FANOUT = 20; // object calls in flight at once

const FLUSH_MS = 5000;

// Frame limits, in base64 characters. An update is one burst of typing (the
// client batches every 80 ms); a paste is the largest thing that makes one.
const MAX_FRAME = 5 * 1024 * 1024;
const MAX_UPDATE = 1024 * 1024;
const MAX_SNAPSHOT = 4 * 1024 * 1024;
const MAX_AWARENESS = 16 * 1024;
const SYNC_CHUNK = 1024 * 1024;

// Compaction: when the log past the last snapshot has more rows than this,
// or more bytes than the snapshot itself (with a floor), the object asks a
// client for a fresh snapshot. CRANIUM_COMPACT_ROWS overrides the row count
// (set it in .yard/dev/secrets.env to watch compaction happen locally).
const COMPACT_ROWS = 400;
const COMPACT_MIN_BYTES = 256 * 1024;
const COMPACT_TIMEOUT_MS = 30 * 1000;
const COMPACT_GAP_MS = 10 * 1000;

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Never serve the backend as an asset. Yard excludes it server-side; this
    // guard keeps any other host honest.
    if (url.pathname === "/_service.js") {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/api/")) {
      const started = Date.now();
      try {
        const response = await handleAPI(request, env, url);
        log("request", {
          method: request.method,
          path: redactPath(url.pathname),
          status: response.status,
          user: shortId(request.headers.get("X-Yard-User-Id")),
          ms: Date.now() - started,
        });
        return response;
      } catch (err) {
        console.error(
          `[cranium] request.failed ${request.method} ${redactPath(url.pathname)}`,
          err && err.stack,
        );
        return json({ error: "something went wrong on our end" }, 500);
      }
    }

    // Everything else: the static frontend (env.ASSETS is this directory).
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------------------------------------------- api */

async function handleAPI(request, env, url) {
  // The access gate normally guarantees the header; this is the backstop.
  const user = request.headers.get("X-Yard-User-Id");
  const method = request.method;
  if (!user) {
    log("auth.rejected", { method, path: redactPath(url.pathname) });
    return json({ error: "sign in to use Cranium", code: "signed_out" }, 401);
  }

  // Every project under yard.sh is the same site as this one, so the session
  // cookie rides along on a form posted from someone else's page. A
  // cross-origin request cannot set this header without a CORS preflight,
  // which this service never answers, so requiring it stops that cold.
  if (method !== "GET" && method !== "HEAD" && !isJSON(request)) {
    return json({ error: "send JSON with Content-Type: application/json", code: "json_required" }, 415);
  }

  const me = await ensureUser(env, request.headers, user);

  // ["api", "workspaces", "<id>", "docs"]: the leading "api" is dropped.
  const [, ...seg] = url.pathname.split("/").filter(Boolean);

  if (seg[0] === "me" && seg.length === 1) {
    if (method === "GET") return getMe(env, me);
    if (method === "PATCH") return renameMe(request, env, me);
    return methodNotAllowed();
  }

  if (seg[0] === "workspaces" && seg.length === 1) {
    if (method === "GET") return listWorkspaces(env, me);
    if (method === "POST") return createWorkspace(request, env, me);
    return methodNotAllowed();
  }

  if (seg[0] === "workspaces" && seg.length >= 2) {
    const access = await workspaceAccess(env, user, seg[1]);
    if (!access) return json({ error: "workspace not found", code: "not_found" }, 404);

    if (seg.length === 2) {
      if (method === "GET") return json(await workspaceDetail(env, access));
      if (method === "PATCH") return renameWorkspace(request, env, access);
      if (method === "DELETE") return deleteWorkspace(env, access);
      return methodNotAllowed();
    }
    const action = seg[2];
    if (action === "leave" && seg.length === 3 && method === "POST") return leaveWorkspace(env, access);
    if (action === "members" && seg.length === 3 && method === "GET") return listMembers(env, access);
    if (action === "members" && seg.length === 4 && method === "DELETE") {
      return removeMember(request, env, access, seg[3]);
    }
    if (action === "invite" && seg.length === 3 && method === "GET") return getInvite(access);
    if (action === "invite" && seg.length === 4 && seg[3] === "reset" && method === "POST") {
      return resetInvite(env, access);
    }
    if (action === "docs" && seg.length === 3) {
      if (method === "GET") return listDocs(env, access, url.searchParams.get("sort"));
      if (method === "POST") return createDoc(env, access);
      return methodNotAllowed();
    }
    return json({ error: "not found", code: "not_found" }, 404);
  }

  if (seg[0] === "invites" && (seg.length === 2 || seg.length === 3)) {
    const invite = await findInvite(env, user, seg[1]);
    if (!invite) {
      return json({ error: "this invite link is invalid or was reset", code: "invite_invalid" }, 404);
    }
    if (seg.length === 2 && method === "GET") return json(invite);
    if (seg.length === 3 && seg[2] === "accept" && method === "POST") return acceptInvite(env, me, invite);
    return methodNotAllowed();
  }

  if (seg[0] === "docs" && seg.length >= 2) {
    const access = await docAccess(env, user, seg[1]);
    if (!access) return json({ error: "document not found", code: "not_found" }, 404);

    if (seg.length === 2) {
      if (method === "GET") return json(docMeta(access.doc, access));
      if (method === "DELETE") return deleteDoc(env, access);
      return methodNotAllowed();
    }
    if (seg.length === 3 && seg[2] === "session" && method === "POST") return openSession(env, access);
    if (seg.length === 3 && seg[2] === "ws" && method === "GET") return connectDoc(request, env, me, access, url);
    return json({ error: "not found", code: "not_found" }, 404);
  }

  return json({ error: "not found", code: "not_found" }, 404);
}

/* -------------------------------------------------------------- identity */

// There is no display-name header, so the first visit derives one from the
// email and the app lets people change it. ON CONFLICT leaves name alone, so
// a rename survives every later request.
async function ensureUser(env, headers, user) {
  const email = headers.get("X-Yard-Email") || "";
  const row = await env.DB.prepare(
    "INSERT INTO users (id, name, email, seen_at) VALUES (?1, ?2, ?3, ?4)" +
      " ON CONFLICT(id) DO UPDATE SET email = excluded.email, seen_at = excluded.seen_at" +
      " RETURNING name",
  )
    .bind(user, defaultName(user, email), email, Date.now())
    .first();
  return { user_id: user, name: row.name, email };
}

function defaultName(user, email) {
  const local = (email.split("@")[0] || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, MAX_NAME);
  return local || "user-" + shortId(user);
}

// "tate.lax" becomes "Tate's workspace".
function personalName(name) {
  const first = (name.split(/[\s._-]+/).find(Boolean) || "My").slice(0, 30);
  return first.charAt(0).toUpperCase() + first.slice(1) + "'s workspace";
}

// Everyone has exactly one personal workspace, made on their first visit and
// never deletable. The unique partial index on workspaces(owner_id) where
// personal = 1 makes the two INSERT OR IGNOREs safe when two first requests
// race: one row wins and both requests read it back.
async function getMe(env, me) {
  const personal = await ensurePersonal(env, me);
  return json({ ...me, personal_workspace_id: personal });
}

async function ensurePersonal(env, me) {
  const find = env.DB.prepare("SELECT id FROM workspaces WHERE owner_id = ?1 AND personal = 1").bind(me.user_id);
  const found = await find.first();
  if (found) return found.id;

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO workspaces (id, name, owner_id, personal, invite_token, created_at)" +
        " VALUES (?1, ?2, ?3, 1, ?4, ?5)",
    ).bind(crypto.randomUUID(), personalName(me.name), me.user_id, newToken(), now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)" +
        " SELECT id, owner_id, 'owner', ?2 FROM workspaces WHERE owner_id = ?1 AND personal = 1",
    ).bind(me.user_id, now),
  ]);
  const made = await find.first();
  log("workspace.provision", { user: shortId(me.user_id), ws: shortId(made.id) });
  return made.id;
}

async function renameMe(request, env, me) {
  const { name } = await readJSON(request);
  const clean = oneLine(name, MAX_NAME);
  if (!clean) return json({ error: "pick a name", code: "name_required" }, 400);
  await env.DB.prepare("UPDATE users SET name = ?1 WHERE id = ?2").bind(clean, me.user_id).run();
  log("me.rename", { user: shortId(me.user_id), nameLen: clean.length });
  return json({ ...me, name: clean });
}

/* ------------------------------------------------------------ workspaces */

// Membership is the only authority, and it comes from the database. A
// workspace you are not in answers 404, the same as one that doesn't exist,
// so ids can't be probed.
async function workspaceAccess(env, user, workspaceId) {
  const row = await env.DB.prepare(
    "SELECT w.id, w.name, w.owner_id, w.personal, w.invite_token, w.created_at, m.role" +
      " FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?2" +
      " WHERE w.id = ?1",
  )
    .bind(workspaceId, user)
    .first();
  if (!row) return null;
  return { workspace: row, user, is_owner: row.owner_id === user };
}

async function listWorkspaces(env, me) {
  const { results } = await env.DB.prepare(
    "SELECT w.id, w.name, w.owner_id, w.personal, m.role," +
      " (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count," +
      " (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = w.id) AS doc_count" +
      " FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id" +
      " WHERE m.user_id = ?1" +
      " ORDER BY (w.personal = 1 AND w.owner_id = ?1) DESC, w.name COLLATE NOCASE",
  )
    .bind(me.user_id)
    .all();
  return json(results.map((row) => workspaceSummary(row, me.user_id)));
}

function workspaceSummary(row, user) {
  const isOwner = row.owner_id === user;
  return {
    id: row.id,
    name: row.name,
    personal: !!row.personal,
    role: isOwner ? OWNER : MEMBER,
    is_owner: isOwner,
    member_count: row.member_count || 0,
    doc_count: row.doc_count || 0,
  };
}

async function workspaceDetail(env, access) {
  const { workspace } = access;
  const row = await env.DB.prepare(
    "SELECT u.name AS owner_name," +
      " (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = ?1) AS member_count," +
      " (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = ?1) AS doc_count" +
      " FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id WHERE w.id = ?1",
  )
    .bind(workspace.id)
    .first();
  return {
    ...workspaceSummary({ ...workspace, ...row }, access.user),
    owner: { user_id: workspace.owner_id, name: row.owner_name || "Someone" },
  };
}

async function createWorkspace(request, env, me) {
  const { name } = await readJSON(request);
  const clean = oneLine(name, MAX_WORKSPACE_NAME);
  if (!clean) return json({ error: "give the workspace a name", code: "name_required" }, 400);

  const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE owner_id = ?1")
    .bind(me.user_id)
    .first();
  if (owned.n >= LIMITS.ownedWorkspaces) {
    return json(
      { error: `you can own up to ${LIMITS.ownedWorkspaces} workspaces`, code: "workspace_limit" },
      403,
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspaces (id, name, owner_id, personal, invite_token, created_at) VALUES (?1, ?2, ?3, 0, ?4, ?5)",
    ).bind(id, clean, me.user_id, newToken(), now),
    env.DB.prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)",
    ).bind(id, me.user_id, now),
  ]);
  log("workspace.create", { user: shortId(me.user_id), ws: shortId(id) });
  const access = await workspaceAccess(env, me.user_id, id);
  return json(await workspaceDetail(env, access), 201);
}

async function renameWorkspace(request, env, access) {
  if (!access.is_owner) return ownerOnly();
  const { name } = await readJSON(request);
  const clean = oneLine(name, MAX_WORKSPACE_NAME);
  if (!clean) return json({ error: "give the workspace a name", code: "name_required" }, 400);
  await env.DB.prepare("UPDATE workspaces SET name = ?1 WHERE id = ?2").bind(clean, access.workspace.id).run();
  log("workspace.rename", { ws: shortId(access.workspace.id), nameLen: clean.length });
  return json(await workspaceDetail(env, { ...access, workspace: { ...access.workspace, name: clean } }));
}

// The rows go first, so nobody can open a document while its object is
// being cleared; then every document's object drops its storage.
async function deleteWorkspace(env, access) {
  const { workspace } = access;
  if (!access.is_owner) return ownerOnly();
  if (workspace.personal) {
    return json({ error: "your personal workspace can't be deleted", code: "personal" }, 400);
  }
  const { results } = await env.DB.prepare("SELECT id FROM documents WHERE workspace_id = ?1")
    .bind(workspace.id)
    .all();
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM doc_sessions WHERE doc_id IN (SELECT id FROM documents WHERE workspace_id = ?1)",
    ).bind(workspace.id),
    env.DB.prepare("DELETE FROM documents WHERE workspace_id = ?1").bind(workspace.id),
    env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ?1").bind(workspace.id),
    env.DB.prepare("DELETE FROM workspaces WHERE id = ?1").bind(workspace.id),
  ]);
  await fanout(results.map((r) => r.id), (id) => internal(env, id, "/__delete"));
  log("workspace.delete", { ws: shortId(workspace.id), docs: results.length });
  return json({ ok: true, docs_deleted: results.length });
}

/* --------------------------------------------------------------- members */

async function listMembers(env, access) {
  const { results } = await env.DB.prepare(
    "SELECT u.id AS user_id, u.name, u.email, m.role, m.joined_at" +
      " FROM workspace_members m JOIN users u ON u.id = m.user_id" +
      " WHERE m.workspace_id = ?1 ORDER BY m.role = 'owner' DESC, m.joined_at",
  )
    .bind(access.workspace.id)
    .all();
  // Emails are the owner's to see: they manage who is in the workspace.
  return json(
    results.map((row) => ({
      user_id: row.user_id,
      name: row.name,
      email: access.is_owner ? row.email : undefined,
      role: row.user_id === access.workspace.owner_id ? OWNER : MEMBER,
      joined_at: row.joined_at,
      is_you: row.user_id === access.user,
    })),
  );
}

async function leaveWorkspace(env, access) {
  if (access.is_owner) {
    return json({ error: "owners delete a workspace instead of leaving it", code: "owner" }, 400);
  }
  const { workspace, user } = access;
  await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2")
    .bind(workspace.id, user)
    .run();
  const kicked = await kick(env, workspace.id, user);
  log("member.leave", { ws: shortId(workspace.id), user: shortId(user), kicked });
  return json({ ok: true });
}

// Removal takes effect now, not on the removed person's next reconnect: every
// document they may still have open is told to close their sockets. The
// invite link is usually reset in the same step, since the old one would let
// them straight back in.
async function removeMember(request, env, access, target) {
  if (!access.is_owner) return ownerOnly();
  const { workspace } = access;
  if (target === workspace.owner_id) {
    return json({ error: "the owner can't be removed", code: "cannot_remove_owner" }, 400);
  }
  const body = await readJSON(request);
  const result = await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2")
    .bind(workspace.id, target)
    .run();
  if (!changed(result)) return json({ error: "not a member of this workspace", code: "not_found" }, 404);

  let token;
  if (body.reset_invite) token = await rotateInvite(env, workspace.id);
  const kicked = await kick(env, workspace.id, target);
  log("member.remove", { ws: shortId(workspace.id), user: shortId(target), kicked, reset: !!token });
  return json({ ok: true, kicked, invite_token: token });
}

// Finds the documents in this workspace the person opened within the last
// day, closes their sockets there, and forgets those sessions (outstanding
// tickets included).
async function kick(env, workspaceId, user) {
  const { results } = await env.DB.prepare(
    "SELECT s.doc_id FROM doc_sessions s JOIN documents d ON d.id = s.doc_id" +
      " WHERE d.workspace_id = ?1 AND s.user_id = ?2 AND s.opened_at > ?3" +
      " ORDER BY s.opened_at DESC LIMIT ?4",
  )
    .bind(workspaceId, user, Date.now() - SESSION_WINDOW_MS, KICK_LIMIT)
    .all();
  await fanout(results.map((r) => r.doc_id), (id) => internal(env, id, "/__kick", { user_id: user }));
  await env.DB.prepare(
    "DELETE FROM doc_sessions WHERE user_id = ?1 AND doc_id IN (SELECT id FROM documents WHERE workspace_id = ?2)",
  )
    .bind(user, workspaceId)
    .run();
  return results.length;
}

/* --------------------------------------------------------------- invites */

// One link per workspace: …/app/?invite=<token>. The token is random and
// separate from the workspace id, so resetting it kills every copy of the
// old link without touching anything else.
function getInvite(access) {
  if (!access.is_owner) return ownerOnly();
  return json({ token: access.workspace.invite_token });
}

async function resetInvite(env, access) {
  if (!access.is_owner) return ownerOnly();
  const token = await rotateInvite(env, access.workspace.id);
  log("invite.reset", { ws: shortId(access.workspace.id) });
  return json({ token });
}

async function rotateInvite(env, workspaceId) {
  const token = newToken();
  await env.DB.prepare("UPDATE workspaces SET invite_token = ?1 WHERE id = ?2").bind(token, workspaceId).run();
  return token;
}

async function findInvite(env, user, token) {
  if (!TOKEN_RE.test(token || "")) return null;
  const row = await env.DB.prepare(
    "SELECT w.id, w.name, u.name AS owner_name," +
      " (SELECT COUNT(*) FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count," +
      " (SELECT COUNT(*) FROM documents d WHERE d.workspace_id = w.id) AS doc_count," +
      " EXISTS (SELECT 1 FROM workspace_members y WHERE y.workspace_id = w.id AND y.user_id = ?2) AS already_member" +
      " FROM workspaces w LEFT JOIN users u ON u.id = w.owner_id WHERE w.invite_token = ?1",
  )
    .bind(token, user)
    .first();
  if (!row) return null;
  return {
    workspace: { id: row.id, name: row.name },
    owner_name: row.owner_name || "Someone",
    member_count: row.member_count || 0,
    doc_count: row.doc_count || 0,
    already_member: !!row.already_member,
  };
}

async function acceptInvite(env, me, invite) {
  if (invite.already_member) return json({ workspace: invite.workspace, already_member: true });
  if (invite.member_count >= LIMITS.members) {
    return json({ error: `this workspace already has ${LIMITS.members} people`, code: "workspace_full" }, 403);
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', ?3)",
  )
    .bind(invite.workspace.id, me.user_id, Date.now())
    .run();
  log("invite.accept", { ws: shortId(invite.workspace.id), user: shortId(me.user_id) });
  return json({ workspace: invite.workspace, already_member: false });
}

/* ------------------------------------------------------------- documents */

const SORTS = {
  edited: "d.updated_at DESC, d.created_at DESC",
  created: "d.created_at DESC",
  title: "d.title = '' , d.title COLLATE NOCASE, d.created_at DESC",
};

async function listDocs(env, access, sort) {
  const order = SORTS[sort] || SORTS.edited;
  const { results } = await env.DB.prepare(
    "SELECT d.id, d.workspace_id, d.author_id, d.title, d.preview, d.created_at, d.updated_at, d.updated_by," +
      " a.name AS author_name, e.name AS updated_by_name" +
      " FROM documents d LEFT JOIN users a ON a.id = d.author_id LEFT JOIN users e ON e.id = d.updated_by" +
      " WHERE d.workspace_id = ?1 ORDER BY " +
      order,
  )
    .bind(access.workspace.id)
    .all();
  return json(results.map((row) => docMeta(row, access)));
}

async function createDoc(env, access) {
  const { workspace, user } = access;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE workspace_id = ?1")
    .bind(workspace.id)
    .first();
  if (count.n >= LIMITS.docs) {
    return json({ error: `a workspace holds up to ${LIMITS.docs} documents`, code: "docs_limit" }, 403);
  }
  const now = Date.now();
  const doc = {
    id: crypto.randomUUID(),
    workspace_id: workspace.id,
    author_id: user,
    title: "",
    preview: "",
    created_at: now,
    updated_at: now,
    updated_by: user,
  };
  await env.DB.prepare(
    "INSERT INTO documents (id, workspace_id, author_id, title, preview, created_at, updated_at, updated_by)" +
      " VALUES (?1, ?2, ?3, '', '', ?4, ?4, ?3)",
  )
    .bind(doc.id, workspace.id, user, now)
    .run();
  log("doc.create", { ws: shortId(workspace.id), doc: shortId(doc.id), user: shortId(user) });
  return json(docMeta(doc, access), 201);
}

async function docAccess(env, user, docId) {
  const row = await env.DB.prepare(
    "SELECT d.id, d.workspace_id, d.author_id, d.title, d.preview, d.created_at, d.updated_at, d.updated_by," +
      " w.name AS workspace_name, w.owner_id, w.personal, a.name AS author_name" +
      " FROM documents d JOIN workspaces w ON w.id = d.workspace_id" +
      " JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = ?2" +
      " LEFT JOIN users a ON a.id = d.author_id" +
      " WHERE d.id = ?1",
  )
    .bind(docId, user)
    .first();
  if (!row) return null;
  return {
    doc: row,
    user,
    is_owner: row.owner_id === user,
    workspace: { id: row.workspace_id, name: row.workspace_name, owner_id: row.owner_id, personal: row.personal },
  };
}

// Authors delete their own documents; the workspace owner can delete any.
function canDelete(row, access) {
  return access.is_owner || row.author_id === access.user;
}

function docMeta(row, access) {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    title: row.title,
    preview: row.preview,
    author: { user_id: row.author_id, name: row.author_name || "" },
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by_name: row.updated_by_name || "",
    can_delete: canDelete(row, access),
    workspace:
      access.doc === row
        ? { id: access.workspace.id, name: access.workspace.name, is_owner: access.is_owner }
        : undefined,
  };
}

async function deleteDoc(env, access) {
  const { doc } = access;
  if (!canDelete(doc, access)) {
    return json(
      { error: "only the author or the workspace owner can delete this", code: "cannot_delete" },
      403,
    );
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM documents WHERE id = ?1").bind(doc.id),
    env.DB.prepare("DELETE FROM doc_sessions WHERE doc_id = ?1").bind(doc.id),
  ]);
  await internal(env, doc.id, "/__delete");
  log("doc.delete", { doc: shortId(doc.id), user: shortId(access.user) });
  return json({ ok: true });
}

/* -------------------------------------------------------------- realtime */

// Opening a document is two steps. This one hands out a ticket, a one-use
// pass for the WebSocket upgrade that must follow within a minute. It exists
// for three reasons:
//   - A WebSocket handshake carries cookies but has no CORS, and every
//     project under yard.sh is the same site as this one. Only a page on
//     this origin can read the ticket, so only this app can open a socket.
//   - A refused upgrade reaches the browser as a bare failure. This request
//     answers first, with a status the client can act on (404: gone, stop).
//   - The row it writes is how a removal finds this person's open documents.
async function openSession(env, access) {
  const ticket = newToken();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO doc_sessions (doc_id, user_id, ticket, ticket_expires, opened_at) VALUES (?1, ?2, ?3, ?4, ?5)" +
      " ON CONFLICT(doc_id, user_id) DO UPDATE SET ticket = excluded.ticket," +
      " ticket_expires = excluded.ticket_expires, opened_at = excluded.opened_at",
  )
    .bind(access.doc.id, access.user, ticket, now + TICKET_MS, now)
    .run();
  return json({ ticket, expires_in: TICKET_MS / 1000 });
}

// The realtime route. docAccess already confirmed membership on this very
// request (so a removal after the ticket was issued still keeps them out);
// what's left is spending the ticket and forwarding the upgrade. The
// X-Cranium-* headers are set here, after stripping anything a client sent,
// so the object can trust them the way it trusts X-Yard-*.
async function connectDoc(request, env, me, access, url) {
  const { doc, user } = access;
  if (request.headers.get("Upgrade") !== "websocket") {
    return json({ error: "expected a WebSocket", code: "upgrade_required" }, 426);
  }
  const ticket = url.searchParams.get("ticket") || "";
  const spent = TOKEN_RE.test(ticket)
    ? await env.DB.prepare(
        "UPDATE doc_sessions SET ticket = NULL" +
          " WHERE doc_id = ?1 AND user_id = ?2 AND ticket = ?3 AND ticket_expires > ?4 RETURNING doc_id",
      )
        .bind(doc.id, user, ticket, Date.now())
        .first()
    : null;
  if (!spent) {
    log("ws.rejected", { doc: shortId(doc.id), user: shortId(user), reason: "ticket" });
    return json({ error: "that pass expired; try again", code: "ticket_invalid" }, 403);
  }

  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key.toLowerCase().startsWith("x-cranium-")) headers.delete(key);
  }
  headers.set("X-Cranium-Doc", doc.id);
  headers.set("X-Cranium-Name", encodeURIComponent(me.name));
  headers.set("X-Cranium-Role", access.is_owner ? OWNER : MEMBER);

  log("ws.forward", { doc: shortId(doc.id), user: shortId(user) });
  return objectFor(env, doc.id).fetch(new Request(request, { headers }));
}

function objectFor(env, docId) {
  return env.DOCS.get(env.DOCS.idFromName(docId));
}

// Handler-to-object calls that are not upgrades. Clients cannot reach the
// object directly, so paths under /__ are private by construction.
async function internal(env, docId, path, body) {
  try {
    return await objectFor(env, docId).fetch("https://cranium.internal" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  } catch (err) {
    console.error(`[cranium] internal.failed path=${path} doc=${shortId(docId)}`, err && err.stack);
    return new Response(null, { status: 502 });
  }
}

async function fanout(ids, fn) {
  for (let i = 0; i < ids.length; i += FANOUT) {
    await Promise.all(ids.slice(i, i + FANOUT).map(fn));
  }
}

function ownerOnly() {
  return json({ error: "only the workspace owner can do that", code: "owner_only" }, 403);
}

/* ------------------------------------------------------------------- Doc */

// One instance per document. The runtime creates it when the first request
// for that document arrives and may retire it when the document goes quiet,
// so instance fields are a cache at best: everything that matters is in
// ctx.storage (the update log, meta) or attached to a connection.
//
// The protocol, one JSON object per frame, with Yjs bytes as base64:
//
//   client → object                     object → client
//   update    { id, u }                 hello     { cid, you, peers, head, floor }
//   awareness { u }                     sync      { u: [..], to, done, reset? }
//   meta      { title, preview }        ack       { id, seq }
//   snapshot  { upto, u }               update    { seq, u }
//                                       awareness { cid, u }
//                                       join { peer } · leave { cid }
//                                       compact   { upto }
//                                       error     { code, message }
//
// Close codes: 4001 full, 4002 deleted, 4003 removed, 4009 protocol error.
// None of them reconnect. 1000 "Session limit reached" is the platform's
// 24-hour cap, and the client reconnects at once.
export class Doc {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.meta = null;
    this.compactRows = Number(env.CRANIUM_COMPACT_ROWS) > 0 ? Number(env.CRANIUM_COMPACT_ROWS) : COMPACT_ROWS;
    this.ctx.blockConcurrencyWhile(async () => {
      this.createTables();
      this.meta = { ...freshMeta(), ...((await this.ctx.storage.get("meta")) || {}) };
      // The log is the truth for seq and the tail's size; meta is a cache of
      // them that could lag if the object was retired mid-save.
      const tail = this.ctx.storage.sql
        .exec(
          "SELECT COALESCE(MAX(seq), 0) AS head, COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM updates WHERE seq > ?",
          this.meta.floor,
        )
        .one();
      this.meta.seq = Math.max(this.meta.seq, tail.head);
      this.meta.tailRows = tail.n;
      this.meta.tailBytes = tail.b;
      log("doc.wake", {
        doc: shortId(this.meta.doc),
        seq: this.meta.seq,
        rows: tail.n,
        live: this.ctx.getWebSockets().length,
      });
    });
  }

  createTables() {
    // kind is 'u' for an update and 's' for a snapshot of everything up to
    // and including its seq.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS updates (" +
        " seq INTEGER PRIMARY KEY, data TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'u')",
    );
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") === "websocket") return this.join(request);

    const url = new URL(request.url);
    if (url.pathname === "/__kick" && request.method === "POST") return this.kick(request);
    if (url.pathname === "/__delete" && request.method === "POST") return this.destroy();
    return new Response("Not found", { status: 404 });
  }

  /* connections */

  async join(request) {
    const h = request.headers;
    const userId = h.get("X-Yard-User-Id") || "";
    if (!userId) return new Response("sign in", { status: 401 });
    const docId = h.get("X-Cranium-Doc") || "";
    const name = oneLine(safeDecode(h.get("X-Cranium-Name")), MAX_NAME) || "Someone";
    const role = h.get("X-Cranium-Role") === OWNER ? OWNER : MEMBER;
    const since = Math.max(0, Math.floor(Number(new URL(request.url).searchParams.get("since")) || 0));
    if (docId && this.meta.doc !== docId) {
      this.meta.doc = docId;
      await this.saveMeta();
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Accept, explain, close: a refused upgrade would reach the browser as a
    // bare failure with nothing to show.
    const live = this.ctx.getWebSockets().length;
    if (this.meta.deleted || live >= LIMITS.peers) {
      const deleted = !!this.meta.deleted;
      this.ctx.acceptWebSocket(server);
      send(server, {
        t: "error",
        code: deleted ? "deleted" : "full",
        message: deleted ? "This document was deleted." : `${live} people are already in this document.`,
      });
      server.close(deleted ? 4002 : 4001, deleted ? "Document deleted" : "Document is full");
      log(deleted ? "doc.tombstone" : "doc.full", { doc: shortId(docId), live });
      return new Response(null, { status: 101, webSocket: client });
    }

    const peer = { cid: crypto.randomUUID().slice(0, 8), user_id: userId, name, role };
    // The attachment is the only thing a message can be traced back to: a
    // WebSocket frame carries no headers. The tag lets a removal find every
    // connection this person has open.
    server.serializeAttachment(peer);
    this.ctx.acceptWebSocket(server, [userId]);

    send(server, {
      t: "hello",
      cid: peer.cid,
      you: peer,
      peers: this.peers(peer.cid),
      head: this.meta.seq,
      floor: this.meta.floor,
    });

    // since > head means this client has seen updates this log no longer
    // holds: the storage was wiped (locally, yard dev --reset-objects). Send
    // everything and say so; the client uploads its whole state back.
    const reset = since > this.meta.seq;
    const from = reset || since < this.meta.floor ? -1 : since;
    const sent = this.sendLog(server, from, reset);

    this.broadcast({ t: "join", peer }, server);
    log("peer.join", {
      doc: shortId(this.meta.doc),
      cid: peer.cid,
      user: shortId(userId),
      since,
      rows: sent.rows,
      bytes: sent.bytes,
      peers: live + 1,
    });
    if (reset) log("heal", { doc: shortId(this.meta.doc), since, head: this.meta.seq });
    if (this.maybeCompact(server)) await this.saveMeta();
    return new Response(null, { status: 101, webSocket: client });
  }

  // The log after `from`, in frames of about SYNC_CHUNK characters. The last
  // frame says done and carries the head, so the client knows where it is
  // even when there was nothing to send.
  sendLog(ws, from, reset) {
    const rows = this.ctx.storage.sql.exec("SELECT seq, data FROM updates WHERE seq > ? ORDER BY seq", from);
    let chunk = [];
    let size = 0;
    let bytes = 0;
    let count = 0;
    let last = 0;
    for (const row of rows) {
      if (size + row.data.length > SYNC_CHUNK && chunk.length) {
        send(ws, { t: "sync", u: chunk, to: last, done: false });
        chunk = [];
        size = 0;
      }
      chunk.push(row.data);
      size += row.data.length;
      bytes += row.data.length;
      count += 1;
      last = row.seq;
    }
    send(ws, { t: "sync", u: chunk, to: this.meta.seq, done: true, reset: reset || undefined });
    return { rows: count, bytes };
  }

  async webSocketMessage(ws, raw) {
    const me = attachment(ws);
    if (!me) return;
    if (typeof raw !== "string") return this.reject(ws, me, "binary");
    if (raw.length > MAX_FRAME) return this.reject(ws, me, "too-big");
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.reject(ws, me, "json");
    }
    if (!msg || typeof msg !== "object") return this.reject(ws, me, "json");

    if (msg.t === "update") return this.update(ws, me, msg);
    if (msg.t === "awareness") return this.awareness(ws, me, msg);
    if (msg.t === "meta") return this.setMeta(msg);
    if (msg.t === "snapshot") return this.snapshot(me, msg);
    return this.reject(ws, me, "type");
  }

  async webSocketClose(ws, code, reason) {
    await this.left(ws, "peer.leave", { code, reason: reason || "-" });
    try {
      ws.close(1000, "bye");
    } catch {
      // Already closed from this side.
    }
  }

  async webSocketError(ws, err) {
    await this.left(ws, "peer.error", { error: err && err.message });
  }

  async left(ws, event, fields) {
    const me = attachment(ws);
    if (!me) return;
    if (this.meta.compact && this.meta.compact.cid === me.cid) {
      this.meta.compact = null;
      await this.saveMeta();
    }
    this.broadcast({ t: "leave", cid: me.cid }, ws);
    log(event, { doc: shortId(this.meta.doc), cid: me.cid, ...fields });
  }

  // Never drop a frame silently: a client whose update vanished would go on
  // believing everyone has it. Closing makes it reconnect-proof (4009 stops
  // the client) and loud.
  reject(ws, me, reason) {
    log("frame.rejected", { doc: shortId(this.meta.doc), cid: me.cid, reason });
    send(ws, { t: "error", code: "rejected", message: "The document refused a message from this tab." });
    try {
      ws.close(4009, "Protocol error");
    } catch {
      // Already gone.
    }
  }

  /* edits */

  // Number it, store it, then tell everyone, all without awaiting: frames go
  // out in seq order, which is what lets a client resume from `since`.
  async update(ws, me, msg) {
    if (!Number.isInteger(msg.id) || !msg.u || !isBase64(msg.u, MAX_UPDATE)) return this.reject(ws, me, "update");
    const seq = ++this.meta.seq;
    this.ctx.storage.sql.exec("INSERT INTO updates (seq, data, size, kind) VALUES (?, ?, ?, 'u')", seq, msg.u, msg.u.length);
    this.meta.tailRows += 1;
    this.meta.tailBytes += msg.u.length;
    this.meta.pending = { ...this.meta.pending, at: Date.now(), by: me.user_id };
    this.meta.pendingV += 1;
    send(ws, { t: "ack", id: msg.id, seq });
    this.broadcast({ t: "update", seq, u: msg.u }, ws);
    this.maybeCompact(ws);
    await this.touched();
  }

  // Cursors and selections: relayed to everyone else, never stored.
  awareness(ws, me, msg) {
    if (!isBase64(msg.u, MAX_AWARENESS)) return this.reject(ws, me, "awareness");
    this.broadcast({ t: "awareness", cid: me.cid, u: msg.u }, ws);
  }

  // The title and preview the grid shows. Every client derives the same
  // values from the same document, so this only records what changed and
  // lets the alarm write it.
  async setMeta(msg) {
    const title = oneLine(msg.title, MAX_TITLE);
    const preview = previewText(msg.preview);
    if (title === this.meta.title && preview === this.meta.preview) return;
    this.meta.title = title;
    this.meta.preview = preview;
    this.meta.pending = { ...this.meta.pending, title, preview };
    this.meta.pendingV += 1;
    await this.touched();
  }

  /* compaction */

  // The log grows by one row per burst of typing. Past a threshold, the
  // object asks the socket that just wrote (alive, and caught up) for its
  // whole state. The socket delivers in order, so by the time the client
  // reads `compact` it has applied everything up to `upto`; it sends its
  // own unsent edits first, so the snapshot holds nothing the log won't.
  maybeCompact(ws) {
    const m = this.meta;
    const now = Date.now();
    if (m.compact && now - m.compact.at < COMPACT_TIMEOUT_MS) return false;
    if (now - m.lastCompactAt < COMPACT_GAP_MS || m.seq <= m.floor) return false;
    if (m.tailRows <= this.compactRows && m.tailBytes <= Math.max(COMPACT_MIN_BYTES, m.baseBytes)) return false;
    const me = attachment(ws);
    if (!me) return false;
    m.compact = { cid: me.cid, upto: m.seq, at: now };
    send(ws, { t: "compact", upto: m.seq });
    log("compact.request", { doc: shortId(m.doc), cid: me.cid, upto: m.seq, rows: m.tailRows, bytes: m.tailBytes });
    return true;
  }

  // The snapshot replaces every row up to `upto`. It is written over row
  // `upto` first and the older rows deleted after, so a failure between the
  // two leaves duplicates (harmless: Yjs updates are idempotent), never a
  // gap. Only the snapshot this object asked for, from the socket it asked,
  // is accepted.
  async snapshot(me, msg) {
    const m = this.meta;
    const c = m.compact;
    if (!c || c.cid !== me.cid || c.upto !== msg.upto || Date.now() - c.at > COMPACT_TIMEOUT_MS) {
      log("compact.stale", { doc: shortId(m.doc), cid: me.cid });
      return;
    }
    m.compact = null;
    if (!isBase64(msg.u, MAX_SNAPSHOT) || !msg.u) {
      log("compact.too_big", { doc: shortId(m.doc), cid: me.cid });
      await this.saveMeta();
      return;
    }
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT OR REPLACE INTO updates (seq, data, size, kind) VALUES (?, ?, ?, 's')", c.upto, msg.u, msg.u.length);
    sql.exec("DELETE FROM updates WHERE seq < ?", c.upto);
    const tail = sql
      .exec("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM updates WHERE seq > ?", c.upto)
      .one();
    const before = m.tailRows;
    m.floor = c.upto;
    m.baseBytes = msg.u.length;
    m.tailRows = tail.n;
    m.tailBytes = tail.b;
    m.lastCompactAt = Date.now();
    await this.saveMeta();
    log("compact.done", { doc: shortId(m.doc), upto: c.upto, rows: before, bytes: msg.u.length });
  }

  /* flush */

  // Each change arms one alarm if none is pending; the alarm writes the
  // title, preview and last-edited time to the documents row. One database
  // write per burst instead of one per keystroke.
  async touched() {
    await this.saveMeta();
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
    }
  }

  async alarm() {
    const started = Date.now();
    const pending = this.meta.pending;
    const version = this.meta.pendingV;
    if (!pending || !this.meta.doc || !this.env.DB) return;
    await this.env.DB.prepare(
      "UPDATE documents SET title = COALESCE(?1, title), preview = COALESCE(?2, preview)," +
        " updated_at = COALESCE(?3, updated_at), updated_by = COALESCE(?4, updated_by) WHERE id = ?5",
    )
      .bind(
        pending.title === undefined ? null : pending.title,
        pending.preview === undefined ? null : pending.preview,
        pending.at || null,
        pending.by || null,
        this.meta.doc,
      )
      .run();
    // Edits that landed while the write was in flight get their own alarm.
    if (this.meta.pendingV === version) {
      this.meta.pending = null;
      await this.saveMeta();
    } else {
      await this.touched();
    }
    log("flush", { doc: shortId(this.meta.doc), ms: Date.now() - started });
  }

  /* handler-only routes */

  // Removed from the workspace: close this person's sockets here now, not on
  // their next reconnect. 4003 tells the client there is nothing to
  // reconnect to.
  async kick(request) {
    const { user_id: userId } = await readJSON(request);
    const sockets = userId ? this.ctx.getWebSockets(userId) : [];
    for (const socket of sockets) {
      const me = attachment(socket);
      if (me && this.meta.compact && this.meta.compact.cid === me.cid) this.meta.compact = null;
      send(socket, { t: "error", code: "removed", message: "You were removed from this workspace." });
      try {
        socket.close(4003, "Removed from workspace");
      } catch {
        // Already gone.
      }
      if (me) this.broadcast({ t: "leave", cid: me.cid }, socket);
    }
    await this.saveMeta();
    log("kick", { doc: shortId(this.meta.doc), user: shortId(userId), closed: sockets.length });
    return json({ ok: true, closed: sockets.length });
  }

  // Deleted: close everyone, drop every row, and leave a tombstone so a join
  // the handler forwarded a moment before the delete can't bring it back.
  async destroy() {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) {
      send(socket, { t: "error", code: "deleted", message: "This document was deleted." });
      try {
        socket.close(4002, "Document deleted");
      } catch {
        // Already gone.
      }
    }
    const doc = this.meta.doc;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.createTables();
    this.meta = { ...freshMeta(), doc, deleted: true };
    await this.saveMeta();
    log("doc.deleted", { doc: shortId(doc), closed: sockets.length });
    return json({ ok: true });
  }

  /* storage */

  saveMeta() {
    return this.ctx.storage.put("meta", this.meta);
  }

  peers(exceptCid) {
    const out = [];
    for (const socket of this.ctx.getWebSockets()) {
      const peer = attachment(socket);
      if (!peer || peer.cid === exceptCid) continue;
      const { cid, user_id, name, role } = peer;
      out.push({ cid, user_id, name, role });
    }
    return out;
  }

  broadcast(event, except) {
    const data = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(data);
      } catch {
        // A socket mid-close is dropped by the runtime; nothing to do here.
      }
    }
  }
}

function freshMeta() {
  return {
    doc: "",
    seq: 0, // last seq handed out
    floor: 0, // seq of the newest snapshot; rows at or below it are gone
    baseBytes: 0, // size of that snapshot
    tailRows: 0, // rows after the floor
    tailBytes: 0,
    compact: null, // { cid, upto, at } while a snapshot is outstanding
    lastCompactAt: 0,
    title: "",
    preview: "",
    pending: null, // { title?, preview?, at?, by? } not yet in env.DB
    pendingV: 0,
    deleted: false,
  };
}

function attachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function send(ws, event) {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // Closed between the check and the send.
  }
}

/* ------------------------------------------------------------ validation */

function isJSON(request) {
  return (request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json");
}

function isBase64(value, max) {
  return typeof value === "string" && value.length <= max && value.length % 4 === 0 && B64_RE.test(value);
}

// Collapses whitespace: names, workspace names, titles.
function oneLine(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

// Keeps line breaks between blocks, collapses everything else.
function previewText(value) {
  if (typeof value !== "string") return "";
  return value
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_PREVIEW);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return "";
  }
}

/* ----------------------------------------------------------------- utils */

// 18 random bytes, base64url: 24 characters nobody guesses.
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readJSON(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function methodNotAllowed() {
  return json({ error: "method not allowed", code: "method_not_allowed" }, 405);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function changed(result) {
  return (result && result.meta && result.meta.changes) || 0;
}

/* --------------------------------------------------------------- logging */
//
// Read these back with `yard service logs` (add --since 2h). Every line
// starts with [cranium] and is one event, so it greps cleanly:
//   yard service logs | grep 'compact.'
//
// Not logged: document text, titles, names, emails, invite tokens, tickets.
// Ids are cut to 8 characters: enough to correlate lines within a session,
// not a lasting identifier sitting in a log store.

function log(event, fields) {
  const parts = ["[cranium] " + event];
  for (const key in fields) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    parts.push(key + "=" + value);
  }
  console.log(parts.join(" "));
}

function shortId(id) {
  return typeof id === "string" && id ? id.slice(0, 8) : "-";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ids shortened, invite tokens hidden. The query string (which carries the
// socket ticket) is never passed in.
function redactPath(pathname) {
  const parts = pathname.split("/");
  return parts
    .map((segment, i) => {
      if (UUID.test(segment)) return shortId(segment);
      if (parts[i - 1] === "invites" && segment) return "…";
      return segment;
    })
    .join("/");
}
