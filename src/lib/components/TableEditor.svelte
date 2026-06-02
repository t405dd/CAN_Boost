<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';
	import { smoothedValue, gradientColor, gradientTextColor } from './table-editor/gradient';
	import { isCellSelected, rectSelection, toggleCellInSelection, selectAll, extendSelection, findCursorCell } from './table-editor/selection';
	import { applyMathOp, interpolateHorizontal, interpolateVertical, parseNumericInput, findBracketingCells, type CellCoord, type MathOp } from './table-editor/math-ops';
	import { copyToClipboard, parseClipboard, pasteIntoData } from './table-editor/clipboard';

	interface Props {
		data: number[][];
		xAxisValues: number[];
		yAxisValues?: number[];
		numCols: number;
		numRows: number;
		decimals?: number;
		readOnly?: boolean;
		liveCursorX?: number;
		liveCursorY?: number;
		xAxisLabel?: string;
		yAxisLabel?: string;
		colorGradient?: boolean;
		gradientMin?: number;
		gradientMax?: number;
		resizable?: boolean;
		minRows?: number;
		maxRows?: number;
		minCols?: number;
		maxCols?: number;
		onDataChange?: (data: number[][]) => void;
		onAxisChange?: (axis: 'x' | 'y', values: number[]) => void;
		onResize?: (rows: number, cols: number) => void;
	}

	let {
		data = $bindable(),
		xAxisValues = $bindable(),
		yAxisValues = $bindable(),
		numCols,
		numRows,
		decimals = 1,
		readOnly = false,
		liveCursorX,
		liveCursorY,
		xAxisLabel,
		yAxisLabel,
		colorGradient = false,
		gradientMin = 0,
		gradientMax = 200,
		resizable = false,
		minRows = 1,
		maxRows = 16,
		minCols = 2,
		maxCols = 16,
		onDataChange,
		onAxisChange,
		onResize
	}: Props = $props();

	// --- Dimension controls (resizable tables only) ---
	function changeRows(delta: number) {
		const r = Math.max(minRows, Math.min(maxRows, numRows + delta));
		if (r !== numRows) onResize?.(r, numCols);
	}
	function changeCols(delta: number) {
		const c = Math.max(minCols, Math.min(maxCols, numCols + delta));
		if (c !== numCols) onResize?.(numRows, c);
	}

	// --- Constants ---
	const CELL_W = 60;
	const CELL_H = 28;

	// --- Selection state ---
	let selection = $state<CellCoord[]>([]);
	let anchor = $state<CellCoord | null>(null);
	let selectionEnd = $state<CellCoord | null>(null);
	let isDragging = $state(false);

	// --- Editing state ---
	let editingCell = $state<CellCoord | null>(null);
	let editValue = $state('');

	// --- Math toolbar ---
	let mathOp = $state<MathOp>('set');
	let mathOperand = $state('');

	// --- Live Edit mode ---
	let liveEditMode = $state(false);
	let liveEditDelta = $state('1');

	// --- Double-click/tap detection ---
	let lastClickCell = $state<CellCoord | null>(null);
	let lastClickTime = $state(0);

	// --- Computed ---
	let is2D = $derived(yAxisValues !== undefined && numRows > 1);
	let hasSelection = $derived(selection.length > 0);
	// Total table width. Combined with `table-layout: fixed` this forces every
	// column to exactly CELL_W, regardless of axis-label text length — otherwise
	// auto-layout sizes columns to their content and the crosshair (which assumes
	// a uniform CELL_W pitch) drifts.
	let tableWidthPx = $derived((numCols + (is2D ? 1 : 0)) * CELL_W);

	// Inverted display order for 2D tables (highest Y at top, like TunerStudio)
	let displayRowIndices = $derived(
		is2D
			? Array.from({ length: numRows }, (_, i) => numRows - 1 - i)
			: Array.from({ length: numRows }, (_, i) => i)
	);

	let cursorInfo = $derived(
		liveCursorX !== undefined
			? findCursorCell(xAxisValues, yAxisValues, numCols, numRows, liveCursorX, liveCursorY)
			: null
	);

	// Interpolated value at cursor position (bilinear)
	let interpolatedValue = $derived.by(() => {
		if (!cursorInfo || !data || data.length === 0) return null;
		const { fracCol, fracRow } = cursorInfo;
		const c0 = Math.max(0, Math.min(Math.floor(fracCol), numCols - 1));
		const c1 = Math.min(c0 + 1, numCols - 1);
		const r0 = Math.max(0, Math.min(Math.floor(fracRow), numRows - 1));
		const r1 = Math.min(r0 + 1, numRows - 1);
		const fx = c0 === c1 ? 0 : fracCol - c0;
		const fy = r0 === r1 ? 0 : fracRow - r0;

		if (numRows <= 1) {
			return data[0][c0] * (1 - fx) + data[0][c1] * fx;
		}
		const v00 = data[r0]?.[c0] ?? 0;
		const v10 = data[r0]?.[c1] ?? 0;
		const v01 = data[r1]?.[c0] ?? 0;
		const v11 = data[r1]?.[c1] ?? 0;
		return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
			v01 * (1 - fx) * fy + v11 * fx * fy;
	});

	// Bracketing cells for Live Edit
	let bracketingInfo = $derived.by(() => {
		if (!liveEditMode || !cursorInfo) return null;
		return findBracketingCells(cursorInfo.fracCol, cursorInfo.fracRow, numCols, numRows);
	});

	// Cursor crosshair pixel positions (relative to tbody area)
	let cursorCrosshair = $derived.by(() => {
		if (!cursorInfo) return null;
		const { fracCol, fracRow } = cursorInfo;
		const displayFracRow = is2D ? (numRows - 1 - fracRow) : fracRow;
		const yAxisOffset = is2D ? CELL_W : 0;
		// Axis nodes are centered in their cells (center at (index + 0.5)·CELL),
		// so the crosshair must add the half-cell offset to land on the node, not
		// the cell's left/top edge.
		return {
			x: yAxisOffset + (fracCol + 0.5) * CELL_W,
			y: (displayFracRow + 0.5) * CELL_H,   // данные начинаются сверху (шапки X больше нет)
			tableWidth: yAxisOffset + numCols * CELL_W,
			tableHeight: numRows * CELL_H
		};
	});

	// --- Cell click / selection ---
	function onCellMouseDown(row: number, col: number, e: MouseEvent) {
		if (readOnly) return;
		if (editingCell) commitEdit();

		const now = Date.now();
		// Double-click/tap detection (same cell within 400ms, no modifiers)
		if (!e.ctrlKey && !e.metaKey && !e.shiftKey &&
			lastClickCell?.row === row && lastClickCell?.col === col &&
			now - lastClickTime < 400) {
			startEdit(row, col);
			lastClickCell = null;
			return;
		}
		lastClickCell = { row, col };
		lastClickTime = now;

		if (e.ctrlKey || e.metaKey) {
			selection = toggleCellInSelection(selection, row, col);
			anchor = { row, col };
		} else if (e.shiftKey && anchor) {
			selection = rectSelection(anchor, { row, col });
			selectionEnd = { row, col };
		} else {
			anchor = { row, col };
			selectionEnd = { row, col };
			selection = [{ row, col }];
			isDragging = true;
		}
	}

	function onCellMouseEnter(row: number, col: number) {
		if (isDragging && anchor) {
			selection = rectSelection(anchor, { row, col });
			selectionEnd = { row, col };
			lastClickCell = null; // Cancel double-click detection during drag
		}
	}

	function onMouseUp() {
		isDragging = false;
	}

	// --- Start editing ---
	function startEdit(row: number, col: number) {
		if (readOnly) return;
		editingCell = { row, col };
		if (row === -1 && col >= 0) {
			editValue = String(xAxisValues[col]);
		} else if (col === -1 && row >= 0 && yAxisValues) {
			editValue = String(yAxisValues[row]);
		} else if (row >= 0 && col >= 0 && data[row]) {
			editValue = String(data[row][col]);
		}
	}

	function commitEdit() {
		if (!editingCell) return;
		const val = parseNumericInput(editValue);
		if (!isNaN(val)) {
			const rounded = Math.round(val * 1000) / 1000;
			if (selection.length > 1 && editingCell.row >= 0 && editingCell.col >= 0) {
				// Multi-cell: set all selected data cells to the same value
				for (const c of selection) {
					if (c.row >= 0 && c.col >= 0 && c.row < numRows && c.col < (data[c.row]?.length ?? 0)) {
						data[c.row][c.col] = rounded;
					}
				}
			} else if (editingCell.row === -1 && editingCell.col >= 0) {
				// X-axis cell
				xAxisValues[editingCell.col] = rounded;
				onAxisChange?.('x', xAxisValues);
			} else if (editingCell.col === -1 && editingCell.row >= 0 && yAxisValues) {
				// Y-axis cell
				yAxisValues[editingCell.row] = rounded;
				onAxisChange?.('y', yAxisValues);
			} else if (editingCell.row >= 0 && editingCell.col >= 0) {
				// Single data cell
				data[editingCell.row][editingCell.col] = rounded;
			}
			notifyDataChange();
		}
		editingCell = null;
		editValue = '';
	}

	function cancelEdit() {
		editingCell = null;
		editValue = '';
	}

	// --- Keyboard navigation ---
	function onKeyDown(e: KeyboardEvent) {
		// Don't intercept events from toolbar inputs (math operand, select, etc.)
		const target = e.target as HTMLElement;
		if (!editingCell && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;

		// Editing mode: Enter/Tab commit, Escape cancel
		if (editingCell) {
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				commitEdit();
				if (selection.length === 1) {
					const { row, col } = selection[0];
					if (row < 0 || col < 0) return; // axis cell — don't navigate
					const nextCol = e.key === 'Tab' ? (e.shiftKey ? col - 1 : col + 1) : col;
					const nextRow = e.key === 'Enter' ? (e.shiftKey ? row - 1 : row + 1) : row;
					if (nextCol >= 0 && nextCol < numCols && nextRow >= 0 && nextRow < numRows) {
						const nc = { row: nextRow, col: nextCol };
						selection = [nc];
						anchor = nc;
						selectionEnd = nc;
					}
				}
			} else if (e.key === 'Escape') {
				cancelEdit();
			}
			return;
		}

		if (selection.length === 0) return;
		const current = selectionEnd || selection[selection.length - 1];
		// Only navigate data cells (row >= 0, col >= 0)
		if (current.row < 0 || current.col < 0) {
			// Selected axis cell — limited navigation
			if (e.key === 'Enter') {
				e.preventDefault();
				if (selection.length === 1) startEdit(current.row, current.col);
			}
			return;
		}

		switch (e.key) {
			case 'ArrowUp':
				e.preventDefault();
				if (e.shiftKey && anchor) {
					const r = extendSelection(anchor, current, 'up', numRows, numCols);
					selection = r.selection; selectionEnd = r.end;
				} else if (current.row > 0) {
					const nc = { row: current.row - 1, col: current.col };
					selection = [nc]; anchor = nc; selectionEnd = nc;
				}
				break;
			case 'ArrowDown':
				e.preventDefault();
				if (e.shiftKey && anchor) {
					const r = extendSelection(anchor, current, 'down', numRows, numCols);
					selection = r.selection; selectionEnd = r.end;
				} else if (current.row < numRows - 1) {
					const nc = { row: current.row + 1, col: current.col };
					selection = [nc]; anchor = nc; selectionEnd = nc;
				}
				break;
			case 'ArrowLeft':
				e.preventDefault();
				if (e.shiftKey && anchor) {
					const r = extendSelection(anchor, current, 'left', numRows, numCols);
					selection = r.selection; selectionEnd = r.end;
				} else if (current.col > 0) {
					const nc = { row: current.row, col: current.col - 1 };
					selection = [nc]; anchor = nc; selectionEnd = nc;
				}
				break;
			case 'ArrowRight':
				e.preventDefault();
				if (e.shiftKey && anchor) {
					const r = extendSelection(anchor, current, 'right', numRows, numCols);
					selection = r.selection; selectionEnd = r.end;
				} else if (current.col < numCols - 1) {
					const nc = { row: current.row, col: current.col + 1 };
					selection = [nc]; anchor = nc; selectionEnd = nc;
				}
				break;
			case 'Enter':
				e.preventDefault();
				if (selection.length === 1) startEdit(current.row, current.col);
				break;
			case 'Delete':
			case 'Backspace':
				e.preventDefault();
				if (!readOnly) {
					for (const c of selection) {
						if (c.row >= 0 && c.col >= 0 && data[c.row]) data[c.row][c.col] = 0;
					}
					notifyDataChange();
				}
				break;
			case 'a':
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					selection = selectAll(numRows, numCols);
				}
				break;
			case 'c':
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					const text = copyToClipboard(data, xAxisValues, yAxisValues, selection);
					navigator.clipboard.writeText(text);
				}
				break;
			case 'v':
				if ((e.ctrlKey || e.metaKey) && !readOnly) {
					e.preventDefault();
					navigator.clipboard.readText().then(text => {
						const clipData = parseClipboard(text);
						if (clipData && anchor && anchor.row >= 0 && anchor.col >= 0) {
							data = pasteIntoData(data, clipData, anchor.row, anchor.col, numRows, numCols);
							notifyDataChange();
						}
					});
				}
				break;
			default:
				// Start typing → enter edit mode (supports Russian decimal chars)
				if (!readOnly && selection.length >= 1 && /^[0-9.,\-бюБЮ/]$/.test(e.key)) {
					const target = selection.length === 1 ? selection[0] : (selection.find(c => c.row >= 0 && c.col >= 0) ?? selection[0]);
					if (target.row >= 0 && target.col >= 0) {
						editingCell = target;
						editValue = /[бюБЮ/,]/.test(e.key) ? '.' : e.key;
					}
				}
		}
	}

	// --- Math ops ---
	function doMathOp() {
		const val = parseNumericInput(mathOperand);
		if (isNaN(val) || selection.length === 0) return;
		applyMathOp(data, xAxisValues, yAxisValues, selection, mathOp, val);
		notifyDataChange();
	}

	function doInterpH() {
		if (selection.length < 2) return;
		interpolateHorizontal(data, xAxisValues, selection);
		notifyDataChange();
	}

	function doInterpV() {
		if (selection.length < 2) return;
		interpolateVertical(data, yAxisValues, selection);
		notifyDataChange();
	}

	function doSelectAll() {
		selection = selectAll(numRows, numCols);
	}

	// --- Live Edit ---
	function applyLiveEdit(sign: number) {
		if (!bracketingInfo) return;
		const delta = parseNumericInput(liveEditDelta);
		if (isNaN(delta) || delta === 0) return;
		const { cells, weights } = bracketingInfo;
		for (let i = 0; i < cells.length; i++) {
			const { row, col } = cells[i];
			if (row >= 0 && row < numRows && col >= 0 && col < numCols && data[row]) {
				data[row][col] = Math.round((data[row][col] + sign * delta * weights[i]) * 1000) / 1000;
			}
		}
		notifyDataChange();
	}

	function notifyDataChange() {
		onDataChange?.(data);
	}

	// --- Format ---
	function fmt(v: number): string {
		return v.toFixed(decimals);
	}

	// Axis-label display: round to 1 decimal, drop trailing ".0" (e.g. 9.091 → 9.1,
	// 38 → 38). Editing still uses the raw full-precision value (see startEdit).
	function fmtAxis(v: number | undefined): string {
		if (v === undefined || v === null || !isFinite(v)) return '';
		return String(Math.round(v * 10) / 10);
	}

	// --- Style helpers ---
	function cellBg(row: number, col: number): string {
		if (!colorGradient || !data[row]) return '';
		const val = smoothedValue(data, row, col, numRows, numCols);
		return gradientColor(val, gradientMin, gradientMax);
	}

	function cellTextColor(row: number, col: number): string {
		if (!colorGradient || !data[row]) return '';
		const val = smoothedValue(data, row, col, numRows, numCols);
		return gradientTextColor(val, gradientMin, gradientMax);
	}

	function isBracketingCell(row: number, col: number): boolean {
		if (!bracketingInfo) return false;
		return bracketingInfo.cells.some(c => c.row === row && c.col === col);
	}

	// Focus action: autofocus attribute only works on page load, not dynamic elements
	function focusOnMount(node: HTMLInputElement) {
		node.focus();
		node.select();
	}
</script>

<svelte:window onmouseup={onMouseUp} />

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="table-editor" tabindex="0" role="grid" onkeydown={onKeyDown}>
	<!-- Dimension control (resizable tables only) -->
	{#if resizable && !readOnly}
		<div class="flex items-center gap-2 mb-2 text-[10px] flex-wrap">
			{#if maxRows > 1}
				<span class="text-[var(--color-dash-text-dim)] uppercase">{t('table.rows')}</span>
				<div class="flex items-center">
					<button onclick={() => changeRows(-1)} disabled={numRows <= minRows}
						class="px-1.5 py-0.5 rounded-l bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] disabled:opacity-30">−</button>
					<span class="px-2 py-0.5 bg-[var(--color-dash-bg)] border-y border-[var(--color-dash-border)] font-mono text-[var(--color-dash-text)] min-w-[22px] text-center">{numRows}</span>
					<button onclick={() => changeRows(1)} disabled={numRows >= maxRows}
						class="px-1.5 py-0.5 rounded-r bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] disabled:opacity-30">+</button>
				</div>
			{/if}
			<span class="text-[var(--color-dash-text-dim)] uppercase">{t('table.cols')}</span>
			<div class="flex items-center">
				<button onclick={() => changeCols(-1)} disabled={numCols <= minCols}
					class="px-1.5 py-0.5 rounded-l bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] disabled:opacity-30">−</button>
				<span class="px-2 py-0.5 bg-[var(--color-dash-bg)] border-y border-[var(--color-dash-border)] font-mono text-[var(--color-dash-text)] min-w-[22px] text-center">{numCols}</span>
				<button onclick={() => changeCols(1)} disabled={numCols >= maxCols}
					class="px-1.5 py-0.5 rounded-r bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] disabled:opacity-30">+</button>
			</div>
			{#if maxRows > 1}
				<span class="px-1.5 py-0.5 rounded font-mono {is2D ? 'bg-[var(--color-dash-accent)]/20 text-[var(--color-dash-accent)]' : 'bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)]'}">{is2D ? '2D' : '1D'}</span>
			{/if}
		</div>
	{/if}

	<!-- Math toolbar (only when not readOnly and has selection) -->
	{#if !readOnly && hasSelection}
		<div class="flex items-center gap-1.5 mb-2 flex-wrap">
			<select bind:value={mathOp}
				class="px-1.5 py-1 text-[10px] rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:outline-none">
				<option value="set">{t('table.set')}</option>
				<option value="add">{t('table.add')}</option>
				<option value="sub">{t('table.sub')}</option>
				<option value="mul">{t('table.mul')}</option>
			</select>
			<input type="text" bind:value={mathOperand} placeholder="0"
				class="w-16 px-1.5 py-1 text-[10px] rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
			<button onclick={doMathOp}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25 transition-colors">
				{t('table.apply')}
			</button>
			<span class="w-px h-4 bg-[var(--color-dash-border)]"></span>
			<button onclick={doInterpH}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] transition-colors">
				{t('table.interpH')}
			</button>
			{#if is2D}
				<button onclick={doInterpV}
					class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] transition-colors">
					{t('table.interpV')}
				</button>
			{/if}
			<button onclick={doSelectAll}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] transition-colors">
				{t('table.selectAll')}
			</button>
			<span class="text-[9px] text-[var(--color-dash-text-dim)] ml-auto">{selection.length} cells</span>
		</div>
	{/if}

	<!-- Cursor info bar -->
	{#if cursorInfo}
		<div class="flex items-center gap-2 mb-1 text-[10px] flex-wrap">
			<span class="text-[var(--color-dash-warn)] font-mono">
				{xAxisLabel ?? 'X'}={liveCursorX?.toFixed(0)}{#if liveCursorY !== undefined}&nbsp;&nbsp;{yAxisLabel ?? 'Y'}={liveCursorY?.toFixed(0)}{/if}
			</span>
			{#if interpolatedValue !== null}
				<span class="text-[var(--color-dash-text)] font-mono font-bold">= {interpolatedValue.toFixed(decimals)}</span>
			{/if}
			{#if !readOnly}
				<button onclick={() => liveEditMode = !liveEditMode}
					class="px-1.5 py-0.5 text-[10px] rounded transition-colors
						{liveEditMode ? 'bg-[var(--color-dash-warn)]/30 text-[var(--color-dash-warn)]' : 'bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]'}">
					LE
				</button>
				{#if liveEditMode}
					<input type="text" bind:value={liveEditDelta} placeholder="1"
						class="w-12 px-1 py-0.5 text-[10px] rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:outline-none" />
					<button onclick={() => applyLiveEdit(1)}
						class="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-dash-success)]/20 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/30">+</button>
					<button onclick={() => applyLiveEdit(-1)}
						class="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-dash-danger)]/20 text-[var(--color-dash-danger)] hover:bg-[var(--color-dash-danger)]/30">−</button>
				{/if}
			{/if}
		</div>
	{/if}

	<!-- Table -->
	<div class="table-scroll overflow-x-auto relative">
		<table class="border-collapse select-none" style="table-layout: fixed; width: {tableWidthPx}px; touch-action: manipulation">
			<tbody>
				{#each displayRowIndices as dataRow}
					<tr>
						{#if is2D}
							{@const ySelected = isCellSelected(selection, dataRow, -1)}
							{@const yEditing = editingCell?.col === -1 && editingCell?.row === dataRow}
							<td class="p-0">
								{#if yEditing}
									<input
										type="text"
										bind:value={editValue}
										onblur={commitEdit}
										onkeydown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
										class="w-[60px] h-7 px-1 text-[10px] text-center bg-white border-2 border-[var(--color-dash-accent)] text-black font-mono focus:outline-none"
										use:focusOnMount />
								{:else}
									<!-- svelte-ignore a11y_click_events_have_key_events -->
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<div
										class="w-[60px] h-7 flex items-center justify-center text-[10px] font-mono border transition-colors duration-75 cursor-default overflow-hidden
											{ySelected ? 'border-[var(--color-dash-accent)] bg-[var(--color-dash-accent)]/30 text-[var(--color-dash-accent)]' : 'border-[var(--color-dash-border)]/30 bg-[var(--color-dash-accent)]/10 text-[var(--color-dash-accent)]'}"
										onmousedown={(e) => onCellMouseDown(dataRow, -1, e)}
										onmouseenter={() => onCellMouseEnter(dataRow, -1)}>
										{fmtAxis(yAxisValues?.[dataRow])}
									</div>
								{/if}
							</td>
						{/if}
						{#each { length: numCols } as _, c}
							{@const selected = isCellSelected(selection, dataRow, c)}
							{@const isEditing = editingCell?.row === dataRow && editingCell?.col === c}
							{@const isCursor = cursorInfo !== null && cursorInfo.row === dataRow && cursorInfo.col === c}
							{@const isBracketing = isBracketingCell(dataRow, c)}
							<td class="p-0"
								onmousedown={(e) => onCellMouseDown(dataRow, c, e)}
								onmouseenter={() => onCellMouseEnter(dataRow, c)}>
								{#if isEditing}
									<input
										type="text"
										bind:value={editValue}
										onblur={commitEdit}
										class="w-[60px] h-7 px-1 text-[10px] text-center bg-white border-2 border-[var(--color-dash-accent)] text-black font-mono focus:outline-none"
										use:focusOnMount />
								{:else}
									<div
										class="w-[60px] h-7 flex items-center justify-center text-[10px] font-mono border transition-colors duration-75
											{selected ? 'border-[var(--color-dash-accent)] bg-[var(--color-dash-accent)]/20' : 'border-[var(--color-dash-border)]/30'}
											{isCursor ? 'ring-2 ring-[var(--color-dash-warn)] ring-inset' : ''}
											{isBracketing && !selected ? 'ring-1 ring-[var(--color-dash-warn)]/50 ring-inset' : ''}"
										style:background-color={!selected ? cellBg(dataRow, c) : ''}
										style:color={!selected ? cellTextColor(dataRow, c) : ''}>
										{fmt(data[dataRow]?.[c] ?? 0)}
									</div>
								{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>

			<!-- X-ось (снизу, редактируемая) -->
			<tfoot>
				<tr>
					{#if is2D}
						<td class="p-0">
							<div class="w-[60px] h-7 flex items-center justify-center text-[9px] text-[var(--color-dash-text-dim)] bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]/30 truncate px-0.5">
								{yAxisLabel ?? 'Y'} \ {xAxisLabel ?? 'X'}
							</div>
						</td>
					{/if}
					{#each { length: numCols } as _, c}
						{@const xSelected = isCellSelected(selection, -1, c)}
						{@const xEditing = editingCell?.row === -1 && editingCell?.col === c}
						<td class="p-0">
							{#if xEditing}
								<input
									type="text"
									bind:value={editValue}
									onblur={commitEdit}
									onkeydown={(e) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') cancelEdit(); }}
									class="w-[60px] h-7 px-1 text-[10px] text-center bg-white border-2 border-[var(--color-dash-accent)] text-black font-mono focus:outline-none"
									use:focusOnMount />
							{:else}
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div
									class="w-[60px] h-7 flex items-center justify-center text-[10px] font-mono border transition-colors duration-75 cursor-default overflow-hidden
										{xSelected ? 'border-[var(--color-dash-accent)] bg-[var(--color-dash-accent)]/30 text-[var(--color-dash-accent)]' : 'border-[var(--color-dash-border)]/30 bg-[var(--color-dash-accent)]/10 text-[var(--color-dash-accent)]'}"
									onmousedown={(e) => onCellMouseDown(-1, c, e)}
									onmouseenter={() => onCellMouseEnter(-1, c)}>
									{fmtAxis(xAxisValues[c])}
								</div>
							{/if}
						</td>
					{/each}
				</tr>
			</tfoot>
		</table>

		<!-- Live cursor crosshair overlay -->
		{#if cursorCrosshair}
			<!-- Horizontal line -->
			<div class="crosshair-h"
				style="top: {cursorCrosshair.y}px; left: 0; width: {cursorCrosshair.tableWidth}px;"></div>
			<!-- Vertical line -->
			<div class="crosshair-v"
				style="left: {cursorCrosshair.x}px; top: 0px; height: {cursorCrosshair.tableHeight}px;"></div>
		{/if}
	</div>
</div>

<style>
	.table-editor:focus {
		outline: none;
	}
	.table-editor:focus-within table {
		outline: 1px solid var(--color-dash-accent);
		outline-offset: 1px;
	}
	.crosshair-h, .crosshair-v {
		position: absolute;
		pointer-events: none;
		z-index: 10;
	}
	.crosshair-h {
		height: 1.5px;
		background: var(--color-dash-warn);
		opacity: 0.6;
		transform: translateY(-50%);   /* center the line on its `top` coordinate */
	}
	.crosshair-v {
		width: 1.5px;
		background: var(--color-dash-warn);
		opacity: 0.6;
		transform: translateX(-50%);   /* center the line on its `left` coordinate */
	}
</style>
