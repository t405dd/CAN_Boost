// Deliberately empty. Tailwind runs through @tailwindcss/vite (vite.config.ts),
// not PostCSS. Without a local config Vite's search walks UP the monorepo and
// finds the Next site's postcss.config.mjs at the repo root, whose plugins are
// not installed here — this file stops that search at the package boundary.
export default { plugins: [] };
