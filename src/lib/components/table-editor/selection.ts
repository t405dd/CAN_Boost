// Selection state management for table editor
// Supports data cells AND axis cells (row=-1 for X-axis, col=-1 for Y-axis)

import type { CellCoord } from './math-ops';

/** Check if a cell is in the selection set */
export function isCellSelected(selection: CellCoord[], row: number, col: number): boolean {
	return selection.some(c => c.row === row && c.col === col);
}

/** Create a rectangular selection from two corner cells.
 *  Handles axis cells: if either anchor is an axis cell, restrict selection to that axis. */
export function rectSelection(a: CellCoord, b: CellCoord): CellCoord[] {
	const result: CellCoord[] = [];

	// Both are X-axis cells (row=-1): select X-axis range
	if (a.row === -1 && b.row === -1) {
		const minC = Math.min(a.col, b.col);
		const maxC = Math.max(a.col, b.col);
		for (let c = minC; c <= maxC; c++) {
			result.push({ row: -1, col: c });
		}
		return result;
	}

	// Both are Y-axis cells (col=-1): select Y-axis range
	if (a.col === -1 && b.col === -1) {
		const minR = Math.min(a.row, b.row);
		const maxR = Math.max(a.row, b.row);
		for (let r = minR; r <= maxR; r++) {
			result.push({ row: r, col: -1 });
		}
		return result;
	}

	// Mixed axis + data, or both data: select data cell rectangle (ignore axis part)
	const minR = Math.min(Math.max(a.row, 0), Math.max(b.row, 0));
	const maxR = Math.max(Math.max(a.row, 0), Math.max(b.row, 0));
	const minC = Math.min(Math.max(a.col, 0), Math.max(b.col, 0));
	const maxC = Math.max(Math.max(a.col, 0), Math.max(b.col, 0));

	for (let r = minR; r <= maxR; r++) {
		for (let c = minC; c <= maxC; c++) {
			result.push({ row: r, col: c });
		}
	}
	return result;
}

/** Toggle a cell in a multi-select set (Ctrl+Click) */
export function toggleCellInSelection(selection: CellCoord[], row: number, col: number): CellCoord[] {
	const idx = selection.findIndex(c => c.row === row && c.col === col);
	if (idx >= 0) {
		return [...selection.slice(0, idx), ...selection.slice(idx + 1)];
	}
	return [...selection, { row, col }];
}

/** Select all data cells in a grid */
export function selectAll(numRows: number, numCols: number): CellCoord[] {
	const result: CellCoord[] = [];
	for (let r = 0; r < numRows; r++) {
		for (let c = 0; c < numCols; c++) {
			result.push({ row: r, col: c });
		}
	}
	return result;
}

/** Select all data cells + all axis cells */
export function selectAllWithAxes(numRows: number, numCols: number, hasYAxis: boolean): CellCoord[] {
	const result: CellCoord[] = [];
	// X-axis cells
	for (let c = 0; c < numCols; c++) {
		result.push({ row: -1, col: c });
	}
	// Y-axis cells
	if (hasYAxis) {
		for (let r = 0; r < numRows; r++) {
			result.push({ row: r, col: -1 });
		}
	}
	// Data cells
	for (let r = 0; r < numRows; r++) {
		for (let c = 0; c < numCols; c++) {
			result.push({ row: r, col: c });
		}
	}
	return result;
}

/** Extend selection by one cell in a direction (Shift+Arrow).
 *  Returns new selection (rectangle from anchor to new end). */
export function extendSelection(
	anchor: CellCoord,
	current: CellCoord,
	direction: 'up' | 'down' | 'left' | 'right',
	numRows: number,
	numCols: number
): { selection: CellCoord[]; end: CellCoord } {
	let newEnd = { ...current };
	switch (direction) {
		case 'up':    if (newEnd.row > 0) newEnd.row--; break;
		case 'down':  if (newEnd.row < numRows - 1) newEnd.row++; break;
		case 'left':  if (newEnd.col > 0) newEnd.col--; break;
		case 'right': if (newEnd.col < numCols - 1) newEnd.col++; break;
	}
	return { selection: rectSelection(anchor, newEnd), end: newEnd };
}

/** Find the live cursor cell indices based on axis values and current X/Y values.
 *  Returns fractional position for sub-pixel cursor rendering. */
export function findCursorCell(
	xAxisValues: number[],
	yAxisValues: number[] | undefined,
	numCols: number,
	numRows: number,
	cursorX: number,
	cursorY?: number
): { col: number; row: number; fracCol: number; fracRow: number } | null {
	if (numCols < 1) return null;

	const fracCol = findFractionalIndex(xAxisValues, numCols, cursorX);
	let fracRow = 0;
	if (yAxisValues && numRows > 1 && cursorY !== undefined) {
		fracRow = findFractionalIndex(yAxisValues, numRows, cursorY);
	}

	// col/row mark the *nearest* node (for the highlight ring) so it coincides
	// with the crosshair; fracCol/fracRow keep the exact position for the
	// crosshair lines and bilinear interpolation.
	return {
		col: Math.max(0, Math.min(Math.round(fracCol), numCols - 1)),
		row: Math.max(0, Math.min(Math.round(fracRow), numRows - 1)),
		fracCol,
		fracRow
	};
}

/** Find fractional index in axis values array. Handles non-uniform spacing. */
function findFractionalIndex(axisValues: number[], numPoints: number, value: number): number {
	if (numPoints <= 1) return 0;

	// Below range
	if (value <= axisValues[0]) return 0;
	// Above range
	if (value >= axisValues[numPoints - 1]) return numPoints - 1;

	// Find bracketing interval
	for (let i = 0; i < numPoints - 1; i++) {
		if (value >= axisValues[i] && value <= axisValues[i + 1]) {
			const span = axisValues[i + 1] - axisValues[i];
			if (Math.abs(span) < 1e-9) return i;
			return i + (value - axisValues[i]) / span;
		}
	}
	return numPoints - 1;
}

/** Get bounding box of selection (min/max row/col, data cells only) */
export function selectionBounds(selection: CellCoord[]): { minRow: number; maxRow: number; minCol: number; maxCol: number } | null {
	const dataCells = selection.filter(c => c.row >= 0 && c.col >= 0);
	if (dataCells.length === 0) return null;
	return {
		minRow: Math.min(...dataCells.map(c => c.row)),
		maxRow: Math.max(...dataCells.map(c => c.row)),
		minCol: Math.min(...dataCells.map(c => c.col)),
		maxCol: Math.max(...dataCells.map(c => c.col))
	};
}
