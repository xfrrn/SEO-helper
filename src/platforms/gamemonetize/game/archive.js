import { validateBatch } from "./batch.js";

const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let bit = 0; bit < 8; bit++) byte = (byte >>> 1) ^ ((byte & 1) ? 0xedb88320 : 0);
  return byte >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

// shortcut: ZIP entries use storage without compression; add compression if archive size becomes a practical problem.
function zipFiles(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const entry = new DataView(local.buffer);
    entry.setUint32(0, 0x04034b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 0x0800, true);
    entry.setUint16(10, time, true);
    entry.setUint16(12, date, true);
    entry.setUint32(14, crc, true);
    entry.setUint32(18, data.length, true);
    entry.setUint32(22, data.length, true);
    entry.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(8, 0x0800, true);
    record.setUint16(12, time, true);
    record.setUint16(14, date, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint32(42, offset, true);
    central.set(name, 46);
    parts.push(local, data);
    directory.push(central);
    offset += local.length + data.length;
    directorySize += central.length;
    if (offset + directorySize + 22 > 0xffffffff) throw new Error("下载包超过 ZIP32 容量，请分批下载。");
  }
  const end = new Uint8Array(22);
  const record = new DataView(end.buffer);
  record.setUint32(0, 0x06054b50, true);
  record.setUint16(8, files.length, true);
  record.setUint16(10, files.length, true);
  record.setUint32(12, directorySize, true);
  record.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}

export function buildBatchZip(rows) {
  rows = validateBatch({ input: "", rows }).rows;
  const files = [];
  const results = rows.map((row, index) => {
    if (row.status !== "success") return row;
    const { xml, ...capture } = row.capture;
    const xmlFile = `xml/${index + 1}-${capture.gameId}.xml`;
    files.push({ name: xmlFile, content: xml });
    return { inputUrl: row.inputUrl, status: row.status, ...capture, xmlFile };
  });
  const manifest = {
    exportedAt: new Date().toISOString(), total: rows.length,
    success: rows.filter(row => row.status === "success").length,
    failed: rows.filter(row => row.status === "error").length,
    pending: rows.filter(row => row.status === "pending").length,
    results,
  };
  if (!manifest.success) throw new Error("还没有采集成功的游戏，请先完成至少一个游戏再下载。");
  files.unshift({ name: "manifest.json", content: JSON.stringify(manifest, null, 2) + "\n" });
  return zipFiles(files);
}
