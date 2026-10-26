// ZIP's uncompressed method: no extra runtime dependency, deterministic archives.
export function calibrationZip(files) {
  const crc32 = bytes => {
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
    return (crc ^ 0xffffffff) >>> 0
  }
  const chunks = [], central = []
  let offset = 0
  for (const [name, data] of files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.split('/').includes('..') || name.startsWith('/')) throw new Error('Invalid archive path')
    const filename = Buffer.from(name), bytes = Buffer.isBuffer(data) ? data : Buffer.from(data), crc = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x5c21, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26)
    chunks.push(local, filename, bytes)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x5c21, 14)
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42)
    central.push(entry, filename); offset += local.length + filename.length + bytes.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, directory, end])
}
