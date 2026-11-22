// Post-build: dist/index.html → dist/app.html.
// Vercel serves static files before rewrites, so while dist/index.html
// exists "/" never reaches api/seo.js. The shell is kept as app.html,
// which api/seo.js fetches as its template.
import { renameSync, existsSync } from "node:fs";

if (existsSync("dist/index.html")) {
  renameSync("dist/index.html", "dist/app.html");
  console.log("dist/index.html → dist/app.html");
} else if (!existsSync("dist/app.html")) {
  console.error("rename-index: dist/index.html not found");
  process.exit(1);
}
