/** Most profiles one account can have. */
export const MAX_VIEWERS_PER_ACCOUNT = 6;

/**
 * Whether accounts can add/delete profiles yet. Kept off until the
 * contract migration has dropped watch_state's old per-account unique index:
 * while it exists, two profiles on one account could not both save progress
 * for the same title.
 */
export const MULTIPLE_VIEWERS_ENABLED = false;

export const VIEWER_NAME_MAX_LENGTH = 40;
