// Adapter: converts between firmware CAN Out table JSON format and PWA internal format.
// Firmware uses different field names (currentXParamName/cols/rows) than PWA (xAxisParamType/numCols/numRows).

import type { CanOutTable, FirmwareCanOutTable } from '$lib/types/config';
import { firmwareNameToPwaName, pwaNameToFirmwareName } from './param-mapping';

const MAX_SIZE = 16;

/** Convert firmware wire format → PWA internal format */
export function firmwareToCanOutTable(fw: FirmwareCanOutTable): CanOutTable {
	const numCols = Math.max(1, Math.min(MAX_SIZE, fw.cols ?? 1));
	const numRows = Math.max(1, Math.min(MAX_SIZE, fw.rows ?? 1));

	// Pad arrays to MAX_SIZE for internal use
	const xAxisValues = padArray(fw.xAxisValues, MAX_SIZE);
	const yAxisValues = padArray(fw.yAxisValues, MAX_SIZE);
	const tableData = padTable(fw.tableData, MAX_SIZE, MAX_SIZE);

	return {
		tableIdBase: fw.tableIdBase ?? '',
		xAxisParamType: firmwareNameToPwaName(fw.currentXParamName ?? 'NONE'),
		yAxisParamType: firmwareNameToPwaName(fw.currentYParamName ?? 'NONE'),
		numCols,
		numRows,
		hasYAxis: fw.hasYAxis ?? false,
		isEnabled: fw.isEnabled ?? false,
		xAxisValues,
		yAxisValues,
		tableData
	};
}

/** Convert PWA internal format → firmware wire format */
export function canOutTableToFirmware(table: CanOutTable): FirmwareCanOutTable {
	const cols = table.numCols;
	const rows = table.hasYAxis ? table.numRows : 1;

	return {
		tableIdBase: table.tableIdBase,
		currentXParamName: pwaNameToFirmwareName(table.xAxisParamType),
		currentYParamName: table.hasYAxis
			? pwaNameToFirmwareName(table.yAxisParamType)
			: 'NONE',
		cols,
		rows,
		hasYAxis: table.hasYAxis,
		isEnabled: table.isEnabled,
		xAxisValues: table.xAxisValues.slice(0, cols),
		yAxisValues: table.hasYAxis ? table.yAxisValues.slice(0, rows) : [],
		tableData: table.tableData.slice(0, rows).map(row => row.slice(0, cols))
	};
}

function padArray(arr: number[] | undefined, size: number): number[] {
	const result = arr ? [...arr] : [];
	while (result.length < size) result.push(0);
	return result;
}

function padTable(data: number[][] | undefined, rows: number, cols: number): number[][] {
	const result: number[][] = [];
	for (let r = 0; r < rows; r++) {
		const srcRow = data?.[r] ?? [];
		const row = [...srcRow];
		while (row.length < cols) row.push(0);
		result.push(row);
	}
	return result;
}
