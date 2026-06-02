<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		open: boolean;
		title: string;
		tabs?: string[];
		activeTab?: number;
		onclose: () => void;
		children: Snippet;
		footer?: Snippet;
	}

	let { open, title, tabs = [], activeTab = $bindable(0), onclose, children, footer }: Props = $props();

	function onBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onclose();
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	$effect(() => {
		if (open) {
			window.addEventListener('keydown', onKeydown);
			document.body.style.overflow = 'hidden';
			return () => {
				window.removeEventListener('keydown', onKeydown);
				document.body.style.overflow = '';
			};
		}
	});
</script>

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
	<div
		class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70"
		onclick={onBackdropClick}
	>
		<div
			class="relative w-full sm:max-w-lg max-h-[90dvh] flex flex-col
				rounded-t-2xl sm:rounded-2xl
				bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]
				shadow-[0_0_40px_rgba(0,0,0,0.8)]"
		>
			<!-- Header -->
			<div class="flex items-center justify-between px-4 py-3 shrink-0">
				<h2 class="text-sm font-bold text-[var(--color-dash-text)] truncate pr-2">{title}</h2>
				<button
					onclick={onclose}
					class="w-7 h-7 flex items-center justify-center rounded-full
						text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]
						hover:bg-[var(--color-dash-border)]/50 transition-colors text-base"
					aria-label="Close"
				>&times;</button>
			</div>

			<!-- Tabs -->
			{#if tabs.length > 0}
				<div class="flex border-b border-[var(--color-dash-border)] shrink-0 overflow-x-auto">
					{#each tabs as tab, idx}
						<button
							onclick={() => activeTab = idx}
							class="px-3 py-2 text-[11px] font-bold uppercase tracking-wider whitespace-nowrap
								transition-colors border-b-2 -mb-px
								{activeTab === idx
									? 'border-[var(--color-dash-accent)] text-[var(--color-dash-accent)]'
									: 'border-transparent text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]'}"
						>{tab}</button>
					{/each}
				</div>
			{/if}

			<!-- Body -->
			<div class="flex-1 overflow-y-auto p-4 space-y-4">
				{@render children()}
			</div>

			<!-- Footer -->
			{#if footer}
				<div class="shrink-0 px-4 py-3 border-t border-[var(--color-dash-border)]">
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}
