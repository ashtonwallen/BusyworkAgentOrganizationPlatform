export const usdPattern = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;

/** USD precision matches NUMERIC(18,6). Never convert monetary strings to Number. */
export function parseUsd(value: string): bigint {
  if (typeof value !== "string" || !usdPattern.test(value)) {
    throw new Error("USD must be a nonnegative decimal with at most six fractional digits.");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
