<script lang="ts">
	import Modal from './Modal.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { getWarning, setWarning, defaultWarning, type ParamWarning } from '$lib/stores/dash-prefs.svelte';
	import { forgetKnownParam } from '$lib/stores/live-data.svelte';

	interface Props {
		open: boolean;
		paramType: number;
		paramName: string;
		value?: number;
		onclose: () => void;
	}

	let { open, paramType, paramName, value, onclose }: Props = $props();

	// Редактируемая копия; синхроним из стора при каждом открытии.
	let draft = $state<ParamWarning>(defaultWarning());
	let lastOpened = false;
	$effect(() => {
		if (open && !lastOpened) draft = { ...getWarning(paramType) };
		lastOpened = open;
	});

	function save() {
		setWarning(paramType, { ...draft });
		onclose();
	}
	function reset() {
		draft = defaultWarning();
	}
	function forget() {
		setWarning(paramType, defaultWarning()); // снять пороги
		forgetKnownParam(paramType); // убрать из реестра (вернётся, если придёт с авто)
		onclose();
	}

	const ic =
		'px-2 py-1 text-sm rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none w-24 text-right disabled:opacity-40';

	// Пороги: enable-поле, value-поле, подпись, поле цвета
	const rows = [
		{ enKey: 'dangerHighEn', valKey: 'dangerHigh', colorKey: 'dangerHighColor', label: 'live.warn.dangerHigh' },
		{ enKey: 'warnHighEn', valKey: 'warnHigh', colorKey: 'warnHighColor', label: 'live.warn.warnHigh' },
		{ enKey: 'warnLowEn', valKey: 'warnLow', colorKey: 'warnLowColor', label: 'live.warn.warnLow' },
		{ enKey: 'dangerLowEn', valKey: 'dangerLow', colorKey: 'dangerLowColor', label: 'live.warn.dangerLow' }
	] as const;

	// Палитра пресетов: красный, оранж, янтарь, зелёный, голубой, синий, фиолетовый, розовый.
	const PRESETS = ['#ff0040', '#ff6b35', '#facc15', '#22c55e', '#22d3ee', '#3b82f6', '#a855f7', '#ec4899'];
</script>

<Modal {open} title={paramName} {onclose}>
	<div class="space-y-3">
		{#if value !== undefined}
			<div class="text-xs text-[var(--color-dash-text-dim)]">
				{t('common.value')}:
				<span class="text-[var(--color-dash-text)] font-bold tabular-nums">{value}</span>
			</div>
		{/if}

		<p class="text-xs text-[var(--color-dash-text-dim)] leading-snug">{t('live.warn.hint')}</p>

		{#each rows as row}
			<div class="space-y-1.5">
				<label class="flex items-center justify-between gap-2">
					<span class="flex items-center gap-2 text-sm">
						<input type="checkbox" bind:checked={draft[row.enKey]} class="accent-[var(--color-dash-accent)]" />
						<span class="inline-block w-2.5 h-2.5 rounded-sm" style="background:{draft[row.colorKey]}"></span>
						{t(row.label as any)}
					</span>
					<input
						type="number"
						step="any"
						bind:value={draft[row.valKey]}
						disabled={!draft[row.enKey]}
						class={ic}
					/>
				</label>
				{#if draft[row.enKey]}
					<!-- Палитра цвета порога: пресеты + кастомный (нативный color input) -->
					<div class="flex items-center gap-1.5 flex-wrap pl-6">
						{#each PRESETS as c}
							<button
								type="button"
								onclick={() => (draft[row.colorKey] = c)}
								class="w-6 h-6 rounded-md border border-black/40 transition-transform active:scale-90
									{draft[row.colorKey].toLowerCase() === c ? 'ring-2 ring-white' : ''}"
								style="background:{c}"
								aria-label={c}
							></button>
						{/each}
						<label
							class="w-6 h-6 rounded-md relative cursor-pointer border border-[var(--color-dash-border)] overflow-hidden"
							title={t('live.warn.customColor')}
						>
							<span class="absolute inset-0" style="background:{draft[row.colorKey]}"></span>
							<span class="absolute inset-0 flex items-center justify-center text-[10px] mix-blend-difference text-white">✎</span>
							<input
								type="color"
								bind:value={draft[row.colorKey]}
								class="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
							/>
						</label>
					</div>
				{/if}
			</div>
		{/each}

		<label class="flex items-center justify-between gap-2 pt-2 border-t border-[var(--color-dash-border)]">
			<span class="flex items-center gap-2 text-sm">
				<input type="checkbox" bind:checked={draft.sound} class="accent-[var(--color-dash-accent)]" />
				{t('live.warn.sound')}
			</span>
		</label>
	</div>

	{#snippet footer()}
		<div class="flex items-center justify-between gap-2">
			<div class="flex flex-col items-start gap-1">
				<button
					onclick={reset}
					class="px-3 py-1.5 text-xs rounded text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]"
				>{t('live.warn.reset')}</button>
				<button
					onclick={forget}
					class="px-3 py-1 text-[11px] rounded text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-danger)]"
				>{t('live.warn.forget')}</button>
			</div>
			<div class="flex gap-2">
				<button
					onclick={onclose}
					class="px-4 py-1.5 text-sm rounded border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]"
				>{t('common.cancel')}</button>
				<button
					onclick={save}
					class="px-4 py-1.5 text-sm rounded bg-[var(--color-dash-accent)] text-black font-bold active:scale-95 transition-transform"
				>{t('live.warn.save')}</button>
			</div>
		</div>
	{/snippet}
</Modal>
