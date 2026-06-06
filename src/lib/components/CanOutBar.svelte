<script lang="ts">
	// Persistent header strip showing what the device transmits on the CAN bus:
	// boost controller output (enum 3) and CO1 (enum 2), plus the boost controller
	// state (enum 55) so it's clear WHY the output is what it is — e.g. a stale
	// MAP/RPM signal forces a safe 0% output ("no data") rather than a real command.
	import { liveData } from '$lib/stores/live-data.svelte';
	import { boostSettings } from '$lib/stores/boost-settings.svelte';
	import { co1Config } from '$lib/stores/co1-settings.svelte';
	import { PARAM_BOOST_STATE } from '$lib/ble/protocol';
	import { t } from '$lib/i18n/index.svelte';

	// Строку boost (выход + статус) показываем только когда контроллер включён — иначе она неактуальна.
	let boostEnabled = $derived(boostSettings.value.enabled);
	let boostOut = $derived(boostEnabled ? liveData.params[3]?.value : undefined);
	// CO1 скрываем целиком, когда выход выключен в настройках (ничего не шлётся в шину).
	let co1 = $derived(co1Config.value.enabled ? liveData.params[2]?.value : undefined);
	let state = $derived(boostEnabled ? liveData.params[PARAM_BOOST_STATE]?.value : undefined);

	let boostPct = $derived(boostOut === undefined ? 0 : Math.max(0, Math.min(100, boostOut)));
	// CO1 рисуем как дюти 0–100 % (как T1 Base / boost). Число рядом покажет реальное значение,
	// если выход выйдет за 100.
	let co1Pct = $derived(co1 === undefined ? 0 : Math.max(0, Math.min(100, co1)));

	function fmt(v: number, d = 1): string {
		return Number.isInteger(v) ? String(v) : v.toFixed(d);
	}

	// Boost state code (firmware enum BoostState) → { label key, css color var, warn }.
	// warn=true marks states where the output is NOT a live command (data stale / off / cut).
	const STATES: Record<number, { key: any; color: string; warn: boolean }> = {
		0: { key: 'hdr.stOff',       color: 'var(--color-dash-text-dim)', warn: true },
		1: { key: 'hdr.stNoMap',     color: 'var(--color-dash-warn)',     warn: true },
		2: { key: 'hdr.stNoRpm',     color: 'var(--color-dash-warn)',     warn: true },
		3: { key: 'hdr.stNoTps',     color: 'var(--color-dash-warn)',     warn: true },
		4: { key: 'hdr.stOverboost', color: 'var(--color-dash-danger)',   warn: true },
		5: { key: 'hdr.stIdle',      color: 'var(--color-dash-text-dim)', warn: false },
		6: { key: 'hdr.stSpool',     color: 'var(--color-dash-accent)',   warn: false },
		7: { key: 'hdr.stPid',       color: 'var(--color-dash-success)',  warn: false },
		8: { key: 'hdr.stCut',       color: 'var(--color-dash-danger)',   warn: true }
	};
	let st = $derived(state === undefined ? null : (STATES[Math.round(state)] ?? null));

	// В режиме «только BIAS» фаза регулирования (7) внутренне зовётся PID, но P/I/D
	// отключены — выход чистый feedforward. Показываем «BIAS», чтобы не путать.
	let stKey = $derived(
		st && Math.round(state!) === 7 && boostSettings.value.biasOnly ? 'hdr.stBias' : st?.key
	);
</script>

{#if boostOut !== undefined || st || co1 !== undefined}
	<div class="shrink-0 flex flex-col bg-[var(--color-dash-card)]/70 border-b border-[var(--color-dash-border)]/40 text-[10px] font-mono">
		<!-- Строка 1: boost-выход + статус регулятора -->
		{#if boostOut !== undefined || st}
			<div class="flex items-center gap-3 px-3 py-1 overflow-x-auto">
				{#if boostOut !== undefined}
					<div class="flex flex-1 items-center gap-1.5 min-w-0">
						<span class="text-[var(--color-dash-text-dim)] shrink-0">BOOST</span>
						<span class="text-[var(--color-dash-accent)] font-bold tabular-nums w-12 text-right shrink-0">{fmt(boostOut)}%</span>
						<div class="flex-1 min-w-16 h-1.5 rounded-full bg-[var(--color-dash-border)]/60 overflow-hidden">
							<div class="h-full bg-[var(--color-dash-accent)] transition-all duration-100" style="width: {boostPct}%"></div>
						</div>
					</div>
				{/if}

				<!-- Boost state chip: explains why the output is what it is -->
				{#if st}
					<div class="flex items-center gap-1 shrink-0 {boostOut === undefined ? 'ml-auto' : ''} px-1.5 py-0.5 rounded"
						style="color: {st.color}; background-color: color-mix(in srgb, {st.color} 14%, transparent);">
						{#if st.warn}
							<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
								<path d="M12 9v4m0 4h.01M10.3 3.86l-8.4 14.55A1.5 1.5 0 003.2 21h17.6a1.5 1.5 0 001.3-2.59L13.7 3.86a1.5 1.5 0 00-2.6 0z" />
							</svg>
						{/if}
						<span class="font-bold uppercase tracking-wide">{t(stKey)}</span>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Строка 2: прогресс-бар CO1 (только когда выход включён) -->
		{#if co1 !== undefined}
			<div class="flex items-center gap-1.5 px-3 py-1 {boostOut !== undefined || st ? 'border-t border-[var(--color-dash-border)]/30' : ''}">
				<span class="text-[var(--color-dash-text-dim)] shrink-0">CANOUT</span>
				<span class="text-[var(--color-dash-text)] font-bold tabular-nums w-12 text-right shrink-0">{fmt(co1)}</span>
				<div class="flex-1 min-w-16 h-1.5 rounded-full bg-[var(--color-dash-border)]/60 overflow-hidden">
					<div class="h-full bg-[var(--color-dash-text)]/70 transition-all duration-100" style="width: {co1Pct}%"></div>
				</div>
			</div>
		{/if}
	</div>
{/if}
