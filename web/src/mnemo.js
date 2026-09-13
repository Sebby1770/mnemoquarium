/* Bridge to the aquarium's genetics. web/engine.js is loaded as a classic
   script before these modules and parks its exports on globalThis, so the game
   and the 2D lab grow their fish from exactly the same rules. */

const E = globalThis.MnemoEngine;

if (!E) {
  throw new Error(
    "mnemoquarium engine missing: load engine.js as a classic script before the game modules",
  );
}

export const {
  DEFAULT_PHRASE,
  EXPRESSED_MASK,
  Rng,
  World,
  fnv,
  genomeTraits,
  inheritGenome,
  makeSpecies,
  pointMutation,
  traitsLabel,
  wordsFromPhrase,
} = E;
