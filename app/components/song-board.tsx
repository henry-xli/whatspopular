"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { releaseDateFor, type CultureSection } from "../culture";
import { CloseIcon, ExternalLinkIcon, PlayIcon } from "./icons";

const SPOTIFY_IFRAME_API_URL = "https://open.spotify.com/embed/iframe-api/v1";

type SpotifyPlaybackEvent = {
  data?: {
    duration?: number;
    isPaused?: boolean;
    playingURI?: string;
    position?: number;
  };
};

type SpotifyEmbedController = {
  addListener: (event: string, callback: (event: SpotifyPlaybackEvent) => void) => void;
  loadEntity?: (uri: string) => void;
  loadUri?: (uri: string) => void;
  pause?: () => void | Promise<void>;
  play: () => void | Promise<void>;
};

type SpotifyIframeApi = {
  createController: (
    element: HTMLElement,
    options: { height: number; theme?: string; uri: string; width: string },
    callback: (controller: SpotifyEmbedController) => void,
  ) => void;
};

declare global {
  interface Window {
    __whatspopularSpotifyIframeApi?: SpotifyIframeApi;
    __whatspopularSpotifyIframeApiPromise?: Promise<SpotifyIframeApi>;
    onSpotifyIframeApiReady?: (api: SpotifyIframeApi) => void;
  }
}

function spotifyUri(trackId: string) {
  return `spotify:track:${trackId}`;
}

function spotifyPlaylistIdFromUrl(url?: string) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/playlist\/([A-Za-z0-9]+)\/?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function loadEntity(controller: SpotifyEmbedController, uri: string) {
  if (controller.loadEntity) {
    controller.loadEntity(uri);
  } else {
    controller.loadUri?.(uri);
  }
}

function loadTrack(controller: SpotifyEmbedController, trackId: string) {
  loadEntity(controller, spotifyUri(trackId));
}

function playController(controller: SpotifyEmbedController) {
  try {
    const result = controller.play();
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch(() => {});
    }
  } catch {
    // The browser may reject playback until the user has interacted with the page.
  }
}

function loadSpotifyIframeApi() {
  if (window.__whatspopularSpotifyIframeApi) {
    return Promise.resolve(window.__whatspopularSpotifyIframeApi);
  }

  if (window.__whatspopularSpotifyIframeApiPromise) {
    return window.__whatspopularSpotifyIframeApiPromise;
  }

  const promise = new Promise<SpotifyIframeApi>((resolve, reject) => {
    let settled = false;
    const previousReady = window.onSpotifyIframeApiReady;
    const script = document.querySelector<HTMLScriptElement>(`script[src="${SPOTIFY_IFRAME_API_URL}"]`)
      ?? document.createElement("script");
    const timeout = window.setTimeout(() => finish(new Error("Spotify embed API timed out")), 12000);

    function finish(errorOrApi: Error | SpotifyIframeApi) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      if (errorOrApi instanceof Error) {
        reject(errorOrApi);
      } else {
        window.__whatspopularSpotifyIframeApi = errorOrApi;
        resolve(errorOrApi);
      }
    }

    window.onSpotifyIframeApiReady = (api) => {
      try {
        previousReady?.(api);
      } catch {
        // A separate embed should not prevent this player from initializing.
      }
      finish(api);
    };

    script.addEventListener("error", () => finish(new Error("Spotify embed API failed to load")), { once: true });
    if (!script.src) {
      script.src = SPOTIFY_IFRAME_API_URL;
      script.async = true;
      script.dataset.whatspopularSpotify = "true";
      document.head.appendChild(script);
    }
  });
  window.__whatspopularSpotifyIframeApiPromise = promise.catch((error: unknown) => {
    delete window.__whatspopularSpotifyIframeApiPromise;
    throw error;
  });
  return window.__whatspopularSpotifyIframeApiPromise;
}

function trackIdFromUri(uri?: string) {
  if (!uri) return null;
  const id = uri.split(":").pop();
  return id && /^[A-Za-z0-9]{22}$/.test(id) ? id : null;
}

export function SongBoard({ section }: { section: CultureSection }) {
  const tracks = useMemo(() => [...section.items, ...(section.moreItems ?? [])], [section.items, section.moreItems]);
  const trackIds = useMemo(
    () => tracks.map((item) => item.spotifyId).filter((id): id is string => Boolean(id)),
    [tracks],
  );
  const trackById = useMemo(() => new Map(
    tracks.flatMap((item) => item.spotifyId ? [[item.spotifyId, item] as const] : []),
  ), [tracks]);
  const [activeTrack, setActiveTrack] = useState<string | null>(null);
  const [playlistMode, setPlaylistMode] = useState(false);
  const [embedError, setEmbedError] = useState(false);
  const [embedReady, setEmbedReady] = useState(false);
  const playerRef = useRef<HTMLDivElement>(null);
  const embedHostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SpotifyEmbedController | null>(null);
  const queueModeRef = useRef(false);
  const queueIndexRef = useRef(-1);
  const pendingTrackRef = useRef<string | null>(null);
  const pendingPlaylistRef = useRef(false);
  const advancingRef = useRef(false);
  const trackIdsRef = useRef(trackIds);

  const activeItem = activeTrack ? trackById.get(activeTrack) : undefined;
  const spotifyPlaylist = section.sources.find((source) => source.url.includes("open.spotify.com/playlist"));
  const spotifyPlaylistId = spotifyPlaylistIdFromUrl(spotifyPlaylist?.url);
  const spotifyPlaylistEmbedUrl = spotifyPlaylistId
    ? `https://open.spotify.com/embed/playlist/${spotifyPlaylistId}?utm_source=generator&theme=0&autoplay=1`
    : null;
  const isPlayerOpen = Boolean(activeItem || playlistMode);

  const updateActiveTrack = (trackId: string | null) => {
    setActiveTrack(trackId);
  };

  useEffect(() => {
    trackIdsRef.current = trackIds;
  }, [trackIds]);

  useEffect(() => {
    const host = embedHostRef.current;
    const firstTrack = trackIds[0];
    if (!host || !firstTrack) return;
    let disposed = false;

    loadSpotifyIframeApi().then((api) => {
      if (disposed || !embedHostRef.current) return;
      api.createController(
        embedHostRef.current,
        { height: 152, theme: "0", uri: spotifyUri(firstTrack), width: "100%" },
        (controller) => {
          if (disposed) return;
          controllerRef.current = controller;
          setEmbedError(false);
          setEmbedReady(true);
          controller.addListener("playback_update", (event) => {
            const data = event.data;
            if (!data) return;
            const currentId = trackIdFromUri(data.playingURI);
            if (currentId && trackIdsRef.current.includes(currentId)) {
              setActiveTrack(currentId);
            }

            const duration = Number(data.duration ?? 0);
            const position = Number(data.position ?? 0);
            const threshold = duration > 100 ? 1500 : 1.5;
            const atEnd = duration > 0 && position >= duration - threshold;
            // Some embeds report a naturally finished track as paused, so the
            // position boundary is the reliable signal for advancing the queue.
            if (!queueModeRef.current || !atEnd || advancingRef.current) return;

            const currentIndex = currentId ? trackIdsRef.current.indexOf(currentId) : queueIndexRef.current;
            const nextTrack = trackIdsRef.current[currentIndex + 1];
            if (!nextTrack) {
              queueModeRef.current = false;
              return;
            }
            advancingRef.current = true;
            queueIndexRef.current = currentIndex + 1;
            window.setTimeout(() => {
              advancingRef.current = false;
              if (disposed || !controllerRef.current) return;
              loadTrack(controllerRef.current, nextTrack);
              updateActiveTrack(nextTrack);
              playController(controllerRef.current);
            }, 120);
          });

          const pendingTrack = pendingTrackRef.current;
          const pendingPlaylist = pendingPlaylistRef.current;
          if (pendingPlaylist) {
            pendingPlaylistRef.current = false;
            queueModeRef.current = true;
            queueIndexRef.current = 0;
            const firstTrack = trackIdsRef.current[0];
            if (firstTrack) {
              loadTrack(controller, firstTrack);
              playController(controller);
            }
          } else if (pendingTrack) {
            pendingTrackRef.current = null;
            loadTrack(controller, pendingTrack);
            playController(controller);
          }
        },
      );
    }).catch(() => {
      if (!disposed) setEmbedError(true);
    });

    return () => {
      disposed = true;
      controllerRef.current = null;
    };
  }, [trackIds]);

  useEffect(() => {
    if (!activeTrack && !playlistMode) return;
    const frame = window.requestAnimationFrame(() => {
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      playerRef.current?.scrollIntoView({ behavior, block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTrack, playlistMode]);

  const startPlaylist = () => {
    if (!trackIds.length) return;
    if (!spotifyPlaylistEmbedUrl) {
      startTrack(trackIds[0]);
      return;
    }
    queueModeRef.current = true;
    advancingRef.current = false;
    queueIndexRef.current = 0;
    pendingTrackRef.current = null;
    pendingPlaylistRef.current = true;
    setPlaylistMode(true);
    updateActiveTrack(null);
    const controller = controllerRef.current;
    if (!controller) return;
    pendingPlaylistRef.current = false;
    loadTrack(controller, trackIds[0]);
    playController(controller);
  };

  const startTrack = (trackId: string) => {
    const index = trackIds.indexOf(trackId);
    if (index < 0) return;
    queueIndexRef.current = index;
    queueModeRef.current = true;
    advancingRef.current = false;
    pendingPlaylistRef.current = false;
    setPlaylistMode(false);
    updateActiveTrack(trackId);
    const controller = controllerRef.current;
    if (!controller) {
      pendingTrackRef.current = trackId;
      return;
    }
    loadTrack(controller, trackId);
    playController(controller);
  };

  const stopTrack = () => {
    queueModeRef.current = false;
    pendingTrackRef.current = null;
    pendingPlaylistRef.current = false;
    setPlaylistMode(false);
    try {
      const result = controllerRef.current?.pause?.();
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(() => {});
      }
    } catch {
      // A paused or unavailable embed is already in the desired state.
    }
    updateActiveTrack(null);
  };

  return (
    <section className="board" id={section.id} aria-labelledby={`${section.id}-title`}>
      <div className="board-heading">
        <div>
          <p className="eyebrow">{section.eyebrow}</p>
          <h2 id={`${section.id}-title`}>{section.title}</h2>
        </div>
        <p>{section.description}</p>
        <div className="source-list" aria-label="Sources">
          {section.sources.map((source) => (
            <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">
              {source.label}<ExternalLinkIcon />
            </a>
          ))}
        </div>
      </div>

      <div className="music-playlist" aria-label="Music playlist">
        <div className="music-playlist-toolbar">
          <button
            type="button"
            className="music-play-all"
            onClick={startPlaylist}
            disabled={!trackIds.length}
          >
            <PlayIcon />
            <span>Play playlist</span>
          </button>
          {spotifyPlaylist ? (
            <a className="music-open-playlist" href={spotifyPlaylist.url} target="_blank" rel="noopener noreferrer">
              Open in Spotify <ExternalLinkIcon />
            </a>
          ) : null}
          <span className="music-playlist-meta">{tracks.length} tracks · ordered by Billboard Hot 100</span>
        </div>

        <div className="music-table-wrap">
          <table className="music-tracklist">
            <caption className="sr-only">Music leaderboard tracks, ordered by Billboard Hot 100 placement</caption>
            <colgroup>
              <col className="music-col-number" />
              <col className="music-col-track" />
              <col className="music-col-release" />
              <col className="music-col-billboard" />
              <col className="music-col-action" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className="music-track-number">#</th>
                <th scope="col">Track</th>
                <th scope="col" className="music-track-release-heading">Released</th>
                <th scope="col" aria-sort="ascending">Billboard Hot 100</th>
                <th scope="col"><span className="sr-only">Open track</span></th>
              </tr>
            </thead>
            <tbody>
              {tracks.map((item) => {
                const trackId = item.spotifyId;
                const isActive = Boolean(trackId && activeTrack === trackId);
                return (
                  <tr key={item.title} className={`music-track-row${isActive ? " is-active" : ""}`}>
                    <td className="music-track-number">{item.rank}</td>
                    <td className="music-track-main">
                      {trackId ? (
                        <button
                          type="button"
                          className="music-track-select"
                          onClick={() => isActive ? stopTrack() : startTrack(trackId)}
                          aria-label={`${isActive ? "Stop" : "Play"} ${item.title} by ${item.subtitle}`}
                        >
                          <span className="music-track-play-icon" aria-hidden="true">{isActive ? <CloseIcon /> : <PlayIcon />}</span>
                          <img src={item.image} alt={item.alt} width="56" height="56" loading="lazy" decoding="async" />
                          <span className="music-track-name">
                            <strong>{item.title}</strong>
                            <span>{item.subtitle}</span>
                            <span className="music-track-release-mobile">Released {releaseDateFor(item)}</span>
                          </span>
                        </button>
                      ) : (
                        <span className="music-track-select">
                          <img src={item.image} alt={item.alt} width="56" height="56" loading="lazy" decoding="async" />
                          <span className="music-track-name">
                            <strong>{item.title}</strong>
                            <span>{item.subtitle}</span>
                            <span className="music-track-release-mobile">Released {releaseDateFor(item)}</span>
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="music-track-release">{releaseDateFor(item)}</td>
                    <td className="music-track-billboard"><strong>{item.metric?.value ?? "—"}</strong></td>
                    <td className="music-track-action">
                      <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.title} in Spotify`}>
                        <ExternalLinkIcon />
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`song-player music-player${isPlayerOpen ? "" : " is-ready"}`} ref={playerRef} aria-live="polite">
        <div className="song-player-heading">
          <span>{isPlayerOpen ? "Now playing" : "Spotify player"}</span>
          <strong>{activeItem ? `${activeItem.title} · ${activeItem.subtitle}` : "Music playlist"}</strong>
          {isPlayerOpen ? (
            <button type="button" onClick={stopTrack} aria-label="Stop Spotify player">
              <CloseIcon />
            </button>
          ) : null}
        </div>
        <div className={`embed-wrap${playlistMode ? " is-playlist" : ""}`}>
          <div className={`spotify-api-slot${playlistMode && !embedReady ? " is-hidden" : ""}`}>
            <div
              ref={embedHostRef}
              className={`music-spotify-embed${embedReady ? " is-ready" : ""}${embedError ? " has-error" : ""}`}
              aria-label="Spotify embedded player"
            />
          </div>
          {playlistMode && !embedReady && spotifyPlaylistEmbedUrl ? (
            <iframe
              title="Spotify music playlist"
              src={spotifyPlaylistEmbedUrl}
              width="100%"
              height="152"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : null}
          {!playlistMode && activeItem?.spotifyId && (!embedReady || embedError) ? (
            <iframe
              title={`Spotify player for ${activeItem.title}`}
              src={`https://open.spotify.com/embed/track/${activeItem.spotifyId}?utm_source=generator&theme=0`}
              width="100%"
              height="152"
              allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
