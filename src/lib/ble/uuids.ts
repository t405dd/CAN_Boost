// BLE UUID definitions — must match firmware/can_boost/ble_uuid.h
// CAN_Boost exposes 4 GATT services: Live Data, CAN Config, System, Boost.

// Service UUIDs
export const SVC_LIVE_DATA = '4d533301-b5a3-f393-e0a9-e50e24dcca9e';
export const SVC_CAN_CONFIG = '4d533303-b5a3-f393-e0a9-e50e24dcca9e';
export const SVC_SYSTEM = '4d533307-b5a3-f393-e0a9-e50e24dcca9e';
export const SVC_BOOST = '4d533308-b5a3-f393-e0a9-e50e24dcca9e';

// All service UUIDs (needed for requestDevice optionalServices + discovery).
// Order is the discovery order in connection.ts.
export const ALL_SERVICE_UUIDS = [
	SVC_LIVE_DATA, SVC_CAN_CONFIG, SVC_SYSTEM, SVC_BOOST
];

// Live Data Service characteristics
export const CHR_ENGINE_DATA = '4d533311-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_SYSTEM_STATUS = '4d533312-b5a3-f393-e0a9-e50e24dcca9e';

// CAN Config Service characteristics
export const CHR_CAN_RECEIVE = '4d533331-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_CAN_OUT_TABLES = '4d533332-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_CAN_OUT_SETTINGS = '4d533334-b5a3-f393-e0a9-e50e24dcca9e';

// System Service characteristics
export const CHR_DEVICE_INFO = '4d533371-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_COMMAND = '4d533372-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_CURRENT_TIME = '4d533373-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_CAN_BUS_SCAN = '4d533374-b5a3-f393-e0a9-e50e24dcca9e';  // read: JSON живых CAN ID

// Boost Controller Service characteristics
export const CHR_BOOST_SETTINGS = '4d533381-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_TARGET = '4d533382-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_CORR = '4d533383-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_LEARN = '4d533384-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_BIAS = '4d533385-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_DELTA_MAP = '4d533386-b5a3-f393-e0a9-e50e24dcca9e';

// Chunked transfer protocol commands
export const BLE_CMD_READ_REQ = 0x01;
export const BLE_CMD_WRITE_START = 0x10;
export const BLE_CMD_WRITE_DATA = 0x11;
export const BLE_CMD_WRITE_END = 0x12;
export const BLE_CMD_WRITE_ACK = 0x13;
export const BLE_CMD_WRITE_NACK = 0x14;
export const BLE_CHUNK_HEADER = 0x80;
export const BLE_CHUNK_DATA = 0x81;
export const BLE_CHUNK_END = 0x82;

// User parameter offset in binary live data protocol
export const USER_PARAM_BLE_OFFSET = 200;

// BLE device name prefix for filtering (suffix is last 4 hex of MAC).
// Must match BLE_DEVICE_NAME_PREFIX in firmware/can_boost/constants.h
export const BLE_DEVICE_NAME_PREFIX = 'CAN_BOOST';

// System command bytes (CHR_COMMAND). Calibration commands (0x20-0x23) are
// CAN_Boost-specific (headless boost calibration over BLE).
export const CMD_RESTART = 0x01;
export const CMD_FACTORY_RESET = 0x02;
export const CMD_BOOST_CAL_START = 0x20;
export const CMD_BOOST_CAL_SAVE = 0x21;
export const CMD_BOOST_CAL_DISCARD = 0x22;
export const CMD_BOOST_CAL_RESET_LEARN = 0x23;
