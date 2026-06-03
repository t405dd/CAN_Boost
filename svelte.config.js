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
		},
		// Идентификатор сборки (виден в шапке/меню PWA через `version` из $app/environment).
		// Дата-время сборки в UTC, напр. "2026-06-03 15:55 UTC" — по нему опознаём, какая
		// сборка реально загружена на устройстве (ключ для отлова залипшего кэша).
		version: {
			name: process.env.BUILD_VERSION ?? new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
		}
	}
};

export default config;
