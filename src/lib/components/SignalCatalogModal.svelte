<script lang="ts">
	import Modal from './Modal.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { loadSignalCatalog, groupSortKey, type PredefinedSignal } from '$lib/utils/signal-catalog';

	interface Props {
		open: boolean;
		existingIds: string[];           // internalId сигналов, уже добавленных в конфиг
		onadd: (signals: PredefinedSignal[]) => void;
		onclose: () => void;
	}

	let { open, existingIds, onadd, onclose }: Props = $props();

	let catalog = $state<PredefinedSignal[]>([]);
	let loadErr = $state('');
	let loadingCat = $state(false);
	let search = $state('');
	let selected = $state<Record<string, boolean>>({});

	let existingSet = $derived(new Set(existingIds));

	// Загрузка каталога при первом открытии + сброс выбора/поиска.
	$effect(() => {
		if (!open) return;
		search = '';
		selected = {};
		if (catalog.length === 0 && !loadingCat) {
			loadingCat = true;
			loadErr = '';
			loadSignalCatalog()
				.then((c) => { catalog = c; })
				.catch((e) => { loadErr = String((e as Error).message ?? e); })
				.finally(() => { loadingCat = false; });
		}
	});

	function matches(s: PredefinedSignal, q: string): boolean {
		return (
			s.friendlyName.toLowerCase().includes(q) ||
			(s.pdfFunction ?? '').toLowerCase().includes(q) ||
			s.internalId.toLowerCase().includes(q) ||
			(s.unit ?? '').toLowerCase().includes(q) ||
			s.groupName.toLowerCase().includes(q)
		);
	}

	// Сигналы, сгруппированные по groupName, с учётом поиска и сортировкой групп.
	let groups = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const map = new Map<string, PredefinedSignal[]>();
		for (const s of catalog) {
			if (q && !matches(s, q)) continue;
			const key = s.groupName.trim();
			const arr = map.get(key) ?? [];
			arr.push(s);
			map.set(key, arr);
		}
		return [...map.entries()]
			.map(([name, sigs]) => ({ name, sigs }))
			.sort((a, b) => groupSortKey(a.name) - groupSortKey(b.name));
	});

	let selectedCount = $derived(Object.values(selected).filter(Boolean).length);

	function toggle(id: string) {
		if (existingSet.has(id)) return;
		selected[id] = !selected[id];
	}

	function addWholeGroup(sigs: PredefinedSignal[]) {
		for (const s of sigs) if (!existingSet.has(s.internalId)) selected[s.internalId] = true;
	}

	function canIdHex(id: number): string {
		return '0x' + id.toString(16).toUpperCase();
	}

	function confirm() {
		const chosen = catalog.filter((s) => selected[s.internalId] && !existingSet.has(s.internalId));
		if (chosen.length > 0) onadd(chosen);
	}
</script>

<Modal {open} title={t('canRx.catalogTitle')} onclose={onclose}>
	<!-- Search -->
	<div class="sticky top-0 z-10">
		<input
			type="text"
			bind:value={search}
			placeholder={t('canRx.catalogSearch')}
			class="w-full px-3 py-2 rounded-lg text-xs bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]/50
				text-[var(--color-dash-text)] placeholder:text-[var(--color-dash-text-dim)]/50
				focus:border-[var(--color-dash-accent)]/50 focus:outline-none"
		/>
	</div>

	{#if loadingCat}
		<div class="text-center py-6 text-[var(--color-dash-text-dim)] text-xs">{t('canRx.catalogLoading')}</div>
	{:else if loadErr}
		<div class="text-center py-6 text-[var(--color-dash-danger)] text-xs">{loadErr}</div>
	{:else}
		{#each groups as group (group.name)}
			<div>
				<div class="flex items-center justify-between mb-1.5">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase tracking-wider">
						{group.name} <span class="opacity-60">· {group.sigs.length}</span>
					</span>
					<button onclick={() => addWholeGroup(group.sigs)}
						class="px-2 py-0.5 rounded text-[10px] bg-[var(--color-dash-accent)]/10 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/20 transition-colors">
						{t('canRx.catalogAddGroup')}
					</button>
				</div>
				<div class="space-y-1">
					{#each group.sigs as s (s.internalId)}
						{@const dup = existingSet.has(s.internalId)}
						{@const sel = !!selected[s.internalId]}
						<button
							type="button"
							disabled={dup}
							onclick={() => toggle(s.internalId)}
							class="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded border transition-colors
								{dup ? 'opacity-40 cursor-not-allowed border-[var(--color-dash-border)]/30'
								  : sel ? 'border-[var(--color-dash-accent)]/60 bg-[var(--color-dash-accent)]/10'
								  : 'border-[var(--color-dash-border)]/30 hover:border-[var(--color-dash-accent)]/40'}">
							<div class="w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px]
								{sel ? 'bg-[var(--color-dash-accent)] border-[var(--color-dash-accent)] text-black' : 'border-[var(--color-dash-border)]'}">
								{#if sel}✓{/if}
							</div>
							<div class="flex-1 min-w-0">
								<div class="flex items-center gap-1.5">
									<span class="text-xs font-bold text-[var(--color-dash-text)] truncate">{s.friendlyName}</span>
									{#if s.unit}<span class="text-[10px] text-[var(--color-dash-text-dim)]">{s.unit}</span>{/if}
									{#if dup}<span class="text-[9px] text-[var(--color-dash-success)] uppercase">{t('canRx.catalogDup')}</span>{/if}
								</div>
								{#if s.pdfFunction}<div class="text-[10px] text-[var(--color-dash-text-dim)] truncate">{s.pdfFunction}</div>{/if}
							</div>
							<div class="text-[9px] text-[var(--color-dash-text-dim)] font-mono text-right shrink-0">
								{canIdHex(s.defaultCanId)}<br />b{s.startByte}+{s.lengthBytes}
							</div>
						</button>
					{/each}
				</div>
			</div>
		{/each}

		{#if groups.length === 0}
			<div class="text-center py-4 text-[var(--color-dash-text-dim)] text-xs">{t('canRx.catalogEmpty')}</div>
		{/if}
	{/if}

	{#snippet footer()}
		<div class="flex items-center gap-2">
			<span class="text-[10px] text-[var(--color-dash-text-dim)]">{t('canRx.catalogHint')}</span>
			<button onclick={confirm} disabled={selectedCount === 0}
				class="ml-auto px-4 py-2 rounded-lg text-xs font-bold bg-[var(--color-dash-accent)] text-black
					disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all">
				{t('canRx.catalogAdd')} ({selectedCount})
			</button>
		</div>
	{/snippet}
</Modal>
