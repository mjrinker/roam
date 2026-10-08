/**
 * The short code a TV shows and a person types. Pure (no server imports), so the phone's form and the server share the same rules.
 * Five characters from 31 symbols (no 0, O, 1, I or L) is 28.6 million codes; with at most a few TVs waiting at once, a guess
 * almost never lands on one, and the number of guesses per account is limited (see the approval route). Case never matters.
 */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 5;

/** What people see: the code as it is (five characters need no hyphen). */
export const formatUserCode = (code: string): string => code;

/** What someone typed, as a code, or null if it can't be one. Case, spaces and hyphens are ignored. */
export function normalizeUserCode(input: string | null | undefined): string | null {
  const code = (input ?? "").toUpperCase().replace(/[\s-]/g, "");
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

/** How many characters of what is typed count towards a code (so a form can wait until there are enough). */
export const typedLength = (input: string): number => input.replace(/[\s-]/g, "").length;
