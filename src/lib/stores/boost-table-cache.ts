// Кэш последних загруженных с устройства boost-таблиц (localStorage). Идея: при открытии страницы
// показываем НЕ голые дефолты, а «прошлую» карту, что реально была на контроллере — затемнённой
// (признак «данные пока не подтверждены устройством»). Когда таблица догрузится по BLE, она
// заменяется свежей и перестаёт быть затемнённой. Кэш обновляется при каждой успешной загрузке.

// v3: Kp/Kd перешли в display-единицы (×100, MS3-числа) + в learn-таблицы добавлена auth.
// Бамп префикса инвалидирует старый кэш (эффективные единицы / без auth), иначе при первом
// открытии мелькнули бы значения /100 или упал бы рендер таблицы authority без поля auth.
const PREFIX = 'canboost.tbl.v3.';

export function loadCachedTable<T>(key: string): T | null {
	if (typeof localStorage === 'undefined') return null; // SSR / недоступно
	try {
		const raw = localStorage.getItem(PREFIX + key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

export function saveCachedTable(key: string, value: unknown): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(PREFIX + key, JSON.stringify(value));
	} catch {
		/* переполнение квоты / приватный режим — не критично, просто не кэшируем */
	}
}
