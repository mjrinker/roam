/** What "done with it" is called for each kind of thing: watched, listened to, read. */
export type DoneKind = "watch" | "listen" | "read";

export interface DoneWords {
  /** "Watched", for a badge. */
  done: string;
  /** "Mark as watched". */
  markDone: string;
  /** "Mark as unwatched". */
  markUndone: string;
  /** What a toast says after marking: "Marked as watched". */
  doneToast: string;
  undoneToast: string;
}

const WORDS: Record<DoneKind, { done: string; undone: string }> = {
  watch: { done: "watched", undone: "unwatched" },
  listen: { done: "listened to", undone: "not listened to" },
  read: { done: "read", undone: "unread" },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function doneWords(kind: DoneKind): DoneWords {
  const w = WORDS[kind];
  return { done: cap(w.done), markDone: `Mark as ${w.done}`, markUndone: `Mark as ${w.undone}`, doneToast: `Marked as ${w.done}`, undoneToast: `Marked as ${w.undone}` };
}

/** Which words fit a title of this kind (an audiobook or audio file is listened to, an eBook is read, everything else is watched). */
export function doneKindOf(titleKind: string): DoneKind {
  return titleKind === "audiobook" ? "listen" : titleKind === "ebook" ? "read" : "watch";
}
