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
export const CHR_LOCAL_INPUTS = '4d533335-b5a3-f393-e0a9-e50e24dcca9e';   // локальные входы (ADC/импульс)
export const CHR_OUTPUTS = '4d533336-b5a3-f393-e0a9-e50e24dcca9e';        // физические ШИМ-выходы
export const CHR_OUT_CHANNELS = '4d533337-b5a3-f393-e0a9-e50e24dcca9e';   // сводка OUT1..4 + селектор edit-канала
export const CHR_SIGNAL_ROLES = '4d533338-b5a3-f393-e0a9-e50e24dcca9e';   // сводка ролей (источники/приоритет/активный)
export const CHR_EWG = '4d533339-b5a3-f393-e0a9-e50e24dcca9e';           // электронный вестгейт (сервопривод BTS7960)
export const CHR_TX_SIGNALS = '4d53333a-b5a3-f393-e0a9-e50e24dcca9e';    // CAN-трансляция параметров (локальные входы → шина)
export const CHR_IGN_CORR = '4d53333b-b5a3-f393-e0a9-e50e24dcca9e';    // карта коррекции УОЗ: настройки + live
export const CHR_IGN_TABLES = '4d53333c-b5a3-f393-e0a9-e50e24dcca9e';    // карта коррекции УОЗ: таблицы (формат can_out_tables)

// System Service characteristics
export const CHR_DEVICE_INFO = '4d533371-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_COMMAND = '4d533372-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_CURRENT_TIME = '4d533373-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_CAN_BUS_SCAN = '4d533374-b5a3-f393-e0a9-e50e24dcca9e';  // read: JSON живых CAN ID
// OTA: два раздельных канала. CTRL — текстовые команды (write) и статус (notify);
// DATA — только сырые чанки образа (writeWithoutResponse). Разделение убирает с горячего
// пути любой разбор «команда это или байты прошивки».
export const CHR_OTA_CTRL = '4d533375-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_OTA_DATA = '4d533376-b5a3-f393-e0a9-e50e24dcca9e';

// Boost Controller Service characteristics
export const CHR_BOOST_SETTINGS = '4d533381-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_TARGET = '4d533382-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_CORR = '4d533383-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_LEARN = '4d533384-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_BIAS = '4d533385-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_DELTA_MAP = '4d533386-b5a3-f393-e0a9-e50e24dcca9e';
export const CHR_BOOST_MAPS = '4d533387-b5a3-f393-e0a9-e50e24dcca9e';  // 4 switchable boost maps
export const CHR_BOOST_LEARN_DELTA = '4d533388-b5a3-f393-e0a9-e50e24dcca9e';  // notify: live learning deltas (changed cells)

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
export const BLE_DEVICE_NAME_PREFIX = 'BoostPilot';
// Прошивки до ребрендинга (2026-06-11) светятся старым именем — ищем и их.
export const BLE_DEVICE_NAME_PREFIX_LEGACY = 'CAN_BC';

// System command bytes (CHR_COMMAND). Boost learning commands are CAN_Boost-specific.
// P7 always-on adaptive: обучение идёт всегда (нет старт/стоп-ритуала).
export const CMD_RESTART = 0x01;
export const CMD_FACTORY_RESET = 0x02;
export const CMD_CAN_TOGGLE = 0x30;            // + байт 0/1: выкл/вкл CAN (NVS + автоперезагрузка)
export const CMD_BOOST_SAVE_NOW = 0x21;        // сохранить накопленное обучение сейчас
export const CMD_BOOST_CAL_RESET_LEARN = 0x23; // сброс таблиц Ki/Kp/Kd к дефолтам
export const CMD_BOOST_COMMIT_BASELINE = 0x24; // зафиксировать текущее как «эталон»
export const CMD_BOOST_REVERT_BASELINE = 0x25; // откатить к «эталону»
// EWG (электронный вестгейт): моторные/калибровочные действия. 🔴 двигатель OFF/стенд.
export const CMD_EWG_AUTOTUNE_START = 0x45;    // старт полной автонастройки (мастер S1–S6)
export const CMD_EWG_AUTOTUNE_ABORT = 0x46;    // аборт автонастройки
export const CMD_EWG_RELAY_TEST = 0x47;        // relay-тест (Tyreus–Luyben)
export const CMD_EWG_HOT_RECAL = 0x48;         // горячая перекалибровка (сохранить шкалу упоров)
export const CMD_EWG_JOG = 0x49;               // + байт: 0=стоп, 1=открывать, 2=закрывать
