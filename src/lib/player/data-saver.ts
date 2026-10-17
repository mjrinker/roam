/**
 * Data saver: a profile setting that keeps video, pictures and background loading light for people on a metered connection. For video it means
 * playing the version nearest 480p unless the viewer picks another; the rest (smaller pictures, no loading of the next song ahead of time) is done
 * where those things are drawn. It never changes the files or what is on the server, only what is fetched by default.
 */

/** The picture height video is aimed at with data saver on (the nearest version, lower on a tie). */
export const DATA_SAVER_HEIGHT = 480;
/** next/image quality for artwork: normal, and with data saver on. */
export const NORMAL_IMAGE_QUALITY = 75;
export const DATA_SAVER_IMAGE_QUALITY = 40;

/** The height to aim a video at: with data saver on, no more than DATA_SAVER_HEIGHT (a lower request is kept); off, whatever was asked for. */
export function aimHeight(requested: number | null, dataSaver: boolean): number | null {
  if (!dataSaver) return requested;
  return requested === null ? DATA_SAVER_HEIGHT : Math.min(requested, DATA_SAVER_HEIGHT);
}

export const imageQuality = (dataSaver: boolean): number => (dataSaver ? DATA_SAVER_IMAGE_QUALITY : NORMAL_IMAGE_QUALITY);
