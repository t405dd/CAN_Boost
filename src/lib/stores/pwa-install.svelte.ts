// Отслеживание возможности установки PWA и режима запуска.
// Кнопку «Установить» показываем только в браузере (с сайта), когда установка доступна,
// и прячем, когда приложение уже запущено как установленное (standalone).
import { browser } from '$app/environment';

// Событие beforeinstallprompt не входит в стандартные типы DOM — опишем минимально.
interface BeforeInstallPromptEvent extends Event {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

function detectStandalone(): boolean {
	if (!browser) return false;
	return (
		window.matchMedia?.('(display-mode: standalone)').matches ||
		// iOS Safari/Bluefy
		(navigator as unknown as { standalone?: boolean }).standalone === true
	);
}

function detectIos(): boolean {
	if (!browser) return false;
	return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export const pwa = $state({
	canInstall: false,   // браузер предложил установку (Chromium) и ещё не установлено
	standalone: detectStandalone(), // уже запущено как установленное приложение
	isIos: detectIos()   // iOS — установка только вручную (Bluefy / «На экран Домой»)
});

if (browser) {
	window.addEventListener('beforeinstallprompt', (e: Event) => {
		e.preventDefault(); // не показывать стандартную мини-плашку — используем свою кнопку
		deferredPrompt = e as BeforeInstallPromptEvent;
		pwa.canInstall = true;
	});

	window.addEventListener('appinstalled', () => {
		pwa.canInstall = false;
		pwa.standalone = true;
		deferredPrompt = null;
	});
}

/** Запустить системный диалог установки (по нажатию кнопки). */
export async function promptInstall(): Promise<void> {
	if (!deferredPrompt) return;
	await deferredPrompt.prompt();
	try {
		await deferredPrompt.userChoice;
	} finally {
		deferredPrompt = null;
		pwa.canInstall = false;
	}
}
