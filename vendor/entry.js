// Everything the app imports from ./vendor/editor.js, and nothing else.
// One bundle means one copy of Yjs and ProseMirror: two copies of either
// break collaboration in ways that look like random desyncs.

export { Editor, Extension, Node, Mark, mergeAttributes } from "@tiptap/core";
export { StarterKit } from "@tiptap/starter-kit";
export { Document } from "@tiptap/extension-document";
export { TaskList, TaskItem } from "@tiptap/extension-list";
export { Placeholder } from "@tiptap/extensions";
export { Collaboration } from "@tiptap/extension-collaboration";
export { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
export { Markdown } from "@tiptap/markdown";

export * as Y from "yjs";
export {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
export { toBase64, fromBase64 } from "lib0/buffer";
