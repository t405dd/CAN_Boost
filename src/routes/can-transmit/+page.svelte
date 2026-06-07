<script lang="ts">
	import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_CAN_CONFIG, CHR_CAN_OUT_TABLES, CHR_CAN_OUT_SETTINGS } from '$lib/ble/uuids';
	import type { CanOutTable, FirmwareCanOutTable, Co1Settings } from '$lib/types/config';
	import { firmwareToCanOutTable, canOutTableToFirmware } from '$lib/utils/can-out-adapter';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import TableEditor from '$lib/components/TableEditor.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, pwaNameToEnum } from '$lib/utils/param-mapping';
	import { PARAM_CACHE_SLOT_START, PARAM_CO_BASE, PARAM_CO_MUL_1, PARAM_CO_MUL_2, PARAM_CO_MUL_3 } from '$lib/ble/protocol';
	import { liveData } from '$lib/stores/live-data.svelte';
	import { getParamDisplayName, getParamShortName, signalLabels } from '$lib/stores/signal-labels.svelte';
	import { co1Config, loadCo1Config, defaultCo1Settings } from '$lib/stores/co1-settings.svelte';

	const TABLE_LABELS_KEYS = ['canTx.t1base', 'canTx.t2mul1', 'canTx.t3mul2', 'canTx.t4mul3'] as const;
	const TABLE_IDS = ['T1_Base', 'T2_Multiplier1', 'T3_Multiplier2', 'T4_Multiplier3'];
	const MAX_SIZE = 16;

	// Gradient bounds per table type
	const GRADIENT_BOUNDS: [number, number][] = [
		[0, 100],    // T1 Base: duty 0-100%
		[50, 150],   // T2 Multiplier: 50-150%
		[50, 150],   // T3 Trim: 50-150%
		[50, 150],   // T4 Trim: 50-150%
	];

	let tables = $state<CanOutTable[]>(createDefaultTables());
	let tablesLoaded = $state(false);   // прочитаны ли таблицы с устройства → затемняем редактор до прихода данных
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let activeSection = $state<string | null>(null);   // аккордеон: открыта одна секция за раз (как на бусте)

	// --- CO1 Bus Settings (источник истины — общий стор co1Config, грузится в hydrate() на коннекте) ---
	let co1Settings = $state<Co1Settings>(defaultCo1Settings());   // редактируемая копия (синхронит $effect ниже)
	// Прочитаны ли настройки CO1 с устройства — пока false, не показываем дефолты (0x269 и т.п.) как реальные.
	let co1Loaded = $derived(co1Config.loaded);
	let co1CanIdHex = $state('269');

	let isConnected = $derived(bleState.status === 'connected');

	// Cache-слоты занимают enum [15..54]; системные параметры — < 15 и >= 55 (вкл. производные).
	const isCacheSlot = (enumVal: number) =>
		enumVal >= PARAM_CACHE_SLOT_START && enumVal < PARAM_CACHE_SLOT_START + 40;
	// Опции селектов осей: системные параметры (вкл. RPMdot/MAPdot/TPSdot) + ТОЛЬКО замапленные
	// cache-слоты (с подписью), чтобы не показывать пустые cache0…cache39. Значение — pwaName.
	let paramOptions = $derived(
		allParamEntries().filter(p =>
			!isCacheSlot(p.enumVal) || signalLabels[p.enumVal - PARAM_CACHE_SLOT_START] !== undefined
		)
	);
	// Понятные имена производных (оси): pwa-имена → дружелюбные RPMdot/MAPdot/TPSdot.
	const AXIS_FRIENDLY_PWA: Record<string, string> = {
		boost_drpm: 'RPMdot', map_dot: 'MAPdot', tps_dot: 'TPSdot'
	};
	const axisOptionLabel = (pwaName: string) => AXIS_FRIENDLY_PWA[pwaName] ?? getParamDisplayName(pwaName);
	const axisShortLabel = (pwaName: string) => AXIS_FRIENDLY_PWA[pwaName] ?? getParamShortName(pwaName);

	// Live cursor: текущее значение двигателя по pwaName параметра оси.
	function getLiveValue(pwaName: string): number | undefined {
		if (!pwaName) return undefined;
		const enumVal = pwaNameToEnum(pwaName);
		if (enumVal === 0) return undefined; // NONE
		const param = liveData.params[enumVal];
		return param?.value;
	}

	// Результат таблицы, ТРАНСЛИРУЕМЫЙ ИЗ КОНТРОЛЛЕРА (единый источник правды): то, что реально
	// применяется к CO1. T1→COBase, T2/T3/T4→COmul1/2/3. Показываем над таблицей вместо
	// браузерного пересчёта — иначе число врёт, если на устройстве лежит другая таблица/мёртвая ось.
	const TABLE_RESULT_PARAM = [PARAM_CO_BASE, PARAM_CO_MUL_1, PARAM_CO_MUL_2, PARAM_CO_MUL_3];
	function getFirmwareTableResult(idx: number): number | undefined {
		return liveData.params[TABLE_RESULT_PARAM[idx]]?.value;
	}

	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	function createDefaultTable(idx: number): CanOutTable {
		return {
			tableIdBase: TABLE_IDS[idx],
			xAxisParamType: '',
			yAxisParamType: '',
			numCols: 1,
			numRows: 1,
			hasYAxis: false,
			isEnabled: false,
			xAxisValues: Array(16).fill(0),
			yAxisValues: Array(16).fill(0),
			tableData: Array.from({ length: 16 }, () => Array(16).fill(0))
		};
	}

	function createDefaultTables(): CanOutTable[] {
		return TABLE_IDS.map((_, i) => createDefaultTable(i));
	}

	// Низкоуровневое чтение таблиц с устройства (без управления UI-флагами — это делают вызывающие).
	async function fetchTables() {
		const rawData = await readJsonConfig<FirmwareCanOutTable[]>(SVC_CAN_CONFIG, CHR_CAN_OUT_TABLES);
		if (rawData && rawData.length > 0) {
			for (let i = 0; i < 4; i++) {
				if (rawData[i]) tables[i] = firmwareToCanOutTable(rawData[i]);
			}
		}
		tablesLoaded = true;
	}

	async function saveTables() {
		saving = true;
		try {
			const fwTables = tables.map(canOutTableToFirmware);
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_CAN_OUT_TABLES, fwTables);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function saveCo1Settings() {
		saving = true;
		try {
			co1Settings.canId = parseInt(co1CanIdHex, 16) || 0x269;
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_CAN_OUT_SETTINGS, co1Settings);
			if (ok) co1Config.value = $state.snapshot(co1Settings);   // стор = то, что на устройстве
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	// --- «Восстановить из Flash»: перечитать секцию с устройства, затерев несохранённые правки. ---
	async function restoreFromFlash(loadFn: () => Promise<unknown>) {
		loading = true;
		statusMsg = '';
		try {
			await loadFn();
			showStatus(t('common.restoredFromFlash'));
		} catch (e) {
			showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			loading = false;
		}
	}
	const restoreCo1 = () => restoreFromFlash(loadCo1Config);
	const restoreTables = () => restoreFromFlash(fetchTables);

	// Изменение размерности через встроенные кнопки +/- TableEditor (как на странице буста).
	// 1D/2D определяется числом строк: rows=1 → 1D, rows>=2 → 2D (hasYAxis выводим отсюда).
	// tableData держим padded до 16×16 — адаптер режет по cols/rows при сохранении.
	function onResize(idx: number, rows: number, cols: number) {
		const tbl = tables[idx];
		tbl.numCols = Math.max(1, Math.min(MAX_SIZE, cols));
		tbl.numRows = Math.max(1, Math.min(MAX_SIZE, rows));
		tbl.hasYAxis = tbl.numRows > 1;
	}

	function onDataChange(idx: number, newData: number[][]) {
		tables[idx].tableData = newData;
	}

	function onAxisChange(idx: number, axis: 'x' | 'y', values: number[]) {
		if (axis === 'x') tables[idx].xAxisValues = values;
		else tables[idx].yAxisValues = values;
	}

	function toggleSection(id: string) {
		activeSection = activeSection === id ? null : id;
	}

	// --- Auto-load on connect ---
	let initialLoadDone = $state(false);

	$effect(() => {
		if (isConnected && !initialLoadDone) {
			initialLoadDone = true;
			// Настройки CO1 обычно грузит централизованный hydrate() (см. +layout); здесь фолбэк
			// (если стор ещё не загружен). Плюс таблицы CAN-выхода (большой конфиг, нужен лишь тут).
			if (!co1Config.loaded) loadCo1Config();
			loading = true;
			fetchTables().catch((e) => showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message)).finally(() => { loading = false; });
		}
		if (!isConnected) {
			initialLoadDone = false;
			tablesLoaded = false;
		}
	});

	// Синхронизация редактируемой копии CO1 из общего стора (грузится в hydrate()). Клонируем при
	// каждом успешном чтении (epoch++); также обновляем hex-поле CAN ID.
	let lastCo1Epoch = 0;
	$effect(() => {
		const e = co1Config.epoch;
		if (e !== lastCo1Epoch) {
			lastCo1Epoch = e;
			co1Settings = $state.snapshot(co1Config.value) as Co1Settings;
			co1CanIdHex = co1Config.value.canId.toString(16).toUpperCase();
		}
	});
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('canTx.title')}</div>

	{#if bleState.status !== 'connected'}
		<ConnectPrompt />
	{:else}
		<!-- Сниппет «Восстановить из Flash»: ставится рядом с каждой кнопкой «Сохранить на устройство»
		     (inline-block → встают в ряд). Перечитывает секцию с устройства, затирая правки. -->
		{#snippet restoreBtn(onRestore: () => void)}
			<button onclick={onRestore} disabled={saving || loading}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] hover:bg-[var(--color-dash-border)]/60 transition-colors disabled:opacity-40">
				{loading ? t('common.loading') : t('common.restoreFromFlash')}
			</button>
		{/snippet}

		<!-- Action bar (статус + индикатор загрузки) -->
		<div class="flex items-center gap-2 flex-wrap empty:hidden">
			{#if loading}
				<span class="text-xs text-[var(--color-dash-accent)] inline-flex items-center gap-1.5">
					<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
					{t('common.loading')}
				</span>
			{/if}
			{#if statusMsg}
				<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>
			{/if}
		</div>

		<!-- Настройки шины CO1 (аккордеон) -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('co1')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
					{t('canTx.co1Settings')}<HelpTip key="help.canTx.co1Settings" />
					{#if !co1Loaded}
						<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin" title={t('common.readingDevice')}></span>
					{:else if co1Settings.enabled}
						<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>
					{/if}
				</span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'co1' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'co1'}
				<div class="px-3 pb-3 space-y-3">
					{#if !co1Loaded}
						<div class="flex items-center gap-2 text-[11px] text-[var(--color-dash-text-dim)] py-2">
							<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
							{t('common.readingDevice')}
						</div>
					{:else}
					<div class="flex items-center justify-between">
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={co1Settings.enabled} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('canTx.co1Enabled')}<HelpTip key="help.canTx.co1Enabled" /></span>
						</label>
						<button onclick={saveCo1Settings} disabled={saving}
							class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
							{saving ? t('common.saving') : t('common.saveToDevice')}
						</button>
						{@render restoreBtn(restoreCo1)}
					</div>

					<div class="flex items-center gap-3 flex-wrap {co1Settings.enabled ? '' : 'opacity-40 pointer-events-none'}">
						<!-- CAN ID -->
						<div class="flex items-center gap-1.5">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.canId')}<HelpTip key="help.canTx.canId" /></span>
							<button onclick={() => { const v = (parseInt(co1CanIdHex, 16) || 0) - 1; if (v >= 0) co1CanIdHex = v.toString(16).toUpperCase(); }}
								class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">&minus;</button>
							<span class="text-xs text-[var(--color-dash-text-dim)]">0x</span>
							<input type="text" bind:value={co1CanIdHex} maxlength="8"
								class="w-20 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono uppercase focus:border-[var(--color-dash-accent)] focus:outline-none" />
							<button onclick={() => { const v = (parseInt(co1CanIdHex, 16) || 0) + 1; if (v <= 0x1FFFFFFF) co1CanIdHex = v.toString(16).toUpperCase(); }}
								class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">+</button>
							<span class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">= {parseInt(co1CanIdHex, 16) || 0} dec</span>
						</div>
						<!-- Byte offset -->
						<label class="flex items-center gap-1.5">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.canByteOffset')}<HelpTip key="help.canTx.canByteOffset" /></span>
							<input type="number" min="0" max="6" bind:value={co1Settings.canByteOffset}
								class="w-14 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<!-- Big-endian -->
						<label class="flex items-center gap-1.5 cursor-pointer pb-0.5">
							<input type="checkbox" bind:checked={co1Settings.canBigEndian} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('canTx.canBigEndian')}<HelpTip key="help.canTx.canBigEndian" /></span>
						</label>
						<!-- Send interval -->
						<label class="flex items-center gap-1.5">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.canInterval')}<HelpTip key="help.canTx.canInterval" /></span>
							<input type="number" min="10" max="1000" step="10" bind:value={co1Settings.canSendIntervalMs}
								class="w-20 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
					</div>
					{/if}
				</div>
			{/if}
		</section>

		<!-- Таблицы CAN выхода: по аккордеон-секции на таблицу (T1…T4). -->
		{#each tables as table, idx}
			<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
				<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('t' + idx)}>
					<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
						{t(TABLE_LABELS_KEYS[idx])}
						{#if table.isEnabled}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
					</span>
					<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 't' + idx ? '−' : '+'}</span>
				</button>
				{#if activeSection === 't' + idx}
					<div class="px-3 pb-3 space-y-2">
						<!-- Включение таблицы + параметры осей (инлайн-селекты, как на бусте) -->
						<div class="flex items-end gap-3 flex-wrap">
							<label class="flex items-center gap-1.5 cursor-pointer pb-1">
								<input type="checkbox" bind:checked={table.isEnabled} class="accent-[var(--color-dash-accent)]" />
								<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('common.enabled')}<HelpTip key="help.canTx.enable" /></span>
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.xParam')}<HelpTip key="help.canTx.xParam" /></span>
								<select bind:value={table.xAxisParamType}
									class="block w-40 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none">
									<option value="">—</option>
									{#each paramOptions as p}
										<option value={p.pwaName}>{axisOptionLabel(p.pwaName)}</option>
									{/each}
								</select>
							</label>
							{#if table.hasYAxis}
								<label class="space-y-1">
									<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.yParam')}<HelpTip key="help.canTx.yParam" /></span>
									<select bind:value={table.yAxisParamType}
										class="block w-40 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none">
										<option value="">—</option>
										{#each paramOptions as p}
											<option value={p.pwaName}>{axisOptionLabel(p.pwaName)}</option>
										{/each}
									</select>
								</label>
							{/if}
						</div>

						<!-- Table Editor -->
						<TableEditor
							data={table.tableData}
							dimmed={!tablesLoaded}
							xAxisValues={table.xAxisValues}
							yAxisValues={table.yAxisValues}
							numCols={table.numCols}
							numRows={table.numRows}
							colorGradient={true}
							gradientMin={GRADIENT_BOUNDS[idx][0]}
							gradientMax={GRADIENT_BOUNDS[idx][1]}
							xAxisLabel={table.xAxisParamType ? axisShortLabel(table.xAxisParamType) : undefined}
							yAxisLabel={table.yAxisParamType ? axisShortLabel(table.yAxisParamType) : undefined}
							liveCursorX={getLiveValue(table.xAxisParamType)}
							liveCursorY={table.hasYAxis ? getLiveValue(table.yAxisParamType) : undefined}
							liveResult={getFirmwareTableResult(idx)}
							resizable={true}
							minCols={1}
							onResize={(r, c) => onResize(idx, r, c)}
							onDataChange={(d) => onDataChange(idx, d)}
							onAxisChange={(a, v) => onAxisChange(idx, a, v)}
						/>

						<button onclick={saveTables} disabled={saving}
							class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
							{saving ? t('common.saving') : t('common.saveToDevice')}
						</button>
						{@render restoreBtn(restoreTables)}
					</div>
				{/if}
			</section>
		{/each}
	{/if}
</div>
