/**
 * Web Bluetooth traffic recorder for `smartcube-fixture` captures (see docs/FIXTURES.md).
 *
 * Load this BEFORE connecting (paste into the DevTools console or import in a dev build).
 * It patches the Web Bluetooth prototypes so discovery, reads, writes and notifications are
 * recorded while the library runs normally. Manual tool — not exercised by CI.
 */
(() => {
    if (typeof BluetoothRemoteGATTCharacteristic === 'undefined') {
        console.error('[fixture-recorder] Web Bluetooth is not available in this context');
        return;
    }
    if (window.__fixtureRecorder) {
        // Re-running would capture the patched methods as "originals" and make
        // restore() leave stale wrappers installed.
        console.warn('[fixture-recorder] already installed; call __fixtureRecorder.restore() first');
        return;
    }
    const t0 = performance.now();
    const traffic = [];
    const now = () => Math.round(performance.now() - t0);
    const toHex = (source) => {
        const view =
            source instanceof ArrayBuffer
                ? new Uint8Array(source)
                : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        return Array.from(view).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    };

    const chr = BluetoothRemoteGATTCharacteristic.prototype;
    const srv = BluetoothRemoteGATTServer.prototype;
    const svc = BluetoothRemoteGATTService.prototype;
    const original = {
        writeWith: chr.writeValueWithResponse,
        writeWithout: chr.writeValueWithoutResponse,
        read: chr.readValue,
        start: chr.startNotifications,
        getService: srv.getPrimaryService,
        getServices: srv.getPrimaryServices,
        getCharacteristic: svc.getCharacteristic,
        getCharacteristics: svc.getCharacteristics,
    };

    const entry = (op, characteristic, extra) => {
        const record = { t: now(), op, service: characteristic.service.uuid, characteristic: characteristic.uuid, ...extra };
        traffic.push(record);
        return record;
    };

    // A write is only replay-worthy if the native operation succeeded: mark failures so
    // they can be filtered out instead of becoming phantom replay traffic.
    const installWriteWrapper = (methodName, nativeMethod) => {
        chr[methodName] = async function (value) {
            const record = entry('write', this, { data: toHex(value) });
            try {
                return await nativeMethod.call(this, value);
            } catch (e) {
                record.op = 'write-failed';
                throw e;
            }
        };
    };
    installWriteWrapper('writeValueWithResponse', original.writeWith);
    installWriteWrapper('writeValueWithoutResponse', original.writeWithout);

    chr.readValue = async function () {
        const value = await original.read.call(this);
        entry('read', this, { data: toHex(value) });
        return value;
    };
    // One recorder listener per characteristic, attached BEFORE notifications start so
    // the first notification cannot slip past, and tracked so restore() can remove it.
    const notifyListeners = new Map();
    chr.startNotifications = async function () {
        if (!notifyListeners.has(this)) {
            const listener = (evt) => {
                const value = evt.target.value;
                if (value) entry('notify', evt.target, { data: toHex(value) });
            };
            this.addEventListener('characteristicvaluechanged', listener);
            notifyListeners.set(this, listener);
        }
        try {
            return await original.start.call(this);
        } catch (e) {
            const listener = notifyListeners.get(this);
            if (listener) {
                this.removeEventListener('characteristicvaluechanged', listener);
                notifyListeners.delete(this);
            }
            throw e;
        }
    };
    srv.getPrimaryService = async function (uuid) {
        const service = await original.getService.call(this, uuid);
        traffic.push({ t: now(), op: 'discover-service', service: service.uuid });
        return service;
    };
    srv.getPrimaryServices = async function (...args) {
        const services = await original.getServices.call(this, ...args);
        for (const s of services) traffic.push({ t: now(), op: 'discover-service', service: s.uuid });
        return services;
    };
    svc.getCharacteristic = async function (uuid) {
        const characteristic = await original.getCharacteristic.call(this, uuid);
        traffic.push({ t: now(), op: 'discover-char', service: this.uuid, characteristic: characteristic.uuid });
        return characteristic;
    };
    svc.getCharacteristics = async function (...args) {
        const characteristics = await original.getCharacteristics.call(this, ...args);
        for (const c of characteristics) traffic.push({ t: now(), op: 'discover-char', service: this.uuid, characteristic: c.uuid });
        return characteristics;
    };

    window.__fixtureRecorder = {
        traffic,
        /** Insert a labelled marker (e.g. 'connected', 'scramble start'). */
        marker(text) {
            traffic.push({ t: now(), op: 'marker', service: 'marker', data: String(text) });
        },
        /** Build and download the fixture JSON. `events` may be filled in by hand afterwards. */
        download(filename, device, protocol, events = []) {
            const fixture = {
                format: 'smartcube-fixture',
                version: 1,
                capturedAt: new Date().toISOString(),
                device: { name: device.name || '', id: '', mac: device.mac },
                protocol,
                services: [],
                // failed writes never reached the cube: they are not replayable traffic
                traffic: traffic.filter((e) => e.op !== 'write-failed'),
                events,
            };
            const blob = new Blob([JSON.stringify(fixture)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            // Revoke after the download has been queued; an immediate revoke can hand
            // the browser an already-dead URL.
            setTimeout(() => {
                URL.revokeObjectURL(url);
                a.remove();
            }, 1000);
        },
        /** Undo the prototype patches and detach every recorder notification listener. */
        restore() {
            chr.writeValueWithResponse = original.writeWith;
            chr.writeValueWithoutResponse = original.writeWithout;
            chr.readValue = original.read;
            chr.startNotifications = original.start;
            srv.getPrimaryService = original.getService;
            srv.getPrimaryServices = original.getServices;
            svc.getCharacteristic = original.getCharacteristic;
            svc.getCharacteristics = original.getCharacteristics;
            for (const [characteristic, listener] of notifyListeners) {
                characteristic.removeEventListener('characteristicvaluechanged', listener);
            }
            notifyListeners.clear();
            delete window.__fixtureRecorder;
        },
    };
    console.log('[fixture-recorder] recording; use __fixtureRecorder.download(...) when done');
})();
