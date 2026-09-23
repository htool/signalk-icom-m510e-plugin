const test = require('node:test')
const assert = require('node:assert/strict')
const protocol = require('../protocol')
const { RadioSession } = require('../radio')

function fakeUdp () {
  let nextPort = 40000
  const sent = []
  return {
    sent,
    createSocket () {
      const handlers = {}
      const socket = {
        on (event, fn) {
          handlers[event] = fn
          return socket
        },
        bind (callback) {
          socket.port = nextPort
          nextPort += 1
          callback()
        },
        address () {
          return { port: socket.port, address: '0.0.0.0' }
        },
        setBroadcast () {},
        send (msg, offset, length, port, address, callback) {
          sent.push({
            msg: Buffer.from(msg.subarray(offset, offset + length)),
            port,
            address,
          })
          if (callback) callback()
        },
        close () {
          socket.closed = true
        },
      }
      return socket
    },
  }
}

function wait (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function session (udp, hooks = {}) {
  return new RadioSession({
    localIp: '192.168.1.25',
    udp,
    discoverIntervalMs: 60000,
    keepaliveMs: 60000,
    silenceIntervalMs: 15,
    namesReadyDelayMs: 0,
    heardTimeoutMs: 40,
    scanIntervalMs: 20,
    tablePart2Ms: 60000,
    askChannelMs: 60000,
    ...hooks,
  })
}

function nameBlock (start, names) {
  const records = Buffer.concat(names.map((name) => {
    const record = Buffer.alloc(11)
    record.write(name.padEnd(10, ' ').slice(0, 10), 1, 'utf8')
    return record
  }))
  const body = Buffer.alloc(7 + records.length)
  body.writeUInt16LE(start, 4)
  records.copy(body, 7)
  return protocol.encodeFrame({
    srcIp: '192.168.1.146',
    dstIp: '192.168.1.25',
    marker: 0x00,
    command: protocol.Command.NAMES,
    body,
  })
}

test('discovery sign-in, channel status, and a refused channel', async () => {
  const udp = fakeUdp()
  const sentences = []
  const radio = session(udp, {
    onNmea: (sentence) => sentences.push(sentence),
  })
  radio.start()
  assert.equal(udp.sent[0].port, protocol.PORT.DISCOVER)
  assert.equal(protocol.classify(udp.sent[0].msg).type, 'icom')

  radio.inject('discovery', Buffer.from('nope'), { address: '192.168.1.146', port: 50000 })
  assert.equal(radio.getState().radio.status, 'offline')

  const reply = protocol.encodeFrame({
    srcIp: '192.168.1.146',
    dstIp: '192.168.1.25',
    marker: 0x00,
    command: protocol.Command.ACK,
    body: Buffer.from([0x03, 0xff, 0x00, 0x00]),
  })
  radio.inject('discovery', reply, { address: '192.168.1.25', port: 50000 })
  assert.equal(radio.getState().radio.status, 'offline')

  radio.inject('discovery', reply, { address: '192.168.1.146', port: 50000 })
  assert.equal(radio.getState().radio.status, 'Initializing RS-M500')
  const signIn = udp.sent.find((packet) => protocol.decodeFrame(packet.msg).command === protocol.Command.SIGN_IN)
  assert.equal(signIn.port, 50000)
  assert.equal(signIn.address, '192.168.1.146')

  radio.inject('keepalive', Buffer.from([0x80, 0xc8, 0x00, 0x05]), { address: '192.168.1.146', port: 50002 })
  const table = udp.sent.filter((packet) => protocol.decodeFrame(packet.msg).command === protocol.Command.CHANNEL_TABLE)
  assert.equal(table.length, 1)
  radio.sendKeepAlive()
  assert.equal(udp.sent.at(-1).msg.toString('hex'), '800100')
  assert.equal(udp.sent.at(-1).port, 50002)

  const status = protocol.encodeStatus('192.168.1.146', '192.168.1.25', 93, {
    squelch: 3,
    busy: false,
    power: 0x0f,
  })
  radio.inject('control', status, { address: '192.168.1.146', port: 50003 })
  assert.equal(radio.getState().channel.label, '31')
  assert.equal(radio.getState().channel.watt, 25)
  assert.equal(radio.getState().radio.squelch, 3)
  assert.equal(radio.setChannel(93), false)

  radio.inject('data', nameBlock(0, ['CALLING']), { address: '192.168.1.146', port: 50004 })
  const properties = protocol.encodeFrame({
    srcIp: '192.168.1.146',
    dstIp: '192.168.1.25',
    marker: 0x00,
    command: protocol.Command.PROPERTIES,
    body: Buffer.concat([Buffer.alloc(8), Buffer.alloc(3)]),
  })
  radio.inject('data', properties, { address: '192.168.1.146', port: 50004 })
  assert.equal(radio.setChannel(0), true)
  const set = protocol.classify(udp.sent.at(-1).msg)
  assert.equal(set.type, 'set-channel')
  assert.equal(set.index, 0)
  assert.equal(udp.sent.at(-1).port, protocol.PORT.CONTROL)

  radio.inject('data', Buffer.from('$GNRMC,201446.00,V,,,,,,120223,,,N*5E\r\n'), {
    address: '192.168.1.146',
    port: 50004,
  })
  assert.deepEqual(sentences, ['$GNRMC,201446.00,V,,,,,,120223,,,N*5E'])
  radio.stop()
})

test('names completion brings the radio online and silence drops it', async () => {
  const udp = fakeUdp()
  const radio = session(udp, { heardTimeoutMs: 500 })
  radio.start()
  const reply = protocol.encodeFrame({
    srcIp: '192.168.1.146',
    dstIp: '192.168.1.25',
    marker: 0x00,
    command: protocol.Command.ACK,
    body: Buffer.from([0x03, 0xff, 0x00, 0x00]),
  })
  radio.inject('discovery', reply, { address: '192.168.1.146', port: 50000 })
  radio.inject('data', nameBlock(520, ['WEATHER']), { address: '192.168.1.146', port: 50004 })
  await wait(80)
  assert.equal(radio.getState().radio.status, 'online')
  const before = udp.sent.length
  radio.lastHeard = Date.now() - 10000
  await wait(80)
  assert.equal(radio.getState().radio.status, 'offline')
  assert.equal(radio.getState().channel, null)
  assert.ok(udp.sent.length > before)
  radio.stop()
})

test('scan steps to the next enabled channel and stops', async () => {
  const udp = fakeUdp()
  const radio = session(udp)
  radio.start()
  const reply = protocol.encodeFrame({
    srcIp: '192.168.1.146',
    dstIp: '192.168.1.25',
    marker: 0x00,
    command: protocol.Command.ACK,
    body: Buffer.from([0x03, 0xff, 0x00, 0x00]),
  })
  radio.inject('discovery', reply, { address: '192.168.1.146', port: 50000 })
  const disabled = Buffer.from([0, 80, 0])
  const enabled = Buffer.from([0, 0, 0])
  const payload = Buffer.concat([
    disabled, disabled, disabled,
    enabled,
    disabled, disabled,
    enabled,
  ])
  const properties = protocol.encodeFrame({
    srcIp: '192.168.1.146',
    dstIp: '192.168.1.25',
    marker: 0x00,
    command: protocol.Command.PROPERTIES,
    body: Buffer.concat([Buffer.alloc(8), payload]),
  })
  radio.inject('data', properties, { address: '192.168.1.146', port: 50004 })
  assert.equal(radio.setChannel(3), true)
  assert.equal(radio.getState().channel.label, '1')
  assert.equal(radio.step(1, false), true)
  assert.equal(radio.getState().channel.label, '2')

  radio.setChannel(3)
  radio.radio.busy = true
  const whileBusy = udp.sent.length
  radio.scan(false)
  await wait(40)
  assert.equal(udp.sent.length, whileBusy)

  radio.radio.busy = false
  radio.scan(false)
  await wait(40)
  assert.ok(udp.sent.length > whileBusy)
  radio.stopScan()
  const stopped = udp.sent.length
  await wait(40)
  assert.equal(udp.sent.length, stopped)
  radio.stop()
})
