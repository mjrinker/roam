"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PlayManifest, PlayOwnerKind, PlaySegment } from "@/lib/player/types";
import type { LoadedTrack } from "@/components/player/subtitles";
import type { Cue } from "@/lib/subtitles/cues";
import { AltAudio, canPlayAltAudio } from "@/lib/player/alt-audio";
import { sameLanguage } from "@/lib/viewers/audio-languages";

/** Tells Roam which language the viewer just picked, so the next video that has it starts that way (best effort). */
export function rememberLanguage(change: { audio?: string | null; subtitles?: string | null }) {
  void fetch("/api/viewers/current/languages", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) }).catch(() => undefined);
}

interface AudioInfo {
  index: number;
  language: string;
  label: string;
  codec: string;
  channels: number;
  mime: string | null;
}
interface TextInfo {
  index: number;
  language: string;
  label: string;
}
interface FileTracks {
  audioTracks: AudioInfo[];
  textTracks: TextInfo[];
}

export interface AudioOption {
  index: number;
  label: string;
  /** False when this browser can't play that track (its sound isn't in a format it takes). */
  supported: boolean;
}

interface Args {
  manifest: PlayManifest | null;
  ownerKind: PlayOwnerKind;
  ownerId: string;
  /** The segment playing now, and where in the whole film. */
  segment: PlaySegment | null;
  globalTime: number;
  frontVideo: () => HTMLVideoElement | null;
  /** Changes when the picture moves to the other video element. */
  frontSlot: number;
  volume: number;
  /** The languages this profile wants by default (from the play manifest). */
  prefs?: { audio: string | null; subtitles: string | null };
}

const tracksUrl = (ownerKind: string, ownerId: string, fileId: string) => `/api/play/${ownerKind}/${ownerId}/tracks/${fileId}`;

/** The audio tracks and subtitle tracks inside a video's files: choosing another language, and subtitles that came with the file. */
export function useEmbeddedTracks({ manifest, ownerKind, ownerId, segment, globalTime, frontVideo, frontSlot, volume, prefs }: Args) {
  const [info, setInfo] = useState<Record<string, FileTracks>>({});
  const [selectedAudio, setSelectedAudio] = useState(0);
  const [audioProblem, setAudioProblem] = useState<string | null>(null);
  const [textState, setTextState] = useState<Record<string, Cue[] | "loading">>({});

  // What each file of this video holds (one small request per file, quietly skipped when it can't be read).
  useEffect(() => {
    setInfo({});
    setTextState({});
    if (!manifest) return;
    let live = true;
    for (const seg of manifest.segments) {
      if (!seg.fileId) continue;
      const fileId = seg.fileId;
      void fetch(tracksUrl(ownerKind, ownerId, fileId))
        .then((r) => (r.ok ? (r.json() as Promise<FileTracks>) : null))
        .then((t) => live && t && Array.isArray(t.audioTracks) && Array.isArray(t.textTracks) && setInfo((all) => ({ ...all, [fileId]: t })))
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [manifest, ownerKind, ownerId]);

  const first = manifest?.segments[0]?.fileId ? info[manifest.segments[0].fileId] : undefined;
  const current = segment?.fileId ? info[segment.fileId] : undefined;

  // A browser that lists a video's audio tracks itself (Safari) switches them natively; everywhere else the other tracks play as pieces.
  const nativeTracks = useCallback(() => {
    const list = (frontVideo() as (HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }) | null)?.audioTracks;
    return list && list.length > 1 ? list : null;
  }, [frontVideo]);

  const audioOptions: AudioOption[] = useMemo(() => {
    if (!first || first.audioTracks.length < 2) return [];
    return first.audioTracks.map((a) => ({ index: a.index, label: a.label, supported: a.index === 0 || canPlayAltAudio(a.mime) || "audioTracks" in HTMLMediaElement.prototype }));
  }, [first]);

  // The track in this part that is the chosen one: the same position, or failing that the same language.
  const trackIn = useCallback(
    (file: FileTracks | undefined) => {
      const want = first?.audioTracks[selectedAudio];
      if (!file || !want) return null;
      const same = file.audioTracks[selectedAudio];
      if (same && same.language === want.language) return same;
      return file.audioTracks.find((a) => a.language === want.language && a.channels === want.channels) ?? file.audioTracks.find((a) => a.language === want.language) ?? null;
    },
    [first, selectedAudio]
  );

  const engines = useRef(new Map<number, AltAudio>());
  const [altActive, setAltActive] = useState(false);
  const volumeRef = useRef(volume);
  useEffect(() => {
    volumeRef.current = volume;
    engines.current.forEach((e) => e.setVolume(volume));
  }, [volume]);

  // Native switching.
  useEffect(() => {
    const list = nativeTracks();
    if (!list) return;
    for (let i = 0; i < list.length; i++) list[i].enabled = i === selectedAudio;
  }, [nativeTracks, selectedAudio, frontSlot, segment?.index, current]);

  // Pieces: one engine for the part playing, and (shortly before it ends) one ready for the next part.
  const segmentIndex = segment?.index ?? -1;
  const segmentEnd = segment ? segment.startSeconds + segment.durationSeconds : 0;
  const wantNext = !!segment && manifest !== null && segmentEnd - globalTime < 30 && segment.index + 1 < manifest.segments.length;
  useEffect(() => {
    const keep = new Set<number>();
    const stop = () => {
      engines.current.forEach((e) => e.destroy());
      engines.current.clear();
      setAltActive(false);
    };
    if (!manifest || !segment || selectedAudio === 0 || nativeTracks()) {
      stop();
      return;
    }
    const make = (seg: PlaySegment): AltAudio | null => {
      const file = seg.fileId ? info[seg.fileId] : undefined;
      const track = trackIn(file);
      if (!seg.fileId || !track || !canPlayAltAudio(track.mime)) return null;
      const existing = engines.current.get(seg.index);
      if (existing) return existing;
      const engine = new AltAudio({
        base: `${tracksUrl(ownerKind, ownerId, seg.fileId)}/audio/${track.index}`,
        mime: track.mime!,
        onFailure: (message) => {
          setAudioProblem(message);
          setSelectedAudio(0);
        },
      });
      engine.setVolume(volumeRef.current);
      engines.current.set(seg.index, engine);
      return engine;
    };
    const engine = make(segment);
    const video = frontVideo();
    if (!engine || !video) {
      stop();
      return;
    }
    keep.add(segment.index);
    engines.current.forEach((e, i) => i !== segment.index && e.detach());
    engine.attach(video);
    setAltActive(true);
    if (wantNext) {
      const next = manifest.segments[segment.index + 1];
      if (make(next)) keep.add(next.index);
    }
    for (const [i, e] of [...engines.current]) {
      if (!keep.has(i)) {
        e.destroy();
        engines.current.delete(i);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, segmentIndex, frontSlot, selectedAudio, info, wantNext, ownerKind, ownerId]);

  useEffect(
    () => () => {
      engines.current.forEach((e) => e.destroy());
      engines.current.clear();
    },
    []
  );

  const selectAudio = useCallback((index: number) => {
    setAudioProblem(null);
    setSelectedAudio(index);
  }, []);

  // What the viewer picks by hand is remembered for the next video; what the preference picks automatically is not saved again.
  const chooseAudio = useCallback(
    (index: number) => {
      selectAudio(index);
      const language = first?.audioTracks[index]?.language;
      if (language && language !== "und") rememberLanguage({ audio: language });
    },
    [first, selectAudio]
  );

  // A new video starts in the profile's audio language when it has that track (and this browser can play it).
  const audioAppliedFor = useRef<PlayManifest | null>(null);
  useEffect(() => {
    if (!manifest || !first || audioAppliedFor.current === manifest) return;
    audioAppliedFor.current = manifest;
    if (!prefs?.audio || first.audioTracks.length < 2) return;
    const want = first.audioTracks.find((a) => sameLanguage(a.language, prefs.audio));
    if (!want || want.index === selectedAudio) return;
    if (want.index === 0 || canPlayAltAudio(want.mime) || "audioTracks" in HTMLMediaElement.prototype) selectAudio(want.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, first, prefs?.audio]);

  // ── Subtitles that came with the file ──
  const textLanguages = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of first?.textTracks ?? []) if (!seen.has(t.language)) seen.set(t.language, t.label);
    return [...seen];
  }, [first]);

  // Subtitles kept with the title (files beside the video, and ones the admin saved): listed with the manifest, read when first chosen.
  const kept = manifest?.subtitleTracks;
  const [keptState, setKeptState] = useState<Record<string, Cue[] | "loading">>({});
  useEffect(() => setKeptState({}), [manifest]);

  const embeddedTracks: LoadedTrack[] = useMemo(
    () => [
      ...textLanguages.map(([language, label]) => {
        const state = textState[language];
        return { id: `emb:${language}`, label: `${label} (in the file)`, cues: Array.isArray(state) ? state : [], embedded: { language, loaded: Array.isArray(state), loading: state === "loading" } };
      }),
      ...(kept ?? []).map((k) => {
        const state = keptState[k.id];
        return { id: `sav:${k.id}`, label: k.label, cues: Array.isArray(state) ? state : [], embedded: { language: k.language ?? "und", loaded: Array.isArray(state), loading: state === "loading", trackId: k.id } };
      }),
    ],
    [textLanguages, textState, kept, keptState]
  );

  /** Reads a kept subtitle track (they are on the whole title's clock already). */
  const loadSaved = useCallback(async (trackId: string): Promise<boolean> => {
    setKeptState((s) => ({ ...s, [trackId]: "loading" }));
    try {
      const res = await fetch(`/api/subtitles/tracks/${trackId}`);
      if (!res.ok) throw new Error("subtitles failed");
      const { cues } = (await res.json()) as { cues: Cue[] };
      setKeptState((s) => ({ ...s, [trackId]: cues }));
      return true;
    } catch {
      setKeptState((s) => {
        const { [trackId]: _gone, ...rest } = s;
        void _gone;
        return rest;
      });
      return false;
    }
  }, []);

  /** Reads one language's subtitles from every part of the video and puts them on the whole film's clock. */
  const loadText = useCallback(
    async (language: string): Promise<boolean> => {
      if (!manifest) return false;
      setTextState((s) => ({ ...s, [language]: "loading" }));
      try {
        const all: Cue[] = [];
        for (const seg of manifest.segments) {
          const file = seg.fileId ? info[seg.fileId] : undefined;
          const track = file?.textTracks.find((t) => t.language === language);
          if (!seg.fileId || !track) continue;
          const res = await fetch(`${tracksUrl(ownerKind, ownerId, seg.fileId)}/text/${track.index}`);
          if (!res.ok) throw new Error("subtitles failed");
          const { cues } = (await res.json()) as { cues: Cue[] };
          const offset = seg.inFileOffsetSeconds ?? 0;
          const end = seg.inFileEndSeconds ?? Infinity;
          for (const [start, stop, words] of cues) {
            if (start < offset - 0.01 || start >= end) continue;
            all.push([seg.startSeconds + start - offset, seg.startSeconds + Math.min(stop, end) - offset, words]);
          }
        }
        all.sort((a, b) => a[0] - b[0]);
        setTextState((s) => ({ ...s, [language]: all }));
        return true;
      } catch {
        setTextState((s) => {
          const { [language]: _gone, ...rest } = s;
          void _gone;
          return rest;
        });
        return false;
      }
    },
    [manifest, info, ownerKind, ownerId]
  );

  // The subtitles to switch on by themselves: the profile's language, when the file has it (the player turns it on once per video).
  const preferredText = useMemo(() => {
    if (!prefs?.subtitles) return null;
    const match = textLanguages.find(([language]) => sameLanguage(language, prefs.subtitles));
    if (match) return `emb:${match[0]}`;
    const keptMatch = kept?.find((k) => sameLanguage(k.language, prefs.subtitles));
    return keptMatch ? `sav:${keptMatch.id}` : null;
  }, [prefs?.subtitles, textLanguages, kept]);

  return { audioOptions, selectedAudio, selectAudio: chooseAudio, audioProblem, altAudioActive: altActive, embeddedTracks, loadText, loadSaved, preferredText };
}
