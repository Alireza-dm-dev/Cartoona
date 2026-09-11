/**
 * Test stub for Next.js's `server-only` marker package.
 *
 * `server-only` exists to make a build fail when a server module is pulled into
 * a Client Component; it has no runtime behaviour and is not resolvable outside
 * the Next build. Aliasing it to this empty module lets unit tests import the
 * real server-side resolution code without weakening that boundary in the app -
 * `next build` still enforces it.
 */
export {};
