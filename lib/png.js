"use strict";

const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { ProtocolError } = require("./errors");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.allocUnsafe(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

const deflate = promisify(zlib.deflate);

function prepareImage({ width, height, rgba }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new ProtocolError("INVALID_IMAGE_SIZE", "PNG dimensions must be positive integers");
  }
  if (!Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) {
    throw new ProtocolError("INVALID_PIXEL_BUFFER", "RGBA buffer length does not match image dimensions");
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const rowBytes = width * 4;
  const scanlines = Buffer.allocUnsafe((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (rowBytes + 1);
    scanlines[targetOffset] = 0;
    rgba.copy(scanlines, targetOffset + 1, row * rowBytes, (row + 1) * rowBytes);
  }

  return { header, scanlines };
}

function assemblePng(header, compressed) {
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodePng({ width, height, rgba, compressionLevel = 6 }) {
  const { header, scanlines } = prepareImage({ width, height, rgba });
  return assemblePng(header, zlib.deflateSync(scanlines, { level: compressionLevel }));
}

async function encodePngAsync({ width, height, rgba, compressionLevel = 6 }) {
  const { header, scanlines } = prepareImage({ width, height, rgba });
  return assemblePng(header, await deflate(scanlines, { level: compressionLevel }));
}

module.exports = { PNG_SIGNATURE, encodePng, encodePngAsync };
