// Electrobun re-exports `three` and `@babylonjs/core` from electrobun/bun.
// We don't use them, but tsc still needs declarations to resolve the imports.
declare module "three";
declare module "@babylonjs/core";
