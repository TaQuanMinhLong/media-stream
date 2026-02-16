import { describe, expect, test } from "bun:test";
import { decrypt } from "./decrypt";

describe("decrypt", () => {
  test("returns ArrayBuffer of same length (passthrough)", async () => {
    const input = new ArrayBuffer(100);
    const output = await decrypt(input);
    expect(output).toBeInstanceOf(ArrayBuffer);
    expect(output.byteLength).toBe(100);
  });

  test("returns same bytes when passthrough", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const output = await decrypt(bytes.buffer);
    expect(new Uint8Array(output)).toEqual(bytes);
  });
});
