import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandRoot = path.join(workspaceRoot, "assets", "brand");
const iconRoot = path.join(workspaceRoot, "apps", "extension", "static", "icons");
const sourceFiles = [
  path.join(brandRoot, "browser-key-automation-icon.svg"),
  path.join(brandRoot, "browser-key-automation-icon-toolbar.svg"),
];

test("brand sources stay flat, two-color, and free of AI-style effects", async () => {
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /<(?:linear|radial)Gradient\b/iu, file);
    assert.doesNotMatch(source, /\b(?:filter|opacity)\s*=/iu, file);
    assert.doesNotMatch(source, /\burl\s*\(/iu, file);
    assert.doesNotMatch(source, /shadow|glow|spark/iu, file);
    const colors = [...new Set([...source.matchAll(/#[0-9A-Fa-f]{6}/gu)].map(([color]) => color.toUpperCase()))].sort();
    assert.deepEqual(colors, ["#2563EB", "#FFFFFF"], file);
  }
});

test("four committed RGBA icons keep exact optical bounds and solid-color mass", async () => {
  for (const size of [16, 32, 48, 128]) {
    const decoded = decodePng(await readFile(path.join(iconRoot, `icon-${size}.png`)));
    assert.equal(decoded.width, size);
    assert.equal(decoded.height, size);
    assert.equal(decoded.bitDepth, 8);
    assert.equal(decoded.colorType, 6);
    assert.equal(decoded.interlace, 0);
    const stats = pixelStats(decoded);
    const margin = size === 128 ? 16 : size / 16;
    assert.equal(stats.bounds.minimumX + stats.bounds.maximumX, size - 1, `icon-${size}.png horizontal centering`);
    assert.equal(stats.bounds.minimumY + stats.bounds.maximumY, size - 1, `icon-${size}.png vertical centering`);
    const tolerance = size === 128 ? 0 : 1;
    assert.ok(Math.abs(stats.bounds.minimumX - margin) <= tolerance, `icon-${size}.png horizontal margin`);
    assert.ok(Math.abs(stats.bounds.minimumY - margin) <= tolerance, `icon-${size}.png vertical margin`);
    assert.ok(stats.transparent > 0, `icon-${size}.png needs a transparent edge`);
    assert.ok(stats.opaque > size * size * 0.5, `icon-${size}.png needs stable opaque mass`);
    assert.ok(stats.pureBlue > 0, `icon-${size}.png is missing its solid brand blue`);
    assert.ok(stats.pureWhite > 0, `icon-${size}.png is missing its solid white glyph`);
    assert.ok(
      Math.abs(stats.whiteBounds.minimumY + stats.whiteBounds.maximumY - (size - 1)) <= Math.max(2, size / 24),
      `icon-${size}.png white glyph optical offset exceeds its bounded clearance`,
    );
    const whiteMassCenterY = stats.whiteMassMomentY / stats.whiteMass;
    assert.ok(
      Math.abs(whiteMassCenterY - size / 2) <= Math.max(0.75, size / 64),
      `icon-${size}.png white visual mass is top- or bottom-heavy: center=${whiteMassCenterY}`,
    );
    assert.ok(stats.partial < size * size * 0.2, `icon-${size}.png has excessive antialiasing`);
  }
});

function decodePng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  let header = null;
  const compressed = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      assert.equal(length, 13);
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  assert.ok(header, "PNG IHDR is missing");
  assert.equal(header.bitDepth, 8);
  assert.equal(header.colorType, 6);
  assert.equal(header.compression, 0);
  assert.equal(header.filter, 0);
  assert.equal(header.interlace, 0);
  const rowBytes = header.width * 4;
  const raw = inflateSync(Buffer.concat(compressed));
  assert.equal(raw.length, (rowBytes + 1) * header.height);
  const pixels = Buffer.alloc(rowBytes * header.height);
  let previous = Buffer.alloc(rowBytes);
  let sourceOffset = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filterType = raw[sourceOffset];
    sourceOffset += 1;
    const current = Buffer.alloc(rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = raw[sourceOffset + x];
      const left = x >= 4 ? current[x - 4] : 0;
      const up = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      let predictor;
      if (filterType === 0) predictor = 0;
      else if (filterType === 1) predictor = left;
      else if (filterType === 2) predictor = up;
      else if (filterType === 3) predictor = Math.floor((left + up) / 2);
      else if (filterType === 4) predictor = paeth(left, up, upperLeft);
      else throw new Error(`Unsupported PNG filter ${filterType}`);
      current[x] = (encoded + predictor) & 0xff;
    }
    current.copy(pixels, y * rowBytes);
    previous = current;
    sourceOffset += rowBytes;
  }
  return { ...header, pixels };
}

function pixelStats({ width, height, pixels }) {
  const stats = {
    transparent: 0,
    partial: 0,
    opaque: 0,
    pureBlue: 0,
    pureWhite: 0,
    whiteMass: 0,
    whiteMassMomentY: 0,
    bounds: { minimumX: width, minimumY: height, maximumX: -1, maximumY: -1 },
    whiteBounds: { minimumX: width, minimumY: height, maximumX: -1, maximumY: -1 },
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      if (alpha === 0) stats.transparent += 1;
      else {
        stats.bounds.minimumX = Math.min(stats.bounds.minimumX, x);
        stats.bounds.minimumY = Math.min(stats.bounds.minimumY, y);
        stats.bounds.maximumX = Math.max(stats.bounds.maximumX, x);
        stats.bounds.maximumY = Math.max(stats.bounds.maximumY, y);
        if (alpha === 255) stats.opaque += 1;
        else stats.partial += 1;
      }
      if (alpha === 255 && red === 37 && green === 99 && blue === 235) stats.pureBlue += 1;
      if (alpha === 255 && red >= 37 && green >= 99 && blue >= 235) {
        const whiteContribution = (red - 37) / (255 - 37);
        stats.whiteMass += whiteContribution;
        stats.whiteMassMomentY += whiteContribution * (y + 0.5);
      }
      if (alpha === 255 && red === 255 && green === 255 && blue === 255) {
        stats.pureWhite += 1;
        stats.whiteBounds.minimumX = Math.min(stats.whiteBounds.minimumX, x);
        stats.whiteBounds.minimumY = Math.min(stats.whiteBounds.minimumY, y);
        stats.whiteBounds.maximumX = Math.max(stats.whiteBounds.maximumX, x);
        stats.whiteBounds.maximumY = Math.max(stats.whiteBounds.maximumY, y);
      }
    }
  }
  return stats;
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}
