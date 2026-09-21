/** The hexadecimal of a record, upper case and unspaced - the webview lays the pairs out itself. */
export function toHex(data: Uint8Array): string {
    let hex = '';
    for (const byte of data) hex += HEX[byte];
    return hex;
}

const HEX: string[] = Array.from({ length: 256 }, (_unused, byte) => byte.toString(16).toUpperCase().padStart(2, '0'));
