/** A profile's choice for screenshots in Photos: shown with the rest, left out, or the only thing shown. */
import { eq } from "drizzle-orm";
import { titles } from "@/lib/db/schema";

export const SCREENSHOT_FILTERS = ["show", "hide", "only"] as const;
export type ScreenshotFilter = (typeof SCREENSHOT_FILTERS)[number];

export const SCREENSHOT_FILTER_LABEL: Record<ScreenshotFilter, string> = { show: "Show", hide: "Hide", only: "Only" };

/** The condition on `titles` for a filter (nothing for "show"). */
export const screenshotCondition = (filter: ScreenshotFilter | undefined) => (filter === "hide" ? eq(titles.isScreenshot, false) : filter === "only" ? eq(titles.isScreenshot, true) : undefined);

/** Favorites ignore "hide" (what was hearted is shown even if it is a screenshot), but "only" still narrows. */
export const forFavorites = (filter: ScreenshotFilter | undefined): ScreenshotFilter | undefined => (filter === "hide" ? "show" : filter);
