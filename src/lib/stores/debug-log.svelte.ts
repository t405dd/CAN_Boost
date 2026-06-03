// Встроенный лог-вьюер: перехватывает console.log/warn/error в кольцевой буфер, который можно
// смотреть прямо на телефоне (страница /logging) и поделиться текстом. Нужен для диагностики BLE
// на Android, где консоль браузера недоступна без подключения к ПК. Оригинальный console.* тоже
// вызывается (в DevTools всё остаётся как было).

export const debugLog = $state({
	lines: [] as string[]
});

const MAX_LINES = 400;
let patched = false;

function fmtArg(a: unknown): string {
	if (typeof a === 'string') return a;
	if (a instanceof Error) return a.message;
	try {
		return JSON.stringify(a);
	} catch {
		return String(a);
	}
}

/** Один раз пропатчить console.*, чтобы дублировать вывод в буфер. Вызывать как можно раньше. */
export function initDebugLog(): void {
	if (patched || typeof window === 'undefined') return;
	patched = true;

	(['log', 'warn', 'error'] as const).forEach((level) => {
		const orig = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			orig(...args);
			try {
				const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
				const tag = level === 'log' ? 'I' : level === 'warn' ? 'W' : 'E';
				debugLog.lines.push(`${ts} ${tag} ${args.map(fmtArg).join(' ')}`);
				if (debugLog.lines.length > MAX_LINES) {
					debugLog.lines.splice(0, debugLog.lines.length - MAX_LINES);
				}
			} catch {
				/* буфер логов никогда не должен ломать приложение */
			}
		};
	});

	console.log('[debug-log] capture started');
}

export function clearDebugLog(): void {
	debugLog.lines = [];
}

export function debugLogText(): string {
	return debugLog.lines.join('\n');
}
