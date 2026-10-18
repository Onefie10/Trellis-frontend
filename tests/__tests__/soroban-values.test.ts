import { serializeSorobanValue, splitGenericType, validateSorobanValue } from "../../lib/soroban/values";

describe("Soroban ABI values", () => {
  it("splits nested generic type arguments", () => {
    expect(splitGenericType("Map<Symbol, Vec<u128>>")).toEqual({ name: "Map", args: ["Symbol", "Vec<u128>"] });
  });

  it("validates address prefixes and integer ranges", () => {
    expect(validateSorobanValue("address", "not-an-address")).toContain("valid Stellar");
    expect(validateSorobanValue("u32", "4294967296")).toContain("valid range");
    expect(validateSorobanValue("i128", "-5")).toBeNull();
  });

  it("serializes nested vectors and maps into ScVals", () => {
    const value = [{ key: "scores", value: ["1", "2"] }];
    const scVal = serializeSorobanValue("Map<Symbol, Vec<u32>>", value);
    expect(scVal.switch().name).toBe("scvMap");
    expect(scVal.map()).toHaveLength(1);
    expect(scVal.map()[0].val().vec()).toHaveLength(2);
  });
});
