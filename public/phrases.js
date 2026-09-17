// NOVA — spoken filler phrases (spec §9.4).
//
// Single source of truth, imported by both the browser (public/speech.js plays them) and the
// server (server.js pre-synthesizes them into the TTS cache at boot, so the first "On it."
// after a restart is instant instead of a ~2.5 s round trip through Hermes).
//
// Rules for anything added here:
//   • Short — under ~1.5 s spoken, or it delays the real answer.
//   • Honest — never promise progress Nova cannot know about ("almost done" is a lie).
//   • Plain words only — no markdown, digits or emoji; they go straight to the TTS engine.

/** Spoken the instant a voice command is heard, so a slow answer never starts with silence. */
export const ACK_PHRASES = [
  'On it.',
  'Sure thing.',
  'Got it.',
  'Let me check.',
  'One moment.',
  'Okay, looking into that.',
];

/** Spoken when Nova starts using a tool — it is about to be busy for a while. */
export const TOOL_PHRASES = [
  'Let me look that up.',
  'Checking on that now.',
  'Pulling that up.',
];

/**
 * Spoken the instant a request is routed down the deep lane: real work is starting and the first
 * words of the answer are seconds away, so she says so at once instead of waiting for them.
 */
export const DEEP_PHRASES = [
  'Let me look into that.',
  'Leave it with me.',
  'Right away.',
  'I will dig into that.',
];

/** Spoken periodically while a long answer is still being generated. */
export const WORKING_PHRASES = [
  'Still working on that.',
  'Still going, bear with me.',
  'Give me another moment.',
  'Still on it.',
];

/** Spoken when the user cuts in with the wake word — she stops and hands the floor back. */
export const INTERRUPT_PHRASES = ['Yes?', 'Go ahead.', 'I am listening.'];

/** Spoken when the user explicitly ends the conversation ("goodbye", "go to sleep"). */
export const SIGNOFF_PHRASES = ['Okay.', 'Sure, I am here when you need me.'];

/** Every phrase the TTS cache should hold warm. */
export const ALL_PHRASES = Object.freeze([
  ...ACK_PHRASES,
  ...TOOL_PHRASES,
  ...DEEP_PHRASES,
  ...WORKING_PHRASES,
  ...INTERRUPT_PHRASES,
  ...SIGNOFF_PHRASES,
]);

/**
 * Pick a phrase at random, avoiding the previous choice so repeated fillers do not sound like
 * a stuck recording. `recent` is a mutable Map the caller keeps between calls.
 */
export function pickPhrase(list, recent = null, key = 'default') {
  if (!Array.isArray(list) || !list.length) return '';
  if (list.length === 1) return list[0];
  const last = recent ? recent.get(key) : null;
  let choice = list[Math.floor(Math.random() * list.length)];
  for (let i = 0; i < 4 && choice === last; i++) choice = list[Math.floor(Math.random() * list.length)];
  if (recent) recent.set(key, choice);
  return choice;
}
