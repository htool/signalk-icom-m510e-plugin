// Icom M510E control frames on UDP.
//
//   0  "Icom"
//   4  0x01
//   5  marker (0xff discover/sign-in, 0x02 set-channel, 0x00 other)
//   8  source IPv4, little-endian
//  12  destination IPv4, little-endian
//  16  command, uint32 little-endian
//  20  body length, uint32 little-endian
//  24  body
//
// Channel numbers are an index: channel * 3 + mode, modes 00 / 10 / 20.
// Voice is RTP payload type 0 on UDP 50001. Keepalive is the 3 bytes
// 80 01 00 on UDP 50002. NMEA 0183 is raw ASCII, not wrapped in Icom.

const MAGIC = Buffer.from('Icom')

const PORT = {
  DISCOVER: 50000,
  VOICE: 50001,
  KEEPALIVE: 50002,
  CONTROL: 50003,
  NMEA: 50004,
}

const Marker = {
  DISCOVER: 0xff,
  SET_CHANNEL: 0x02,
  PLAIN: 0x00,
}

const Command = {
  DISCOVER: 0x00000000,
  SET_CHANNEL: 0x00000001,
  ACK: 0x00000101,
  STATUS: 0x00000201,
  SIGN_IN: 0x00000200,
  ASK_CHANNEL: 0x00000301,
  CHANNEL_TABLE: 0x00000400,
  PROPERTIES: 0x00000500,
  NAMES: 0x00000600,
}

const MODES = ['00', '10', '20']
const MAX_CHANNEL = 88
const NAME_TABLE_LAST_START = 520
const SCAN_SPAN = MAX_CHANNEL * 3 + 3

// Bytes after the model name in an RS-M500 sign-in. The radio checks them.
const RS_M500 = Buffer.from('RS-M500', 'ascii')
const SIGN_IN_TAIL = Buffer.from(
  '00000042134195000000000000000000000000000000000000000000000000000000000000',
  'hex'
)

function writeIp (buffer, offset, ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) {
    throw new Error(`Icom control frames need an IPv4 address, got ${ip}`)
  }
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i])
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`Bad IPv4 address ${ip}`)
    }
    buffer[offset + (3 - i)] = n
  }
}

function readIp (buffer, offset) {
  return `${buffer[offset + 3]}.${buffer[offset + 2]}.${buffer[offset + 1]}.${buffer[offset]}`
}

function encodeFrame ({ srcIp, dstIp, marker, command, body }) {
  const payload = Buffer.from(body)
  const frame = Buffer.alloc(24 + payload.length)
  MAGIC.copy(frame, 0)
  frame[4] = 0x01
  frame[5] = marker
  writeIp(frame, 8, srcIp)
  writeIp(frame, 12, dstIp)
  frame.writeUInt32LE(command, 16)
  frame.writeUInt32LE(payload.length, 20)
  payload.copy(frame, 24)
  return frame
}

function decodeFrame (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  if (!buffer.subarray(0, 4).equals(MAGIC) || buffer[4] !== 0x01) return null
  const command = buffer.readUInt32LE(16)
  const length = buffer.readUInt32LE(20)
  if (length > buffer.length - 24) return null
  return {
    marker: buffer[5],
    srcIp: readIp(buffer, 8),
    dstIp: readIp(buffer, 12),
    command,
    body: buffer.subarray(24, 24 + length),
    raw: buffer,
  }
}

function encodeDiscover (srcIp, replyPort) {
  const body = Buffer.alloc(4)
  body.writeUInt16LE(replyPort, 0)
  return encodeFrame({
    srcIp,
    dstIp: '255.255.255.255',
    marker: Marker.DISCOVER,
    command: Command.DISCOVER,
    body,
  })
}

function encodeSignIn (srcIp, dstIp, ports) {
  const body = Buffer.alloc(2 + 10 + RS_M500.length + SIGN_IN_TAIL.length)
  let offset = 0
  body.writeUInt16LE(2, offset)
  offset += 2
  for (const port of [ports.data, ports.voice, ports.keepalive, ports.control, ports.extra]) {
    body.writeUInt16LE(port, offset)
    offset += 2
  }
  RS_M500.copy(body, offset)
  offset += RS_M500.length
  SIGN_IN_TAIL.copy(body, offset)
  return encodeFrame({
    srcIp,
    dstIp,
    marker: Marker.DISCOVER,
    command: Command.SIGN_IN,
    body,
  })
}

function encodeChannelTableRequest (srcIp, dstIp, part) {
  const body = part === 1 ? Buffer.from([0x00, 0x00, 0x00, 0x00]) : Buffer.from([0x01, 0x00])
  return encodeFrame({
    srcIp,
    dstIp,
    marker: Marker.PLAIN,
    command: Command.CHANNEL_TABLE,
    body,
  })
}

function encodeAskChannel (srcIp, dstIp) {
  return encodeFrame({
    srcIp,
    dstIp,
    marker: Marker.PLAIN,
    command: Command.ASK_CHANNEL,
    body: Buffer.alloc(0),
  })
}

function encodeSetChannel (srcIp, dstIp, index) {
  const body = Buffer.alloc(8)
  body[0] = 0x03
  body[4] = 0x01
  body.writeUInt16LE(index, 6)
  return encodeFrame({
    srcIp,
    dstIp,
    marker: Marker.SET_CHANNEL,
    command: Command.SET_CHANNEL,
    body,
  })
}

function encodeStatus (srcIp, dstIp, index, fields = {}) {
  const body = Buffer.alloc(16)
  body[0] = 0x00
  body[1] = 0xff
  body.writeUInt16LE(index, 2)
  body.writeUInt16LE(0x0030, 4)
  body.writeUInt16LE(index, 6)
  body[8] = 0x02
  body[9] = 0x05
  body[10] = fields.squelch == null ? 0 : fields.squelch
  body[11] = fields.busy ? 0x80 : 0x00
  body[12] = fields.power == null ? 0x0f : fields.power
  return encodeFrame({
    srcIp,
    dstIp,
    marker: Marker.PLAIN,
    command: Command.STATUS,
    body,
  })
}

// Level is 0-10. The channel index belongs in the same slots the status frame uses.
function encodeSquelch (srcIp, dstIp, index, level) {
  const body = Buffer.alloc(16)
  body[0] = 0x02
  body[1] = 0x03
  body.writeUInt16LE(index, 2)
  body.writeUInt16LE(0x0030, 4)
  body.writeUInt16LE(index, 6)
  body[8] = 0x02
  body[9] = 0x05
  body[10] = level
  body[12] = 0x07
  return encodeFrame({
    srcIp,
    dstIp,
    marker: Marker.PLAIN,
    command: Command.STATUS,
    body,
  })
}

function encodeKeepAlive () {
  return Buffer.from([0x80, 0x01, 0x00])
}

function decodePower (byte) {
  switch (byte) {
    case 0x03: return { watt: 1, hilo: false }
    case 0x07: return { watt: 1, hilo: true }
    case 0x0b: return { watt: 1, hilo: true }
    case 0x0f: return { watt: 25, hilo: true }
    default: return null
  }
}

function parseStatus (body) {
  if (!body || body.length < 13 || body[0] !== 0x00 || body[1] !== 0xff) return null
  const power = decodePower(body[12])
  return {
    index: body.readUInt16LE(2),
    indexRepeat: body.readUInt16LE(6),
    squelch: body[10],
    busy: (body[11] & 0x80) !== 0,
    watt: power ? power.watt : null,
    hilo: power ? power.hilo : null,
    power: body[12],
  }
}

function parseAck (body) {
  if (!body || body.length < 2) return null
  return { subtype: body[0], ok: body[1] === 0xff }
}

// Name blocks start at byte 28: uint16 start, one skipped byte, then
// 11-byte records (one prefix byte + 10 character name). Start value 520
// is the last block the radio sends.
function parseNames (buffer) {
  const frame = decodeFrame(buffer)
  if (!frame || frame.command !== Command.NAMES || buffer.length < 31) return null
  const start = buffer.readUInt16LE(28)
  const names = []
  let offset = 31
  while (buffer.length - offset > 10) {
    names.push(buffer.toString('utf8', offset + 1, offset + 11).trim())
    offset += 11
  }
  return { start, names, done: start === NAME_TABLE_LAST_START }
}

function parseProperties (buffer) {
  const frame = decodeFrame(buffer)
  if (!frame || frame.command !== Command.PROPERTIES || buffer.length < 32) return null
  return {
    propertyType: buffer[24],
    offset: buffer[28],
    payload: Buffer.from(buffer.subarray(32)),
  }
}

// Favourite flag and the 24-bit channel properties were matched against the
// handset while each byte was expanded with parseInt(String(byte), 16).
// The bit positions below are in that expansion, not in the raw byte.
function propertyBits (byte) {
  const expanded = Number.parseInt(String(byte), 16)
  return (expanded & 0xff).toString(2).padStart(8, '0')
}

function favouriteFromFlag (byte) {
  const bits = propertyBits(byte)
  return bits[3] === bits[5]
}

function fieldsFromPropertyBits (bits) {
  const at = 15
  return {
    fav: bits[at + 4] === bits[at + 6],
    enabled: bits[8] === '0',
    watt: bits[at + 4] === '0' ? 25 : 1,
    duplex: bits[at + 7] === '0' && bits[at + 4] !== '1',
  }
}

function propertyRecords (bytes) {
  const records = []
  let offset = 0
  while (offset + 3 <= bytes.length) {
    const bits = propertyBits(bytes[offset]) +
      propertyBits(bytes[offset + 1]) +
      propertyBits(bytes[offset + 2])
    records.push(fieldsFromPropertyBits(bits))
    offset += 3
  }
  return records
}

function parseFavourite (buffer) {
  const frame = decodeFrame(buffer)
  if (!frame || buffer.length < 33 || buffer.length > 64) return null
  if (frame.command === Command.STATUS || frame.command === Command.ACK ||
      frame.command === Command.NAMES || frame.command === Command.PROPERTIES ||
      frame.command === Command.SET_CHANNEL) {
    return null
  }
  const index = buffer.readUInt16LE(28)
  if (index > MAX_CHANNEL * 3 + 2) return null
  return { index, favourite: favouriteFromFlag(buffer[32]) }
}

function parseHorn (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 32 || !buffer.subarray(0, 4).equals(MAGIC)) {
    return null
  }
  if (buffer[26] === 0x50) return { on: true }
  if (buffer[26] === 0x40) return { on: false }
  return null
}

function readNmeaSentences (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return []
  const first = buffer[0]
  if (first !== 0x24 && first !== 0x21) return []
  return buffer.toString('latin1')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('$') || line.startsWith('!'))
}

function isKeepAlive (buffer) {
  if (buffer.length === 3 && buffer[0] === 0x80 && buffer[1] === 0x01 && buffer[2] === 0x00) {
    return true
  }
  return buffer.length >= 2 && buffer[0] === 0x80 && (buffer[1] === 0xc8 || buffer[1] === 0xc9)
}

function isRtp (buffer) {
  return buffer.length >= 12 && (buffer[0] >> 6) === 2 && (buffer[1] & 0x7f) === 0
}

function classify (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { type: 'unknown' }
  const sentences = readNmeaSentences(buffer)
  if (sentences.length) return { type: 'nmea', sentences }
  if (isKeepAlive(buffer)) return { type: 'keepalive' }
  if (isRtp(buffer)) return { type: 'rtp' }
  const frame = decodeFrame(buffer)
  if (!frame) return { type: 'unknown' }
  if (frame.command === Command.ACK) {
    return { type: 'ack', ...parseAck(frame.body), frame }
  }
  if (frame.command === Command.STATUS) {
    const status = parseStatus(frame.body)
    if (status) return { type: 'status', ...status, frame }
  }
  if (frame.command === Command.NAMES) {
    const names = parseNames(buffer)
    if (names) return { type: 'names', ...names, frame }
  }
  if (frame.command === Command.PROPERTIES) {
    const properties = parseProperties(buffer)
    if (properties) return { type: 'properties', ...properties, frame }
  }
  if (frame.command === Command.SET_CHANNEL && frame.body.length >= 8) {
    return { type: 'set-channel', index: frame.body.readUInt16LE(6), frame }
  }
  const horn = parseHorn(buffer)
  if (horn) return { type: 'horn', ...horn, frame }
  const favourite = parseFavourite(buffer)
  if (favourite) return { type: 'favourite', ...favourite, frame }
  return { type: 'icom', frame }
}

function splitIndex (index) {
  const modeIndex = index % 3
  return {
    nr: Math.floor(index / 3),
    mode: MODES[modeIndex],
    modeIndex,
  }
}

function channelIndex (nr, mode) {
  const modeIndex = MODES.indexOf(mode)
  if (modeIndex < 0) return null
  return nr * 3 + modeIndex
}

function formatChannel (nr, mode) {
  if (nr == null || mode == null) return ''
  if (mode === '00') return String(nr)
  return mode + String(nr).padStart(2, '0')
}

function parseChannelCommand (value) {
  const text = String(value)
  if (text === 'scanStop' || text === 'scanAll' || text === 'scanFav' || text === '+1' || text === '-1') {
    return { op: text }
  }
  if (text.length === 4) {
    const modeIndex = MODES.indexOf(text.slice(0, 2))
    const nr = Number.parseInt(text.slice(2), 10)
    if (modeIndex < 0 || Number.isNaN(nr)) return null
    return { op: 'set', index: nr * 3 + modeIndex }
  }
  const nr = Number.parseInt(text, 10)
  if (Number.isNaN(nr)) return null
  return { op: 'set', index: nr * 3 }
}

// Same walk the handset plugin used: the search never lands on index 0.
function nextChannelIndex (fromIndex, direction, accept) {
  let n = fromIndex
  for (let i = 0; i < SCAN_SPAN; i++) {
    if (n > MAX_CHANNEL * 3) n = 2
    else if (n < 2) n = MAX_CHANNEL * 3 + 1
    n += direction
    if (accept(n)) return n
  }
  return null
}

module.exports = {
  PORT,
  Marker,
  Command,
  MODES,
  MAX_CHANNEL,
  NAME_TABLE_LAST_START,
  encodeFrame,
  decodeFrame,
  encodeDiscover,
  encodeSignIn,
  encodeChannelTableRequest,
  encodeAskChannel,
  encodeSetChannel,
  encodeStatus,
  encodeSquelch,
  encodeKeepAlive,
  decodePower,
  parseStatus,
  parseNames,
  parseProperties,
  propertyBits,
  favouriteFromFlag,
  fieldsFromPropertyBits,
  propertyRecords,
  readNmeaSentences,
  classify,
  splitIndex,
  channelIndex,
  formatChannel,
  parseChannelCommand,
  nextChannelIndex,
}
