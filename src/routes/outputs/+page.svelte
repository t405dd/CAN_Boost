<script lang="ts">
	import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_CAN_CONFIG, CHR_OUTPUTS } from '$lib/ble/uuids';
	import type { PhysOutputConfig } from '$lib/types/config';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, firmwareNameToPwaName } from '$lib/utils/param-mapping';
	import { PARAM_CACHE_SLOT_START } from '$lib/ble/protocol';
	import { getParamDisplayName, signalLabels } from '$lib/stores/signal-labels.svelte';

	const MAX_OUTPUTS = 2;
	// Свободные пины под выходы (CAN 3/4, LED 21 заняты; ADC1 лучше беречь под входы)
	const OUTPUT_PINS = [11, 12, 13, 1, 2, 5, 6, 7, 8, 9, 10];

	function defaultOutput(): PhysOutputConfig {
		return {
			en: false, pin: -1, src: 'BST_OUT', freq: 30,
			inMin: 0, inMax: 100, invert: false,
			dutyMin: 0, dutyMax: 100, safe: 0, staleMs: 500
		};
	}

	let isConnected = $derived(bleState.status === 'connected');
	let outputs = $state<PhysOutputConfig[]>(Array.from({ length: MAX_OUTPUTS }, defaultOutput));
	let liveOutputs = $state<PhysOutputConfig[]>([]);
	let loaded = $state(false);
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	// Источник: системные параметры (BST_OUT, OUT1..4, …) + замапленные cache-слоты.
	// Значение храним firmware-именем (src в прошивке резолвится getParamTypeByName).
	const isCacheSlot = (enumVal: number) =>
		enumVal >= PARAM_CACHE_SLOT_START && enumVal < PARAM_CACHE_SLOT_START + 40;
	let srcOptions = $derived(
		allParamEntries().filter(p =>
			p.enumVal !== 0 && (!isCacheSlot(p.enumVal) || signalLabels[p.enumVal - PARAM_CACHE_SLOT_START] !== undefined)
		)
	);
	const srcLabel = (firmwareName: string) => {
		if (firmwareName === 'CO1') return 'OUT1';   // переосмысленное имя канала 1
		const m = firmwareName.match(/^CACHE(\d+)$/);
		if (m) return getParamDisplayName(firmwareNameToPwaName(firmwareName));
		return firmwareName;
	};

	async function loadOutputs(silent = false) {
		if (!silent) loading = true;
		try {
			const data = await readJsonConfig<{ outputs: PhysOutputConfig[] }>(SVC_CAN_CONFIG, CHR_OUTPUTS);
			if (data && Array.isArray(data.outputs)) {
				liveOutputs = data.outputs;
				if (!silent || !loaded) {
					const filled = data.outputs.slice(0, MAX_OUTPUTS).map(o => ({ ...defaultOutput(), ...o }));
					while (filled.length < MAX_OUTPUTS) filled.push(defaultOutput());
					outputs = filled;
				}
				loaded = true;
			}
		} catch (e) {
			if (!silent) showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			if (!silent) loading = false;
		}
	}

	async function save() {
		saving = true;
		try {
			const clean = outputs.map(({ liveDuty, liveSource, ...rest }) => rest);
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_OUTPUTS, { outputs: clean });
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
			if (ok) await loadOutputs(true);
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	let initialLoadDone = $state(false);
	$effect(() => {
		if (isConnected && !initialLoadDone) {
			initialLoadDone = true;
			loadOutputs();
			refreshTimer = setInterval(() => loadOutputs(true), 3000);   // live duty
		}
		if (!isConnected) {
			initialLoadDone = false;
			loaded = false;
			if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
		}
		return () => {
			if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
		};
	});

	const inputClass = 'px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none';
	const labelClass = 'text-[10px] text-[var(--color-dash-text-dim)] uppercase';
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider inline-flex items-center gap-1">
		{t('outputs.title')}<HelpTip key="help.outputs.title" />
	</div>

	{#if !isConnected}
		<ConnectPrompt />
	{:else}
		<div class="flex items-center gap-2 flex-wrap">
			{#if loading}
				<span class="text-xs text-[var(--color-dash-accent)] inline-flex items-center gap-1.5">
					<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
					{t('common.loading')}
				</span>
			{/if}
			<button onclick={() => loadOutputs()} disabled={loading || saving}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] transition-colors disabled:opacity-40">
				{t('common.restoreFromFlash')}
			</button>
			<button onclick={save} disabled={saving || !loaded}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
				{saving ? t('common.saving') : t('common.saveToDevice')}
			</button>
			{#if statusMsg}<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>{/if}
		</div>

		<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('outputs.hint')}</p>

		{#each outputs as out, idx}
			{@const live = liveOutputs[idx]}
			<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-3 {loaded ? '' : 'opacity-50 pointer-events-none'}">
				<div class="flex items-center justify-between">
					<span class="text-sm font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
						{t('outputs.output')} {idx + 1}
						{#if out.en}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
					</span>
					{#if out.en && live?.liveDuty !== undefined}
						<span class="text-sm font-mono text-[var(--color-dash-accent)] tabular-nums">{live.liveDuty.toFixed(1)}%</span>
					{/if}
				</div>

				<!-- Live duty bar -->
				{#if out.en && live?.liveDuty !== undefined}
					<div class="h-1.5 rounded bg-[var(--color-dash-bg)] overflow-hidden">
						<div class="h-full bg-[var(--color-dash-accent)] transition-all" style="width: {Math.max(0, Math.min(100, live.liveDuty))}%"></div>
					</div>
				{/if}

				<div class="flex items-end gap-3 flex-wrap">
					<label class="flex items-center gap-1.5 cursor-pointer pb-1">
						<input type="checkbox" bind:checked={out.en} class="accent-[var(--color-dash-accent)]" />
						<span class="text-xs text-[var(--color-dash-text)]">{t('common.enabled')}</span>
					</label>
					<label class="space-y-1">
						<span class="{labelClass} inline-flex items-center gap-0.5">GPIO<HelpTip key="help.outputs.pin" /></span>
						<select bind:value={out.pin} class="{inputClass} block w-20">
							<option value={-1}>—</option>
							{#each OUTPUT_PINS as p}<option value={p}>{p}</option>{/each}
						</select>
					</label>
					<label class="space-y-1">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.source')}<HelpTip key="help.outputs.source" /></span>
						<select bind:value={out.src} class="{inputClass} block w-36">
							{#each srcOptions as p}
								<option value={p.firmwareName}>{srcLabel(p.firmwareName)}</option>
							{/each}
						</select>
					</label>
					<label class="space-y-1">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.freq')}<HelpTip key="help.outputs.freq" /></span>
						<input type="number" min="1" max="1000" bind:value={out.freq} class="{inputClass} block w-20 text-center" />
					</label>
				</div>

				<!-- Маппинг значение → duty -->
				<div class="rounded border border-[var(--color-dash-border)]/40 p-2 space-y-2">
					<span class="text-[10px] font-bold text-[var(--color-dash-text)] uppercase inline-flex items-center gap-0.5">{t('outputs.mapping')}<HelpTip key="help.outputs.mapping" /></span>
					<div class="flex items-center gap-2 flex-wrap">
						<span class={labelClass}>{t('outputs.inRange')}</span>
						<input type="number" step="any" bind:value={out.inMin} class="{inputClass} w-20 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">…</span>
						<input type="number" step="any" bind:value={out.inMax} class="{inputClass} w-20 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">→ 0…100%</span>
						<label class="flex items-center gap-1.5 cursor-pointer ml-2">
							<input type="checkbox" bind:checked={out.invert} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('outputs.invert')}<HelpTip key="help.outputs.invert" /></span>
						</label>
					</div>
					<div class="flex items-center gap-2 flex-wrap">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.dutyClamp')}<HelpTip key="help.outputs.dutyClamp" /></span>
						<input type="number" min="0" max="100" bind:value={out.dutyMin} class="{inputClass} w-16 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">…</span>
						<input type="number" min="0" max="100" bind:value={out.dutyMax} class="{inputClass} w-16 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">%</span>
					</div>
					<div class="flex items-center gap-2 flex-wrap">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.safeDuty')}<HelpTip key="help.outputs.safeDuty" /></span>
						<input type="number" min="0" max="100" bind:value={out.safe} class="{inputClass} w-16 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">%</span>
						<span class="{labelClass} ml-3 inline-flex items-center gap-0.5">{t('outputs.staleMs')}<HelpTip key="help.outputs.staleMs" /></span>
						<input type="number" min="100" max="5000" step="100" bind:value={out.staleMs} class="{inputClass} w-20 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">ms</span>
					</div>
				</div>
			</section>
		{/each}

		<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('outputs.hwHint')}</p>
	{/if}
</div>
