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
    const t0 = performance.now();
    const traffic = [];
    const now = () => Math.round(performance.now() - t0);
    const toHex = (source) => {
        let view;
        if (source instanceof DataView) view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        else if (source instanceof ArrayBuffer) view = new Uint8Array(source);
        else view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
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
        traffic.push({ t: now(), op, service: characteristic.service.uuid, characteristic: characteristic.uuid, ...extra });
    };

    chr.writeValueWithResponse = function (value) {
        entry('write', this, { data: toHex(value) });
        return original.writeWith.call(this, value);
    };
    chr.writeValueWithoutResponse = function (value) {
        entry('write', this, { data: toHex(value) });
        return original.writeWithout.call(this, value);
    };
    chr.readValue = async function () {
        const value = await original.read.call(this);
        entry('read', this, { data: toHex(value) });
        return value;
    };
    chr.startNotifications = async function () {
        const result = await original.start.call(this);
        this.addEventListener('characteristicvaluechanged', (evt) => {
            const value = evt.target.value;
            if (value) entry('notify', evt.target, { data: toHex(value) });
        });
        return result;
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
                traffic,
                events,
            };
            const blob = new Blob([JSON.stringify(fixture)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            a.click();
            URL.revokeObjectURL(a.href);
        },
        /** Undo the prototype patches (existing notification listeners remain). */
        restore() {
            chr.writeValueWithResponse = original.writeWith;
            chr.writeValueWithoutResponse = original.writeWithout;
            chr.readValue = original.read;
            chr.startNotifications = original.start;
            srv.getPrimaryService = original.getService;
            srv.getPrimaryServices = original.getServices;
            svc.getCharacteristic = original.getCharacteristic;
            svc.getCharacteristics = original.getCharacteristics;
        },
    };
    console.log('[fixture-recorder] recording; use __fixtureRecorder.download(...) when done');
})();
