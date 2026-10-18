/** Lossless nonnegative safe integers in fixed-width base64 slots. */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function unpackUnsignedSlots(text: string, width: number): number[] {
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    width > 9 ||
    text.length % width
  )
    throw new Error("Invalid unsigned slot width");
  const values: number[] = [];
  for (let at = 0; at < text.length; at += width) {
    let value = 0;
    for (let digit = 0; digit < width; digit++) {
      const n = ALPHABET.indexOf(text[at + digit]!);
      if (n < 0) throw new Error("Invalid unsigned slot digit");
      value = value * 64 + n;
    }
    if (!Number.isSafeInteger(value)) throw new Error("Invalid unsigned slot");
    values.push(value);
  }
  return values;
}
export function packUnsignedSlots(values: readonly number[]): {
  width: number;
  text: string;
} {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new Error("Invalid unsigned slot value");
  const max = Math.max(1, ...values);
  let width = 1;
  while (64 ** width <= max) width++;
  const text = values
    .map((value) => {
      let rest = value,
        result = "";
      for (let digit = 0; digit < width; digit++) {
        result = ALPHABET[rest % 64]! + result;
        rest = Math.floor(rest / 64);
      }
      return result;
    })
    .join("");
  return { width, text };
}
