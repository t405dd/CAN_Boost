<script lang="ts">
	// Expandable live chart over the in-memory boost history (boost-history store).
	// Curated series: RPM / MAP / target / boost / bias / TPS / CO1, derivatives
	// RPMdot / MAPdot / TPSdot, received signals knock / AFR / AFR target / ignition
	// (resolved by cache-slot label), CLT / MAT. Fixed normalized axes: MAP↔TGT,
	// boost↔bias, AFR↔AFRtgt (10–20), CLT (60–110 °C), MAT (0–60 °C) so lines don't
	// jump while scrolling; derivatives use auto-scaled symmetric axes.
	//
	// Beyond the curated set, ANY configured CAN-receive signal and ANY controller-
	// computed parameter can be added as a "raw" series (value from HistSample.extra,
	// own auto axis). A colored regulator-state band runs along the bottom.
	//
	// Touch-first: drag to scroll time, pinch / wheel to zoom, tap to drop a slice
	// cursor (vertical line + exact values at that instant in the legend). Tap a
	// legend chip to show/hide a series; the «+» fullscreen picker manages WHICH
	// params are in the legend and lets you pin any of them to a fixed min/max axis.
	// All choices persisted.
	import { histState, getHistory, toggleChart, roleSlotEnums, type HistSample } from '$lib/stores/boost-history.svelte';
	import { boostSettings } from '$lib/stores/boost-settings.svelte';
	import { signalLabels } from '$lib/stores/signal-labels.svelte';
	import { PARAM_NAMES, PARAM_CACHE_SLOT_START } from '$lib/ble/protocol';
	import { t } from '$lib/i18n/index.svelte';

	type SeriesKey =
		| 'rpm' | 'map' | 'target' | 'boost' | 'bias' | 'tps' | 'co1'
		| 'rpmdot' | 'mapdot' | 'tpsdot'
		| 'knk' | 'afr' | 'afrTarget' | 'ign'
		| 'cobase' | 'comul1' | 'comul2' | 'comul3'
		| 'clt' | 'mat';
	type AxisKey =
		| 'kpa' | 'pct' | 'rpm' | 'tps' | 'rpmdot' | 'mapdot' | 'tpsdot'
		| 'knk' | 'afr' | 'ign' | 'mul' | 'clt' | 'mat';
	// Группы курируемых серий + две динамические: 'canrx' (все настроенные CAN-сигналы) и
	// 'ctrl' (прочие расчётные параметры контроллера). Их состав строится из signalLabels/PARAM_NAMES.
	type GroupKey = 'boost' | 'engine' | 'deriv' | 'signals' | 'co' | 'temp' | 'canrx' | 'ctrl';
	interface Series { key: SeriesKey; label: string; color: string; axis: AxisKey; group: GroupKey; }
	// Группы для пикера «+» (порядок = порядок секций в оверлее). label — i18n-ключ.
	const GROUPS: { key: GroupKey; label: string }[] = [
		{ key: 'boost',   label: 'chart.grpBoost' },
		{ key: 'engine',  label: 'chart.grpEngine' },
		{ key: 'signals', label: 'chart.grpSignals' },
		{ key: 'co',      label: 'chart.grpCo' },
		{ key: 'temp',    label: 'chart.grpTemp' },
		{ key: 'deriv',   label: 'chart.grpDeriv' },
		{ key: 'canrx',   label: 'chart.grpCanRx' },
		{ key: 'ctrl',    label: 'chart.grpCtrl' }
	];

	// «Сырые» серии — добавляемые произвольные параметры. Значение берётся из HistSample.extra[enum],
	// ось — авто (или override-диапазон из пикера). id = `raw:<enum>` (живёт рядом с курируемыми ключами).
	interface RawSeries { id: string; enum: number; label: string; color: string; group: 'canrx' | 'ctrl'; }
	// Расчётные enum'ы контроллера, не покрытые курируемыми сериями (совпадает с RAW_COMPUTED_ENUMS в истории).
	// 64-66 = вычисляемые каналы OUT2..4 (OUT1 = курируемая серия 'co1').
	const RAW_COMPUTED_ENUMS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 56, 64, 65, 66];
	const RAW_PALETTE = [
		'#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#a855f7', '#14b8a6',
		'#eab308', '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#8b5cf6', '#d946ef', '#0ea5e9'
	];
	const rawColor = (enumVal: number) => RAW_PALETTE[enumVal % RAW_PALETTE.length];

	// Список сырых серий: расчётные (ctrl) + настроенные CAN-слоты (canrx), исключая слоты,
	// уже занятые курируемыми ролями (MAP/RPM/TPS/knk/afr/…), чтобы не дублировать.
	let rawSeries = $derived.by<RawSeries[]>(() => {
		const out: RawSeries[] = [];
		for (const e of RAW_COMPUTED_ENUMS) {
			out.push({ id: `raw:${e}`, enum: e, label: PARAM_NAMES[e] ?? `p${e}`, color: rawColor(e), group: 'ctrl' });
		}
		const taken = roleSlotEnums();
		for (const k of Object.keys(signalLabels)) {
			const slot = Number(k);
			const en = PARAM_CACHE_SLOT_START + slot;
			const info = signalLabels[slot];
			if (!info || !info.label || taken.has(en)) continue;
			out.push({ id: `raw:${en}`, enum: en, label: info.label, color: rawColor(en), group: 'canrx' });
		}
		return out;
	});

	// Axis specs. Основные сигналы — фикс-диапазоны (линии не прыгают при прокрутке,
	// MAP↔TGT и BOOST↔BIAS в одном масштабе). Производные (dRPM/dMAP/dTPS) знаковые с
	// неизвестным размахом → автоскейл, симметрично около нуля.
	type AxisSpec = { kind: 'fixed'; min: number; max: number } | { kind: 'auto'; sym?: boolean };
	const AXES: Record<AxisKey, AxisSpec> = {
		kpa: { kind: 'fixed', min: 0, max: 400 }, // MAP / target MAP
		pct: { kind: 'fixed', min: 0, max: 100 }, // boost / bias / CO1 (duty %)
		rpm: { kind: 'fixed', min: 0, max: 9000 }, // RPM
		tps: { kind: 'fixed', min: 0, max: 100 }, // TPS (throttle %)
		rpmdot: { kind: 'auto', sym: true }, // dRPM/dt
		mapdot: { kind: 'auto', sym: true }, // dMAP/dt
		tpsdot: { kind: 'auto', sym: true }, // dTPS/dt
		knk: { kind: 'auto' }, // детонация (счёт/град)
		afr: { kind: 'fixed', min: 10, max: 20 }, // AFR факт + цель (общая ось — сравнимы)
		ign: { kind: 'auto' }, // угол зажигания, град
		mul: { kind: 'fixed', min: 0, max: 200 }, // COmul1/2/3 (множители %, нейтраль 100; COBase — на оси pct)
		clt: { kind: 'fixed', min: 60, max: 110 }, // CLT (охлаждайка), °C
		mat: { kind: 'fixed', min: 0, max: 60 } // MAT (впуск), °C
	};

	const SERIES: Series[] = [
		{ key: 'map',    label: 'MAP',    color: '#00d4ff', axis: 'kpa', group: 'boost' },
		{ key: 'target', label: 'TGT',    color: '#ffd400', axis: 'kpa', group: 'boost' },
		{ key: 'boost',  label: 'BOOST',  color: '#00ff88', axis: 'pct', group: 'boost' },
		{ key: 'bias',   label: 'BIAS',   color: '#ff6b35', axis: 'pct', group: 'boost' },
		{ key: 'co1',    label: 'TBL1',   color: '#f472b6', axis: 'pct', group: 'boost' },
		{ key: 'rpm',    label: 'RPM',    color: '#9ca3af', axis: 'rpm', group: 'engine' },
		{ key: 'tps',    label: 'TPS',    color: '#c084fc', axis: 'tps', group: 'engine' },
		{ key: 'knk',       label: 'KNK',    color: '#f87171', axis: 'knk', group: 'signals' },
		{ key: 'afr',       label: 'AFR',    color: '#bef264', axis: 'afr', group: 'signals' },
		{ key: 'afrTarget', label: 'AFRtgt', color: '#84cc16', axis: 'afr', group: 'signals' },
		{ key: 'ign',       label: 'IGN',    color: '#818cf8', axis: 'ign', group: 'signals' },
		{ key: 'cobase',    label: 'COBase', color: '#fbbf24', axis: 'pct', group: 'co' },
		{ key: 'comul1',    label: 'COmul1', color: '#fb923c', axis: 'mul', group: 'co' },
		{ key: 'comul2',    label: 'COmul2', color: '#22d3ee', axis: 'mul', group: 'co' },
		{ key: 'comul3',    label: 'COmul3', color: '#a78bfa', axis: 'mul', group: 'co' },
		{ key: 'clt',       label: 'CLT',    color: '#38bdf8', axis: 'clt', group: 'temp' },
		{ key: 'mat',       label: 'MAT',    color: '#fb7185', axis: 'mat', group: 'temp' },
		{ key: 'rpmdot', label: 'RPMdot', color: '#60a5fa', axis: 'rpmdot', group: 'deriv' },
		{ key: 'mapdot', label: 'MAPdot', color: '#2dd4bf', axis: 'mapdot', group: 'deriv' },
		{ key: 'tpsdot', label: 'TPSdot', color: '#e879f9', axis: 'tpsdot', group: 'deriv' }
	];

	// Regulator phase → { i18n key, color } (mirrors CanOutBar's STATES palette).
	const STATES: Record<number, { key: string; color: string }> = {
		0: { key: 'hdr.stOff',       color: '#6b7280' },
		1: { key: 'hdr.stNoMap',     color: '#ff6b35' },
		2: { key: 'hdr.stNoRpm',     color: '#ff6b35' },
		3: { key: 'hdr.stNoTps',     color: '#ff6b35' },
		4: { key: 'hdr.stOverboost', color: '#ff0040' },
		5: { key: 'hdr.stIdle',      color: '#6b7280' },
		6: { key: 'hdr.stSpool',     color: '#00d4ff' },
		7: { key: 'hdr.stPid',       color: '#00ff88' },
		8: { key: 'hdr.stCut',       color: '#ff0040' }
	};

	// Два независимых состояния на серию:
	//   inLegend — серия присутствует чипом в легенде (состав набирается в пикере «+»);
	//   enabled  — линия рисуется (тап по чипу легенды; выкл = чип зачёркнут, но остаётся).
	// Рисуется серия только когда inLegend && enabled. Оба набора персистятся.
	const ENABLED_KEY = 'canboost.chart.enabled';
	const LEGEND_KEY = 'canboost.chart.legend';
	function defaultEnabled(): Record<SeriesKey, boolean> {
		return {
			map: true, target: true, boost: true, bias: true, rpm: true, tps: true,
			co1: false, rpmdot: false, mapdot: false, tpsdot: false,
			knk: false, afr: false, afrTarget: false, ign: false,
			cobase: false, comul1: false, comul2: false, comul3: false,
			clt: false, mat: false
		};
	}
	// Ключи — строковые id (курируемые 'map'… и сырые 'raw:<enum>'), чтобы оба типа жили вместе.
	function loadRecord(key: string, def: Record<string, boolean>): Record<string, boolean> {
		if (typeof localStorage === 'undefined') return def;
		try {
			const raw = localStorage.getItem(key);
			if (raw) return { ...def, ...JSON.parse(raw) };
		} catch {}
		return def;
	}
	let enabled = $state<Record<string, boolean>>(loadRecord(ENABLED_KEY, defaultEnabled()));
	// Дефолт состава легенды = что было видно (старые юзеры мигрируют из enabled-набора).
	let inLegend = $state<Record<string, boolean>>(
		loadRecord(LEGEND_KEY, { ...defaultEnabled(), ...enabled })
	);
	function saveEnabled() { try { localStorage.setItem(ENABLED_KEY, JSON.stringify(enabled)); } catch {} }
	function saveLegend() { try { localStorage.setItem(LEGEND_KEY, JSON.stringify(inLegend)); } catch {} }

	// Per-series override диапазона оси (задаётся в пикере). Если min<max заданы — серия рисуется на
	// собственной фикс-оси [min,max], иначе fallback: курируемая ось AXES или авто для сырых. Персист.
	const AXES_KEY = 'canboost.chart.axes';
	type AxisOv = { min: number | null; max: number | null };
	function loadAxes(): Record<string, AxisOv> {
		if (typeof localStorage === 'undefined') return {};
		try { const raw = localStorage.getItem(AXES_KEY); if (raw) return JSON.parse(raw); } catch {}
		return {};
	}
	let axisOverride = $state<Record<string, AxisOv>>(loadAxes());
	function setAxis(id: string, which: 'min' | 'max', raw: string) {
		const num = raw.trim() === '' ? null : Number(raw);
		const val = num != null && Number.isFinite(num) ? num : null;
		const cur = axisOverride[id] ?? { min: null, max: null };
		const next: AxisOv = { ...cur, [which]: val };
		if (next.min == null && next.max == null) delete axisOverride[id];
		else axisOverride[id] = next;
		try { localStorage.setItem(AXES_KEY, JSON.stringify(axisOverride)); } catch {}
	}
	/** Фикс-диапазон оси из override, если задан корректно (min<max); иначе null. */
	function axisFixed(id: string): { min: number; max: number } | null {
		const o = axisOverride[id];
		if (o && o.min != null && o.max != null && o.min < o.max) return { min: o.min, max: o.max };
		return null;
	}
	/** Действующий по умолчанию диапазон (для placeholder в пикере): курируемая фикс-ось — её min/max;
	 *  авто-оси (производные) и сырые серии — null (показываем «мин»/«макс»). */
	function defaultRange(id: string): { min: number; max: number } | null {
		if (id.startsWith('raw:')) return null;
		const ser = SERIES.find((s) => s.key === id);
		if (!ser) return null;
		const spec = AXES[ser.axis];
		return spec.kind === 'fixed' ? { min: spec.min, max: spec.max } : null;
	}

	// Тап по чипу легенды — показать/скрыть линию (зачёркивание).
	function toggleSeries(id: string) {
		enabled[id] = !enabled[id];
		saveEnabled();
	}
	// Чек в пикере — добавить/убрать серию из легенды. Добавление сразу включает отрисовку.
	function toggleLegend(id: string) {
		inLegend[id] = !inLegend[id];
		if (inLegend[id]) enabled[id] = true;
		saveLegend();
		saveEnabled();
	}

	// Унифицированный дескриптор для легенды/пикера (курируемые + сырые в одном списке).
	interface Item { id: string; label: string; color: string; group: GroupKey; }
	let allItems = $derived<Item[]>([
		...SERIES.map((s) => ({ id: s.key, label: s.label, color: s.color, group: s.group })),
		...rawSeries.map((r) => ({ id: r.id, label: r.label, color: r.color, group: r.group }))
	]);
	/** Значение серии (по id) из сэмпла истории: курируемые — именованное поле, сырые — extra[enum]. */
	function valById(d: HistSample | null | undefined, id: string): number {
		if (!d) return NaN;
		if (id.startsWith('raw:')) return d.extra?.[Number(id.slice(4))] ?? NaN;
		return (d as unknown as Record<string, number>)[id] ?? NaN;
	}

	// Легенда показывает только серии, добавленные через «+». Пикер — полноэкранный оверлей.
	let pickerOpen = $state(false);
	let legendItems = $derived(allItems.filter((i) => inLegend[i.id]));
	let legendCount = $derived(allItems.filter((i) => inLegend[i.id]).length);
	// Секции пикера: курируемые группы из SERIES, динамические (canrx/ctrl) — из rawSeries. Пустые скрыты.
	let pickerGroups = $derived(
		GROUPS.map((g) => ({ key: g.key, label: g.label, items: allItems.filter((i) => i.group === g.key) }))
			.filter((g) => g.items.length > 0)
	);

	let canvas = $state<HTMLCanvasElement | null>(null);
	let cssW = $state(0);
	let cssH = $state(0);

	// Visible time window (ms since session start).
	const SPAN_DEFAULT = 30_000;
	const MIN_SPAN = 1_000;
	let view = $state({ t0: 0, t1: SPAN_DEFAULT });
	let following = $state(true); // auto-track the latest data (live mode)
	let spanMs = SPAN_DEFAULT; // desired follow-window width (plain, not reactive)
	let cursorT = $state<number | null>(null); // slice cursor time, null = none

	const PAD = { l: 6, r: 6, t: 8, b: 22 }; // b leaves room for state band + time labels
	const BAND_H = 7;

	function metrics() {
		return {
			plotL: PAD.l,
			plotW: Math.max(1, cssW - PAD.l - PAD.r),
			plotT: PAD.t,
			plotB: cssH - PAD.b,
			plotH: Math.max(1, cssH - PAD.t - PAD.b)
		};
	}

	function clamp(v: number, lo: number, hi: number): number {
		return v < lo ? lo : v > hi ? hi : v;
	}

	function maxT(): number {
		const s = getHistory();
		return s.length ? s[s.length - 1].t : 0;
	}

	/** First index with s[i].t >= t (binary search; s is sorted by t). */
	function lowerBound(s: HistSample[], time: number): number {
		let lo = 0, hi = s.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (s[m].t < time) lo = m + 1;
			else hi = m;
		}
		return lo;
	}

	function nearestIndex(s: HistSample[], time: number): number {
		if (s.length === 0) return -1;
		const i = lowerBound(s, time);
		if (i <= 0) return 0;
		if (i >= s.length) return s.length - 1;
		return time - s[i - 1].t <= s[i].t - time ? i - 1 : i;
	}

	function xToTime(x: number): number {
		const { plotL, plotW } = metrics();
		const span = view.t1 - view.t0 || 1;
		return clamp(view.t0 + ((x - plotL) / plotW) * span, view.t0, view.t1);
	}

	/** Apply a target [t0,t1], clamping span and edges to the data domain. */
	function setView(t0: number, t1: number, follow?: boolean) {
		const mx = maxT();
		const span = clamp(t1 - t0, MIN_SPAN, Math.max(SPAN_DEFAULT, mx));
		let nt1 = Math.min(t1, mx);
		let nt0 = nt1 - span;
		if (nt0 < 0) { nt0 = 0; nt1 = span; } // hit start → grow rightward (empty area ok)
		view.t0 = nt0;
		view.t1 = nt1;
		spanMs = span;
		following = follow ?? nt1 >= mx - 1;
	}

	function zoomAround(centerT: number, factor: number) {
		const span = view.t1 - view.t0;
		const newSpan = clamp(span * factor, MIN_SPAN, Math.max(SPAN_DEFAULT, maxT()));
		const frac = (centerT - view.t0) / (span || 1);
		setView(centerT - frac * newSpan, centerT - frac * newSpan + newSpan);
	}

	function jumpLive() {
		cursorT = null;
		following = true;
		const mx = maxT();
		const span = spanMs || SPAN_DEFAULT;
		if (mx <= span) { view.t0 = 0; view.t1 = span; }
		else { view.t1 = mx; view.t0 = mx - span; }
	}

	// --- Live follow: re-anchor the window to the newest sample ------------------
	$effect(() => {
		histState.count; // dep: new sample arrived
		if (!following) return;
		const mx = maxT();
		const span = spanMs || SPAN_DEFAULT;
		if (mx <= span) { view.t0 = 0; view.t1 = span; }
		else { view.t1 = mx; view.t0 = mx - span; }
	});

	// --- Slice sample for the readout (cursor, or latest in live mode) -----------
	let readSample = $derived.by<HistSample | null>(() => {
		histState.count; // refresh latest as data streams in
		const s = getHistory();
		if (s.length === 0) return null;
		if (cursorT == null) return s[s.length - 1];
		const i = nearestIndex(s, cursorT);
		return i >= 0 ? s[i] : null;
	});

	// --- Drawing ----------------------------------------------------------------
	$effect(() => {
		histState.count; // redraw on new data
		view.t0; view.t1; cursorT; cssW; cssH; // and on view / cursor / size changes
		// react on any toggle / axis override / raw-series change (signalLabels)
		for (const it of allItems) { enabled[it.id]; inLegend[it.id]; axisOverride[it.id]; }
		draw();
	});

	function niceTimeStep(target: number): number {
		const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600].map((s) => s * 1000);
		for (const s of steps) if (s >= target) return s;
		return steps[steps.length - 1];
	}

	function fmtClock(ms: number): string {
		const total = Math.max(0, Math.round(ms / 1000));
		const m = Math.floor(total / 60);
		const s = total % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	function draw() {
		if (!canvas || cssW === 0 || cssH === 0) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(cssW * dpr);
		canvas.height = Math.round(cssH * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cssW, cssH);

		const { plotL, plotW, plotT, plotB, plotH } = metrics();
		const s = getHistory();
		const t0 = view.t0, t1 = view.t1, span = t1 - t0 || 1;
		const tx = (time: number) => plotL + ((time - t0) / span) * plotW;

		const iStart = Math.max(0, lowerBound(s, t0) - 1);
		const iEnd = Math.min(s.length, lowerBound(s, t1) + 1);

		// --- Активные серии (в легенде и включённые): курируемые + сырые ----------
		const activeCurated = SERIES.filter((ser) => inLegend[ser.key] && enabled[ser.key]);
		const activeRaw = rawSeries.filter((rs) => inLegend[rs.id] && enabled[rs.id]);

		// Resolve курируемых осей: fixed → как есть; auto → скан окна (серии с override-осью не вносим).
		const resolved = {} as Record<AxisKey, { min: number; max: number }>;
		const autoAcc = {} as Partial<Record<AxisKey, { min: number; max: number }>>;
		for (const k of Object.keys(AXES) as AxisKey[]) {
			const spec = AXES[k];
			if (spec.kind === 'fixed') resolved[k] = { min: spec.min, max: spec.max };
			else autoAcc[k] = { min: Infinity, max: -Infinity };
		}
		// Авто-аккумуляторы для сырых серий (каждая на собственной оси), кроме заданных override.
		const rawAcc = new Map<number, { min: number; max: number }>();
		for (const rs of activeRaw) if (!axisFixed(rs.id)) rawAcc.set(rs.enum, { min: Infinity, max: -Infinity });

		for (let i = iStart; i < iEnd; i++) {
			const d = s[i];
			for (const ser of activeCurated) {
				const acc = autoAcc[ser.axis];
				if (!acc || axisFixed(ser.key)) continue;
				const v = d[ser.key];
				if (Number.isFinite(v)) { if (v < acc.min) acc.min = v; if (v > acc.max) acc.max = v; }
			}
			for (const [en, acc] of rawAcc) {
				const v = d.extra?.[en];
				if (v !== undefined && Number.isFinite(v)) { if (v < acc.min) acc.min = v; if (v > acc.max) acc.max = v; }
			}
		}
		for (const k of Object.keys(autoAcc) as AxisKey[]) {
			const acc = autoAcc[k]!;
			const spec = AXES[k] as { kind: 'auto'; sym?: boolean };
			if (!Number.isFinite(acc.min)) { resolved[k] = { min: -1, max: 1 }; continue; }
			if (spec.sym) {
				const m = Math.max(Math.abs(acc.min), Math.abs(acc.max), 1e-6);
				resolved[k] = { min: -m, max: m };
			} else {
				let mn = acc.min, mx = acc.max;
				if (mn === mx) { mn -= 1; mx += 1; }
				resolved[k] = { min: mn, max: mx };
			}
		}
		const rawRange = (en: number): { min: number; max: number } => {
			const acc = rawAcc.get(en);
			if (!acc || !Number.isFinite(acc.min)) return { min: -1, max: 1 };
			let mn = acc.min, mx = acc.max;
			if (mn === mx) { mn -= 1; mx += 1; }
			return { min: mn, max: mx };
		};

		// Единый список к отрисовке. range: override-диапазон → курир.ось/авто. read — геттер значения.
		interface Drawn { color: string; read: (d: HistSample) => number; min: number; max: number; }
		const drawn: Drawn[] = [];
		for (const ser of activeCurated) {
			const r = axisFixed(ser.key) ?? resolved[ser.axis];
			drawn.push({ color: ser.color, read: (d) => d[ser.key], min: r.min, max: r.max });
		}
		for (const rs of activeRaw) {
			const r = axisFixed(rs.id) ?? rawRange(rs.enum);
			drawn.push({ color: rs.color, read: (d) => d.extra?.[rs.enum] ?? NaN, min: r.min, max: r.max });
		}
		const yOf = (v: number, d: Drawn) => plotB - ((v - d.min) / (d.max - d.min || 1)) * plotH;

		// Horizontal grid (thirds).
		ctx.strokeStyle = 'rgba(255,255,255,0.06)';
		ctx.lineWidth = 1;
		for (let g = 0; g <= 4; g++) {
			const y = plotT + (plotH * g) / 4;
			ctx.beginPath();
			ctx.moveTo(plotL, y);
			ctx.lineTo(plotL + plotW, y);
			ctx.stroke();
		}
		// Vertical time grid + labels.
		const step = niceTimeStep(span / 5);
		ctx.fillStyle = '#9ca3af';
		ctx.font = '9px ui-monospace, monospace';
		ctx.textBaseline = 'top';
		const first = Math.ceil(t0 / step) * step;
		for (let tk = first; tk <= t1; tk += step) {
			const x = tx(tk);
			ctx.strokeStyle = 'rgba(255,255,255,0.06)';
			ctx.beginPath();
			ctx.moveTo(x, plotT);
			ctx.lineTo(x, plotB);
			ctx.stroke();
			const label = fmtClock(tk);
			const tw = ctx.measureText(label).width;
			ctx.fillText(label, clamp(x - tw / 2, plotL, plotL + plotW - tw), plotB + BAND_H + 3);
		}

		// Regulator-state band (runs of equal state).
		const bandY = plotB + 2;
		let runStart = -1, runState = NaN;
		const flushRun = (endIdx: number) => {
			if (runStart < 0) return;
			const st = STATES[Math.round(runState)];
			if (st && Number.isFinite(runState)) {
				const x0 = tx(s[runStart].t);
				const x1 = tx(s[Math.min(endIdx, iEnd - 1)].t);
				ctx.fillStyle = st.color;
				ctx.globalAlpha = 0.55;
				ctx.fillRect(x0, bandY, Math.max(1, x1 - x0), BAND_H);
				ctx.globalAlpha = 1;
			}
		};
		for (let i = iStart; i < iEnd; i++) {
			const st = s[i].state;
			if (st !== runState) { flushRun(i); runStart = i; runState = st; }
		}
		flushRun(iEnd - 1);

		// Series polylines (break on NaN).
		ctx.lineWidth = 1.6;
		ctx.lineJoin = 'round';
		for (const ds of drawn) {
			ctx.strokeStyle = ds.color;
			ctx.beginPath();
			let pen = false;
			for (let i = iStart; i < iEnd; i++) {
				const v = ds.read(s[i]);
				if (!Number.isFinite(v)) { pen = false; continue; }
				const x = tx(s[i].t), y = yOf(v, ds);
				if (pen) ctx.lineTo(x, y);
				else { ctx.moveTo(x, y); pen = true; }
			}
			ctx.stroke();
		}

		// Slice cursor + value dots.
		if (cursorT != null && cursorT >= t0 && cursorT <= t1) {
			const cx = tx(cursorT);
			ctx.strokeStyle = 'rgba(229,231,235,0.7)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(cx, plotT);
			ctx.lineTo(cx, plotB);
			ctx.stroke();
			const ci = nearestIndex(s, cursorT);
			if (ci >= 0) {
				for (const ds of drawn) {
					const v = ds.read(s[ci]);
					if (!Number.isFinite(v)) continue;
					ctx.fillStyle = ds.color;
					ctx.beginPath();
					ctx.arc(cx, yOf(v, ds), 2.6, 0, Math.PI * 2);
					ctx.fill();
				}
			}
		}
	}

	// --- Pointer interaction (pan / pinch / tap) --------------------------------
	const pointers = new Map<number, { x: number; y: number }>();
	let mode: 'none' | 'pan' | 'pinch' = 'none';
	let panStartX = 0, panT0 = 0, panT1 = 0, moved = 0;
	let pinchDist0 = 0, pinchSpan0 = 0, pinchCenterT = 0, pinchCenterFrac = 0;

	function localX(e: PointerEvent): number {
		const r = (canvas as HTMLCanvasElement).getBoundingClientRect();
		return e.clientX - r.left;
	}

	function onPointerDown(e: PointerEvent) {
		(canvas as HTMLCanvasElement).setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 1) {
			mode = 'pan';
			panStartX = localX(e);
			panT0 = view.t0;
			panT1 = view.t1;
			moved = 0;
		} else if (pointers.size === 2) {
			mode = 'pinch';
			const pts = [...pointers.values()];
			pinchDist0 = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
			pinchSpan0 = view.t1 - view.t0;
			const r = (canvas as HTMLCanvasElement).getBoundingClientRect();
			const midX = (pts[0].x + pts[1].x) / 2 - r.left;
			pinchCenterT = xToTime(midX);
			pinchCenterFrac = (midX - PAD.l) / metrics().plotW;
		}
	}

	function onPointerMove(e: PointerEvent) {
		if (!pointers.has(e.pointerId)) return;
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (mode === 'pan' && pointers.size === 1) {
			const x = localX(e);
			const dx = x - panStartX;
			moved = Math.max(moved, Math.abs(dx));
			const span = panT1 - panT0;
			const dt = (dx / metrics().plotW) * span;
			setView(panT0 - dt, panT1 - dt);
		} else if (mode === 'pinch' && pointers.size === 2) {
			const pts = [...pointers.values()];
			const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
			const newSpan = clamp(pinchSpan0 * (pinchDist0 / dist), MIN_SPAN, Math.max(SPAN_DEFAULT, maxT()));
			const nt0 = pinchCenterT - pinchCenterFrac * newSpan;
			setView(nt0, nt0 + newSpan);
		}
	}

	function onPointerUp(e: PointerEvent) {
		const wasTap = mode === 'pan' && moved < 6;
		pointers.delete(e.pointerId);
		try { (canvas as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch {}
		if (wasTap) {
			// Tap → drop slice cursor and freeze follow so the cursor doesn't scroll away.
			cursorT = xToTime(localX(e));
			following = false;
		}
		mode = pointers.size === 2 ? 'pinch' : pointers.size === 1 ? 'pan' : 'none';
		if (pointers.size === 1) { // one finger lifted from a pinch — resume panning
			const [p] = pointers.values();
			const r = (canvas as HTMLCanvasElement).getBoundingClientRect();
			panStartX = p.x - r.left;
			panT0 = view.t0;
			panT1 = view.t1;
			moved = 0;
		}
	}

	function onWheel(e: WheelEvent) {
		e.preventDefault();
		const r = (canvas as HTMLCanvasElement).getBoundingClientRect();
		zoomAround(xToTime(e.clientX - r.left), e.deltaY > 0 ? 1.2 : 1 / 1.2);
	}

	// --- Readout helpers --------------------------------------------------------
	function fmtVal(v: number | undefined): string {
		if (v === undefined || !Number.isFinite(v)) return '—';
		return Number.isInteger(v) ? String(v) : v.toFixed(1);
	}

	let stateInfo = $derived.by(() => {
		const st = readSample?.state;
		if (st === undefined || !Number.isFinite(st)) return null;
		const code = Math.round(st);
		const base = STATES[code];
		if (!base) return null;
		// «Только BIAS»: фаза 7 внутренне PID, но P/I/D отключены — показываем BIAS.
		const key = code === 7 && boostSettings.value.biasOnly ? 'hdr.stBias' : base.key;
		return { color: base.color, key };
	});
</script>

<div class="shrink-0 bg-[var(--color-dash-card)] border-b border-[var(--color-dash-border)]">
	<!-- Title row: live indicator + close -->
	<div class="flex items-center gap-2 px-3 py-1 border-b border-[var(--color-dash-border)]/40">
		<span class="text-[10px] uppercase tracking-wider text-[var(--color-dash-text-dim)]">{t('chart.title')}</span>
		{#if following}
			<span class="flex items-center gap-1 text-[9px] font-bold uppercase text-[var(--color-dash-success)]">
				<span class="w-1.5 h-1.5 rounded-full bg-[var(--color-dash-success)] animate-pulse"></span>{t('chart.live')}
			</span>
		{:else}
			<button onclick={jumpLive}
				class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25">
				{t('chart.toLive')}
			</button>
		{/if}
		<span class="ml-auto text-[9px] font-mono text-[var(--color-dash-text-dim)]">
			{cursorT != null ? fmtClock(readSample?.t ?? 0) : ''}
		</span>
		<button onclick={toggleChart} aria-label="Close chart"
			class="w-6 h-6 flex items-center justify-center text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)]">
			<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12" /></svg>
		</button>
	</div>

	<!-- Canvas -->
	<div class="relative w-full" style="height: clamp(160px, 38vh, 320px);"
		bind:clientWidth={cssW} bind:clientHeight={cssH}>
		<canvas bind:this={canvas}
			class="absolute inset-0 w-full h-full"
			style="touch-action: none;"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			onwheel={onWheel}></canvas>
		{#if histState.count === 0}
			<div class="absolute inset-0 flex items-center justify-center text-xs text-[var(--color-dash-text-dim)] pointer-events-none">
				{t('chart.waiting')}
			</div>
		{/if}
	</div>

	<!-- Legend / per-series readout — состав легенды набирается в пикере «+» (inLegend); тап по
	     чипу включает/выключает ОТРИСОВКУ линии (enabled), выключенный остаётся, но зачёркнут.
	     Залитый кружок = рисуется, контур + зачёркнуто = скрыт. Крупная зона тапа + touch-manipulation. -->
	<div class="flex flex-wrap items-center gap-1 px-2 py-1.5 font-mono text-[11px] border-t border-[var(--color-dash-border)]/40 select-none">
		<button type="button" onclick={() => (pickerOpen = true)}
			title={t('chart.pickSeries')}
			class="flex items-center gap-1 px-1.5 py-1 rounded touch-manipulation cursor-pointer text-[var(--color-dash-text-dim)]
				transition-colors active:bg-[var(--color-dash-card-hover)] hover:bg-[var(--color-dash-card-hover)]/60 hover:text-[var(--color-dash-accent)]">
			<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				<path stroke-linecap="round" d="M12 5v14M5 12h14" />
			</svg>
		</button>
		{#each legendItems as item (item.id)}
			<button type="button" onclick={() => toggleSeries(item.id)}
				aria-pressed={enabled[item.id]}
				class="flex items-center gap-1 px-1.5 py-1 rounded touch-manipulation cursor-pointer
					transition-colors active:bg-[var(--color-dash-card-hover)] hover:bg-[var(--color-dash-card-hover)]/60
					{enabled[item.id] ? '' : 'opacity-45'}">
				<span class="w-2.5 h-2.5 rounded-full shrink-0"
					style="background:{enabled[item.id] ? item.color : 'transparent'}; box-shadow: inset 0 0 0 1.5px {item.color}"></span>
				<span class="text-[var(--color-dash-text-dim)] {enabled[item.id] ? '' : 'line-through'}">{item.label}</span>
				{#if enabled[item.id]}<span class="tabular-nums font-bold" style="color:{item.color}">{fmtVal(valById(readSample, item.id))}</span>{/if}
			</button>
		{/each}
		{#if stateInfo}
			<span class="flex items-center gap-1 ml-auto px-1.5 py-0.5 rounded uppercase font-bold tracking-wide"
				style="color:{stateInfo.color}; background-color: color-mix(in srgb, {stateInfo.color} 14%, transparent);">
				{t(stateInfo.key as any)}
			</span>
		{/if}
	</div>
</div>

<!-- Полноэкранный пикер состава легенды (открывается по «+»). Чек = серия в легенде (и сразу
     рисуется); снятие чека — убрать чип из легенды совсем. Крупные строки под палец. -->
{#if pickerOpen}
	<div class="fixed inset-0 z-50 flex flex-col bg-[var(--color-dash-bg)]/97 backdrop-blur-sm"
		role="dialog" aria-modal="true">
		<div class="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-dash-border)] shrink-0">
			<span class="text-sm font-bold uppercase tracking-wider text-[var(--color-dash-text)]">{t('chart.pickTitle')}</span>
			<span class="text-[11px] font-mono text-[var(--color-dash-text-dim)] tabular-nums">{legendCount}</span>
			<button type="button" onclick={() => (pickerOpen = false)}
				class="ml-auto px-4 py-1.5 rounded-lg bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] text-sm font-bold uppercase tracking-wide
					touch-manipulation active:bg-[var(--color-dash-accent)]/30">
				{t('chart.done')}
			</button>
		</div>
		<p class="px-4 py-2 text-[11px] leading-snug text-[var(--color-dash-text-dim)] shrink-0">{t('chart.pickHint')}</p>
		<div class="flex-1 overflow-y-auto px-2 pb-8">
			{#each pickerGroups as grp (grp.key)}
				<div class="mt-3 mb-1 px-2 text-[10px] uppercase tracking-wider text-[var(--color-dash-text-dim)]">{t(grp.label as any)}</div>
				{#each grp.items as item (item.id)}
					<div class="w-full flex items-center gap-2 px-2 rounded-lg {inLegend[item.id] ? 'bg-[var(--color-dash-card-hover)]/25' : ''}">
						<button type="button" onclick={() => toggleLegend(item.id)}
							aria-pressed={inLegend[item.id]}
							class="flex items-center gap-3 flex-1 min-w-0 text-left py-2.5 touch-manipulation">
							<span class="w-5 h-5 rounded flex items-center justify-center shrink-0 border-2 transition-colors"
								style="border-color:{inLegend[item.id] ? item.color : 'var(--color-dash-border)'}; background:{inLegend[item.id] ? item.color : 'transparent'}">
								{#if inLegend[item.id]}
									<svg class="w-3.5 h-3.5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3">
										<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
									</svg>
								{/if}
							</span>
							<span class="w-3 h-3 rounded-full shrink-0" style="background:{item.color}"></span>
							<span class="font-mono text-sm text-[var(--color-dash-text)] truncate">{item.label}</span>
						</button>
						<!-- Диапазон оси: оба поля заданы (min<max) → серия на собственной фикс-оси; иначе авто/курируемая. -->
						<div class="flex items-center gap-1 shrink-0">
							<input type="number" inputmode="decimal" placeholder={String(defaultRange(item.id)?.min ?? t('chart.axisMin'))}
								value={axisOverride[item.id]?.min ?? ''}
								onchange={(e) => setAxis(item.id, 'min', e.currentTarget.value)}
								class="w-12 px-1 py-1 rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]
									text-[var(--color-dash-text)] text-[11px] font-mono text-center focus:outline-none focus:border-[var(--color-dash-accent)]" />
							<span class="text-[var(--color-dash-text-dim)] text-[10px]">–</span>
							<input type="number" inputmode="decimal" placeholder={String(defaultRange(item.id)?.max ?? t('chart.axisMax'))}
								value={axisOverride[item.id]?.max ?? ''}
								onchange={(e) => setAxis(item.id, 'max', e.currentTarget.value)}
								class="w-12 px-1 py-1 rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]
									text-[var(--color-dash-text)] text-[11px] font-mono text-center focus:outline-none focus:border-[var(--color-dash-accent)]" />
						</div>
					</div>
				{/each}
			{/each}
		</div>
	</div>
{/if}
