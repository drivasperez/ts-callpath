import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Render a self-contained HTML file with the graph data inlined.
 * Reads the visualiser's index.html and dist/bundle.js, injects the data,
 * and inlines the bundle script.
 */
export function renderHtml(graphData: object): string {
  const visualiserDir = path.resolve(__dirname, '..', 'visualiser');
  const indexPath = path.join(visualiserDir, 'index.html');
  const bundlePath = path.join(visualiserDir, 'dist', 'bundle.js');

  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `Visualiser bundle not found at ${bundlePath}.\n` +
        `Run "npm run build:visualiser" in tools/ts-callpath/ first.`
    );
  }

  let html = fs.readFileSync(indexPath, 'utf-8');
  const bundleJs = fs.readFileSync(bundlePath, 'utf-8');

  // Inject graph data before the bundle script.
  // Two escaping concerns for content inside <script> tags:
  //  1. String.replace interprets $' / $& in replacement strings, so use () => fn form
  //  2. The HTML parser closes <script> on any "</script" in the character stream
  //
  // For JSON data: escape all </ → <\/ (safe because \/ is a valid JSON/JS escape for /)
  // For the JS bundle: don't escape — it contains </ inside regexes (e.g. /</g) where
  // adding a backslash would change semantics. The bundle doesn't contain </script.
  const jsonStr = JSON.stringify(graphData).replace(/<\//g, '<\\/');
  const dataScript = `<script>window.GRAPH_DATA = ${jsonStr};</script>`;
  html = html.replace('<!-- INLINE_DATA -->', () => dataScript);

  // Replace external script tag with inline bundle
  html = html.replace(
    '<script src="dist/bundle.js"></script>',
    () => `<script>${bundleJs}</script>`
  );

  return html;
}
