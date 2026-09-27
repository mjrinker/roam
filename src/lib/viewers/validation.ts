import { z } from "zod";
import { isAvatarKey } from "@/lib/viewers/avatars";
import { VIEWER_NAME_MAX_LENGTH } from "@/lib/viewers/config";
import { isSupportedLocale } from "@/lib/viewers/locales";

export const nameSchema = z.string().trim().min(1, "Give the profile a name").max(VIEWER_NAME_MAX_LENGTH);
export const avatarKeySchema = z.string().refine(isAvatarKey, "Unknown avatar");
export const localeSchema = z.string().refine(isSupportedLocale, "Unsupported language");

export const createViewerSchema = z.object({
  name: nameSchema,
  avatarKey: avatarKeySchema,
  locale: localeSchema.optional(),
});

export const updateViewerSchema = z
  .object({
    name: nameSchema.optional(),
    avatarKey: avatarKeySchema.optional(),
    locale: localeSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
