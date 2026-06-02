// Math operations for table cell selections
// Supports data cells AND axis cells (row=-1 for X-axis, col=-1 for Y-axis)

export type MathOp = 'set' | 'add' | 'sub' | 'mul';

export interface CellCoord {
	row: number; // -1 = X-axis cell
	col: number; // -1 = Y-axis cell
}

/** Parse numeric input with Russian decimal separators (comma, б, ю) */
export function parseNumericInput(input: string): number {
	const normalized = input.replace(/[,бюБЮ/]/g, '.');
	return parseFloat(normalized);
}

/** Apply a math operation to selected cells. Handles both data and axis cells. */
export function applyMathOp(
	data: number[][],
	xAxisValues: number[],
	yAxisValues: number[] | undefined,
	cells: CellCoord[],
	op: MathOp,
	operand: number
): void {
	for (const { row, col } of cells) {
		if (row === -1 && col >= 0 && col < xAxisValues.length) {
			xAxisValues[col] = doOp(xAxisValues[col], op, operand);
		} else if (col === -1 && row >= 0 && yAxisValues && row < yAxisValues.length) {
			yAxisValues[row] = doOp(yAxisValues[row], op, operand);
		} else if (row >= 0 && col >= 0 && row < data.length && col < (data[0]?.length ?? 0)) {
			data[row][col] = doOp(data[row][col], op, operand);
		}
	}
}

function doOp(val: number, op: MathOp, operand: number): number {
	switch (op) {
		case 'set': val = operand; break;
		case 'add': val += operand; break;
		case 'sub': val -= operand; break;
		case 'mul': val *= operand; break;
	}
	return Math.round(val * 1000) / 1000;
}

/** Axis-aware horizontal interpolation. Uses actual X-axis values for non-uniform spacing. */
export function interpolateHorizontal(
	data: number[][],
	xAxisValues: number[],
	cells: CellCoord[]
): void {
	// Handle X-axis cell interpolation
	const xAxisCols: number[] = [];
	for (const c of cells) {
		if (c.row === -1 && c.col >= 0) xAxisCols.push(c.col);
	}
	if (xAxisCols.length >= 2) {
		interpolate1D(xAxisValues, xAxisCols);
	}

	// Handle data cell interpolation (grouped by row, using xAxisValues as coordinates)
	const byRow = new Map<number, number[]>();
	for (const { row, col } of cells) {
		if (row < 0 || col < 0) continue;
		if (!byRow.has(row)) byRow.set(row, []);
		byRow.get(row)!.push(col);
	}

	for (const [row, cols] of byRow) {
		cols.sort((a, b) => a - b);
		if (cols.length < 2) continue;
		const startCol = cols[0];
		const endCol = cols[cols.length - 1];
		const startVal = data[row][startCol];
		const endVal = data[row][endCol];

		// Use axis values for interpolation coordinate
		const axisSpan = xAxisValues[endCol] - xAxisValues[startCol];
		const useAxis = Math.abs(axisSpan) > 1e-9;

		for (const col of cols) {
			const t = useAxis
				? (xAxisValues[col] - xAxisValues[startCol]) / axisSpan
				: (col - startCol) / (endCol - startCol);
			data[row][col] = Math.round((startVal + t * (endVal - startVal)) * 1000) / 1000;
		}
	}
}

/** Axis-aware vertical interpolation. Uses actual Y-axis values for non-uniform spacing. */
export function interpolateVertical(
	data: number[][],
	yAxisValues: number[] | undefined,
	cells: CellCoord[]
): void {
	// Handle Y-axis cell interpolation
	if (yAxisValues) {
		const yAxisRows: number[] = [];
		for (const c of cells) {
			if (c.col === -1 && c.row >= 0) yAxisRows.push(c.row);
		}
		if (yAxisRows.length >= 2) {
			interpolate1D(yAxisValues, yAxisRows);
		}
	}

	// Handle data cell interpolation (grouped by col, using yAxisValues as coordinates)
	const byCol = new Map<number, number[]>();
	for (const { row, col } of cells) {
		if (row < 0 || col < 0) continue;
		if (!byCol.has(col)) byCol.set(col, []);
		byCol.get(col)!.push(row);
	}

	for (const [col, rows] of byCol) {
		rows.sort((a, b) => a - b);
		if (rows.length < 2) continue;
		const startRow = rows[0];
		const endRow = rows[rows.length - 1];
		const startVal = data[startRow][col];
		const endVal = data[endRow][col];

		const useAxis = yAxisValues && Math.abs(yAxisValues[endRow] - yAxisValues[startRow]) > 1e-9;

		for (const row of rows) {
			const t = useAxis
				? (yAxisValues![row] - yAxisValues![startRow]) / (yAxisValues![endRow] - yAxisValues![startRow])
				: (row - startRow) / (endRow - startRow);
			data[row][col] = Math.round((startVal + t * (endVal - startVal)) * 1000) / 1000;
		}
	}
}

/** 1D interpolation helper for axis values */
function interpolate1D(arr: number[], indices: number[]): void {
	indices.sort((a, b) => a - b);
	if (indices.length < 2) return;
	const startIdx = indices[0];
	const endIdx = indices[indices.length - 1];
	const startVal = arr[startIdx];
	const endVal = arr[endIdx];
	const span = endIdx - startIdx;
	for (const idx of indices) {
		arr[idx] = Math.round((startVal + ((idx - startIdx) / span) * (endVal - startVal)) * 1000) / 1000;
	}
}

/** Bilinear rescale: remap table data from old axes to new axes */
export function rescaleTableData(
	oldData: number[][],
	oldXAxis: number[],
	oldYAxis: number[],
	newXAxis: number[],
	newYAxis: number[],
	oldCols: number,
	oldRows: number,
	newCols: number,
	newRows: number
): number[][] {
	const result: number[][] = [];
	for (let r = 0; r < newRows; r++) {
		result.push([]);
		for (let c = 0; c < newCols; c++) {
			const x = newXAxis[c];
			const y = newYAxis[r];

			// Find bracketing X index
			let ci = 0;
			for (let i = 0; i < oldCols - 1; i++) {
				if (x >= oldXAxis[i]) ci = i;
			}
			const ci2 = Math.min(ci + 1, oldCols - 1);

			// Find bracketing Y index
			let ri = 0;
			for (let i = 0; i < oldRows - 1; i++) {
				if (y >= oldYAxis[i]) ri = i;
			}
			const ri2 = Math.min(ri + 1, oldRows - 1);

			// Fractions
			let tx = 0;
			if (ci !== ci2) tx = Math.max(0, Math.min(1, (x - oldXAxis[ci]) / (oldXAxis[ci2] - oldXAxis[ci])));
			let ty = 0;
			if (ri !== ri2) ty = Math.max(0, Math.min(1, (y - oldYAxis[ri]) / (oldYAxis[ri2] - oldYAxis[ri])));

			const v00 = oldData[ri]?.[ci] ?? 0;
			const v10 = oldData[ri]?.[ci2] ?? 0;
			const v01 = oldData[ri2]?.[ci] ?? 0;
			const v11 = oldData[ri2]?.[ci2] ?? 0;

			const val = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) +
				v01 * (1 - tx) * ty + v11 * tx * ty;
			result[r].push(Math.round(val * 1000) / 1000);
		}
	}
	return result;
}

/** Find the 4 bracketing cells around a fractional cursor position (for Live Edit) */
export function findBracketingCells(
	fracCol: number,
	fracRow: number,
	numCols: number,
	numRows: number
): { cells: CellCoord[]; weights: number[] } {
	const c0 = Math.floor(fracCol);
	const c1 = Math.min(c0 + 1, numCols - 1);
	const r0 = Math.floor(fracRow);
	const r1 = Math.min(r0 + 1, numRows - 1);

	const fx = fracCol - c0;
	const fy = fracRow - r0;

	if (numRows <= 1) {
		// 1D: only two cells
		return {
			cells: [{ row: 0, col: c0 }, { row: 0, col: c1 }],
			weights: [1 - fx, fx]
		};
	}

	return {
		cells: [
			{ row: r0, col: c0 },
			{ row: r0, col: c1 },
			{ row: r1, col: c0 },
			{ row: r1, col: c1 }
		],
		weights: [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy]
	};
}
