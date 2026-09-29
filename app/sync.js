// The connection between one Y.Doc in this tab and the document's object.
//
// The object is an ordered log: it numbers every update it receives (seq),
// stores it, acks it to the sender and relays it to everyone else. This
// side keeps its own edits until they are acked, remembers the highest seq
// it has applied (head), and reconnects with ?since=head so it only
// downloads what it missed. Yjs updates are idempotent and commute, so
// resending after a drop and receiving things twice are both harmless.
//
// Protocol and close codes: see the Doc class in _service.js.

import {
  Y,
  toBase64,
  fromBase64,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "./vendor/editor.js";
import { api } from "./api.js";

// Transaction origins this module applies with, so the update listener can
// tell other people's edits (and the frozen seed) from this tab's.
export const REMOTE = Symbol("remote");
export const SEED = Symbol("seed");

const BATCH_MS = 80; // local edits are merged and sent at most this often
const AWARENESS_MS = 60; // cursor moves, likewise
const MAX_UPDATE = 1024 * 1024; // base64 characters; the object's limit too
const MAX_SNAPSHOT = 4 * 1024 * 1024;

// Closes that mean "don't come back": reconnecting would only repeat them.
const STOP = { 4001: "full", 4002: "deleted", 4003: "removed", 4009: "rejected" };

export function connectDoc(docId, ydoc, awareness, handlers = {}) {
  let h = handlers; // emptied once the view is gone (see close)
  let ws = null;
  let ready = false; // hello received on the current socket
  let head = 0;
  let attempt = 0;
  let retryTimer = 0;
  let stopped = false; // no more reconnecting
  let draining = false; // the view closed; still sending what's unacked
  let finished = false;
  let drainTimer = 0;
  let nextId = 1;
  let unsent = []; // Uint8Array updates made here, not yet sent
  let inflight = []; // { id, u } sent on this socket, not yet acked
  let batchTimer = 0;
  let awarenessTimer = 0;
  let status = "";
  let you = null;
  const peers = new Map(); // cid -> { cid, user_id, name, role }
  const peerClients = new Map(); // cid -> Set of awareness client ids
  const abort = new AbortController();

  let resolveFirst;
  let rejectFirst;
  const firstSync = new Promise((resolve, reject) => {
    resolveFirst = resolve;
    rejectFirst = reject;
  });
  firstSync.catch(() => {});

  const saved = () => unsent.length === 0 && inflight.length === 0;

  function setStatus(next) {
    if (next === status) return;
    status = next;
    if (h.onStatus) h.onStatus(next);
  }

  function emitPeers() {
    if (h.onPeers) h.onPeers([...peers.values()]);
  }

  function emitSaved() {
    if (draining && saved()) return finish();
    if (h.onSaved) h.onSaved(saved());
  }

  /* ------------------------------------------------------------ sending */

  function send(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  function onUpdate(update, origin) {
    if (origin === REMOTE || origin === SEED) return;
    unsent.push(update);
    emitSaved();
    if (!batchTimer) batchTimer = setTimeout(flush, BATCH_MS);
  }

  // Sends everything unsent as one merged update. Also called directly
  // (flushNow) before a snapshot, which must not hold edits the log lacks.
  function flush() {
    clearTimeout(batchTimer);
    batchTimer = 0;
    if (!ready || !unsent.length) return;
    const merged = unsent.length === 1 ? unsent[0] : Y.mergeUpdates(unsent);
    const u = toBase64(merged);
    if (u.length > MAX_UPDATE) {
      stop("too_big");
      return;
    }
    const id = nextId++;
    if (!send({ t: "update", id, u })) return;
    unsent = [];
    inflight.push({ id, u });
  }

  function onAwareness({ added, updated, removed }, origin) {
    if (origin === "local") {
      if (!awarenessTimer) awarenessTimer = setTimeout(sendAwareness, AWARENESS_MS);
      return;
    }
    // Remember which connection each remote client id arrived on, so a
    // `leave` can clear exactly that person's cursor.
    if (typeof origin === "string" && origin.startsWith("peer:")) {
      const cid = origin.slice(5);
      const set = peerClients.get(cid) || new Set();
      for (const id of added.concat(updated)) set.add(id);
      for (const id of removed) set.delete(id);
      peerClients.set(cid, set);
    }
  }

  function sendAwareness() {
    clearTimeout(awarenessTimer);
    awarenessTimer = 0;
    if (!ready) return;
    const u = toBase64(encodeAwarenessUpdate(awareness, [ydoc.clientID]));
    send({ t: "awareness", u });
  }

  function clearRemoteAwareness() {
    const ids = [...awareness.getStates().keys()].filter((id) => id !== ydoc.clientID);
    if (ids.length) removeAwarenessStates(awareness, ids, "reset");
    peerClients.clear();
  }

  /* ---------------------------------------------------------- receiving */

  function applyRemote(list) {
    Y.transact(
      ydoc,
      () => {
        for (const b of list) Y.applyUpdate(ydoc, fromBase64(b), REMOTE);
      },
      REMOTE,
    );
  }

  function onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.t === "hello") {
      you = msg.you;
      peers.clear();
      for (const peer of msg.peers || []) peers.set(peer.cid, peer);
      emitPeers();
      clearRemoteAwareness();
      ready = true;
      // Anything the last socket never acked goes out again on this one.
      unsent = inflight.map((x) => fromBase64(x.u)).concat(unsent);
      inflight = [];
      sendAwareness();
      return;
    }

    if (msg.t === "sync") {
      applyRemote(msg.u || []);
      head = msg.to;
      if (!msg.done) return;
      // The object's log is behind this tab (its storage was wiped): hand
      // it everything, and it becomes the log again.
      if (msg.reset) unsent.unshift(Y.encodeStateAsUpdate(ydoc));
      attempt = 0;
      setStatus("connected");
      resolveFirst({ you, peers: [...peers.values()] });
      flush();
      emitSaved();
      return;
    }

    if (msg.t === "ack") {
      inflight = inflight.filter((x) => x.id !== msg.id);
      head = Math.max(head, msg.seq);
      emitSaved();
      return;
    }

    if (msg.t === "update") {
      applyRemote([msg.u]);
      head = Math.max(head, msg.seq);
      return;
    }

    if (msg.t === "awareness") {
      applyAwarenessUpdate(awareness, fromBase64(msg.u), "peer:" + msg.cid);
      return;
    }

    if (msg.t === "join") {
      peers.set(msg.peer.cid, msg.peer);
      emitPeers();
      sendAwareness(); // so the newcomer sees this cursor straight away
      return;
    }

    if (msg.t === "leave") {
      const ids = peerClients.get(msg.cid);
      if (ids && ids.size) removeAwarenessStates(awareness, [...ids], "leave");
      peerClients.delete(msg.cid);
      peers.delete(msg.cid);
      emitPeers();
      return;
    }

    if (msg.t === "compact") {
      // Send our own edits first so the snapshot holds nothing the log
      // won't also have, then the whole state.
      flush();
      if (unsent.length) return;
      const u = toBase64(Y.encodeStateAsUpdate(ydoc));
      if (u.length <= MAX_SNAPSHOT) send({ t: "snapshot", upto: msg.upto, u });
    }
  }

  /* --------------------------------------------------------- connecting */

  // A ticket first: it doubles as the access check, so a document that was
  // deleted, or a workspace this person was removed from, answers 404 here
  // instead of failing the upgrade with nothing to say.
  async function connect() {
    if (stopped) return;
    setStatus(attempt === 0 && !head ? "connecting" : "reconnecting");
    let ticket;
    try {
      ({ ticket } = await api(`api/docs/${encodeURIComponent(docId)}/session`, { method: "POST" }));
    } catch (err) {
      if (stopped) return;
      if (err.status === 404) return stop("gone");
      if (err.status === 401) return location.reload();
      return retry();
    }
    if (stopped) return;

    const url = new URL(
      `api/docs/${encodeURIComponent(docId)}/ws?ticket=${encodeURIComponent(ticket)}&since=${head}`,
      location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    ws = socket;
    ready = false;
    socket.onmessage = (event) => {
      if (ws === socket) onMessage(event);
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      ready = false;
      closed(event);
    };
  }

  function closed(event) {
    clearRemoteAwareness();
    peers.clear();
    emitPeers();
    if (stopped) return;
    if (STOP[event.code]) return stop(STOP[event.code]);
    // The platform ends every connection after 24 hours; pick straight up.
    if (event.code === 1000 && event.reason === "Session limit reached") {
      attempt = 0;
      return connect();
    }
    retry();
  }

  function retry() {
    if (stopped) return;
    setStatus(navigator.onLine === false ? "offline" : "reconnecting");
    const delay = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
    attempt += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
  }

  function stop(reason) {
    if (stopped) return;
    if (draining) return finish();
    stopped = true;
    teardown();
    setStatus("stopped");
    rejectFirst(Object.assign(new Error(reason), { reason }));
    if (h.onStop) h.onStop(reason);
  }

  // Nothing more will happen on this connection.
  function finish() {
    if (finished) return;
    finished = true;
    stopped = true;
    clearTimeout(drainTimer);
    teardown();
    awareness.destroy();
  }

  function teardown() {
    abort.abort();
    clearTimeout(retryTimer);
    clearTimeout(batchTimer);
    clearTimeout(awarenessTimer);
    ydoc.off("update", onUpdate);
    awareness.off("update", onAwareness);
    const socket = ws;
    ws = null;
    ready = false;
    if (socket) {
      try {
        socket.close(1000, "bye");
      } catch {
        // Already closing.
      }
    }
  }

  ydoc.on("update", onUpdate);
  awareness.on("update", onAwareness);
  window.addEventListener(
    "online",
    () => {
      if (ws || stopped) return;
      clearTimeout(retryTimer);
      attempt = 0;
      connect();
    },
    { signal: abort.signal },
  );
  window.addEventListener("offline", () => !stopped && !ws && setStatus("offline"), { signal: abort.signal });
  // Edits not yet acked would be lost with the tab; let the browser ask.
  window.addEventListener(
    "beforeunload",
    (event) => {
      if (!saved()) event.preventDefault();
    },
    { signal: abort.signal },
  );

  connect();

  return {
    firstSync,
    get saved() {
      return saved();
    },
    get status() {
      return status;
    },
    sendMeta(meta) {
      return ready && send({ t: "meta", title: meta.title, preview: meta.preview });
    },
    // Leaving the document: take this cursor off everyone's screen and
    // send what's pending. If edits are still unacked (a slow network, or
    // offline), keep the connection going in the background until the
    // object has them, for up to a minute, instead of dropping them.
    close() {
      h = {};
      if (stopped || draining) return finish();
      draining = true;
      flush();
      if (ready) {
        removeAwarenessStates(awareness, [ydoc.clientID], "local");
        sendAwareness();
      }
      if (saved()) return finish();
      drainTimer = setTimeout(finish, 60 * 1000);
    },
  };
}
