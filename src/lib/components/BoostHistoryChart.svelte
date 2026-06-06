<script lang="ts">
	// Expandable live chart over the in-memory boost history (boost-history store).
	// Series: RPM / MAP / target / boost / bias / TPS / CO1 + derivatives RPMdot /
	// MAPdot / TPSdot. Same-unit pairs share a fixed axis (MAP↔TGT, boost↔bias) so
	// they stay directly comparable; derivatives use auto-scaled symmetric axes.
	// A colored regulator-state band runs along the bottom.
	//
	// Touch-first: drag to scroll time, pinch / wheel to zoom, tap to drop a slice
	// cursor (vertical line + exact values at that instant in the legend). Tap a
	// legend chip to toggle a series (choice persisted).
	import { histState, getHistory, toggleChart, type HistSample } from '$lib/stores/boost-history.svelte';
	import { boostSettings } from '$lib/stores/boost-settings.svelte';
	import { t } from '$lib/i18n/index.svelte';

	type SeriesKey =
		| 'rpm' | 'map' | 'target' | 'boost' | 'bias' | 'tps' | 'co1'
		| 'rpmdot' | 'mapdot' | 'tpsdot';
	type AxisKey = 'kpa' | 'pct' | 'rpm' | 'tps' | 'rpmdot' | 'mapdot' | 'tpsdot';
	interface Series { key: SeriesKey; label: string; color: string; axis: AxisKey; }

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
		tpsdot: { kind: 'auto', sym: true } // dTPS/dt
	};

	const SERIES: Series[] = [
		{ key: 'map',    label: 'MAP',    color: '#00d4ff', axis: 'kpa' },
		{ key: 'target', label: 'TGT',    color: '#ffd400', axis: 'kpa' },
		{ key: 'boost',  label: 'BOOST',  color: '#00ff88', axis: 'pct' },
		{ key: 'bias',   label: 'BIAS',   color: '#ff6b35', axis: 'pct' },
		{ key: 'rpm',    label: 'RPM',    color: '#9ca3af', axis: 'rpm' },
		{ key: 'tps',    label: 'TPS',    color: '#c084fc', axis: 'tps' },
		{ key: 'co1',    label: 'CO1',    color: '#f472b6', axis: 'pct' },
		{ key: 'rpmdot', label: 'RPMdot', color: '#60a5fa', axis: 'rpmdot' },
		{ key: 'mapdot', label: 'MAPdot', color: '#2dd4bf', axis: 'mapdot' },
		{ key: 'tpsdot', label: 'TPSdot', color: '#e879f9', axis: 'tpsdot' }
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

	// Видимость серий. Основные — вкл; CO1 и производные — выкл по умолчанию (чтобы не
	// загромождать), пользователь включает тапом по чипу легенды. Выбор персистится.
	const ENABLED_KEY = 'canboost.chart.enabled';
	function defaultEnabled(): Record<SeriesKey, boolean> {
		return {
			map: true, target: true, boost: true, bias: true, rpm: true, tps: true,
			co1: false, rpmdot: false, mapdot: false, tpsdot: false
		};
	}
	function loadEnabled(): Record<SeriesKey, boolean> {
		const def = defaultEnabled();
		if (typeof localStorage === 'undefined') return def;
		try {
			const raw = localStorage.getItem(ENABLED_KEY);
			if (raw) return { ...def, ...JSON.parse(raw) };
		} catch {}
		return def;
	}
	let enabled = $state<Record<SeriesKey, boolean>>(loadEnabled());
	function toggleSeries(k: SeriesKey) {
		enabled[k] = !enabled[k];
		try { localStorage.setItem(ENABLED_KEY, JSON.stringify(enabled)); } catch {}
	}

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
		for (const ser of SERIES) enabled[ser.key]; // and on any series toggle
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

		// Resolve per-axis ranges: fixed → as-is; auto → scan visible enabled series.
		const resolved = {} as Record<AxisKey, { min: number; max: number }>;
		const autoAcc = {} as Partial<Record<AxisKey, { min: number; max: number }>>;
		for (const k of Object.keys(AXES) as AxisKey[]) {
			const spec = AXES[k];
			if (spec.kind === 'fixed') resolved[k] = { min: spec.min, max: spec.max };
			else autoAcc[k] = { min: Infinity, max: -Infinity };
		}
		for (let i = iStart; i < iEnd; i++) {
			const d = s[i];
			for (const ser of SERIES) {
				const acc = autoAcc[ser.axis];
				if (!acc || !enabled[ser.key]) continue;
				const v = d[ser.key];
				if (Number.isFinite(v)) { if (v < acc.min) acc.min = v; if (v > acc.max) acc.max = v; }
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
		const yFor = (v: number, axis: AxisKey) => {
			const a = resolved[axis];
			return plotB - ((v - a.min) / (a.max - a.min || 1)) * plotH;
		};

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
		for (const ser of SERIES) {
			if (!enabled[ser.key]) continue;
			ctx.strokeStyle = ser.color;
			ctx.beginPath();
			let pen = false;
			for (let i = iStart; i < iEnd; i++) {
				const v = s[i][ser.key];
				if (!Number.isFinite(v)) { pen = false; continue; }
				const x = tx(s[i].t), y = yFor(v, ser.axis);
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
				for (const ser of SERIES) {
					if (!enabled[ser.key]) continue;
					const v = s[ci][ser.key];
					if (!Number.isFinite(v)) continue;
					ctx.fillStyle = ser.color;
					ctx.beginPath();
					ctx.arc(cx, yFor(v, ser.axis), 2.6, 0, Math.PI * 2);
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

	<!-- Legend / per-series readout — тап по чипу включает/выключает серию (выбор сохраняется).
	     Залитый кружок = вкл, контур + зачёркнуто = выкл. -->
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 font-mono text-[11px] border-t border-[var(--color-dash-border)]/40">
		{#each SERIES as ser (ser.key)}
			<button onclick={() => toggleSeries(ser.key)}
				class="flex items-center gap-1 transition-opacity {enabled[ser.key] ? '' : 'opacity-45'}">
				<span class="w-2.5 h-2.5 rounded-full"
					style="background:{enabled[ser.key] ? ser.color : 'transparent'}; box-shadow: inset 0 0 0 1.5px {ser.color}"></span>
				<span class="text-[var(--color-dash-text-dim)] {enabled[ser.key] ? '' : 'line-through'}">{ser.label}</span>
				<span class="tabular-nums font-bold" style="color:{ser.color}">{fmtVal(readSample?.[ser.key])}</span>
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
