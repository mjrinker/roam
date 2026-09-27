import { z } from "zod";
import { isAvatarKey } from "@/lib/viewers/avatars";
import { VIEWER_NAME_MAX_LENGTH } from "@/lib/viewers/config";
import { isSupportedLocale } from "@/lib/viewers/locales";
import { RATING_LEVEL_VALUES } from "@/lib/content/access";

export const nameSchema = z.string().trim().min(1, "Give the profile a name").max(VIEWER_NAME_MAX_LENGTH);
export const avatarKeySchema = z.string().refine(isAvatarKey, "Unknown avatar");
export const localeSchema = z.string().refine(isSupportedLocale, "Unsupported language");
export const maxAgeSchema = z
  .union([z.number().int(), z.null()])
  .refine((v) => RATING_LEVEL_VALUES.includes(v), "Not a valid rating limit");
// null clears the PIN; a 4-digit string sets or changes it.
export const pinSchema = z.union([z.string().regex(/^\d{4}$/, "PIN must be 4 digits"), z.null()]);
// The owner is fixed at account creation and never assigned through this
// schema — see lib/content/roles.
export const assignableRoleSchema = z.enum(["admin", "limited"]);

export const createViewerSchema = z.object({
  name: nameSchema,
  avatarKey: avatarKeySchema,
  role: assignableRoleSchema.optional(),
  locale: localeSchema.optional(),
  maxAge: maxAgeSchema.optional(),
  allowUnrated: z.boolean().optional(),
  visibleOnServer: z.boolean().optional(),
  // A PIN can be set at creation time; there's nothing to clear yet, so null is just ignored.
  pin: pinSchema.optional(),
});

/** Fields any profile may change about itself, regardless of role. */
export const selfEditSchema = z
  .object({
    name: nameSchema.optional(),
    avatarKey: avatarKeySchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

/**
 * Everything that needs the "extended" permission (see lib/content/roles'
 * canEditExtended): the owner editing any profile, or an admin editing
 * itself. `role` reassignment is validated separately in the route, since
 * it's only ever legal for the OWNER acting on a DIFFERENT profile.
 */
export const extendedEditSchema = z
  .object({
    name: nameSchema.optional(),
    avatarKey: avatarKeySchema.optional(),
    locale: localeSchema.optional(),
    maxAge: maxAgeSchema.optional(),
    allowUnrated: z.boolean().optional(),
    visibleOnServer: z.boolean().optional(),
    pin: pinSchema.optional(),
    role: assignableRoleSchema.optional(),
    // Required whenever the ACTING profile itself has a PIN — see the PATCH route.
    currentPin: z.string().regex(/^\d{4}$/).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "currentPin"), "Nothing to change");
