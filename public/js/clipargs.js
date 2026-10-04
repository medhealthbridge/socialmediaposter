/**
 * The shapes a clip can be made in, and the ffmpeg recipe for one clip.
 *
 * Kept apart from clip.js — which needs a browser — so these can be unit tested.
 */
export const SHAPES = [
  { id: '9:16', label: 'Vertical 9:16', w: 1080, h: 1920, hint: 'TikTok, Reels, Shorts' },
  { id: '1:1', label: 'Square 1:1', w: 1080, h: 1080, hint: 'Instagram feed' },
  { id: '4:5', label: 'Portrait 4:5', w: 1080, h: 1350, hint: 'Instagram feed' },
  { id: 'keep', label: 'Keep original shape', w: 0, h: 0, hint: '' },
];

/** The longest clip we will make in the browser, in seconds. */
export const MAX_SECONDS = 600;

/** 0:07.5 — short enough to sit next to the player without wrapping. */
export const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 10))}`;

/** The ffmpeg arguments for one clip. */
export function clipArgs({ start, end, shape, mute }) {
  const args = ['-ss', start.toFixed(2), '-to', end.toFixed(2), '-i', 'in.mp4'];
  const s = SHAPES.find((x) => x.id === shape);
  if (s && s.id !== 'keep') {
    // Fill the frame, then crop whatever overflows, so there are never black bars.
    args.push('-vf', `scale=${s.w}:${s.h}:force_original_aspect_ratio=increase,crop=${s.w}:${s.h},setsar=1`);
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  args.push(...(mute ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k']));
  args.push('-movflags', '+faststart', 'out.mp4');
  return args;
}
