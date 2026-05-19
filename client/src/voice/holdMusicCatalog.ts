import { HOLD_MUSIC_TRACKS } from 'virtual:hold-music-tracks';
import type { MusicVolumeLevel } from '../storage';

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

export function holdMusicTrackUrl(
  track: string,
  effects: boolean,
  volumeLevel: MusicVolumeLevel = 'medium',
): string {
  return effects ? processedHoldMusicTrackUrl(track, volumeLevel) : originalHoldMusicTrackUrl(track, volumeLevel);
}

export function processedHoldMusicTrackUrl(
  track: string,
  volumeLevel: MusicVolumeLevel = 'medium',
): string {
  return `/music${holdMusicVolumeLevelPathSuffix(volumeLevel)}/${encodeURIComponent(track)}`;
}

export function originalHoldMusicTrackUrl(
  track: string,
  volumeLevel: MusicVolumeLevel = 'medium',
): string {
  return `/music-original${holdMusicVolumeLevelPathSuffix(volumeLevel)}/${encodeURIComponent(track)}`;
}

function holdMusicVolumeLevelPathSuffix(volumeLevel: MusicVolumeLevel): string {
  if (volumeLevel === 'low') return '-low';
  if (volumeLevel === 'high') return '-high';
  return '';
}
