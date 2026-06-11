<script lang="ts">
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import type { LocalInputConfig } from '$lib/types/config';
	import { localInputsStore, loadLocalInputs, saveLocalInputs, defaultLocalInput, MAX_LOCAL_INPUTS } from '$lib/stores/local-inputs.svelte';
	import { loadSignalLabels } from '$lib/stores/signal-labels.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';

	// Роли — значения SignalRole прошивки (как в can-receive + APP)
	const SIGNAL_ROLES = [
		{ value: 0, labelKey: 'canRx.roleNone' },
		{ value: 1, labelKey: 'canRx.roleMap' },
		{ value: 2, labelKey: 'canRx.roleRpm' },
		{ value: 3, labelKey: 'canRx.roleTps' },
		{ value: 4, labelKey: 'canRx.roleKnock' },
		{ value: 5, labelKey: 'canRx.roleClt' },
		{ value: 6, labelKey: 'canRx.roleApp' }
	] as const;

	// ADC1-пины S3 Zero (ANALOG: только они — ADC2 конфликтует с BLE); CAN занял GPIO3/4
	const ANALOG_PINS = [1, 2, 5, 6, 7, 8, 9, 10];
	const PULSE_PINS = [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13];

	let isConnected = $derived(bleState.status === 'connected');
	let inputs = $state<LocalInputConfig[]>(Array.from({ length: MAX_LOCAL_INPUTS }, defaultLocalInput));
	let loaded = $derived(localInputsStore.loaded);
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let activeSection = $state<number | null>(null);

	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	// Редактируемая копия из стора (клонируем на каждое успешное чтение)
	let lastEpoch = 0;
	$effect(() => {
		const e = localInputsStore.epoch;
		if (e !== lastEpoch) {
			lastEpoch = e;
			inputs = $state.snapshot(localInputsStore.inputs) as LocalInputConfig[];
		}
	});

	async function refresh() {
		loading = true;
		try { await loadLocalInputs(); } finally { loading = false; }
	}

	async function save() {
		saving = true;
		try {
			// Имена — lowercase, как в прошивке (имя сигнала в кэше)
			for (const i of inputs) i.name = i.name.trim().toLowerCase();
			const ok = await saveLocalInputs($state.snapshot(inputs) as LocalInputConfig[]);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
			if (ok) {
				await loadLocalInputs();        // подтянуть liveVolts/slot после перераскладки
				await loadSignalLabels(true);   // слоты перемапились → обновить подписи везде
			}
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	// «Захват» калибровочной точки: перечитать конфиг (live-вольты в нём) и подставить
	// текущее напряжение датчика в точку 1 или 2 редактируемой копии.
	async function capturePoint(idx: number, point: 1 | 2) {
		loading = true;
		try {
			await loadLocalInputs();
			const v = localInputsStore.inputs[idx]?.liveVolts;
			if (v === undefined || isNaN(v)) {
				showStatus(t('localIn.captureNoData'));
				return;
			}
			if (point === 1) inputs[idx].v1 = Number(v.toFixed(3));
			else inputs[idx].v2 = Number(v.toFixed(3));
			showStatus(t('localIn.captured', v.toFixed(3)));
		} finally {
			loading = false;
		}
	}

	// Дубликаты ролей в пределах локальных входов (прошивка возьмёт первый)
	let assignedRoles = $derived.by(() => {
		const m = new Map<number, number>();
		inputs.forEach((inp, i) => { if (inp.en && inp.role > 0 && !m.has(inp.role)) m.set(inp.role, i); });
		return m;
	});
	const roleTakenByOther = (role: number, idx: number) =>
		role > 0 && assignedRoles.has(role) && assignedRoles.get(role) !== idx;

	let initialLoadDone = $state(false);
	$effect(() => {
		if (isConnected && !initialLoadDone) {
			initialLoadDone = true;
			if (!localInputsStore.loaded) refresh();
		}
		if (!isConnected) initialLoadDone = false;
	});

	const inputClass = 'px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none';
	const labelClass = 'text-[10px] text-[var(--color-dash-text-dim)] uppercase';
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider inline-flex items-center gap-1">
		{t('localIn.title')}<HelpTip key="help.localIn.title" />
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
			<button onclick={refresh} disabled={loading || saving}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] transition-colors disabled:opacity-40">
				{t('common.restoreFromFlash')}
			</button>
			<button onclick={save} disabled={saving || !loaded}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
				{saving ? t('common.saving') : t('common.saveToDevice')}
			</button>
			{#if statusMsg}<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>{/if}
		</div>

		<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('localIn.hint')}</p>

		{#each inputs as inp, idx}
			{@const live = localInputsStore.inputs[idx]}
			<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 {loaded ? '' : 'opacity-50 pointer-events-none'}">
				<button class="w-full flex items-center justify-between p-3" onclick={() => activeSection = activeSection === idx ? null : idx}>
					<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
						{t('localIn.channel')} {idx + 1}
						{#if inp.en}
							<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>
							<span class="text-[var(--color-dash-text-dim)] font-normal">
								{inp.name || '—'} · {inp.type === 0 ? t('localIn.typeAnalog') : t('localIn.typePulse')} · GPIO{inp.pin}
							</span>
						{/if}
					</span>
					<span class="text-xs text-[var(--color-dash-text-dim)] inline-flex items-center gap-2">
						{#if inp.en && live?.liveValue !== undefined}
							<span class="font-mono text-[var(--color-dash-accent)] tabular-nums">{live.liveValue.toFixed(inp.prec)} {inp.unit}</span>
						{/if}
						{activeSection === idx ? '−' : '+'}
					</span>
				</button>

				{#if activeSection === idx}
					<div class="px-3 pb-3 space-y-3">
						<div class="flex items-end gap-3 flex-wrap">
							<label class="flex items-center gap-1.5 cursor-pointer pb-1">
								<input type="checkbox" bind:checked={inp.en} class="accent-[var(--color-dash-accent)]" />
								<span class="text-xs text-[var(--color-dash-text)]">{t('common.enabled')}</span>
							</label>
							<!-- Тип канала -->
							<label class="space-y-1">
								<span class="{labelClass} inline-flex items-center gap-0.5">{t('localIn.type')}<HelpTip key="help.localIn.type" /></span>
								<select bind:value={inp.type} class="{inputClass} block w-28">
									<option value={0}>{t('localIn.typeAnalog')}</option>
									<option value={1}>{t('localIn.typePulse')}</option>
								</select>
							</label>
							<!-- Пин -->
							<label class="space-y-1">
								<span class="{labelClass} inline-flex items-center gap-0.5">GPIO<HelpTip key="help.localIn.pin" /></span>
								<select bind:value={inp.pin} class="{inputClass} block w-20">
									<option value={-1}>—</option>
									{#each (inp.type === 0 ? ANALOG_PINS : PULSE_PINS) as p}
										<option value={p}>{p}</option>
									{/each}
								</select>
							</label>
							<!-- Роль -->
							<label class="space-y-1">
								<span class="{labelClass} inline-flex items-center gap-0.5">{t('canRx.role')}<HelpTip key="help.localIn.role" /></span>
								<select bind:value={inp.role} class="{inputClass} block w-24 {inp.role > 0 ? 'border-[var(--color-dash-accent)]' : ''}">
									{#each SIGNAL_ROLES as r}
										<option value={r.value} disabled={roleTakenByOther(r.value, idx)}>{t(r.labelKey)}</option>
									{/each}
								</select>
							</label>
						</div>

						<div class="flex items-end gap-3 flex-wrap">
							<label class="space-y-1">
								<span class="{labelClass} inline-flex items-center gap-0.5">{t('localIn.name')}<HelpTip key="help.localIn.name" /></span>
								<input type="text" bind:value={inp.name} maxlength="16" placeholder="an_map" class="{inputClass} block w-28" />
							</label>
							<label class="space-y-1">
								<span class={labelClass}>{t('canRx.label')}</span>
								<input type="text" bind:value={inp.label} maxlength="12" placeholder="MAP-A" class="{inputClass} block w-24" />
							</label>
							<label class="space-y-1">
								<span class={labelClass}>{t('localIn.unit')}</span>
								<input type="text" bind:value={inp.unit} maxlength="8" placeholder="kPa" class="{inputClass} block w-20" />
							</label>
							<label class="space-y-1">
								<span class={labelClass}>{t('localIn.precision')}</span>
								<input type="number" min="0" max="3" bind:value={inp.prec} class="{inputClass} block w-14 text-center" />
							</label>
						</div>

						{#if inp.type === 0}
							<!-- ANALOG: делитель + live-вольты + 2-точечная калибровка + валидный диапазон -->
							<div class="rounded border border-[var(--color-dash-border)]/40 p-2 space-y-2">
								<div class="flex items-center gap-3 flex-wrap">
									<span class="text-[10px] font-bold text-[var(--color-dash-text)] uppercase">{t('localIn.calibration')}</span>
									{#if live?.liveVolts !== undefined}
										<span class="text-xs font-mono text-[var(--color-dash-accent)] tabular-nums">{t('localIn.liveVolts')}: {live.liveVolts.toFixed(3)} V</span>
									{/if}
									<label class="flex items-center gap-1.5 ml-auto">
										<span class="{labelClass} inline-flex items-center gap-0.5">{t('localIn.divider')}<HelpTip key="help.localIn.divider" /></span>
										<input type="number" step="0.001" min="0.05" max="1" bind:value={inp.div} class="{inputClass} w-20 text-center" />
									</label>
								</div>
								<!-- Точка 1 / Точка 2 -->
								{#each [1, 2] as pt}
									<div class="flex items-center gap-2 flex-wrap">
										<span class="{labelClass} w-14">{t('localIn.point')} {pt}</span>
										<input type="number" step="0.001" value={pt === 1 ? inp.v1 : inp.v2}
											oninput={(e) => { const v = parseFloat((e.target as HTMLInputElement).value); if (pt === 1) inp.v1 = v; else inp.v2 = v; }}
											class="{inputClass} w-20 text-center" /> <span class="text-[10px] text-[var(--color-dash-text-dim)]">V →</span>
										<input type="number" step="0.1" value={pt === 1 ? inp.val1 : inp.val2}
											oninput={(e) => { const v = parseFloat((e.target as HTMLInputElement).value); if (pt === 1) inp.val1 = v; else inp.val2 = v; }}
											class="{inputClass} w-20 text-center" /> <span class="text-[10px] text-[var(--color-dash-text-dim)]">{inp.unit}</span>
										<button onclick={() => capturePoint(idx, pt as 1 | 2)} disabled={loading || !inp.en}
											class="px-2 py-0.5 text-[10px] rounded bg-[var(--color-dash-accent)]/10 text-[var(--color-dash-accent)] border border-[var(--color-dash-accent)]/20 hover:bg-[var(--color-dash-accent)]/20 transition-colors disabled:opacity-40">
											{t('localIn.capture')}
										</button>
									</div>
								{/each}
								<!-- Валидный диапазон -->
								<div class="flex items-center gap-2 flex-wrap">
									<span class="{labelClass} inline-flex items-center gap-0.5">{t('localIn.validRange')}<HelpTip key="help.localIn.validRange" /></span>
									<input type="number" step="0.05" bind:value={inp.vmin} class="{inputClass} w-20 text-center" />
									<span class="text-[10px] text-[var(--color-dash-text-dim)]">…</span>
									<input type="number" step="0.05" bind:value={inp.vmax} class="{inputClass} w-20 text-center" />
									<span class="text-[10px] text-[var(--color-dash-text-dim)]">V</span>
								</div>
							</div>
						{:else}
							<!-- PULSE: множитель + антидребезг + таймаут -->
							<div class="rounded border border-[var(--color-dash-border)]/40 p-2 space-y-2">
								<div class="flex items-center gap-3 flex-wrap">
									<label class="space-y-1">
										<span class="{labelClass} inline-flex items-center gap-0.5">{t('localIn.pulseMult')}<HelpTip key="help.localIn.pulseMult" /></span>
										<input type="number" step="0.1" bind:value={inp.mult} class="{inputClass} block w-24 text-center" />
									</label>
									<label class="space-y-1">
										<span class="{labelClass} inline-flex items-center gap-0.5">{t('localIn.minPeriod')}<HelpTip key="help.localIn.minPeriod" /></span>
										<input type="number" min="10" max="100000" bind:value={inp.minUs} class="{inputClass} block w-24 text-center" />
									</label>
									<label class="space-y-1">
										<span class="{labelClass} inline-flex items-center gap-0.5">{t('localIn.timeout')}<HelpTip key="help.localIn.timeout" /></span>
										<input type="number" min="100" max="10000" step="100" bind:value={inp.toMs} class="{inputClass} block w-24 text-center" />
									</label>
								</div>
								<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('localIn.pulseHint')}</p>
							</div>
						{/if}
					</div>
				{/if}
			</section>
		{/each}
	{/if}
</div>
