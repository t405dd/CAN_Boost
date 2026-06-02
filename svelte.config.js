import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: 'index.html',
			precompress: false,
			strict: true
		}),
		// На GitHub Pages (project-сайт) приложение живёт в подкаталоге /<repo>/.
		// BASE_PATH задаётся в CI; локально/при пустом значении — корень.
		paths: {
			base: process.env.BASE_PATH ?? ''
		}
	}
};

export default config;
