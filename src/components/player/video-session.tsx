"use client";

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useAudioActions } from "@/components/audio/audio-player-provider";
import { FloatingVideoBar } from "@/components/player/floating-video-bar";
import { SeamlessPlayer, type PlayerControls, type PlayerStatus } from "@/components/player/seamless-player";
import { NO_SESSION, videoSessionReducer, type VideoSessionInfo, type VideoSessionState } from "@/components/player/video-session-state";

interface VideoSessionView extends VideoSessionState {
  status: PlayerStatus | null;
}
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
  const controls = useRef<PlayerControls | null>(null);
  const audio = useAudioActions();

  const actions = useMemo<VideoSessionActions>(
    () => ({
      open: (session) => dispatch({ type: "open", session }),
      minimize: () => dispatch({ type: "minimize" }),
      close: () => {
        controls.current?.pause();
        dispatch({ type: "close" });
        setStatus(null);
      },
      // One thing plays at a time: starting the video stops any audiobook or song.
      toggle: () => {
        audio?.pause();
        controls.current?.toggle();
      },
      skip: (seconds) => controls.current?.skip(seconds),
    }),
    [audio]
  );

  // ...and the other way round: when audio starts, the video pauses.
  useEffect(() => {
    const onAudioPlay = () => controls.current?.pause();
    window.addEventListener("roam:audio-play", onAudioPlay);
    return () => window.removeEventListener("roam:audio-play", onAudioPlay);
  }, []);

  const view = useMemo<VideoSessionView>(() => ({ ...state, status }), [state, status]);
  const { session, expanded } = state;

  return (
    <ActionsContext.Provider value={actions}>
      <ViewContext.Provider value={view}>
        {children}
        {session && (
          <div className={expanded ? "fixed inset-0 z-50 bg-black" : undefined}>
            <SeamlessPlayer
              mode={expanded ? "full" : "mini"}
              onStatus={setStatus}
              controlsRef={controls}
              ownerKind={session.ownerKind}
              ownerId={session.ownerId}
              title={session.title}
              subtitle={session.subtitle}
              backHref={session.backHref}
              nextHref={session.nextHref}
              nextLabel={session.nextLabel}
            />
          </div>
        )}
        {session && !expanded && <FloatingVideoBar />}
      </ViewContext.Provider>
    </ActionsContext.Provider>
  );
}
