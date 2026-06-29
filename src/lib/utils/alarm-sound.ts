// Звуковой сигнал тревоги через Web Audio (без аудиофайлов — синтез на лету).
// Повторяется, пока активен уровень; danger звучит чаще и выше warn.
// AudioContext создаётся лениво и резюмируется при первом вызове (после жеста пользователя
// он уже разблокирован — на главный экран попадают через кнопку «Подключить»).

type Level = 'warn' | 'danger';

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let currentLevel: Level | null = null;

function ensureCtx(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (!ctx) {
		try {
			const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
			if (!Ctor) return null;
			ctx = new Ctor();
		} catch {
			return null;
		}
	}
	if (ctx.state === 'suspended') ctx.resume().catch(() => {});
	return ctx;
}

function beep(level: Level) {
	const c = ensureCtx();
	if (!c) return;
	const osc = c.createOscillator();
	const gain = c.createGain();
	osc.type = 'square';
	osc.frequency.value = level === 'danger' ? 1200 : 760;
	osc.connect(gain);
	gain.connect(c.destination);
	const now = c.currentTime;
	const dur = level === 'danger' ? 0.12 : 0.1;
	gain.gain.setValueAtTime(0.0001, now);
	gain.gain.exponentialRampToValueAtTime(0.22, now + 0.012);
	gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
	osc.start(now);
	osc.stop(now + dur + 0.02);
}

/** Задать активный уровень тревоги (null — тишина). Идемпотентно: повторный тот же уровень — no-op. */
export function setAlarm(level: Level | null) {
	if (level === currentLevel) return;
	currentLevel = level;
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	if (!level) return;
	beep(level);
	const period = level === 'danger' ? 500 : 1100;
	timer = setInterval(() => beep(level), period);
}
