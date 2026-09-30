# Cranium

<p align="center">
<a href="https://dash.yard.sh/projects?action=create&repo=https%3A%2F%2Fgithub.com%2Fyard-sh%2Fyard-cranium"><img src="https://yard.sh/create-in-yard.png" width="200" alt="Create in Yard" /></a>
</p>

A collaborative document editor hosted end to end on Yard. Everyone in a
workspace writes in the same document at once, with a named cursor each and
no merge conflicts. Workspaces come with a single invite link, and the owner
decides who stays. The pieces:

- **Frontend:** a static app with a vendored TipTap editor.
- **CRDT:** a Yjs document in every browser.
- **Backend:** one fetch handler, plus one realtime room per document.
- **Storage:** a per-project SQLite database.
- **Sign-in:** Yard Auth.
- **Pricing:** one free tier.

Use the button above, or paste this repository's URL into the **Create from
GitHub URL** field of the Yard dashboard's Create Project dialog. Cranium
declares rooms (realtime state inside a service) and a custom landing page.
Both are part of Yard Pro, so creating it needs a Pro plan. The service is
`authenticated`, so it also needs Yard Auth.

Once it's live:

- The landing page is at `https://<team>.yard.sh/<slug>/`.
- The app is at `https://<team>.yard.sh/<slug>/app/`.

## Layout

    .yard/
      settings.json       every project setting: service, room class, landing page, pricing
      migrations/         users, workspaces, members, documents, doc sessions
      landing-page/       the public page, with a live two-cursor demo
      dev/                local state written by yard dev; ignored by git
    app/                  the deployable bundle (the services[] entry with dir: app)
      _service.js         the whole backend: the fetch handler and the Doc room class
      index.html          app shell: sidebar, views, dialogs
      app.js              boot, routing, workspace switcher, document grid, members, invites
      doc.js              one open document: connection, seed, presence, title and preview
      editing.js          the editor: schema, menu bar, toolbar, shortcuts, Markdown
      sync.js             the connection between a Y.Doc and its room
      api.js · ui.js      fetch wrapper; DOM helpers, dialogs, colours
      styles.css          paper & graphite tokens, light and dark
      vendor/editor.js    GENERATED: TipTap + Yjs as one ES module (see below)
    vendor/               how app/vendor/editor.js is built; not deployed

The service entry declares its mount, access mode, database, and room class:

    "services": [
      { "dir": "app", "name": "app", "url": "/app",
        "access": "authenticated", "database_access": true,
        "rooms": [{ "class": "Doc", "binding": "DOCS" }] }
    ]

## How it fits together

**One document is one room.** `_service.js` exports a class called `Doc`.

- Yard keeps one instance of it per document, reached through `env.DOCS`.
- Every connection to that document lands on that same instance.
- The instance holds the open sockets and the document's content. The content
  sits in its own SQL storage and never goes into `env.DB`.

**The CRDT lives in the browsers; the room is a log.**

- Each tab holds a Yjs document and sends its changes as Yjs updates.
- The room doesn't parse them. It numbers each one (`seq`), stores it, acks
  it to the sender, and relays it to everyone else.
- Yjs updates can arrive in any order and more than once, so a relay is all a
  server needs to be. That's why `_service.js` stays one plain module with no
  bundler and no dependencies.
- A tab keeps its own edits until they're acked and reconnects with
  `?since=<seq>`. After a dropped connection it downloads only what it missed
  and resends what never landed.
- Cursors and selections (Yjs awareness) are relayed and never stored.

The protocol is one JSON object per frame, with Yjs bytes in base64:

    client → room                       room → client
    update    { id, u }                 hello     { cid, you, peers, head, floor }
    awareness { u }                     sync      { u: [..], to, done, reset? }
    meta      { title, preview }        ack       { id, seq } · update { seq, u }
    snapshot  { upto, u }               awareness · join · leave · compact · error

Close codes 4001 (full), 4002 (deleted), 4003 (removed) and 4009 (protocol
error) tell the client not to reconnect. `1000 "Session limit reached"` is
the platform's 24-hour cap, and the client reconnects at once.

**Compaction is done by a client.**

1. The log grows by one row per burst of typing (tabs batch every 80 ms).
2. Past 400 rows, or once the rows since the last snapshot outweigh it, the
   room sends `compact { upto }` to the socket that just wrote. That socket
   is alive and caught up.
3. That tab first sends anything unsent, then its whole state.
4. The room writes the snapshot over row `upto` and deletes the rows before
   it.

The socket delivers in order, so the snapshot holds everything up to `upto`.
Writing before deleting means a failure between the two leaves duplicates,
never a gap. Only the snapshot the room asked for, from the socket it
asked, is accepted.

Members are trusted editors: a bogus snapshot can do no more than deleting
all the text, which any member can already do.

**The handler decides who gets in.** The socket route,
`GET api/docs/:id/ws?since=<seq>`, does the following:

- checks membership in the database,
- notes that this person has the document open (a removal reads that),
- strips any client-sent `X-Cranium-*` headers,
- stamps trusted ones, and forwards the upgrade to the document's room.

The room trusts `X-Cranium-*` the way it trusts `X-Yard-*`. The edge honors
the session only for requests from the project's own pages, so a socket
opened from any other site arrives signed out and is turned away. A refused
upgrade reaches the browser with no reason attached, so before reconnecting
the client asks `GET api/docs/:id`. A 404 means the document was deleted or
the person was removed, and it stops trying.

**The first line is the title, until someone renames it.**

- A document is `block+`: no separate title line. Its title is its first
  line of text, or the name set by clicking the title in the top bar (kept
  in the Y.Doc, so a rename reaches everyone like any other edit).
- A frozen seed update gives every new document one empty paragraph. Any
  number of tabs applying the seed make one copy. Documents from before this
  started from a different seed, with a title line; `seed()` in `doc.js`
  applies whichever one a document's edits hang off.
- Tabs that are editing report the title and a preview.
- The room writes them to the `documents` row from a 5-second alarm: one
  database write per burst, not per keystroke. That row is what the grid
  shows and sorts by.

**Everything stays Markdown.** The editor works like Google Docs (menu bar,
toolbar with a text-style picker, Docs keyboard shortcuts) but only offers
formatting Markdown can express: headings 1 to 3, bold, italic,
strikethrough, code, links, lists, checklists, quotes, code blocks and
horizontal lines. Markdown typed or pasted as text turns into formatting.
File > Download saves a `.md`, File > Import inserts one at the cursor, and
View > Markdown source edits the raw text. Leaving the source view applies
only the part that changed, so collaborators' edits elsewhere survive.
Underline isn't Markdown: nothing creates it, but the mark stays in the
schema, because y-tiptap deletes text carrying a mark the schema doesn't
know.

**Workspaces, invites, removal.**

- **Personal workspace.** Everyone gets one on first visit. It can be renamed
  but never deleted. More can be made from the switcher.
- **Owner and members.** Documents belong to a workspace. Its owner is the
  only one who sees the invite link, resets it, removes members, or deletes the
  workspace.
- **Deleting documents.** Any member writes. A document can be deleted by its
  author or the owner.
- **The invite link.** It is `…/app/?invite=<token>`, a random token separate
  from the workspace id. Resetting it kills every copy of the old link.
- **Removal takes effect now.** The handler looks up the documents that person
  opened in the last day (a socket can't outlive 24 hours), and each of those
  rooms closes their sockets with 4003. The Remove
  dialog also resets the invite link by default, since the old one would let
  them straight back in.

**The editor bundle is vendored.** `app/vendor/editor.js` holds TipTap 3,
Yjs, and the awareness protocol, prebuilt as one ES module and committed.
There are two reasons:

- Create in Yard deploys the repository as it is, and the app has no build
  step.
- One bundle guarantees one copy of Yjs and ProseMirror. Two copies break
  collaboration in ways that look like random desyncs.

To change what it exports or upgrade a pinned version:

    cd vendor && npm ci && npm run build

The build fails if any of those libraries would be bundled twice. `app.js`
loads the editor only when a document opens, so the grid never downloads it.

Two details worth knowing before editing:

- **Relative URLs only.** The app is mounted at `/<slug>/app/`, so it uses
  `fetch("api/docs")`, never `/api/docs`. Routes live in `location.hash`, and
  the socket URL is built from `location.href`.
- **The class name is the identity.** Renaming `Doc` in `settings.json`
  deletes every document's content on the next deploy; `yard push` warns
  before it does. Change the `binding` if only the name in `env` should change.

## Local development

    yard dev

This serves the landing page at `http://localhost:9875/cranium/` and the app
at `http://localhost:9875/cranium/app/`. The migration is applied to a local
database, and document rooms are stored under `.yard/dev/rooms/`.

There is no sign-up screen and no login code in this repo: Yard Auth signs
people in and hands the service trusted `X-Yard-*` headers. Locally, a
**persona** stands in for it, and each persona is a different person:

| Persona     | Who they are                  |
| ----------- | ----------------------------- |
| `member`    | you, the project owner        |
| `signed-in` | someone who just signed in    |
| `user:free` | someone on the Free tier      |

- **Switching:** switch at `http://localhost:9875/cranium/app/__yard/auth/login`,
  or start with `yard dev --as signed-in`.
- **Collaborating:** open the app in a normal window and a private window, pick
  a different persona in each, and invite one from the other.
- **Watching compaction:** add `CRANIUM_COMPACT_ROWS=20` to
  `.yard/dev/secrets.env`.

Every save restarts the local runtime, which drops every open socket. The
client reconnects on its own, the same way it does when a hosted session
reaches its 24-hour limit. `yard dev --reset-db` starts from an empty database
and `--reset-rooms` deletes every stored document.

## Logging

    yard service logs --since 2h
    yard service logs --since 2h | grep 'compact.'

Every line starts with `[cranium]` and is one event:

    [cranium] peer.join doc=5b1c37d7 cid=c91853ac user=05c444a7 since=212 rows=3 bytes=411 peers=2
    [cranium] compact.request doc=5b1c37d7 cid=c91853ac upto=640 rows=401 bytes=38912
    [cranium] compact.done doc=5b1c37d7 upto=640 rows=401 bytes=5120
    [cranium] member.remove ws=a1f0c2d9 user=05c444a7 kicked=2 reset=true

**Handler events:**

- `request`, `auth.rejected`, `me.rename`
- `workspace.provision|create|rename|delete`
- `member.leave|remove`
- `invite.reset|accept`
- `doc.create|delete`
- `ws.forward|rejected`

**Room events:**

- `doc.wake|full|tombstone|deleted`
- `peer.join|leave|error`
- `heal`, `frame.rejected`
- `compact.request|done|stale|too_big`
- `flush`, `kick`

**Not logged:** document text, titles, names, emails, invite tokens.
Ids are cut to 8 characters.

## Usage and cost

Rooms are metered: requests, compute time while a message is handled, and
stored bytes. An inbound socket message counts as one twentieth of a request,
and a document that holds sockets but sees no activity costs no compute. So
the client:

- batches typing every 80 ms,
- throttles cursor moves to 60 ms,
- lets compaction keep each document's storage close to its actual size.

## Shipping

    yard service check                        validate bundle + lint, no network
    yard push                                 upload service, page and settings into the draft
    yard releases publish <tag>               publish the draft, which makes it live
    yard service open                         print/open the live app URL
    yard db query "select title, updated_at from documents"

Nothing serves a draft release, so pushing is safe to repeat. Migrations
apply themselves at deploy. To try a release before anyone else sees it:

    yard sandbox create preview
    yard sandbox pin                            hold the project on what it serves
    yard releases publish <tag>
    yard sandbox pin <tag> --sandbox preview
    yard service open --sandbox preview         team-only URL
    yard sandbox unpin                          go live

A sandbox has its own database and its own documents.

## Data lifecycle

- **Deleting a document** removes its rows and tells its room to drop its
  storage. A small tombstone stays behind, so a connection already on its way
  can't bring the document back.
- **Deleting a workspace** does the same for every document in it.
- **Removing the `Doc` class** from `settings.json` deletes every document's
  content at the next deploy.
- **Removing the whole service** keeps room data for 30 days.
