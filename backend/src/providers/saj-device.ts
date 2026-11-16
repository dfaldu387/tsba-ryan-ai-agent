import type { DeviceState, NormalizedDevice } from './types.js';

/** A node of SAJ's `/monitor/plantDevice/listForWeb` device tree (eSolar API and Elekeeper portal). */
export interface SajDeviceNode {
  deviceSn?: string;
  deviceName?: string;
  deviceModel?: string;
  aliasName?: string;
  deviceStatus?: number;
  deviceStatusName?: string;
  children?: SajDeviceNode[];
}

/**
 * Classify a SAJ device by its status LABEL. The numeric `deviceStatus` codes differ
 * by device type, so they can't be trusted on their own. Observed live in Nov 2026:
 * 2 is "Discharge" on battery packs but "Alarm" on inverters, and 3 is "Standby" on
 * control boxes and battery packs but "Offline" on other devices. A Standby battery
 * is healthy (it is idle, often at 100% SOC) and must not be raised as offline.
 */
export function classifySajDevice(code?: number, label?: string): DeviceState {
  const n = (label || '').trim().toLowerCase();
  if (n) {
    if (n.includes('offline') || n.includes('disconnect')) return 'offline';
    if (n.includes('alarm') || n.includes('fault') || n.includes('error')) return 'alarm';
    if (n.includes('standby') || n.includes('wait') || n.includes('idle') || n.includes('sleep')) return 'standby';
    if (n.includes('normal') || n.includes('online') || n.includes('charge') || n.includes('run')) return 'normal';
    return 'unknown';
  }
  // No label: only code 1 means the same thing on every device type.
  return code === 1 ? 'normal' : 'unknown';
}

/** Flatten the device tree (inverter → modules / control box → battery packs / meters). */
export function flattenSajDevices(nodes: SajDeviceNode[], out: NormalizedDevice[] = []): NormalizedDevice[] {
  for (const n of nodes) {
    const sn = n.deviceSn || n.aliasName;
    if (sn) {
      const state = classifySajDevice(n.deviceStatus, n.deviceStatusName);
      out.push({
        sn,
        type: n.deviceName || n.deviceModel || undefined,
        state,
        stateLabel: n.deviceStatusName || undefined,
        online: state === 'offline' ? false : state === 'unknown' ? undefined : true,
      });
    }
    if (n.children?.length) flattenSajDevices(n.children, out);
  }
  return out;
}
