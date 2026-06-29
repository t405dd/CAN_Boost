<script lang="ts">
	import { onDestroy } from 'svelte';
	import { flip } from 'svelte/animate';
	import { bleState, connect, connectScanAll } from '$lib/stores/ble-connection.svelte';
	import { liveData, getDashParamList } from '$lib/stores/live-data.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { dashPrefs, severityOf, alarmStateOf, setOrder } from '$lib/stores/dash-prefs.svelte';
	import { setAlarm } from '$lib/utils/alarm-sound';
	import ParamWarningModal from '$lib/components/ParamWarningModal.svelte';

	let params = $derived(getDashParamList());
	let byType = $derived(new Map(params.map((p) => [p.paramType, p])));
	let isConnected = $derived(bleState.status === 'connected');
	let dataRate = $derived(
		liveData.lastPacketTime > 0
			? `${liveData.packetsReceived} pkts | seq ${liveData.sequence}`
			: t('common.noData')
	);

	function formatValue(value: number): string {
		if (Number.isInteger(value)) return value.toString();
		if (Math.abs(value) >= 100) return value.toFixed(1);
		if (Math.abs(value) >= 10) return value.toFixed(2);
		return value.toFixed(3);
	}

	// --- Порядок плашек: сохранённый порядок впереди, новые параметры — в естественном хвосте ---
	function orderedTypes(): number[] {
		const present = params.map((p) => p.paramType);
		const presentSet = new Set(present);
		const head = dashPrefs.order.filter((pt) => presentSet.has(pt));
		const headSet = new Set(head);
		const tail = present.filter((pt) => !headSet.has(pt));
		return [...head, ...tail];
	}

	// --- Drag-to-sort долгим нажатием ---
	const LONG_PRESS_MS = 400;
	const MOVE_CANCEL = 10; // px — больше = считаем скроллом, отменяем long-press
	const DOUBLE_TAP_MS = 300;

	let dragging = $state(false);
	let dragList = $state<number[]>([]); // рабочая копия порядка во время перетаскивания
	let dragType = $state<number | null>(null); // плашка под пальцем
	let gridEl = $state<HTMLDivElement>();

	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let startX = 0;
	let startY = 0;
	let moved = false;
	let activePt: number | null = null;
	let lastTapTime = 0;
	let lastTapPt: number | null = null;

	// Настройки порогов
	let settingsOpen = $state(false);
	let settingsPt = $state(0);

	let displayTypes = $derived(dragging ? dragList : orderedTypes());

	function tileByPoint(x: number, y: number): number | null {
		const el = document.elementFromPoint(x, y);
		const tile = (el as Element | null)?.closest('[data-pt]') as HTMLElement | null;
		const v = tile?.getAttribute('data-pt');
		return v == null ? null : Number(v);
	}

	function startDrag(pt: number) {
		dragList = orderedTypes();
		dragType = pt;
		dragging = true;
		navigator.vibrate?.(15);
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		const pt = tileByPoint(e.clientX, e.clientY);
		if (pt == null) return;
		activePt = pt;
		moved = false;
		startX = e.clientX;
		startY = e.clientY;
		if (pressTimer) clearTimeout(pressTimer);
		pressTimer = setTimeout(() => {
			pressTimer = null;
			startDrag(pt);
			try {
				(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
			} catch {
				/* capture не обязателен */
			}
		}, LONG_PRESS_MS);
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) {
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			if (Math.abs(dx) > MOVE_CANCEL || Math.abs(dy) > MOVE_CANCEL) {
				moved = true;
				if (pressTimer) {
					clearTimeout(pressTimer);
					pressTimer = null;
				}
			}
			return;
		}
		e.preventDefault();
		const overPt = tileByPoint(e.clientX, e.clientY);
		if (overPt == null || dragType == null || overPt === dragType) return;
		const from = dragList.indexOf(dragType);
		const to = dragList.indexOf(overPt);
		if (from < 0 || to < 0) return;
		const next = dragList.slice();
		next.splice(from, 1);
		next.splice(to, 0, dragType);
		dragList = next;
	}

	function endDrag(commit: boolean) {
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
		if (dragging) {
			if (commit) setOrder(dragList.slice());
			dragging = false;
			dragType = null;
		}
	}

	function onPointerUp() {
		if (dragging) {
			endDrag(true);
			activePt = null;
			return;
		}
		if (pressTimer) {
			clearTimeout(pressTimer);
			pressTimer = null;
		}
		const pt = activePt;
		activePt = null;
		if (moved || pt == null) return;
		// Тап / двойной тап (двойной → настройки порогов)
		const now = Date.now();
		if (lastTapPt === pt && now - lastTapTime < DOUBLE_TAP_MS) {
			lastTapTime = 0;
			lastTapPt = null;
			settingsPt = pt;
			settingsOpen = true;
		} else {
			lastTapTime = now;
			lastTapPt = pt;
		}
	}

	function onPointerCancel() {
		endDrag(false);
		activePt = null;
	}

	// #rgb / #rrggbb → rgba() с заданной прозрачностью (для фона плашки).
	function hexToRgba(hex: string, alpha: number): string {
		let h = hex.replace('#', '');
		if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
		const n = parseInt(h, 16);
		if (Number.isNaN(n) || h.length !== 6) return hex;
		const r = (n >> 16) & 255;
		const g = (n >> 8) & 255;
		const b = n & 255;
		return `rgba(${r},${g},${b},${alpha})`;
	}

	// --- Звуковая тревога: бипаем, пока хоть один параметр со звуком за порогом ---
	$effect(() => {
		if (!isConnected) {
			setAlarm(null);
			return;
		}
		let level: 'warn' | 'danger' | null = null;
		for (const p of params) {
			if (!p.online) continue; // не бипать на устаревшем значении
			const w = dashPrefs.warnings[p.paramType];
			if (!w || !w.sound) continue;
			const sev = severityOf(p.paramType, p.value);
			if (sev === 'danger') {
				level = 'danger';
				break;
			}
			if (sev === 'warn') level = 'warn';
		}
		setAlarm(level);
	});

	onDestroy(() => setAlarm(null));

	// Пока идёт перетаскивание — глушим прокрутку страницы. touch-action менять посреди жеста
	// поздно (браузер уже застолбил тач под скролл при touchstart), поэтому вешаем НЕ-passive
	// touchmove и зовём preventDefault: только так pointermove продолжает приходить и reorder
	// работает, а не уезжает страница под пальцем.
	$effect(() => {
		const el = gridEl;
		if (!el) return;
		const block = (e: TouchEvent) => {
			if (dragging) e.preventDefault();
		};
		el.addEventListener('touchmove', block, { passive: false });
		return () => el.removeEventListener('touchmove', block);
	});
</script>

<div class="space-y-3">
	<!-- Status bar -->
	<div class="flex items-center justify-between text-xs text-[var(--color-dash-text-dim)]">
		<span>{t('live.title')}</span>
		<span>{dataRate}</span>
	</div>

	{#if !bleState.supported}
		<div class="p-6 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-danger)]/30 text-center">
			<p class="text-[var(--color-dash-danger)] font-bold mb-2">{t('ble.notSupported')}</p>
			<p class="text-sm text-[var(--color-dash-text-dim)]">{t('ble.notSupportedHint')}</p>
		</div>
	{:else}
		<!-- Connection state -->
		{#if !isConnected}
			{#if params.length === 0}
				<!-- Нет ни live-, ни сохранённых плашек → крупный экран подключения -->
				<div class="flex flex-col items-center justify-center gap-4 py-16">
					{#if bleState.status === 'connecting' || bleState.status === 'reconnecting'}
						<div class="w-16 h-16 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></div>
						<p class="text-[var(--color-dash-warn)] text-sm font-bold">
							{bleState.status === 'connecting' ? t('ble.connectingBtn') : t('ble.reconnectingBtn')}
						</p>
						{#if bleState.statusStep !== 'idle'}
							<p class="text-[var(--color-dash-text-dim)] text-xs">
								{#if bleState.statusDetail}
									{t(`ble.step.${bleState.statusStep}` as any, bleState.statusDetail)}
								{:else}
									{t(`ble.step.${bleState.statusStep}` as any)}
								{/if}
							</p>
						{/if}
					{:else}
						<div class="w-16 h-16 rounded-full bg-[var(--color-dash-card)] border-2 border-[var(--color-dash-border)] flex items-center justify-center">
							<svg class="w-8 h-8 text-[var(--color-dash-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
								<path d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
							</svg>
						</div>
						<p class="text-[var(--color-dash-text-dim)] text-sm">{t('ble.connectPrompt')}</p>
						<button onclick={() => connect()}
							class="px-6 py-3 rounded-lg bg-[var(--color-dash-accent)] text-black font-bold text-sm
								hover:bg-[var(--color-dash-accent)]/80 active:scale-95 transition-all">
							{t('ble.connect')}
						</button>
						<button onclick={() => connectScanAll()}
							class="px-4 py-2 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] text-xs
								hover:border-[var(--color-dash-accent)]/50 active:scale-95 transition-all">
							{t('ble.scanAll')}
						</button>
					{/if}
					{#if bleState.lastError}
						<p class="text-[var(--color-dash-warn)] text-xs text-center max-w-xs">{bleState.lastError}</p>
					{/if}
				</div>
			{:else}
				<!-- Есть сохранённые плашки → компактная панель, сетка показывается ниже (офлайн-настройка) -->
				<div class="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
					<div class="flex items-center gap-2 min-w-0">
						{#if bleState.status === 'connecting' || bleState.status === 'reconnecting'}
							<div class="w-4 h-4 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin shrink-0"></div>
							<span class="text-xs text-[var(--color-dash-warn)] truncate">
								{bleState.status === 'connecting' ? t('ble.connectingBtn') : t('ble.reconnectingBtn')}
							</span>
						{:else}
							<span class="w-2 h-2 rounded-full bg-[var(--color-dash-muted)] shrink-0"></span>
							<span class="text-xs text-[var(--color-dash-text-dim)] truncate">{t('live.offlineConfig')}</span>
						{/if}
					</div>
					{#if bleState.status !== 'connecting' && bleState.status !== 'reconnecting'}
						<button onclick={() => connect()}
							class="px-3 py-1.5 rounded-lg bg-[var(--color-dash-accent)] text-black font-bold text-xs
								hover:bg-[var(--color-dash-accent)]/80 active:scale-95 transition-all shrink-0">
							{t('ble.connect')}
						</button>
					{/if}
				</div>
				{#if bleState.lastError}
					<p class="text-[var(--color-dash-warn)] text-xs text-center max-w-xs mx-auto">{bleState.lastError}</p>
				{/if}
			{/if}
		{/if}

		<!-- Parameter grid (live + сохранённые офлайн-плашки) -->
		{#if params.length > 0}
			<p class="text-[11px] text-[var(--color-dash-text-dim)] text-center -mt-1">{t('live.hint')}</p>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				bind:this={gridEl}
				class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 no-select"
				style="touch-action:{dragging ? 'none' : 'auto'}"
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerCancel}
			>
				{#each displayTypes as pt (pt)}
					{@const param = byType.get(pt)}
					{@const al = param?.online ? alarmStateOf(pt, param.value) : null}
					<div
						data-pt={pt}
						animate:flip={{ duration: 220 }}
						class="p-2.5 rounded-lg border transition-colors
							{al?.color ? '' : 'bg-[var(--color-dash-card)] border-[var(--color-dash-border)]/50 hover:border-[var(--color-dash-accent)]/30'}
							{al?.level === 'danger' ? 'animate-pulse' : ''}
							{dragging && dragType === pt ? 'ring-2 ring-[var(--color-dash-accent)] scale-105 shadow-lg shadow-black/40 z-10 opacity-90' : ''}"
						style={al?.color ? `background-color:${hexToRgba(al.color, 0.28)};border-color:${al.color}` : ''}
					>
						<div class="text-sm font-semibold text-[var(--color-dash-text-dim)] tracking-wide truncate mb-1">
							{param?.name ?? ''}
						</div>
						<div class="text-2xl font-bold text-[var(--color-dash-text)] tabular-nums leading-tight {param?.online ? '' : 'opacity-50'}">
							{param ? formatValue(param.value) : ''}
						</div>
					</div>
				{/each}
			</div>
		{:else if isConnected}
			<div class="text-center py-8 text-[var(--color-dash-text-dim)] text-sm">
				{t('live.waitingForData')}
			</div>
		{/if}
	{/if}
</div>

<ParamWarningModal
	open={settingsOpen}
	paramType={settingsPt}
	paramName={byType.get(settingsPt)?.name ?? ''}
	value={byType.get(settingsPt)?.online ? byType.get(settingsPt)?.value : undefined}
	onclose={() => (settingsOpen = false)}
/>
