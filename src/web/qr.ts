import { encode } from 'uqr';

export interface QrMatrix {
  /** Modules per side, without the quiet zone. */
  size: number;
  /** SVG path of the dark modules (one rectangle per horizontal run), in module units. */
  path: string;
}

/** Encodes text (e.g. an otpauth:// URI) as a QR code, rendered server-side as an SVG path. */
export function qrMatrix(text: string): QrMatrix {
  const { size, data } = encode(text, { ecc: 'M', border: 0 });
  let path = '';
  data.forEach((row, y) => {
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return { size, path };
}
