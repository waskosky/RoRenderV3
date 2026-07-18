"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { encodePng, PNG_SIGNATURE } = require("../lib/png");

function chunks(png) {
  const result = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    result.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return result;
}

test("PNG encoder creates standards-shaped lossless RGBA data", () => {
  const rgba = Buffer.from([1, 2, 3, 4, 250, 251, 252, 253]);
  const png = encodePng({ width: 2, height: 1, rgba });
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  const parsed = chunks(png);
  assert.deepEqual(parsed.map(({ type }) => type), ["IHDR", "IDAT", "IEND"]);
  assert.equal(parsed[0].data.readUInt32BE(0), 2);
  assert.equal(parsed[0].data.readUInt32BE(4), 1);
  const scanline = zlib.inflateSync(parsed[1].data);
  assert.equal(scanline[0], 0);
  assert.deepEqual(scanline.subarray(1), rgba);
});

test("PNG encoder rejects mismatched buffers", () => {
  assert.throws(
    () => encodePng({ width: 2, height: 2, rgba: Buffer.alloc(4) }),
    (error) => error.code === "INVALID_PIXEL_BUFFER",
  );
});
