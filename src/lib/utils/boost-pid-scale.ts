// MS3-style отображение коэффициентов ПИД буста.
//
// Прошивка хранит и считает ЭФФЕКТИВНЫЕ коэффициенты: Kp = %duty на 1 кПа ошибки
// (P-член = Kp·error, выход 0..100%). В таком масштабе рабочий Kp ≈ 0.1, что неудобно
// и непривычно после MS3, где те же по смыслу настройки исчисляются десятками.
//
// Поэтому весь UI работает в «MS3-числах» = эффективное ×100 (Kp 0.10 → 10). Конвертация
// живёт ТОЛЬКО на границе BLE-ввода/вывода (здесь), так что страница, таблицы, градиенты,
// подсветка и дефолты целиком в display-единицах, а прошивка/LittleFS — в эффективных.
// Менять масштаб — только эта константа (и дефолты BOOST_DEFAULT_K* в прошивке).
export const BOOST_PID_DISPLAY_SCALE = 100;

// Поля BoostControllerSettings, которые суть коэффициенты усиления (масштабируем).
// Скорости обучения (learnKpRate/learnKdRate) и пороги — НЕ коэффициенты, не трогаем.
const PID_GAIN_KEYS = ['kp', 'ki', 'kd', 'kpMin', 'kpMax', 'kdMin', 'kdMax'] as const;

function scaleSettings<T>(s: T, factor: number): T {
	const out = { ...s } as Record<string, unknown>;
	for (const k of PID_GAIN_KEYS) {
		if (typeof out[k] === 'number') out[k] = (out[k] as number) * factor;
	}
	return out as T;
}

/** Прочитано с устройства (эффективные) → display (×100). Возвращает новый объект. */
export function settingsToDisplay<T>(s: T): T {
	return scaleSettings(s, BOOST_PID_DISPLAY_SCALE);
}

/** display → на устройство (÷100). Принимать СНИМОК (не $state), чтобы не мутировать живое. */
export function settingsToDevice<T>(s: T): T {
	return scaleSettings(s, 1 / BOOST_PID_DISPLAY_SCALE);
}

/** Ячейки таблицы Kp/Kd: эффективные → display (×100). Новый 2D-массив. */
export function gridToDisplay(data: number[][]): number[][] {
	return data.map((row) => row.map((v) => v * BOOST_PID_DISPLAY_SCALE));
}

/** Ячейки таблицы Kp/Kd: display → на устройство (÷100). Новый 2D-массив. */
export function gridToDevice(data: number[][]): number[][] {
	return data.map((row) => row.map((v) => v / BOOST_PID_DISPLAY_SCALE));
}
