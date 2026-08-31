import { parseMacBytes } from './smartcube/attachment/mac-address';

/** 6-byte MAC as reversed salt for GAN gen2–4 AES; throws if invalid. */
export function macStringToSaltOrThrow(mac: string): Uint8Array {
    return new Uint8Array(parseMacBytes(mac).reverse());
}
