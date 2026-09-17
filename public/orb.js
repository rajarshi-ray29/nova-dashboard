/**
 * Production NOVA orb.
 *
 * Variant 4 is the selected renderer: a lightweight orbital particle orb with
 * a circular core, audio reactivity, and animated state changes.
 * Keep this stable entry point so the dashboard and orb test harness can import
 * the selected implementation without knowing which candidate won.
 */
export { createOrb, default } from './orb_v4.js';
