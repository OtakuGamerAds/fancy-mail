/** The root package.json's version, set by build.mjs. */
declare const __FANCY_MAIL_VERSION__: string;

/** PNGs are embedded into the bundle as bytes (esbuild's binary loader). */
declare module "*.png" {
  const bytes: Uint8Array;
  export default bytes;
}
