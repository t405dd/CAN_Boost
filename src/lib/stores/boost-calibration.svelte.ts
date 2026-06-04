// Глобальное состояние автокалибровки буста, переживающее переходы между страницами PWA.
// Базлайн = снимок Ki/Kp/Kd/BIAS на старте калибровки; подсветка «дельт обучения» на /boost
// рисуется как (текущее − базлайн). Раньше базлайн жил в компоненте /boost и терялся при уходе
// со страницы → по возвращении подсветка считалась заново (с момента возврата). Теперь хранится
// здесь и переживает размонтирование страницы. Сбрасывается: на старте новой калибровки,
// на Save/Discard и централизованно на разрыве связи (resetHydration → clearCalBaselines).

export type HlKey = 'ki' | 'kp' | 'kd' | 'bias';

// null → базлайна нет → подсветка для этой таблицы не рисуется.
export const calBaseline = $state<Record<HlKey, number[][] | null>>({
	ki: null,
	kp: null,
	kd: null,
	bias: null
});

/** Снять базлайн таблицы (глубокая копия текущих значений). */
export function snapCalBaseline(key: HlKey, data: number[][]): void {
	calBaseline[key] = data.map((r) => (r ? r.slice() : []));
}

/** Есть ли снятый базлайн для таблицы. */
export function hasCalBaseline(key: HlKey): boolean {
	return calBaseline[key] !== null;
}

/** Сбросить все базлайны (подсветка пропадает). */
export function clearCalBaselines(): void {
	calBaseline.ki = null;
	calBaseline.kp = null;
	calBaseline.kd = null;
	calBaseline.bias = null;
}
