<script lang="ts">
	import { bleState, connect, connectScanAll } from '$lib/stores/ble-connection.svelte';
	import { liveData, getParamList } from '$lib/stores/live-data.svelte';
	import { t } from '$lib/i18n/index.svelte';

	let params = $derived(getParamList());
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
	{:else if !isConnected}
		<div class="flex flex-col items-center justify-center gap-4 py-16">
			{#if bleState.status === 'connecting' || bleState.status === 'reconnecting'}
				<!-- Connecting: show animated spinner + step text -->
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
				<!-- Disconnected: show connect button -->
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
		<!-- Parameter grid -->
		<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
			{#each params as param (param.paramType)}
				<div class="p-2.5 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50
					hover:border-[var(--color-dash-accent)]/30 transition-colors">
					<div class="text-[10px] text-[var(--color-dash-text-dim)] uppercase tracking-wider truncate mb-1">
						{param.name}
					</div>
					<div class="text-lg font-bold text-[var(--color-dash-text)] tabular-nums leading-tight">
						{formatValue(param.value)}
					</div>
				</div>
			{/each}
		</div>

		{#if params.length === 0}
			<div class="text-center py-8 text-[var(--color-dash-text-dim)] text-sm">
				{t('live.waitingForData')}
			</div>
		{/if}
	{/if}
</div>
