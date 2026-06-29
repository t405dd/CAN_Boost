// Клиентские настройки главного экрана (Live):
//  - произвольный порядок плашек (drag-to-sort долгим нажатием);
//  - пороги предупреждений на параметр (два уровня: warn + danger) → фон плашки меняет цвет;
//  - опциональный звуковой сигнал при выходе параметра за порог.
// Всё хранится только в localStorage — это настройка отображения, прошивка о ней не знает
// (single source of truth не нарушается: значения по-прежнему считает FW, тут лишь раскраска).

export type Severity = 'none' | 'warn' | 'danger';

export interface ParamWarning {
	warnLowEn: boolean;
	warnLow: number;
	warnLowColor: string;
	warnHighEn: boolean;
	warnHigh: number;
	warnHighColor: string;
	dangerLowEn: boolean;
	dangerLow: number;
	dangerLowColor: string;
	dangerHighEn: boolean;
	dangerHigh: number;
	dangerHighColor: string;
	sound: boolean;
}

// Дефолтные цвета: верхние пороги — «горячие» (оранж/красный), «предупреждение ниже» —
// голубой (холодный мотор/низкое давление). Любой можно переопределить в модалке.
export function defaultWarning(): ParamWarning {
	return {
		warnLowEn: false,
		warnLow: 0,
		warnLowColor: '#22d3ee',
		warnHighEn: false,
		warnHigh: 0,
		warnHighColor: '#ff6b35',
		dangerLowEn: false,
		dangerLow: 0,
		dangerLowColor: '#ff0040',
		dangerHighEn: false,
		dangerHigh: 0,
		dangerHighColor: '#ff0040',
		sound: false
	};
}

const STORAGE_KEY = 'dash_prefs_v1';

// order — список paramType в порядке отображения; warnings — пороги по paramType.
export const dashPrefs = $state({
	order: [] as number[],
	warnings: {} as Record<number, ParamWarning>
});

function load() {
	if (typeof window === 'undefined') return;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed.order)) {
			dashPrefs.order = parsed.order.filter((n: unknown) => typeof n === 'number');
		}
		if (parsed.warnings && typeof parsed.warnings === 'object') {
			for (const [k, v] of Object.entries(parsed.warnings)) {
				dashPrefs.warnings[Number(k)] = { ...defaultWarning(), ...(v as object) };
			}
		}
	} catch {
		/* битый json — игнор, поедем с дефолтами */
	}
}

export function saveDashPrefs() {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ order: dashPrefs.order, warnings: dashPrefs.warnings })
		);
	} catch {
		/* квота/приватный режим — не критично */
	}
}

export function setOrder(order: number[]) {
	dashPrefs.order = order;
	saveDashPrefs();
}

export function getWarning(paramType: number): ParamWarning {
	return dashPrefs.warnings[paramType] ?? defaultWarning();
}

/** true, если в конфиге задан хотя бы один порог. */
export function hasWarning(w: ParamWarning): boolean {
	return w.warnLowEn || w.warnHighEn || w.dangerLowEn || w.dangerHighEn;
}

export function setWarning(paramType: number, w: ParamWarning) {
	// Пустой конфиг без звука не храним — чтобы localStorage не пух от «сброшенных» параметров.
	if (!hasWarning(w) && !w.sound) {
		delete dashPrefs.warnings[paramType];
	} else {
		dashPrefs.warnings[paramType] = w;
	}
	saveDashPrefs();
}

export interface AlarmState {
	level: Severity;
	color: string | null; // цвет сработавшего порога (для фона плашки)
}

/** Состояние тревоги по текущему значению: уровень + цвет сработавшего порога.
 *  Приоритет: dangerHigh → dangerLow → warnHigh → warnLow (опасность важнее, high/low
 *  взаимоисключающи). Цвет берётся именно у сработавшего порога — поэтому «ниже» и «выше»
 *  могут быть разными цветами (напр. голубой холодный / оранжевый горячий). */
export function alarmStateOf(paramType: number, value: number): AlarmState {
	const w = dashPrefs.warnings[paramType];
	if (!w) return { level: 'none', color: null };
	if (w.dangerHighEn && value >= w.dangerHigh) return { level: 'danger', color: w.dangerHighColor };
	if (w.dangerLowEn && value <= w.dangerLow) return { level: 'danger', color: w.dangerLowColor };
	if (w.warnHighEn && value >= w.warnHigh) return { level: 'warn', color: w.warnHighColor };
	if (w.warnLowEn && value <= w.warnLow) return { level: 'warn', color: w.warnLowColor };
	return { level: 'none', color: null };
}

/** Уровень тревоги параметра по текущему значению. danger важнее warn. */
export function severityOf(paramType: number, value: number): Severity {
	return alarmStateOf(paramType, value).level;
}

load();
