/**
 * Encrypt/decrypt round-trip and streaming response tests.
 * Run: bun test src/crypto.test.ts
 */
import { describe, expect, test } from "bun:test";
import { deriveKey, openSealedData, sealChunksStreaming, sealData } from "@media-stream/secret";
import { Elysia } from "elysia";

describe("sealData + openSealedData round-trip", () => {
  test("round-trip recovers original data", () => {
    const sessionId = "test-session";
    const salt = Buffer.alloc(16);
    salt.write("saltsaltsaltsalt");
    const key = deriveKey(sessionId, salt);
    const data = Buffer.from("hello fMP4 segment");
    const sealed = sealData(data, key);
    expect(sealed.length).toBeGreaterThan(data.length);
    expect(sealed.subarray(0, 4).toString()).toBe("RIFF");

    const opened = openSealedData(sealed, key);
    expect(Buffer.compare(opened, data)).toBe(0);
  });

  test("wrong key returns garbage or throws", () => {
    const key = Buffer.alloc(32);
    const wrongKey = Buffer.alloc(32, 1);
    const data = Buffer.from("secret");
    const sealed = sealData(data, key);
    expect(() => openSealedData(sealed, wrongKey)).toThrow();
  });
});

describe("sealChunksStreaming output format", () => {
  test("callback receives binary Buffer starting with RIFF", () => {
    const key = Buffer.alloc(32);
    const data = Buffer.from("test chunk");
    const chunks: Buffer[] = [];

    sealChunksStreaming([data], key, (chunk: Buffer) => {
      chunks.push(Buffer.from(chunk));
    });

    expect(chunks.length).toBe(1);
    const sealed = chunks[0]!;
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed[0]).toBe(0x52); // 'R'
    expect(sealed[1]).toBe(0x49); // 'I'
    expect(sealed[2]).toBe(0x46); // 'F'
    expect(sealed[3]).toBe(0x46); // 'F'

    const opened = openSealedData(sealed, key);
    expect(Buffer.compare(opened, data)).toBe(0);
  });

  test("streaming output is valid sealed data (round-trip)", () => {
    const sessionId = "stream-test";
    const salt = Buffer.alloc(16, 42);
    const key = deriveKey(sessionId, salt);
    const rawSegment = Buffer.alloc(1000);
    for (let i = 0; i < rawSegment.length; i++) rawSegment[i] = i % 256;

    const collected: Buffer[] = [];
    sealChunksStreaming([rawSegment], key, (chunk) => {
      collected.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer));
    });

    const sealed = Buffer.concat(collected);
    const opened = openSealedData(sealed, key);
    expect(Buffer.compare(opened, rawSegment)).toBe(0);
  });
});

describe("Elysia ReadableStream binary response", () => {
  test("returning Response(stream) preserves binary; raw ReadableStream gets JSON-serialized", async () => {
    const key = Buffer.alloc(32);
    const rawData = Buffer.from("binary payload");
    const stream = new ReadableStream({
      type: "direct",
      pull(controller) {
        sealChunksStreaming([rawData], key, (chunk: Buffer) => {
          controller.write(chunk);
        });
        controller.close();
      },
    });

    const app = new Elysia().get("/binary", () => {
      return new Response(stream, {
        headers: { "Content-Type": "application/octet-stream" },
      });
    });

    const res = await app.handle(new Request("http://localhost/binary"));
    const ct = res.headers.get("Content-Type") ?? "";
    expect(ct).toContain("application/octet-stream");

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
    const bytes = new Uint8Array(body);
    expect(bytes[0]).toBe(0x52); // RIFF
    expect(bytes[1]).toBe(0x49);
    expect(bytes[2]).toBe(0x46);
    expect(bytes[3]).toBe(0x46);

    const sealed = Buffer.from(body);
    const opened = openSealedData(sealed, key);
    expect(Buffer.compare(opened, rawData)).toBe(0);
  });
});
