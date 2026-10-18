import * as StellarSdk from "@stellar/stellar-sdk";

const INTEGER_BITS: Record<string, { min: bigint; max: bigint }> = {
  u32: { min: 0n, max: 4_294_967_295n },
  i32: { min: -2_147_483_648n, max: 2_147_483_647n },
  u64: { min: 0n, max: 18_446_744_073_709_551_615n },
  i64: { min: -9_223_372_036_854_775_808n, max: 9_223_372_036_854_775_807n },
  u128: { min: 0n, max: 340_282_366_920_938_463_463_374_607_431_768_211_455n },
  i128: { min: -170_141_183_460_469_231_731_687_303_715_884_105_728n, max: 170_141_183_460_469_231_731_687_303_715_884_105_727n },
  u256: { min: 0n, max: 115792089237316195423570985008687907853269984665640564039457584007913129639935n },
  i256: { min: -57896044618658097711785492504343953926634992332820282019728792003956564819968n, max: 57896044618658097711785492504343953926634992332820282019728792003956564819967n },
};

export type SorobanInputType =
  | { kind: "boolean" | "text" | "number" | "address" | "json"; type: string }
  | { kind: "optional"; type: string; childType: string };

function unwrapType(type: string) {
  return type.replace(/^\s+|\s+$/g, "");
}

export function splitGenericType(type: string): { name: string; args: string[] } {
  const normalized = unwrapType(type);
  const open = normalized.indexOf("<");
  if (open < 0 || !normalized.endsWith(">")) return { name: normalized, args: [] };
  const name = normalized.slice(0, open).trim();
  const inner = normalized.slice(open + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] === "<") depth += 1;
    if (inner[index] === ">") depth -= 1;
    if (inner[index] === "," && depth === 0) {
      args.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return { name, args };
}

export function getSorobanInputType(type: string): SorobanInputType {
  const normalized = unwrapType(type);
  const { name, args } = splitGenericType(normalized);
  const lowerName = name.toLowerCase();
  if (lowerName === "option" && args.length === 1) return { kind: "optional", type: normalized, childType: args[0] };
  if (lowerName === "vec" || lowerName === "map" || lowerName === "tuple") return { kind: "json", type: normalized };
  if (lowerName === "bool") return { kind: "boolean", type: normalized };
  if (lowerName === "address") return { kind: "address", type: normalized };
  if (INTEGER_BITS[lowerName] || lowerName === "timepoint" || lowerName === "duration") return { kind: "number", type: normalized };
  return { kind: "text", type: normalized };
}

function isAddress(value: unknown): boolean {
  return typeof value === "string" && /^[GC][A-Z2-7]{55}$/.test(value);
}

export function validateSorobanValue(type: string, value: unknown): string | null {
  const normalized = unwrapType(type);
  const { name, args } = splitGenericType(normalized);
  const lowerName = name.toLowerCase();
  if (lowerName === "option" && args.length === 1) return value === null || value === "" ? null : validateSorobanValue(args[0], value);
  if (lowerName === "vec" && args.length === 1) {
    if (!Array.isArray(value)) return "Expected a JSON array.";
    for (const item of value) { const error = validateSorobanValue(args[0], item); if (error) return error; }
    return null;
  }
  if (lowerName === "map" && args.length === 2) {
    if (!Array.isArray(value)) return "Expected an array of {key, value} entries.";
    for (const item of value) {
      if (!item || typeof item !== "object" || !("key" in item) || !("value" in item)) return "Map entries must contain key and value.";
      const keyError = validateSorobanValue(args[0], (item as { key: unknown }).key);
      const valueError = validateSorobanValue(args[1], (item as { value: unknown }).value);
      if (keyError || valueError) return keyError ?? valueError;
    }
    return null;
  }
  if (lowerName === "bool" && typeof value !== "boolean") return "Enter true or false.";
  if (lowerName === "address" && !isAddress(value)) return "Enter a valid Stellar G... or C... address.";
  if (lowerName === "bytes" && (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(value))) return "Enter a hexadecimal byte string.";
  if (INTEGER_BITS[lowerName]) {
    if (!/^-?\d+$/.test(String(value))) return `${lowerName} must be an integer.`;
    const number = BigInt(String(value));
    if (number < INTEGER_BITS[lowerName].min || number > INTEGER_BITS[lowerName].max) return `${lowerName} is outside its valid range.`;
  }
  return null;
}

function toNativeValue(type: string, value: unknown): unknown {
  const { name, args } = splitGenericType(type);
  const lowerName = name.toLowerCase();
  if (lowerName === "vec" && args.length === 1) return (value as unknown[]).map((item) => toNativeValue(args[0], item));
  if (lowerName === "map" && args.length === 2) return (value as { key: unknown; value: unknown }[]).map((item) => [toNativeValue(args[0], item.key), toNativeValue(args[1], item.value)]);
  if (lowerName === "option" && args.length === 1) return value === null || value === "" ? null : toNativeValue(args[0], value);
  if (INTEGER_BITS[lowerName]) return lowerName === "u32" || lowerName === "i32" ? Number(value) : BigInt(String(value));
  return value;
}

export function serializeSorobanValue(type: string, value: unknown): StellarSdk.xdr.ScVal {
  const error = validateSorobanValue(type, value);
  if (error) throw new Error(`${type}: ${error}`);
  const { name, args } = splitGenericType(type);
  const lowerName = name.toLowerCase();
  if (lowerName === "vec" && args.length === 1) {
    return StellarSdk.xdr.ScVal.scvVec((value as unknown[]).map((item) => serializeSorobanValue(args[0], item)));
  }
  if (lowerName === "map" && args.length === 2) {
    return StellarSdk.xdr.ScVal.scvMap((value as { key: unknown; value: unknown }[]).map((item) => StellarSdk.xdr.ScMapEntry({ key: serializeSorobanValue(args[0], item.key), val: serializeSorobanValue(args[1], item.value) })));
  }
  if (lowerName === "option" && args.length === 1 && (value === null || value === "")) return StellarSdk.xdr.ScVal.scvVoid();
  return StellarSdk.nativeToScVal(toNativeValue(type, value), { type: lowerName as never });
}

export function parseFormValue(type: string, raw: string): unknown {
  const input = getSorobanInputType(type);
  if (input.kind === "boolean") return raw === "true";
  if (input.kind === "json") return JSON.parse(raw);
  if (input.kind === "optional" && raw.trim() === "") return null;
  return raw;
}
