// Lightweight i18n system for Svelte 5 with runes.
// No external dependencies — just reactive locale state + translation dictionaries.

import en from './locales/en';
import ru from './locales/ru';

export type Locale = 'en' | 'ru';
type TranslationKey = keyof typeof en;
type Translations = Record<string, string>;

const locales: Record<Locale, Translations> = { en, ru };

const STORAGE_KEY = 'ms3dash-locale';

function getInitialLocale(): Locale {
	if (typeof window === 'undefined') return 'en';
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved === 'en' || saved === 'ru') return saved;
	// Auto-detect from browser
	const lang = navigator.language.toLowerCase();
	if (lang.startsWith('ru')) return 'ru';
	return 'en';
}

export const i18n = $state({
	locale: getInitialLocale()
});

export function setLocale(locale: Locale) {
	i18n.locale = locale;
	if (typeof window !== 'undefined') {
		localStorage.setItem(STORAGE_KEY, locale);
		document.documentElement.lang = locale;
	}
}

// Set initial lang attribute
if (typeof window !== 'undefined') {
	document.documentElement.lang = getInitialLocale();
}

/**
 * Translate a key. Supports {0}, {1}... placeholders.
 * Usage: t('canRx.loaded', messageCount)  =>  "Loaded 5 messages"
 */
export function t(key: TranslationKey, ...args: (string | number)[]): string {
	const dict = locales[i18n.locale] ?? locales.en;
	let text = dict[key] ?? locales.en[key] ?? key;
	for (let i = 0; i < args.length; i++) {
		text = text.replace(`{${i}}`, String(args[i]));
	}
	return text;
}

export const availableLocales: { code: Locale; label: string }[] = [
	{ code: 'en', label: 'English' },
	{ code: 'ru', label: 'Русский' }
];
