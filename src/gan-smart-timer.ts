
import { Observable, Subject } from 'rxjs';
import { resolveBluetooth, type BluetoothSourceOptions } from './bluetooth-source';

// GAN Smart Timer bluetooth service and characteristic UUIDs
const BLE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const GAN_TIMER_SERVICE: string = '0000fff0' + BLE_UUID_SUFFIX;
const GAN_TIMER_TIME_CHARACTERISTIC: string = '0000fff2' + BLE_UUID_SUFFIX;
const GAN_TIMER_STATE_CHARACTERISTIC: string = '0000fff5' + BLE_UUID_SUFFIX;

/**
 * GAN Smart Timer events/states
 */
enum GanTimerState {
    /** Fired when timer is disconnected from bluetooth */
    DISCONNECT = 0,
    /** Grace delay is expired and timer is ready to start */
    GET_SET = 1,
    /** Hands removed from the timer before grace delay expired */
    HANDS_OFF = 2,
    /** Timer is running */
    RUNNING = 3,
    /** Timer is stopped, this event includes recorded time */
    STOPPED = 4,
    /** Timer is reset and idle */
    IDLE = 5,
    /** Hands are placed on the timer */
    HANDS_ON = 6,
    /** Timer moves to this state immediately after STOPPED */
    FINISHED = 7
}

/**
 * Representation of time value
 */
interface GanTimerTime {
    readonly minutes: number;
    readonly seconds: number;
    readonly milliseconds: number;
    readonly asTimestamp: number;
    toString(): string;
}

/**
 * Timer state event
 */
interface GanTimerEvent {
    /** Current timer state */
    state: GanTimerState;
    /** Recorder time value in case of STOPPED event */
    recordedTime?: GanTimerTime;
}

/**
 * Representation of recorded in timer memory time values
 */
interface GanTimerRecordedTimes {
    displayTime: GanTimerTime;
    previousTimes: [GanTimerTime, GanTimerTime, GanTimerTime];
}

/**
 * GAN Timer connection object representing connection API and state
 */
interface GanTimerConnection {
    /** RxJS Subject to subscribe for cube event messages */
    events$: Observable<GanTimerEvent>;
    /** Retrieve last time values recored by timer */
    getRecordedTimes(): Promise<GanTimerRecordedTimes>;
    /** Disconnect from timer; resolves when teardown completed. Safe to call twice. */
    disconnect(): Promise<void>;
}

/**
 * Construct time object
 */
function makeTime(min: number, sec: number, msec: number): GanTimerTime {
    if (
        !Number.isInteger(min) || min < 0 ||
        !Number.isInteger(sec) || sec < 0 || sec > 59 ||
        !Number.isInteger(msec) || msec < 0 || msec > 999
    ) {
        throw new Error(`Invalid time components: ${min}:${sec}.${msec}`);
    }
    return {
        minutes: min,
        seconds: sec,
        milliseconds: msec,
        asTimestamp: 60000 * min + 1000 * sec + msec,
        toString: () => `${min.toString(10)}:${sec.toString(10).padStart(2, '0')}.${msec.toString(10).padStart(3, '0')}`
    }
}

/**
 * Construct time object from raw event data
 */
function makeTimeFromRaw(data: DataView, offset: number): GanTimerTime {
    const min = data.getUint8(offset);
    const sec = data.getUint8(offset + 1);
    const msec = data.getUint16(offset + 2, true);
    return makeTime(min, sec, msec);
}

/**
 * Construct time object from milliseconds timestamp
 */
function makeTimeFromTimestamp(timestamp: number): GanTimerTime {
    const min = Math.trunc(timestamp / 60000);
    const sec = Math.trunc(timestamp % 60000 / 1000);
    const msec = Math.trunc(timestamp % 1000);
    return makeTime(min, sec, msec);
}

/**
 * Calculate ArrayBuffer checksum using CRC-16/CCIT-FALSE algorithm variation
 */
function crc16ccit(buff: ArrayBufferLike): number {
    const dataView = new DataView(buff);
    let crc: number = 0xFFFF;
    for (let i = 0; i < dataView.byteLength; ++i) {
        crc ^= dataView.getUint8(i) << 8;
        for (let j = 0; j < 8; ++j) {
            crc = (crc & 0x8000) > 0 ? (crc << 1) ^ 0x1021 : crc << 1;
        }
    }
    return crc & 0xFFFF;
}

/**
 * Ensure received timer event has valid data: check data magic and CRC
 */
function validateEventData(data: DataView): boolean {
    try {
        // Magic byte, at least a state byte at offset 3, and the trailing 16-bit CRC.
        if (!data || data.byteLength < 6 || data.getUint8(0) !== 0xFE) {
            return false;
        }
        const eventCRC = data.getUint16(data.byteLength - 2, true);
        // Slice relative to the view's bounds: buffer.slice(2, …) ignores byteOffset and
        // would CRC unrelated bytes when the DataView is a subview of a larger buffer.
        const calculatedCRC = crc16ccit(
            data.buffer.slice(data.byteOffset + 2, data.byteOffset + data.byteLength - 2),
        );
        if (eventCRC !== calculatedCRC) {
            return false;
        }
        const state = data.getUint8(3);
        if (GanTimerState[state] === undefined) {
            return false; // CRC-valid frame carrying an undocumented state
        }
        if (state === GanTimerState.STOPPED && data.byteLength < 10) {
            return false; // STOPPED carries a 4-byte recorded time at offset 4
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Construct event object from raw data
 */
function buildTimerEvent(data: DataView): GanTimerEvent {
    const evt: GanTimerEvent = {
        state: data.getUint8(3)
    };
    if (evt.state === GanTimerState.STOPPED) {
        evt.recordedTime = makeTimeFromRaw(data, 4);
    }
    return evt;
}

/**
 * Initiate new connection with the GAN Smart Timer device
 * @param options Optional source for the Web Bluetooth entry point (defaults to navigator.bluetooth)
 * @returns Connection connection object representing connection API and state
 */
async function connectGanTimer(options?: BluetoothSourceOptions): Promise<GanTimerConnection> {

    // Request user for the bluetooth device (popup selection dialog)
    const device = await resolveBluetooth(options?.bluetooth).requestDevice(
        {
            filters: [
                { namePrefix: "GAN" },
                { namePrefix: "gan" },
                { namePrefix: "Gan" }
            ],
            optionalServices: [GAN_TIMER_SERVICE]
        }
    );

    // Connect to GATT server
    const server = await device.gatt!.connect();

    // Connect to main timer service and characteristics
    const service = await server.getPrimaryService(GAN_TIMER_SERVICE);
    const timeCharacteristic = await service.getCharacteristic(GAN_TIMER_TIME_CHARACTERISTIC);
    const stateCharacteristic = await service.getCharacteristic(GAN_TIMER_STATE_CHARACTERISTIC);

    // Subscribe to value updates of the timer state characteristic
    const eventSubject = new Subject<GanTimerEvent>();
    const onStateChanged = (evt: Event) => {
        const chr: BluetoothRemoteGATTCharacteristic = <BluetoothRemoteGATTCharacteristic>evt.target;
        const data = chr.value;
        // A frame that fails the magic/CRC check is dropped; erroring the subject would
        // terminate the stream for every subscriber on a single corrupt notification.
        if (data && validateEventData(data)) {
            eventSubject.next(buildTimerEvent(data));
        }
    };
    stateCharacteristic.addEventListener('characteristicvaluechanged', onStateChanged);
    try {
        await stateCharacteristic.startNotifications();
    } catch (e) {
        // Failed startup must not leave the listener installed or the device connected.
        stateCharacteristic.removeEventListener('characteristicvaluechanged', onStateChanged);
        try {
            server.disconnect();
        } catch {
            /* ignore */
        }
        throw e;
    }

    // This action retrieves latest recorded times from timer
    const getRecordedTimesAction = async (): Promise<GanTimerRecordedTimes> => {
        const data = await timeCharacteristic.readValue();
        if (!data || data.byteLength < 16) {
            throw new Error("Invalid time characteristic value received from Timer");
        }
        return {
            displayTime: makeTimeFromRaw(data, 0),
            previousTimes: [makeTimeFromRaw(data, 4), makeTimeFromRaw(data, 8), makeTimeFromRaw(data, 12)]
        };
    }

    // Shared teardown for manual disconnect and the GATT disconnect event. Idempotent,
    // and the server disconnect is not gated behind stopNotifications (a hung stop
    // would otherwise keep the link open forever).
    let tornDown = false;
    const disconnectAction = async (): Promise<void> => {
        if (tornDown) return;
        tornDown = true;
        device.removeEventListener('gattserverdisconnected', disconnectAction);
        stateCharacteristic.removeEventListener('characteristicvaluechanged', onStateChanged);
        eventSubject.next({ state: GanTimerState.DISCONNECT });
        eventSubject.complete();
        const stop = stateCharacteristic.stopNotifications().catch(() => { });
        if (server.connected) {
            server.disconnect();
        }
        await stop;
    }
    device.addEventListener('gattserverdisconnected', disconnectAction);

    return {
        events$: eventSubject,
        getRecordedTimes: getRecordedTimesAction,
        disconnect: disconnectAction,
    };

}

export type {
    GanTimerConnection,
    GanTimerEvent,
    GanTimerTime,
    GanTimerRecordedTimes
};

export {
    connectGanTimer,
    makeTime,
    makeTimeFromTimestamp,
    GanTimerState
};

