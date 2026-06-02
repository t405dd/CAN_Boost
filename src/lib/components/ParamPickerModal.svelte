<script lang="ts">
	import Modal from './Modal.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { getParamDisplayName } from '$lib/stores/signal-labels.svelte';

	interface ParamGroup {
		label: string;
		params: string[];
	}

	interface Props {
		open: boolean;
		knownParams: string[];
		currentValue?: string;
		onselect: (param: string) => void;
		onclose: () => void;
	}

	let { open, knownParams, currentValue = '', onselect, onclose }: Props = $props();

	let search = $state('');

	// System params (built-in, always available)
	const SYSTEM_PARAMS = ['time', 'co1', 'lps', 'fps'];
	const IMU_PARAMS = ['accel_x', 'accel_y', 'accel_z', 'total_accel'];

	// Categorize known params into groups
	let groups = $derived.by((): ParamGroup[] => {
		const system: string[] = [];
		const imu: string[] = [];
		const userParams: string[] = [];
		const canSignals: string[] = [];
		const other: string[] = [];

		for (const name of knownParams) {
			if (SYSTEM_PARAMS.includes(name)) system.push(name);
			else if (IMU_PARAMS.includes(name)) imu.push(name);
			else if (name.startsWith('user_')) userParams.push(name);
			else if (name.startsWith('cache_')) canSignals.push(name);
			else other.push(name);
		}

		const result: ParamGroup[] = [];
		if (system.length) result.push({ label: t('grid.systemParams'), params: system });
		if (imu.length) result.push({ label: t('grid.imuParams'), params: imu });
		if (canSignals.length) result.push({ label: t('grid.canSignals'), params: canSignals });
		if (userParams.length) result.push({ label: t('grid.userParams'), params: userParams });
		if (other.length) result.push({ label: t('grid.otherParams'), params: other });
		return result;
	});

	// Filter by search (matches both pwa name and display name)
	let filteredGroups = $derived.by((): ParamGroup[] => {
		if (!search.trim()) return groups;
		const q = search.toLowerCase().trim();
		return groups
			.map(g => ({
				label: g.label,
				params: g.params.filter(p =>
					p.toLowerCase().includes(q) ||
					getParamDisplayName(p).toLowerCase().includes(q)
				)
			}))
			.filter(g => g.params.length > 0);
	});

	function selectParam(name: string) {
		search = '';
		onselect(name);
	}

	function clearParam() {
		search = '';
		onselect('');
	}

	// Reset search when modal opens
	$effect(() => {
		if (open) search = '';
	});
</script>

<Modal {open} title={t('grid.pickParam')} onclose={onclose}>
	<!-- Search -->
	<div class="sticky top-0 z-10 pb-2">
		<input
			type="text"
			bind:value={search}
			placeholder={t('grid.searchParam')}
			class="w-full px-3 py-2 rounded-lg text-xs bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]/50
				text-[var(--color-dash-text)] placeholder:text-[var(--color-dash-text-dim)]/50
				focus:border-[var(--color-dash-accent)]/50 focus:outline-none"
		/>
	</div>

	<!-- Current value -->
	{#if currentValue}
		<div class="flex items-center gap-2 px-2 py-1.5 rounded bg-[var(--color-dash-accent)]/10 border border-[var(--color-dash-accent)]/20">
			<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase">{t('grid.current')}:</span>
			<span class="text-xs font-bold text-[var(--color-dash-accent)] flex-1">{getParamDisplayName(currentValue)}</span>
			<button
				onclick={clearParam}
				class="px-2 py-0.5 rounded text-[10px] bg-[var(--color-dash-danger)]/10 text-[var(--color-dash-danger)]
					hover:bg-[var(--color-dash-danger)]/20 transition-colors"
			>{t('grid.clear')}</button>
		</div>
	{/if}

	<!-- Custom input -->
	<div class="flex items-center gap-2">
		<input
			type="text"
			bind:value={search}
			placeholder={t('grid.customName')}
			class="flex-1 px-3 py-1.5 rounded text-xs bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]/50
				text-[var(--color-dash-text)] placeholder:text-[var(--color-dash-text-dim)]/50
				focus:border-[var(--color-dash-accent)]/50 focus:outline-none"
		/>
		{#if search.trim()}
			<button
				onclick={() => selectParam(search.trim())}
				class="px-3 py-1.5 rounded text-[10px] font-bold
					bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)]
					hover:bg-[var(--color-dash-accent)]/25 transition-colors shrink-0"
			>{t('grid.useCustom')}</button>
		{/if}
	</div>

	<!-- Grouped params -->
	{#each filteredGroups as group}
		<div>
			<div class="text-[10px] text-[var(--color-dash-text-dim)] uppercase tracking-wider mb-1.5">{group.label}</div>
			<div class="flex flex-wrap gap-1">
				{#each group.params as param}
					<button
						onclick={() => selectParam(param)}
						class="px-2.5 py-1.5 rounded text-xs transition-colors
							{param === currentValue
								? 'bg-[var(--color-dash-accent)]/20 text-[var(--color-dash-accent)] font-bold border border-[var(--color-dash-accent)]/30'
								: 'bg-[var(--color-dash-bg)] text-[var(--color-dash-text)] border border-[var(--color-dash-border)]/30 hover:border-[var(--color-dash-accent)]/50 hover:text-[var(--color-dash-accent)]'}"
					>{getParamDisplayName(param)}</button>
				{/each}
			</div>
		</div>
	{/each}

	{#if filteredGroups.length === 0 && search.trim()}
		<div class="text-center py-4 text-[var(--color-dash-text-dim)] text-xs">{t('grid.noMatch')}</div>
	{/if}
</Modal>
