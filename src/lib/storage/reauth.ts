/** A storage connection's login is dead (revoked, expired, or its keys no longer work) and an admin must sign in to it again. Any provider throws this. */
export class StorageReauthRequiredError extends Error {
  constructor(
    public readonly connectionId: string,
    message?: string
  ) {
    super(message ?? `Storage connection ${connectionId} needs to be signed in again`);
    this.name = "StorageReauthRequiredError";
  }
}

/** Matches this error (or Box's subclass of it) when it has been through a boundary that loses the class, such as a settled-promise reason in another module. */
export const isReauthError = (err: unknown): boolean => /ReauthRequiredError$/.test((err as { name?: string } | null)?.name ?? "");
