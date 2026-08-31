import { describe, it, expect, vi } from 'vitest';
import { connectGanTimer, GanTimerState, type GanTimerEvent } from '../../gan-smart-timer';

const TIME_CHR = '0000fff2-0000-1000-8000-00805f9b34fb';
const STATE_CHR = '0000fff5-0000-1000-8000-00805f9b34fb';

/** Same CRC-16/CCITT-FALSE variant the timer driver validates against. */
function crc16ccit(bytes: number[]): number {
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) > 0 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return crc & 0xffff;
}

/** [magic, len, tag, state, min, sec, msLo, msHi, crcLo, crcHi]; CRC covers bytes 2..7. */
function timerFrame(state: GanTimerState, time = { min: 0, sec: 0, ms: 0 }): number[] {
  const body = [0x03, state, time.min, time.sec, time.ms & 0xff, time.ms >> 8];
  const crc = crc16ccit(body);
  return [0xfe, 0x0a, ...body, crc & 0xff, crc >> 8];
}

class MockCharacteristic extends EventTarget {
  value: DataView | null = null;
  startNotifications = vi.fn(async () => this);
  stopNotifications = vi.fn(async () => this);
  readValue = vi.fn(async () => new DataView(new ArrayBuffer(0)));

  notify(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

function installMockTimer(): { device: EventTarget; time: MockCharacteristic; state: MockCharacteristic; server: { connected: boolean } } {
  const time = new MockCharacteristic();
  const state = new MockCharacteristic();
  const service = {
    getCharacteristic: async (uuid: string) => {
      if (uuid === TIME_CHR) return time;
      if (uuid === STATE_CHR) return state;
      throw new Error(`unexpected characteristic ${uuid}`);
    },
  };
  const server = {
    connected: false,
    getPrimaryService: async () => service,
    disconnect: () => {
      server.connected = false;
    },
  };
  const device = new (class extends EventTarget {
    gatt = {
      connect: async () => {
        server.connected = true;
        return server;
      },
    };
  })();
  (globalThis as unknown as { navigator: { bluetooth: unknown } }).navigator.bluetooth = {
    requestDevice: async () => device,
  };
  return { device, time, state, server };
}

describe('connectGanTimer', () => {
  it('delivers timer states from valid frames, including the recorded time on STOPPED', async () => {
    const { state } = installMockTimer();
    const conn = await connectGanTimer();
    const events: GanTimerEvent[] = [];
    conn.events$.subscribe({ next: (e) => events.push(e) });

    state.notify(timerFrame(GanTimerState.RUNNING));
    state.notify(timerFrame(GanTimerState.STOPPED, { min: 1, sec: 23, ms: 456 }));

    expect(events.map((e) => e.state)).toEqual([GanTimerState.RUNNING, GanTimerState.STOPPED]);
    expect(events[1]!.recordedTime?.asTimestamp).toBe(60000 + 23000 + 456);
    expect(events[1]!.recordedTime?.toString()).toBe('1:23.456');
  });

  it('drops a corrupt frame and keeps delivering later frames', async () => {
    const { state } = installMockTimer();
    const conn = await connectGanTimer();
    const events: GanTimerEvent[] = [];
    const onError = vi.fn();
    conn.events$.subscribe({ next: (e) => events.push(e), error: onError });

    const corrupt = timerFrame(GanTimerState.RUNNING);
    corrupt[corrupt.length - 1] ^= 0xff; // break the CRC
    state.notify(corrupt);
    state.notify(timerFrame(GanTimerState.IDLE));

    expect(onError).not.toHaveBeenCalled();
    expect(events.map((e) => e.state)).toEqual([GanTimerState.IDLE]);
  });

  it('does not resolve until state notifications are active', async () => {
    const { state } = installMockTimer();
    let release!: () => void;
    state.startNotifications.mockImplementation(
      () => new Promise<MockCharacteristic>((resolve) => {
        release = () => resolve(state);
      })
    );

    let resolved = false;
    const p = connectGanTimer().then((c) => {
      resolved = true;
      return c;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.startNotifications).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    release();
    await p;
    expect(resolved).toBe(true);
  });

  it('getRecordedTimes rejects with an Error when the value is too short', async () => {
    const { time } = installMockTimer();
    time.readValue.mockResolvedValue(new DataView(new ArrayBuffer(4)));
    const conn = await connectGanTimer();
    await expect(conn.getRecordedTimes()).rejects.toBeInstanceOf(Error);
  });

  it('emits DISCONNECT and completes when the GATT server disconnects', async () => {
    const { device } = installMockTimer();
    const conn = await connectGanTimer();
    const events: GanTimerEvent[] = [];
    const onComplete = vi.fn();
    conn.events$.subscribe({ next: (e) => events.push(e), complete: onComplete });

    device.dispatchEvent(new Event('gattserverdisconnected'));
    await new Promise((r) => setTimeout(r, 0));

    expect(events.map((e) => e.state)).toEqual([GanTimerState.DISCONNECT]);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
