"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- Google's Cast sender is a global with no types of its own */
import { useCallback, useEffect, useRef, useState } from "react";
import { castGlobal, castItems, castPosition } from "@/lib/player/cast";
import type { PlayManifest } from "@/lib/player/types";

const SDK = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";

let sdkReady: Promise<boolean> | null = null;
/** Loads Google's Cast sender once, in a browser that can use it (Chrome and Edge); resolves false anywhere else or if it can't load. */
function loadCastSdk(): Promise<boolean> {
  if (sdkReady) return sdkReady;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const supported = /Chrome\//.test(ua) && !/iPhone|iPad|iPod/.test(ua);
  sdkReady = new Promise<boolean>((resolve) => {
    if (!supported || typeof document === "undefined") return resolve(false);
    (window as any).__onGCastApiAvailable = (ok: boolean) => resolve(ok);
    const script = document.createElement("script");
    script.src = SDK;
    script.async = true;
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    setTimeout(() => resolve(false), 8000);
  });
  return sdkReady;
}

export interface CastState {
  /** There is a Chromecast on the network to send to. */
  available: boolean;
  /** Sending to a device now: its name, and where the picture is (seconds into the whole video). */
  casting: { device: string; playing: boolean; time: number } | null;
  problem: string | null;
}

interface Args {
  manifest: PlayManifest | null;
  enabled: boolean;
  title: string;
  /** Where the viewer is in the whole video now. */
  getTime: () => number;
  pauseLocal: () => void;
  /** Casting ended: carry on here from this place. */
  resumeLocal: (globalSeconds: number) => void;
}

/** Sending the picture to a Chromecast: pick a device, send every file of the video as a queue from where the viewer is, and follow it. */
export function useCast({ manifest, enabled, title, getTime, pauseLocal, resumeLocal }: Args) {
  const [state, setState] = useState<CastState>({ available: false, casting: null, problem: null });
  const refs = useRef<{ context: any; player: any; controller: any } | null>(null);
  const manifestRef = useRef(manifest);
  const latest = useRef({ pauseLocal, resumeLocal, getTime });
  useEffect(() => {
    manifestRef.current = manifest;
    latest.current = { pauseLocal, resumeLocal, getTime };
  });

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadCastSdk().then((ok) => {
      if (!alive || !ok) return;
      try {
        const cast = (window as any).cast;
        const chromeCast = (window as any).chrome.cast;
        const context = cast.framework.CastContext.getInstance();
        context.setOptions({ receiverApplicationId: chromeCast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED });
        const player = new cast.framework.RemotePlayer();
        const controller = new cast.framework.RemotePlayerController(player);
        refs.current = { context, player, controller };
        const follow = () => {
          const m = manifestRef.current;
          const connected = context.getCastState() === cast.framework.CastState.CONNECTED && player.isConnected;
          if (!connected || !m) return setState((s) => (s.casting ? { ...s, casting: null } : s));
          const items = castItems(m);
          const at = Math.max(0, items.findIndex((i) => i.url === player.mediaInfo?.contentId));
          setState((s) => ({ ...s, casting: { device: context.getCurrentSession()?.getCastDevice()?.friendlyName ?? "your TV", playing: !player.isPaused, time: castGlobal(items, at, player.currentTime ?? 0) } }));
        };
        const types = cast.framework.RemotePlayerEventType;
        for (const t of [types.IS_CONNECTED_CHANGED, types.CURRENT_TIME_CHANGED, types.IS_PAUSED_CHANGED, types.MEDIA_INFO_CHANGED]) controller.addEventListener(t, follow);
        const refresh = () => setState((s) => ({ ...s, available: context.getCastState() !== cast.framework.CastState.NO_DEVICES_AVAILABLE }));
        context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, refresh);
        refresh();
      } catch {
        // Casting just isn't offered
      }
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  const start = useCallback(async () => {
    const r = refs.current;
    const m = manifestRef.current;
    if (!r || !m) return;
    setState((s) => ({ ...s, problem: null }));
    try {
      const chromeCast = (window as any).chrome.cast;
      await r.context.requestSession();
      const items = castItems(m);
      const at = castPosition(items, latest.current.getTime());
      const queue = items.map((i) => {
        const info = new chromeCast.media.MediaInfo(i.url, i.contentType);
        info.metadata = new chromeCast.media.GenericMediaMetadata();
        info.metadata.title = title;
        return new chromeCast.media.QueueItem(info);
      });
      const request = new chromeCast.media.QueueLoadRequest(queue);
      request.startIndex = at.index;
      request.currentTime = at.seconds;
      request.repeatMode = chromeCast.media.RepeatMode.OFF;
      const session = r.context.getCurrentSession();
      await session.getSessionObj().queueLoad(request);
      latest.current.pauseLocal();
    } catch (e) {
      // Closing the device picker is not a problem.
      const code = typeof e === "string" ? e : (e as { code?: string })?.code;
      if (code !== "cancel") setState((s) => ({ ...s, problem: "Couldn't start casting. Check that the TV is on the same network." }));
    }
  }, [title]);

  const togglePause = useCallback(() => refs.current?.controller.playOrPause(), []);

  const stop = useCallback(() => {
    const at = state.casting?.time ?? latest.current.getTime();
    try {
      refs.current?.context.endCurrentSession(true);
    } catch {
      // already ended
    }
    latest.current.resumeLocal(at);
  }, [state.casting?.time]);

  return { ...state, start, togglePause, stop };
}
