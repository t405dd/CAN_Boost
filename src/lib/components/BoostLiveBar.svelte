<script lang="ts">
	// Persistent header strip with the live boost picture the user always wants in view:
	// RPM, current MAP, and the boost error (actual − target: above target = +, below = −).
	// MAP/RPM come from the configured signal slots (boost_settings); error is the
	// streamed system param BST_ERR (enum 5).
	import { liveData } from '$lib/stores/live-data.svelte';
	import { boostSettings } from '$lib/stores/boost-settings.svelte';
	import { t } from '$lib/i18n/index.svelte';

	let rpm = $derived(liveData.params[boostSettings.value.rpmSignalParam]?.value);
	let tps = $derived(liveData.params[boostSettings.value.tpsSignalParam]?.value);
	let map = $derived(liveData.params[boostSettings.value.mapSignalParam]?.value);
	let err = $derived(liveData.params[5]?.value);   // BST_ERR

	function fmt(v: number, d = 1): string {
		return Number.isInteger(v) ? String(v) : v.toFixed(d);
	}

	// Цвет ошибки по модулю: близко к цели — зелёная, средне — warn, далеко — danger.
	let errColor = $derived(
		err === undefined ? 'var(--color-dash-text)'
			: Math.abs(err) < 5 ? 'var(--color-dash-success)'
			: Math.abs(err) < 15 ? 'var(--color-dash-warn)'
			: 'var(--color-dash-danger)'
	);

	let any = $derived(
		rpm !== undefined || tps !== undefined || map !== undefined || err !== undefined
	);
</script>

{#if any}
	<div class="shrink-0 flex items-stretch w-full bg-[var(--color-dash-card)]/70 border-b border-[var(--color-dash-border)]/40 font-mono">
		<div class="flex-1 flex flex-col items-center justify-center py-1.5 border-r border-[var(--color-dash-border)]/30">
			<span class="text-[9px] uppercase tracking-wider text-[var(--color-dash-text-dim)]">RPM</span>
			<span class="text-lg leading-none font-bold tabular-nums text-[var(--color-dash-text)]">{rpm === undefined ? '—' : fmt(rpm, 0)}</span>
		</div>

		<div class="flex-1 flex flex-col items-center justify-center py-1.5 border-r border-[var(--color-dash-border)]/30">
			<span class="text-[9px] uppercase tracking-wider text-[var(--color-dash-text-dim)]">TPS</span>
			<span class="text-lg leading-none font-bold tabular-nums text-[var(--color-dash-text)]">{tps === undefined ? '—' : fmt(tps, 0)}</span>
		</div>

		<div class="flex-1 flex flex-col items-center justify-center py-1.5 border-r border-[var(--color-dash-border)]/30">
			<span class="text-[9px] uppercase tracking-wider text-[var(--color-dash-text-dim)]">MAP</span>
			<span class="text-lg leading-none font-bold tabular-nums text-[var(--color-dash-text)]">{map === undefined ? '—' : fmt(map)}</span>
		</div>

		<div class="flex-1 flex flex-col items-center justify-center py-1.5">
			<span class="text-[9px] uppercase tracking-wider text-[var(--color-dash-text-dim)]">{t('hdr.err')}</span>
			<span class="text-lg leading-none font-bold tabular-nums" style="color: {errColor}">
				{err === undefined ? '—' : (err > 0 ? '+' : '') + fmt(err)}
			</span>
		</div>
	</div>
{/if}
