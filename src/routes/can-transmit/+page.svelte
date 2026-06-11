<script lang="ts">
	import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_CAN_CONFIG, CHR_CAN_OUT_TABLES, CHR_OUT_CHANNELS } from '$lib/ble/uuids';
	import type { CanOutTable, FirmwareCanOutTable, OutChannelsConfig } from '$lib/types/config';
	import { firmwareToCanOutTable, canOutTableToFirmware } from '$lib/utils/can-out-adapter';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import TableEditor from '$lib/components/TableEditor.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, pwaNameToEnum } from '$lib/utils/param-mapping';
	import { PARAM_CACHE_SLOT_START, PARAM_CO_BASE, PARAM_CO_MUL_1, PARAM_CO_MUL_2, PARAM_CO_MUL_3 } from '$lib/ble/protocol';
	import { liveData } from '$lib/stores/live-data.svelte';
	import { getParamDisplayName, getParamShortName, signalLabels } from '$lib/stores/signal-labels.svelte';
	import { base } from '$app/paths';

	// Страница ЧИСТОГО РАСЧЁТА: только таблицы каналов OUT1..4. Доставка значений
	// (CAN-адреса каналов и ШИМ-пины) — на странице «Выходы» (полное разделение
	// «вычисление ↔ доставка», как роли на входе).

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

	let isConnected = $derived(bleState.status === 'connected');

	// --- Селектор вычисляемого канала OUT1..4 (как селектор карт буста) ---
	// Прошивка адресует can_out_tables/can_out_settings редактируемым каналом (g_editOutChannel):
	// пишем {edit:n} в out_channels (apply синхронный), затем перечитываем таблицы и настройки.
	let outChannels = $state<OutChannelsConfig | null>(null);
	let editChannel = $state(0);
	let switchingChannel = $state(false);

	async function loadOutChannels() {
		const data = await readJsonConfig<OutChannelsConfig>(SVC_CAN_CONFIG, CHR_OUT_CHANNELS);
		if (data) {
			outChannels = data;
			editChannel = data.edit ?? 0;
		}
	}

	async function selectChannel(n: number) {
		if (n === editChannel || switchingChannel) return;
		switchingChannel = true;
		loading = true;
		tablesLoaded = false;
		try {
			await writeJsonConfig(SVC_CAN_CONFIG, CHR_OUT_CHANNELS, { edit: n });
			editChannel = n;
			// Канал переключён — таблицы теперь отдаются для него
			await fetchTables();
			await loadOutChannels();
		} catch (e) {
			showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			switchingChannel = false;
			loading = false;
		}
	}

	// Cache-слоты занимают enum [15..54]; системные параметры — < 15 и >= 55 (вкл. производные).
	const isCacheSlot = (enumVal: number) =>
		enumVal >= PARAM_CACHE_SLOT_START && enumVal < PARAM_CACHE_SLOT_START + 40;
	// Опции селектов осей: системные параметры (вкл. RPMdot/MAPdot/TPSdot) + ТОЛЬКО замапленные
	// cache-слоты (с подписью), чтобы не показывать пустые cache0…cache39. Значение — pwaName.
	// NONE (дублирует пункт «—») и TIME (бессмыслен как ось) отфильтрованы.
	let paramOptions = $derived(
		allParamEntries().filter(p =>
			p.enumVal > 1 &&
			(!isCacheSlot(p.enumVal) || signalLabels[p.enumVal - PARAM_CACHE_SLOT_START] !== undefined)
		)
	);
	// Понятные имена (оси): pwa-имена → дружелюбные RPMdot/MAPdot/TPSdot и семейство OUT.
	const AXIS_FRIENDLY_PWA: Record<string, string> = {
		boost_drpm: 'RPMdot', map_dot: 'MAPdot', tps_dot: 'TPSdot',
		co1: 'OUT1', out2: 'OUT2', out3: 'OUT3', out4: 'OUT4'
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
	const TABLE_RESULT_LABEL = ['COBase', 'COmul1', 'COmul2', 'COmul3'];
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
			// Таблицы канала (большой chunked-конфиг, нужен лишь тут) + сводка OUT-каналов (селектор).
			loadOutChannels().catch(() => {});
			loading = true;
			fetchTables().catch((e) => showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message)).finally(() => { loading = false; });
		}
		if (!isConnected) {
			initialLoadDone = false;
			tablesLoaded = false;
			outChannels = null;
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

		<!-- Селектор вычисляемого канала OUT1..4 (таблицы/настройки ниже — для выбранного) -->
		<div class="flex items-stretch gap-1">
			<span class="self-center text-[9px] uppercase tracking-wider text-[var(--color-dash-text-dim)] pr-1 shrink-0 inline-flex items-center gap-0.5">{t('canTx.channel')}<HelpTip key="help.canTx.channel" /></span>
			{#each Array.from({ length: 4 }, (_, i) => i) as i}
				{@const ch = outChannels?.channels?.[i]}
				<button onclick={() => selectChannel(i)} disabled={switchingChannel}
					class="flex-1 min-w-0 px-1.5 py-1 text-[11px] rounded border truncate transition-colors disabled:opacity-50 {i === editChannel
						? 'bg-[var(--color-dash-accent)]/20 border-[var(--color-dash-accent)] text-[var(--color-dash-accent)] font-bold'
						: 'bg-[var(--color-dash-bg)] border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:border-[var(--color-dash-accent)]'}">
					OUT{i + 1}
					{#if ch?.enabled}<span class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-dash-success)] ml-0.5 align-middle"></span>{/if}
					{#if ch?.value !== undefined}<span class="block text-[9px] font-mono font-normal opacity-70">{ch.value.toFixed(1)}</span>{/if}
				</button>
			{/each}
			{#if switchingChannel}
				<span class="self-center w-3 h-3 shrink-0 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
			{/if}
		</div>

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

		<!-- Доставка канала (CAN-адрес / ШИМ-пин) настраивается на странице «Выходы» -->
		<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('canTx.deliveryMoved')}
			<a href="{base}/outputs" class="text-[var(--color-dash-accent)] underline">{t('nav.outputs')}</a></p>

		<!-- Таблицы канала: по аккордеон-секции на таблицу (T1…T4). -->
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
							liveResultLabel={TABLE_RESULT_LABEL[idx]}
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
