import { HOLD_MUSIC_TRACKS } from 'virtual:hold-music-tracks';

export interface HoldMusicTrackOption {
  id: string;
  label: string;
  url: string;
  originalUrl: string;
}

export function getHoldMusicTracks(): readonly string[] {
  return HOLD_MUSIC_TRACKS;
}

export function getHoldMusicTrackOptions(): HoldMusicTrackOption[] {
  return HOLD_MUSIC_TRACKS.map((track) => ({
    id: track,
    label: holdMusicTrackLabel(track),
    url: processedHoldMusicTrackUrl(track),
    originalUrl: originalHoldMusicTrackUrl(track),
  }));
}

export function holdMusicTrackLabel(track: string): string {
  return track.replace(/\.[^.]+$/, '');
}

export function holdMusicTrackUrl(track: string, effects: boolean): string {
  return effects ? processedHoldMusicTrackUrl(track) : originalHoldMusicTrackUrl(track);
}

export function processedHoldMusicTrackUrl(track: string): string {
  return `/music/${encodeURIComponent(track)}`;
}

export function originalHoldMusicTrackUrl(track: string): string {
  return `/music-original/${encodeURIComponent(track)}`;
}
