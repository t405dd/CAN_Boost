// Copy/paste logic for table editor (Excel/Google Sheets compatible)
// Supports axis cells (row=-1 for X-axis, col=-1 for Y-axis)

import type { CellCoord } from './math-ops';

/** Copy selected cells to clipboard as tab-separated values.
 *  Handles data cells and axis cells separately. */
export function copyToClipboard(
	data: number[][],
	xAxisValues: number[],
	yAxisValues: number[] | undefined,
	cells: CellCoord[]
): string {
	if (cells.length === 0) return '';

	// Separate axis and data cells
	const xAxisCells = cells.filter(c => c.row === -1 && c.col >= 0).sort((a, b) => a.col - b.col);
	const yAxisCells = cells.filter(c => c.col === -1 && c.row >= 0).sort((a, b) => a.row - b.row);
	const dataCells = cells.filter(c => c.row >= 0 && c.col >= 0);

	// If only axis cells selected, copy as single row/column
	if (dataCells.length === 0) {
		if (xAxisCells.length > 0) {
			return xAxisCells.map(c => String(xAxisValues[c.col])).join('\t');
		}
		if (yAxisCells.length > 0) {
			return yAxisCells.map(c => String(yAxisValues![c.row])).join('\n');
		}
		return '';
	}

	// Data cells: build rectangular region
	const rows = [...new Set(dataCells.map(c => c.row))].sort((a, b) => a - b);
	const cols = [...new Set(dataCells.map(c => c.col))].sort((a, b) => a - b);
	const cellSet = new Set(dataCells.map(c => `${c.row},${c.col}`));

	const lines: string[] = [];
	for (const r of rows) {
		const vals: string[] = [];
		for (const c of cols) {
			vals.push(cellSet.has(`${r},${c}`) ? String(data[r][c]) : '');
		}
		lines.push(vals.join('\t'));
	}
	return lines.join('\n');
}

/** Parse clipboard text (tab/newline separated) into a 2D array of numbers.
 *  Handles Russian decimal separators: comma, б, ю, Б, Ю, / */
export function parseClipboard(text: string): number[][] | null {
	const lines = text.trim().split('\n');
	if (lines.length === 0) return null;

	const result: number[][] = [];
	for (const line of lines) {
		const vals = line.split('\t').map(s => {
			const n = parseFloat(s.trim().replace(/[,бюБЮ/]/g, '.'));
			return isNaN(n) ? 0 : n;
		});
		result.push(vals);
	}
	return result;
}

/** Paste clipboard data into table at anchor position. Returns modified data copy. */
export function pasteIntoData(
	data: number[][],
	clipData: number[][],
	anchorRow: number,
	anchorCol: number,
	maxRows: number,
	maxCols: number
): number[][] {
	// Create a shallow copy of rows that will be affected
	const newData = data.map(row => [...row]);
	for (let r = 0; r < clipData.length && anchorRow + r < maxRows; r++) {
		for (let c = 0; c < clipData[r].length && anchorCol + c < maxCols; c++) {
			newData[anchorRow + r][anchorCol + c] = clipData[r][c];
		}
	}
	return newData;
}
