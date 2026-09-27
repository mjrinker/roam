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

export const createViewerSchema = z.object({
  name: nameSchema,
  avatarKey: avatarKeySchema,
  locale: localeSchema.optional(),
  maxAge: maxAgeSchema.optional(),
  allowUnrated: z.boolean().optional(),
  // A PIN can be set at creation time; there's nothing to clear yet, so null is just ignored.
  pin: pinSchema.optional(),
});

/** Fields any profile may change about itself, whether or not it's a manager. */
export const selfEditSchema = z
  .object({
    name: nameSchema.optional(),
    avatarKey: avatarKeySchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

/** Everything an unrestricted (manager) profile may change, on itself or any other profile on the account. */
export const managerEditSchema = z
  .object({
    name: nameSchema.optional(),
    avatarKey: avatarKeySchema.optional(),
    locale: localeSchema.optional(),
    maxAge: maxAgeSchema.optional(),
    allowUnrated: z.boolean().optional(),
    pin: pinSchema.optional(),
    // Required whenever the acting manager profile itself has a PIN — see
    // requireManagerViewer's caller in the PATCH route.
    currentPin: z.string().regex(/^\d{4}$/).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "currentPin"), "Nothing to change");
