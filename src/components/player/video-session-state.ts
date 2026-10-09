/** The video the floating player bar carries: what is open, and whether it fills the screen. Pure, so the rules can be tested. */

export interface VideoSessionInfo {
  ownerKind: "title" | "episode";
  ownerId: string;
  title: string;
  subtitle?: string | null;
  /** Where the player's back arrow goes. */
  backHref: string;
  nextHref?: string;
  nextLabel?: string;
  /** The address of the full player, for the bar's expand button. */
  watchHref: string;
}

export interface VideoSessionState {
  session: VideoSessionInfo | null;
  expanded: boolean;
}

export const NO_SESSION: VideoSessionState = { session: null, expanded: false };

export type VideoSessionAction = { type: "open"; session: VideoSessionInfo } | { type: "minimize" } | { type: "close" };

/** Whether two sessions are the same video (opening it again then just brings the player back, it does not start over). */
export const sameVideo = (a: VideoSessionInfo, b: VideoSessionInfo) => a.ownerKind === b.ownerKind && a.ownerId === b.ownerId;

export function videoSessionReducer(state: VideoSessionState, action: VideoSessionAction): VideoSessionState {
  switch (action.type) {
    // The watch page opened: the player fills the screen, for this video (details refreshed if it is the one already open).
    case "open":
      return { session: action.session, expanded: true };
    // The watch page went away (the viewer navigated): the video carries on in the bar.
    case "minimize":
      return state.session ? { ...state, expanded: false } : state;
    // The bar's close button: stop and forget.
    case "close":
      return NO_SESSION;
  }
}

/** A progress bar's fill, 0 to 100, safe against a length of zero. */
export const progressPercent = (time: number, duration: number) => (duration > 0 ? Math.min(100, Math.max(0, (time / duration) * 100)) : 0);
