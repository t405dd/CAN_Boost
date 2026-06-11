<script lang="ts">
	import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_CAN_CONFIG, CHR_CAN_RECEIVE, SVC_SYSTEM, CHR_CAN_BUS_SCAN } from '$lib/ble/uuids';
	import { type CanMessageConfig, type CanSignalConfig, type CanSignalDataType, CAN_DATA_TYPE_NAMES } from '$lib/types/config';
	import { setCacheLabelsFromConfig } from '$lib/stores/live-data.svelte';
	import { loadSignalLabels } from '$lib/stores/signal-labels.svelte';
	import { loadBoostSettings } from '$lib/stores/boost-settings.svelte';
	import { normalizeTempUnit } from '$lib/utils/param-mapping';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import SignalCatalogModal from '$lib/components/SignalCatalogModal.svelte';
	import { loadSignalCatalog, type PredefinedSignal } from '$lib/utils/signal-catalog';

	let messages = $state<CanMessageConfig[]>([]);
	let expandedIndex = $state<number | null>(null);
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');

	let isConnected = $derived(bleState.status === 'connected');

	const DATA_TYPES: { value: CanSignalDataType; label: string }[] = [
		{ value: 0, label: 'INT8' },
		{ value: 1, label: 'UINT8' },
		{ value: 2, label: 'INT16' },
		{ value: 3, label: 'UINT16' },
		{ value: 4, label: 'INT32' },
		{ value: 5, label: 'UINT32' }
	];

	// Роль сигнала (значения совпадают с firmware SignalRole). Назначение роли делает
	// сигнал источником для буст-контроллера и производных MAPdot/RPMdot/TPSdot.
	const SIGNAL_ROLES = [
		{ value: 0, labelKey: 'canRx.roleNone' },
		{ value: 1, labelKey: 'canRx.roleMap' },
		{ value: 2, labelKey: 'canRx.roleRpm' },
		{ value: 3, labelKey: 'canRx.roleTps' },
		{ value: 4, labelKey: 'canRx.roleKnock' },
		{ value: 5, labelKey: 'canRx.roleClt' },
		{ value: 6, labelKey: 'canRx.roleApp' }
	] as const;

	// Подсказка роли по имени — чтобы каталог/пресет назначали MAP/RPM/TPS/CLT/Knock сразу.
	function inferRole(...names: (string | undefined)[]): number {
		for (const raw of names) {
			const n = (raw ?? '').toLowerCase();
			if (n === 'map') return 1;
			if (n === 'rpm') return 2;
			if (n === 'tps') return 3;
			if (n === 'knock' || n === 'knk') return 4;
			if (n === 'clt' || n === 'coolant') return 5;
			if (n === 'app' || n === 'pps') return 6;
		}
		return 0;
	}

	// Какая роль каким сигналом уже занята (первый встретившийся). Для блокировки
	// повторного назначения одной роли двум сигналам.
	let assignedRoles = $derived.by(() => {
		const m = new Map<number, CanSignalConfig>();
		for (const msg of messages)
			for (const s of msg.signals)
				if (s.role > 0 && !m.has(s.role)) m.set(s.role, s);
		return m;
	});
	const roleTakenByOther = (role: number, sig: CanSignalConfig) =>
		role > 0 && assignedRoles.has(role) && assignedRoles.get(role) !== sig;

	const MAX_MESSAGES = 10;
	const MAX_SIGNALS = 8;

	let catalogOpen = $state(false);
	// internalId всех уже добавленных сигналов — для пометки дубликатов в каталоге.
	let existingSignalIds = $derived(messages.flatMap((m) => m.signals.map((s) => s.signalName)));

	// CAN ID, реально приходящие сейчас по шине (для индикатора «есть на шине» в каталоге).
	let liveCanIds = $state<number[]>([]);
	async function refreshBusScan() {
		if (!isConnected) return;
		try {
			const ids = await readJsonConfig<number[]>(SVC_SYSTEM, CHR_CAN_BUS_SCAN);
			if (Array.isArray(ids)) liveCanIds = ids;
		} catch { /* нет данных/старая прошивка — индикатор просто не покажется */ }
	}
	// Пока открыта модалка каталога — периодически обновляем скан шины.
	$effect(() => {
		if (!catalogOpen || !isConnected) return;
		refreshBusScan();
		const id = setInterval(refreshBusScan, 1500);
		return () => clearInterval(id);
	});

	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	async function loadConfig() {
		loading = true;
		statusMsg = '';
		try {
			const data = await readJsonConfig<CanMessageConfig[]>(SVC_CAN_CONFIG, CHR_CAN_RECEIVE);
			if (data) {
				// Чиним устаревшую единицу °F у температурных сигналов с F→C: значение
				// приходит в °C, поэтому подпись должна быть °C (на устройствах,
				// настроенных до правки каталога).
				for (const msg of data) {
					for (const sig of msg.signals ?? []) {
						sig.userUnit = normalizeTempUnit(sig.userUnit || '', sig.requiresFtoC);
							sig.role = sig.role ?? 0;   // старые конфиги без роли
					}
				}
				messages = data;
				setCacheLabelsFromConfig(data); // update live data label map
				showStatus(t('canRx.loaded', data.length));
			} else {
				showStatus(t('canRx.noConfig'));
			}
		} catch (e) {
			showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			loading = false;
		}
	}

	async function saveConfig() {
		saving = true;
		statusMsg = '';
		try {
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_CAN_RECEIVE, messages);
			if (ok) {
				// Прошивка перемапила слоты кэша — обновляем метки сразу (живые данные)
				// и перечитываем с устройства (пикеры/оси), чтобы пропали "cache*".
				setCacheLabelsFromConfig(messages);
				await loadSignalLabels(true);   // force — слоты кэша перемапились, нужен свежий список
				// Прошивка перерезолвила роли → источники буста/производных (*SignalParam).
				// Перечитываем настройки буста, чтобы read-only сводка и живые бары были свежими.
				await loadBoostSettings();
			}
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	function addMessage() {
		if (messages.length >= MAX_MESSAGES) return;
		messages.push({
			canId: 0,
			isExtendedId: false,
			expectedDlc: 8,
			isEnabled: true,
			description: 'New Message',
			signals: []
		});
		expandedIndex = messages.length - 1;
	}

	function removeMessage(idx: number) {
		messages.splice(idx, 1);
		if (expandedIndex === idx) expandedIndex = null;
		else if (expandedIndex !== null && expandedIndex > idx) expandedIndex--;
	}

	function addSignal(msgIdx: number) {
		const msg = messages[msgIdx];
		if (msg.signals.length >= MAX_SIGNALS) return;
		msg.signals.push({
			signalName: 'signal_' + msg.signals.length,
			userLabel: '',
			userUnit: '',
			userPrecision: 1,
			isEnabled: true,
			startByte: 0,
			lengthBytes: 1,
			dataType: 1 as CanSignalDataType,
			isBigEndian: false,
			multiplier: 1,
			divider: 1,
			offset: 0,
			requiresFtoC: false,
			requiresVssProcessing: false,
			role: 0
		});
	}

	function removeSignal(msgIdx: number, sigIdx: number) {
		messages[msgIdx].signals.splice(sigIdx, 1);
	}

	// Сколько сигналов реально занимают cache-слоты прошивки (enabled в enabled-сообщении).
	function enabledSignalCount(): number {
		let n = 0;
		for (const m of messages) if (m.isEnabled) for (const s of m.signals) if (s.isEnabled) n++;
		return n;
	}

	// Добавление из каталога: размещаем по defaultCanId (находим сообщение или
	// создаём новое), с учётом лимитов сообщений/сигналов и потолка 40 cache-слотов.
	function addFromCatalog(sigs: PredefinedSignal[]) {
		let added = 0, skipped = 0;
		let enabled = enabledSignalCount();
		for (const s of sigs) {
			if (enabled >= 40) { skipped++; continue; }            // потолок cache-слотов
			let msg = messages.find((m) => m.canId === s.defaultCanId);
			if (!msg) {
				if (messages.length >= MAX_MESSAGES) { skipped++; continue; }
				messages.push({
					canId: s.defaultCanId,
					isExtendedId: s.defaultIsExtendedId,
					expectedDlc: 8,
					isEnabled: true,
					description: `0x${s.defaultCanId.toString(16).toUpperCase()} (${s.defaultCanId})`,
					signals: []
				});
				msg = messages[messages.length - 1];
			}
			if (msg.signals.some((x) => x.signalName === s.internalId)) { skipped++; continue; }
			if (msg.signals.length >= MAX_SIGNALS) { skipped++; continue; }
			msg.signals.push({
				signalName: s.internalId,
				userLabel: s.friendlyName,
				userUnit: normalizeTempUnit(s.unit, s.requiresFtoC),
				userPrecision: 1,
				isEnabled: true,
				startByte: s.startByte,
				lengthBytes: s.lengthBytes,
				dataType: s.dataType,
				isBigEndian: s.isBigEndian,
				multiplier: s.multiplier,
				divider: s.divider,
				offset: s.offset,
				requiresFtoC: s.requiresFtoC,
				requiresVssProcessing: s.requiresVssProcessing,
				role: assignedRoles.has(inferRole(s.pdfName, s.friendlyName)) ? 0 : inferRole(s.pdfName, s.friendlyName)
			});
			added++;
			enabled++;
		}
		catalogOpen = false;
		showStatus(skipped > 0 ? t('canRx.catalogAdded', added, skipped) : t('canRx.catalogAddedN', added));
	}

	function formatCanId(id: number): string {
		return '0x' + id.toString(16).toUpperCase().padStart(3, '0');
	}

	function parseCanId(val: string): number {
		const cleaned = val.replace(/^0x/i, '');
		const parsed = parseInt(cleaned, 16);
		return isNaN(parsed) ? 0 : parsed;
	}

	function toggleExpand(idx: number) {
		expandedIndex = expandedIndex === idx ? null : idx;
	}

	async function loadMs3Preset() {
		try {
			const library = await loadSignalCatalog();
			const simplified = library.filter(s => s.groupName.trim() === 'Simplified Dash');

			// Group by CAN ID
			const byId = new Map<number, PredefinedSignal[]>();
			for (const sig of simplified) {
				const arr = byId.get(sig.defaultCanId) ?? [];
				arr.push(sig);
				byId.set(sig.defaultCanId, arr);
			}

			for (const [canId, sigs] of byId) {
				const newMsg: CanMessageConfig = {
					canId,
					isExtendedId: sigs[0].defaultIsExtendedId,
					expectedDlc: 8,
					isEnabled: true,
					description: `MS3 0x${canId.toString(16).toUpperCase()} (${canId})`,
					signals: sigs.slice(0, MAX_SIGNALS).map(s => ({
						signalName: s.internalId,
						userLabel: s.friendlyName,
						userUnit: s.unit,
						userPrecision: 1,
						isEnabled: true,
						startByte: s.startByte,
						lengthBytes: s.lengthBytes,
						dataType: s.dataType,
						isBigEndian: s.isBigEndian,
						multiplier: s.multiplier,
						divider: s.divider,
						offset: s.offset,
						requiresFtoC: s.requiresFtoC,
						requiresVssProcessing: s.requiresVssProcessing,
						role: inferRole(s.pdfName, s.friendlyName)
					}))
				};
				// Если группа с таким CAN ID уже есть — ЗАМЕНЯЕМ её правильной из пресета
				// (иначе кривой аварийный дефолт 0x5E8 оставался бы). Иначе добавляем.
				const existingIdx = messages.findIndex(m => m.canId === canId);
				if (existingIdx >= 0) {
					messages[existingIdx] = newMsg;
				} else {
					if (messages.length >= MAX_MESSAGES) break;
					messages.push(newMsg);
				}
			}
			showStatus(t('canRx.presetLoaded'));
		} catch (e) {
			showStatus('Preset load failed: ' + (e as Error).message);
		}
	}

	// --- Auto-load on connect ---
	let initialLoadDone = $state(false);

	$effect(() => {
		if (isConnected && !initialLoadDone) {
			loadConfig();
			initialLoadDone = true;
		}
		if (!isConnected) {
			initialLoadDone = false;
		}
	});
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('canRx.title')}</div>

	{#if bleState.status !== 'connected'}
		<ConnectPrompt />
	{:else}
		<!-- Action bar -->
		<div class="flex items-center gap-2 flex-wrap">
			<button onclick={loadConfig} disabled={loading}
				class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25 transition-colors disabled:opacity-40">
				{loading ? t('common.loading') : t('common.loadFromDevice')}
			</button>
			<button onclick={saveConfig} disabled={saving}
				class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
				{saving ? t('common.saving') : t('common.saveToDevice')}
			</button>
			<button onclick={addMessage} disabled={messages.length >= MAX_MESSAGES}
				class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-border)] text-[var(--color-dash-text)] hover:bg-[var(--color-dash-card-hover)] transition-colors disabled:opacity-40">
				{t('canRx.addMessage')}
			</button>
			<button onclick={() => catalogOpen = true} disabled={messages.length >= MAX_MESSAGES}
				class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25 border border-[var(--color-dash-accent)]/30 transition-colors disabled:opacity-40">
				{t('canRx.addFromCatalog')}
			</button>
			<button onclick={loadMs3Preset} disabled={messages.length >= MAX_MESSAGES}
				class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-accent)]/10 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/20 border border-[var(--color-dash-accent)]/30 transition-colors disabled:opacity-40">
				{t('canRx.presetMs3')}
			</button>
			{#if statusMsg}
				<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>
			{/if}
		</div>

		<!-- Message list -->
		{#if messages.length === 0}
			<div class="p-6 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 text-center">
				<p class="text-[var(--color-dash-text-dim)] text-sm">{t('canRx.noMessages')}</p>
			</div>
		{/if}

		{#each messages as msg, msgIdx}
			<div class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 overflow-hidden">
				<!-- Card header -->
				<button onclick={() => toggleExpand(msgIdx)}
					class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[var(--color-dash-card-hover)] transition-colors">
					<!-- Expand arrow -->
					<svg class="w-3.5 h-3.5 text-[var(--color-dash-text-dim)] transition-transform {expandedIndex === msgIdx ? 'rotate-90' : ''}"
						fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path d="M9 5l7 7-7 7" />
					</svg>

					<!-- CAN ID -->
					<span class="shrink-0 font-mono flex items-baseline gap-1"><span class="text-xs font-bold text-[var(--color-dash-accent)]">{formatCanId(msg.canId)}</span><span class="text-[10px] text-[var(--color-dash-text-dim)]">({msg.canId})</span></span>

					<!-- Description -->
					<span class="text-xs text-[var(--color-dash-text)] truncate flex-1">{msg.description}</span>

					<!-- Signal count -->
					<span class="text-xs text-[var(--color-dash-text-dim)]">{msg.signals.length} sig</span>

					<!-- Enabled indicator -->
					<span class="w-2 h-2 rounded-full {msg.isEnabled ? 'bg-[var(--color-dash-success)]' : 'bg-[var(--color-dash-danger)]'}"></span>
				</button>

				<!-- Expanded content -->
				{#if expandedIndex === msgIdx}
					<div class="border-t border-[var(--color-dash-border)]/30 px-3 py-3 space-y-3">
						<!-- Message properties -->
						<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
							<!-- CAN ID -->
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canRx.canId')}<HelpTip key="help.canRx.canId" /></span>
								<input type="text" value={formatCanId(msg.canId)}
									onchange={(e) => { msg.canId = parseCanId(e.currentTarget.value); }}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<!-- DLC -->
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canRx.dlc')}<HelpTip key="help.canRx.dlc" /></span>
								<input type="number" min="0" max="8" bind:value={msg.expectedDlc}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<!-- Description -->
							<label class="space-y-1 col-span-2 sm:col-span-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('common.description')}<HelpTip key="help.canRx.description" /></span>
								<input type="text" bind:value={msg.description}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<!-- Toggles -->
							<div class="flex items-end gap-3 pb-0.5">
								<label class="flex items-center gap-1.5 cursor-pointer">
									<input type="checkbox" bind:checked={msg.isEnabled}
										class="accent-[var(--color-dash-accent)]" />
									<span class="text-[10px] text-[var(--color-dash-text-dim)]">{t('common.enabled')}</span>
								</label>
								<label class="flex items-center gap-1.5 cursor-pointer">
									<input type="checkbox" bind:checked={msg.isExtendedId}
										class="accent-[var(--color-dash-accent)]" />
									<span class="text-[10px] text-[var(--color-dash-text-dim)] inline-flex items-center gap-0.5">{t('canRx.extended')}<HelpTip key="help.canRx.extended" /></span>
								</label>
							</div>
						</div>

						<!-- Signals header -->
						<div class="flex items-center justify-between">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase tracking-wider inline-flex items-center gap-0.5">{t('canRx.signals')}<HelpTip key="help.canRx.signalsSection" /> ({msg.signals.length}/{MAX_SIGNALS})</span>
							<div class="flex gap-2">
								<button onclick={() => addSignal(msgIdx)} disabled={msg.signals.length >= MAX_SIGNALS}
									class="px-2 py-0.5 text-[10px] rounded bg-[var(--color-dash-border)] text-[var(--color-dash-text)] hover:bg-[var(--color-dash-card-hover)] transition-colors disabled:opacity-40">
									{t('canRx.addSignal')}
								</button>
								<button onclick={() => removeMessage(msgIdx)}
									class="px-2 py-0.5 text-[10px] rounded bg-[var(--color-dash-danger)]/15 text-[var(--color-dash-danger)] hover:bg-[var(--color-dash-danger)]/25 transition-colors">
									{t('canRx.deleteMsg')}
								</button>
							</div>
						</div>

						<!-- Signals table -->
						{#if msg.signals.length > 0}
							<div class="overflow-x-auto -mx-3 px-3">
								<table class="w-full text-[10px]">
									<thead>
										<tr class="text-[var(--color-dash-text-dim)] uppercase border-b border-[var(--color-dash-border)]/30">
											<th class="text-left py-1 px-1 font-normal">{t('common.name')}</th>
											<th class="text-left py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.role')}<HelpTip key="help.canRx.role" /></span></th>
											<th class="text-left py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.label')}<HelpTip key="help.canRx.label" /></span></th>
											<th class="text-left py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('common.unit')}<HelpTip key="help.canRx.unit" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.start')}<HelpTip key="help.canRx.startByte" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.len')}<HelpTip key="help.canRx.length" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.type')}<HelpTip key="help.canRx.dataType" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.be')}<HelpTip key="help.canRx.bigEndian" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.mult')}<HelpTip key="help.canRx.multiplier" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.div')}<HelpTip key="help.canRx.divider" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.offs')}<HelpTip key="help.canRx.offset" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.prec')}<HelpTip key="help.canRx.precision" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.ftoc')}<HelpTip key="help.canRx.ftoc" /></span></th>
											<th class="text-center py-1 px-1 font-normal"><span class="inline-flex items-center gap-0.5">{t('canRx.vss')}<HelpTip key="help.canRx.vss" /></span></th>
											<th class="text-center py-1 px-1 font-normal">{t('common.on')}</th>
											<th class="py-1 px-1"></th>
										</tr>
									</thead>
									<tbody>
										{#each msg.signals as sig, sigIdx}
											<tr class="border-b border-[var(--color-dash-border)]/20 hover:bg-[var(--color-dash-bg)]/30">
												<!-- Signal Name -->
												<td class="py-1 px-1">
													<input type="text" bind:value={sig.signalName}
														class="w-20 px-1 py-0.5 text-[10px] rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- Role (источник для буста/производных) -->
												<td class="py-1 px-1">
													<select bind:value={sig.role}
														class="w-20 px-1 py-0.5 text-[10px] rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:border-[var(--color-dash-accent)] focus:outline-none {sig.role > 0 ? 'border-[var(--color-dash-accent)]' : ''}">
														{#each SIGNAL_ROLES as r}
															<option value={r.value} disabled={roleTakenByOther(r.value, sig)}>{t(r.labelKey)}</option>
														{/each}
													</select>
												</td>
												<!-- User Label -->
												<td class="py-1 px-1">
													<input type="text" bind:value={sig.userLabel}
														class="w-16 px-1 py-0.5 text-[10px] rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- Unit -->
												<td class="py-1 px-1">
													<input type="text" bind:value={sig.userUnit}
														class="w-12 px-1 py-0.5 text-[10px] rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- Start Byte -->
												<td class="py-1 px-1 text-center">
													<input type="number" min="0" max="7" bind:value={sig.startByte}
														class="w-10 px-1 py-0.5 text-[10px] text-center rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- Length -->
												<td class="py-1 px-1 text-center">
													<input type="number" min="1" max="4" bind:value={sig.lengthBytes}
														class="w-10 px-1 py-0.5 text-[10px] text-center rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- Data Type -->
												<td class="py-1 px-1 text-center">
													<select bind:value={sig.dataType}
														class="w-16 px-1 py-0.5 text-[10px] rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:border-[var(--color-dash-accent)] focus:outline-none">
														{#each DATA_TYPES as dt}
															<option value={dt.value}>{dt.label}</option>
														{/each}
													</select>
												</td>
												<!-- Big Endian -->
												<td class="py-1 px-1 text-center">
													<input type="checkbox" bind:checked={sig.isBigEndian}
														class="accent-[var(--color-dash-accent)]" />
												</td>
												<!-- Multiplier -->
												<td class="py-1 px-1 text-center">
													<input type="number" step="any" bind:value={sig.multiplier}
														class="w-12 px-1 py-0.5 text-[10px] text-center rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- Divider -->
												<td class="py-1 px-1 text-center">
													<input type="number" step="any" bind:value={sig.divider}
														class="w-12 px-1 py-0.5 text-[10px] text-center rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- Offset -->
												<td class="py-1 px-1 text-center">
													<input type="number" step="any" bind:value={sig.offset}
														class="w-12 px-1 py-0.5 text-[10px] text-center rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- Precision -->
												<td class="py-1 px-1 text-center">
													<input type="number" min="0" max="6" bind:value={sig.userPrecision}
														class="w-10 px-1 py-0.5 text-[10px] text-center rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
												</td>
												<!-- F to C -->
												<td class="py-1 px-1 text-center">
													<input type="checkbox" bind:checked={sig.requiresFtoC}
														class="accent-[var(--color-dash-accent)]" />
												</td>
												<!-- VSS -->
												<td class="py-1 px-1 text-center">
													<input type="checkbox" bind:checked={sig.requiresVssProcessing}
														class="accent-[var(--color-dash-accent)]" />
												</td>
												<!-- Enabled -->
												<td class="py-1 px-1 text-center">
													<input type="checkbox" bind:checked={sig.isEnabled}
														class="accent-[var(--color-dash-success)]" />
												</td>
												<!-- Delete -->
												<td class="py-1 px-1 text-center">
													<button onclick={() => removeSignal(msgIdx, sigIdx)}
														class="text-[var(--color-dash-danger)] hover:text-[var(--color-dash-danger)]/70 transition-colors"
														title={t('common.delete')}>
														<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
															<path d="M6 18L18 6M6 6l12 12" />
														</svg>
													</button>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{:else}
							<p class="text-[10px] text-[var(--color-dash-text-dim)] italic">{t('canRx.noSignals')}</p>
						{/if}
					</div>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<SignalCatalogModal
	open={catalogOpen}
	existingIds={existingSignalIds}
	{liveCanIds}
	onadd={addFromCatalog}
	onclose={() => catalogOpen = false}
/>
