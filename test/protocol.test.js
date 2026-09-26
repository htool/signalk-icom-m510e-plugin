const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const protocol = require('../protocol')

const CAPTURE = path.join(__dirname, '../../icom/capture.pcap.gz')

function readCapture (file) {
  const data = zlib.gunzipSync(fs.readFileSync(file))
  const linkType = data.readUInt32LE(20)
  if (linkType !== 1) throw new Error(`expected ethernet capture, got link type ${linkType}`)
  const packets = []
  let offset = 24
  while (offset + 16 <= data.length) {
    const included = data.readUInt32LE(offset + 8)
    offset += 16
    const frame = data.subarray(offset, offset + included)
    offset += included
    if (frame.length < 14 + 20 + 8) continue
    if (frame.readUInt16BE(12) !== 0x0800) continue
    const ip = frame.subarray(14)
    const headerLength = (ip[0] & 0x0f) * 4
    if (ip[9] !== 17) continue
    const udp = ip.subarray(headerLength)
    const srcPort = udp.readUInt16BE(0)
    const dstPort = udp.readUInt16BE(2)
    const length = udp.readUInt16BE(4)
    packets.push({
      src: `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`,
      dst: `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}`,
      srcPort,
      dstPort,
      payload: Buffer.from(udp.subarray(8, length)),
    })
  }
  return packets
}

function legacyIp (ip) {
  return ip.split('.').map((part) => Number(part).toString(16).padStart(2, '0')).reverse().join('')
}

function legacyPort (port) {
  const hex = port.toString(16)
  return hex[2] + hex[3] + hex[0] + hex[1]
}

test('set-channel bytes match the capture', () => {
  const packets = readCapture(CAPTURE)
  const sample = packets.find((packet) => protocol.classify(packet.payload).type === 'set-channel')
  const decoded = protocol.classify(sample.payload)
  const encoded = protocol.encodeSetChannel(decoded.frame.srcIp, decoded.frame.dstIp, decoded.index)
  assert.deepEqual(encoded, sample.payload)
  assert.equal(decoded.index, 112)
  assert.deepEqual(protocol.splitIndex(112), { nr: 37, mode: '10', modeIndex: 1 })
})

test('capture control, voice, keepalive, and NMEA', () => {
  const packets = readCapture(CAPTURE)
  const counts = {}
  const channels = new Set()
  for (const packet of packets) {
    const message = protocol.classify(packet.payload)
    counts[message.type] = (counts[message.type] || 0) + 1
    if (message.type === 'set-channel') channels.add(message.index)
    if (message.type === 'status') {
      assert.equal(message.index, message.indexRepeat)
      assert.equal(message.squelch, 3)
      assert.ok(message.power === 0x03 || message.power === 0x0f)
      assert.equal(message.busy, (packet.payload[35] & 0x80) !== 0)
    }
    if (message.type === 'nmea') {
      assert.equal(message.sentences.length, 1)
      assert.match(message.sentences[0], /^\$[A-Z]{4,5},/)
    }
  }
  assert.deepEqual(channels, new Set([112, 183, 93]))
  assert.equal(counts['set-channel'], 19)
  assert.equal(counts.ack, 20)
  assert.equal(counts.status, 16)
  assert.equal(counts.nmea, 99)
  assert.equal(counts.rtp, 184)
  assert.equal(counts.keepalive, 4)
  assert.equal(packets.length, 342)
})

test('status round-trip', () => {
  const frame = protocol.encodeStatus('192.168.1.146', '192.168.1.25', 93, {
    squelch: 3,
    busy: true,
    power: 0x0f,
  })
  const message = protocol.classify(frame)
  assert.equal(message.type, 'status')
  assert.equal(message.index, 93)
  assert.equal(message.busy, true)
  assert.equal(message.watt, 25)
  assert.equal(message.hilo, true)
  assert.equal(message.groupName, 5)
  assert.equal(protocol.channelGroupLabel(message.groupName, message.wx), 'ATIS')
  assert.equal(protocol.channelGroupLabel(2, true), 'WX')
  assert.equal(protocol.channelGroupLabel(1, false), 'USA')
  assert.equal(protocol.channelGroupLabel(0, false), '')
  assert.equal(protocol.formatChannel(31, '00'), '31')
  assert.equal(protocol.formatChannel(37, '10'), '1037')
})

test('discovery, sign-in, table request, ask, squelch, and keepalive match the old layout', () => {
  const src = '192.168.1.25'
  const radio = '192.168.1.146'
  const ports = { data: 0x4101, voice: 0x4102, keepalive: 0x4103, control: 0x4104, extra: 0x4105 }
  const discover = protocol.encodeDiscover(src, 0x9c40)
  assert.equal(
    discover.toString('hex'),
    '49636f6d01ff0000' + legacyIp(src) + legacyIp('255.255.255.255') + '0000000004000000' + legacyPort(0x9c40) + '0000'
  )

  const signIn = protocol.encodeSignIn(src, radio, ports)
  const signInBody = '0200' +
    legacyPort(ports.data) + legacyPort(ports.voice) + legacyPort(ports.keepalive) +
    legacyPort(ports.control) + legacyPort(ports.extra) +
    Buffer.from('RS-M500').toString('hex') +
    '00000042134195000000000000000000000000000000000000000000000000000000000000'
  assert.equal(signInBody.length / 2, 0x38)
  assert.equal(
    signIn.toString('hex'),
    '49636f6d01ff0000' + legacyIp(src) + legacyIp(radio) + '0002000038000000' + signInBody
  )

  const table = protocol.encodeChannelTableRequest(src, radio, 1)
  assert.equal(
    table.toString('hex'),
    '49636f6d01000000' + legacyIp(src) + legacyIp(radio) + '000400000400000000000000'
  )
  const ask = protocol.encodeAskChannel(src, radio)
  assert.equal(
    ask.toString('hex'),
    '49636f6d01000000' + legacyIp(src) + legacyIp(radio) + '0103000000000000'
  )
  const squelch = protocol.encodeSquelch(src, radio, 0x5d, 4)
  assert.equal(
    squelch.toString('hex'),
    '49636f6d01020000' + legacyIp(src) + legacyIp(radio) + '01000000080000000300000002000400'
  )
  assert.equal(protocol.encodeKeepAlive().toString('hex'), '800100')
})

test('names, properties, horn, and favourite frames', () => {
  const names = Buffer.alloc(24 + 7 + 22)
  names.write('Icom')
  names[4] = 0x01
  names.writeUInt32LE(protocol.Command.NAMES, 16)
  names.writeUInt32LE(names.length - 24, 20)
  names.writeUInt16LE(520, 28)
  names.write('DISTRESS  ', 32)
  names.write('WEATHER   ', 43)
  const parsedNames = protocol.classify(names)
  assert.equal(parsedNames.type, 'names')
  assert.deepEqual(parsedNames.names, ['DISTRESS', 'WEATHER'])
  assert.equal(parsedNames.done, true)

  const properties = Buffer.alloc(24 + 8 + 3)
  properties.write('Icom')
  properties[4] = 0x01
  properties.writeUInt32LE(protocol.Command.PROPERTIES, 16)
  properties.writeUInt32LE(properties.length - 24, 20)
  properties[28] = 0
  const parsedProperties = protocol.classify(properties)
  assert.equal(parsedProperties.type, 'properties')
  assert.deepEqual(protocol.propertyRecords(parsedProperties.payload), [
    { fav: false, enabled: true, watt: 25, duplex: true },
    { fav: false, enabled: true, watt: 25, duplex: true },
    { fav: false, enabled: true, watt: 25, duplex: true },
  ])
  assert.deepEqual(protocol.channelFlags(0xe2), {
    fav: true,
    enabled: false,
    watt: 1,
    duplex: false,
  })

  const horn = Buffer.alloc(32)
  horn.write('Icom')
  horn[4] = 0x01
  horn[26] = 0x50
  horn.writeUInt32LE(8, 20)
  assert.deepEqual(protocol.classify(horn), { type: 'horn', on: true, frame: protocol.decodeFrame(horn) })
})

test('set-favourite frame is 46 bytes with the on and off flags', () => {
  const on = protocol.encodeSetFavourite('192.168.2.1', '192.168.2.18', 48, true)
  const off = protocol.encodeSetFavourite('192.168.2.1', '192.168.2.18', 48, false)
  assert.equal(on.length, 46)
  assert.equal(on.readUInt32LE(16), 0x90)
  assert.equal(on.readUInt16LE(28), 48)
  assert.equal(on[32], 0x00)
  assert.equal(off[32], 0x40)
})

test('favourite flag and property bits keep the old expansion', () => {
  function legacyBits (byte) {
    return ('00000000' + Number.parseInt(byte, 16).toString(2)).slice(-8)
  }
  for (let byte = 0; byte < 256; byte++) {
    assert.equal(protocol.propertyBits(byte), legacyBits(byte))
    const bits = legacyBits(byte)
    const a = Number(bits[3])
    const b = Number(bits[5])
    const favourite = a ? !b : b
    assert.equal(protocol.favouriteFromFlag(byte), !favourite)
  }
})

test('nearest VHF value yields one channel', () => {
  const station = {
    id: 'lock-near',
    name: 'Near lock',
    type: 'lock',
    channel: '12/16',
    distance: -12,
  }
  assert.equal(protocol.channelFromFollowValue(JSON.stringify(station)), '12')
  assert.equal(protocol.channelFromFollowValue(station), '12')
  assert.equal(protocol.channelFromFollowValue({ properties: { channel: '04 / 65' } }), '4')
  assert.equal(protocol.channelFromFollowValue({ channel: 22 }), '22')
  assert.equal(protocol.channelFromFollowValue('71/72,73'), '71')
  assert.deepEqual(protocol.channelsFromFollowValue('71/72,73'), [71, 72, 73])
  assert.deepEqual(protocol.channelsFromFollowValue({ channel: '04 / 65' }), [4, 65])
  assert.deepEqual(protocol.channelsFromFollowValue([{ channel: '12' }, { channel: '16/12' }]), [12, 16])
  assert.equal(protocol.channelFromFollowValue(null), '')
  assert.equal(protocol.channelFromFollowValue('null'), '')
  assert.deepEqual(protocol.parseChannelCommand('12'), { op: 'set', index: 36 })
})

test('channel commands and the scan walk', () => {
  assert.deepEqual(protocol.parseChannelCommand('+1'), { op: '+1' })
  assert.deepEqual(protocol.parseChannelCommand('scanFav'), { op: 'scanFav' })
  assert.deepEqual(protocol.parseChannelCommand('16'), { op: 'set', index: 48 })
  assert.deepEqual(protocol.parseChannelCommand('1037'), { op: 'set', index: 112 })
  assert.equal(protocol.parseChannelCommand('9937'), null)

  const enabled = new Set([3, 6])
  const accept = (index) => enabled.has(index)
  assert.equal(protocol.nextChannelIndex(3, 1, accept), 6)
  assert.equal(protocol.nextChannelIndex(6, -1, accept), 3)
  assert.equal(protocol.nextChannelIndex(6, 1, accept), 3)
  assert.equal(protocol.nextChannelIndex(0, 1, (index) => index === 0), null)
  assert.equal(protocol.nextChannelIndex(3, -1, (index) => index === 1), 1)
})

test('voice RTP payload decodes μ-law silence to PCM', () => {
  const packet = Buffer.alloc(13)
  packet[0] = 0x80
  packet[1] = 0x00
  packet[12] = 0xff
  const payload = protocol.rtpPayload(packet)
  assert.equal(payload.length, 1)
  assert.equal(protocol.mulawToPcm(payload).readInt16LE(0), 0)
  assert.equal(protocol.rtpPayload(Buffer.from('Icom')), null)
  const encoded = protocol.pcmToMulaw(Buffer.from([0x00, 0x00]))
  assert.equal(encoded[0], 0xff)
  const rtp = protocol.encodeRtp(encoded, 1, 320, 0x2250b644)
  assert.equal(rtp[0], 0x80)
  assert.equal(rtp.length, 13)
  assert.equal(protocol.rtpPayload(rtp)[0], 0xff)
})

test('rejects a truncated Icom frame and ignores the odd keepalive nibble', () => {
  assert.equal(protocol.decodeFrame(Buffer.from('Icom')), null)
  assert.equal(protocol.classify(Buffer.from('not a radio')).type, 'unknown')
  const keepalive = protocol.encodeKeepAlive()
  assert.equal(keepalive.length, 3)
  assert.notEqual(keepalive.toString('hex'), '8001004')
})
