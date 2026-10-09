"use client";

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useAudioActions, useAudioPlayer } from "@/components/audio/audio-player-provider";
import { FloatingVideoBar } from "@/components/player/floating-video-bar";
import { SeamlessPlayer, type PlayerControls, type PlayerStatus } from "@/components/player/seamless-player";
import { NO_SESSION, needsFreshPlayer, videoSessionReducer, type VideoSessionInfo, type VideoSessionState } from "@/components/player/video-session-state";

interface VideoSessionView extends VideoSessionState {
  status: PlayerStatus | null;
  /** Whether the floating video bar is on screen (it gives way to the audio bar while audio is what is playing, and on full-screen pages). */
  barShown: boolean;
}

/** Pages that are full-screen experiences of their own (the reader, the picture viewer): no floating bar over them. */
export const hidesFloatingBar = (pathname: string | null) => !!pathname && /\/(read|photo)\//.test(pathname);
/** Whether this address is the full video player. */
export const isWatchPath = (pathname: string | null) => !!pathname && /\/watch\//.test(pathname);
interface VideoSessionActions {
  open(session: VideoSessionInfo): void;
  minimize(): void;
  close(): void;
  toggle(): void;
  skip(seconds: number): void;
}

const ViewContext = createContext<VideoSessionView | null>(null);
const ActionsContext = createContext<VideoSessionActions | null>(null);

/** The video that is open (if any), whether it fills the screen, and what the player says about itself. Null outside the provider. */
export const useVideoSession = () => useContext(ViewContext);
export const useVideoSessionActions = () => useContext(ActionsContext);

/**
 * Keeps the video player alive above the pages, so a video carries on when the viewer browses away: the watch page only asks for the
 * player to fill the screen, and leaving it shrinks the player to a floating bar (the picture is hidden, the sound continues).
 */
export function VideoSessionProvider({ children, initial = NO_SESSION }: { children: ReactNode; /** For tests: start with a video already open. */ initial?: VideoSessionState }) {
  const [state, dispatch] = useReducer(videoSessionReducer, initial);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  // Bumped to throw the player away and start a fresh one (the same video opened again after it finished or failed).
  const [instance, setInstance] = useState(0);
  // Which of the two is the one in use: set when audio starts, cleared when the video is played.
  const [audioActive, setAudioActive] = useState(false);
  const controls = useRef<PlayerControls | null>(null);
  const stateRef = useRef(state);
  const statusRef = useRef(status);
  useEffect(() => {
    stateRef.current = state;
    statusRef.current = status;
  }, [state, status]);
  const audio = useAudioActions();
  const audioHasBook = !!useAudioPlayer()?.book;
  const pathname = usePathname();

  const actions = useMemo<VideoSessionActions>(
    () => ({
      open: (session) => {
        if (needsFreshPlayer(stateRef.current.session, session, statusRef.current)) {
          setInstance((i) => i + 1);
          setStatus(null);
        }
        dispatch({ type: "open", session });
      },
      minimize: () => dispatch({ type: "minimize" }),
      close: () => {
        controls.current?.pause();
        dispatch({ type: "close" });
        setStatus(null);
      },
      // One thing plays at a time: starting the video stops any audiobook or song.
      toggle: () => {
        audio?.pause();
        setAudioActive(false);
        controls.current?.toggle();
      },
      skip: (seconds) => controls.current?.skip(seconds),
    }),
    [audio]
  );

  // ...and the other way round: when audio starts, the video pauses.
  useEffect(() => {
    const onAudioPlay = () => {
      controls.current?.pause();
      setAudioActive(true);
    };
    window.addEventListener("roam:audio-play", onAudioPlay);
    return () => window.removeEventListener("roam:audio-play", onAudioPlay);
  }, []);

  // The player fills the screen only on the watch page itself. Leaving it (by any route) shrinks it to the bar, but moving between two
  // watch pages (the next episode) never does, so there is no flash of the bar while the next page loads.
  const { expanded } = state;
  useEffect(() => {
    if (expanded && !isWatchPath(pathname)) dispatch({ type: "minimize" });
  }, [expanded, pathname]);

  // Lock-screen and headset controls for the video (they also help a phone keep the sound going when the screen is off).
  const session = state.session;
  useEffect(() => {
    if (!session || typeof navigator === "undefined" || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title: session.title, artist: session.subtitle ?? "" });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => actions.toggle()],
      ["pause", () => controls.current?.pause()],
      ["seekbackward", () => actions.skip(-10)],
      ["seekforward", () => actions.skip(10)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // an action this browser does not know
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, [session, actions]);

  const barShown = !!session && !expanded && !hidesFloatingBar(pathname) && !(audioActive && audioHasBook);
  const view = useMemo<VideoSessionView>(() => ({ ...state, status, barShown }), [state, status, barShown]);

  return (
    <ActionsContext.Provider value={actions}>
      <ViewContext.Provider value={view}>
        {children}
        {session && (
          <div className={expanded ? "fixed inset-0 z-50 bg-black" : undefined}>
            <SeamlessPlayer
              key={instance}
              mode={expanded ? "full" : "mini"}
              onStatus={setStatus}
              controlsRef={controls}
              ownerKind={session.ownerKind}
              ownerId={session.ownerId}
              title={session.title}
              manageSubtitlesHref={session.manageSubtitlesHref}
              subtitle={session.subtitle}
              backHref={session.backHref}
              nextHref={session.nextHref}
              nextLabel={session.nextLabel}
            />
          </div>
        )}
        {barShown && <FloatingVideoBar />}
      </ViewContext.Provider>
    </ActionsContext.Provider>
  );
}
