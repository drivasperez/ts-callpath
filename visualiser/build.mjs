import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** Strip Vite-style ?raw suffix so esbuild resolves the bare path.
 *  Required so that vitest and esbuild don't go to war when working out how to bundle
 *  imported css files. Vite/vitest defaults to css module (unless you specify ?raw), esbuild
 *  defaults to raw but doesn't understand '?raw' suffix.
 */
const rawSuffixPlugin = {
  name: "raw-suffix",
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, async (args) => {
      const result = await build.resolve(args.path.replace(/\?raw$/, ""), {
        resolveDir: args.resolveDir,
        kind: args.kind,
      });
      return result;
    });
  },
};

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ["visualiser/src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: "visualiser/dist/bundle.js",
  sourcemap: true,
  loader: { ".css": "text" },
  plugins: [rawSuffixPlugin],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
  console.log("Built visualiser/dist/bundle.js");
}
