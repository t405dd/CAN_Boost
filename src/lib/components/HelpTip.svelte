<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';

	let { key }: { key: string } = $props();
	let show = $state(false);
	let tipEl: HTMLElement | undefined = $state();
	let btnEl: HTMLElement | undefined = $state();
	let tooltipStyle = $state('');

	function toggle(e: Event) {
		e.preventDefault();
		e.stopPropagation();
		show = !show;
	}

	function calcPosition() {
		if (!btnEl) return;
		const rect = btnEl.getBoundingClientRect();
		const margin = 6;

		// Vertical: prefer above, flip below if near top
		const placeBelow = rect.top < 80;
		let top: number;
		if (placeBelow) {
			top = rect.bottom + margin;
		} else {
			top = rect.top - margin;
		}

		// Horizontal: center on button, clamp to viewport edges
		let left = rect.left + rect.width / 2;
		left = Math.max(148, Math.min(window.innerWidth - 148, left));

		tooltipStyle = `top:${top}px;left:${left}px;transform:translate(-50%,${placeBelow ? '0' : '-100%'})`;
	}

	// Close on click outside (mobile) + close on scroll
	$effect(() => {
		if (!show) return;
		calcPosition();

		const clickHandler = (e: Event) => {
			if (tipEl && !tipEl.contains(e.target as Node)) show = false;
		};
		const scrollHandler = () => {
			show = false;
		};

		document.addEventListener('click', clickHandler, true);
		window.addEventListener('scroll', scrollHandler, true);
		return () => {
			document.removeEventListener('click', clickHandler, true);
			window.removeEventListener('scroll', scrollHandler, true);
		};
	});
</script>

<span class="inline-flex items-center" bind:this={tipEl}>
	<button
		type="button"
		bind:this={btnEl}
		class="w-3.5 h-3.5 rounded-full bg-[var(--color-dash-border)] text-[var(--color-dash-text-dim)]
			   text-[8px] leading-none inline-flex items-center justify-center
			   hover:bg-[var(--color-dash-accent)]/30 hover:text-[var(--color-dash-accent)]
			   cursor-help ml-1 shrink-0"
		onclick={toggle}
		onmouseenter={() => show = true}
		onmouseleave={() => show = false}
	>?</button>

	{#if show}
		<div
			class="fixed z-[9999] max-w-[280px] min-w-[140px] px-2.5 py-1.5 rounded
				   bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]
				   text-[10px] text-[var(--color-dash-text)] leading-relaxed
				   shadow-lg whitespace-normal pointer-events-none"
			style={tooltipStyle}
		>
			{t(key as any)}
		</div>
	{/if}
</span>
