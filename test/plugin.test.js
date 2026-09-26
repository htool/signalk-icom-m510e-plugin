const test = require('node:test')
const assert = require('node:assert/strict')
const NmeaParser = require('@signalk/nmea0183-signalk')
const createPlugin = require('../index')

test('plugin metadata matches the Signal K entry points', () => {
  const plugin = createPlugin({
    debug () {},
    error () {},
    handleMessage () {},
    emit () {},
    registerPutHandler () {},
    subscriptionmanager: { subscribe () {} },
  })
  assert.equal(plugin.id, 'signalk-icom-m510e-plugin')
  const schema = plugin.schema()
  assert.equal(schema.properties.silence.default, 30)
  assert.equal(schema.properties.scanResume.default, 30)
  assert.equal(schema.properties.followPath.default, 'resources.vhfdata.nearest.0')
  assert.equal(schema.properties.autoFollowPath.default, 'communication.vhf.autofollow')
  assert.equal(schema.properties.IP.type, 'string')
})

test('channel fields are one document', () => {
  const document = createPlugin.channelDocument({
    nr: 16,
    mode: '00',
    name: 'Distress',
    fav: true,
    duplex: false,
    hilo: true,
    watt: 25,
    enabled: true,
    busy: true,
  })
  assert.deepEqual(document, {
    nr: 16,
    duplex: false,
    hilo: true,
    fav: true,
    name: 'Distress',
    watt: 25,
    mode: '00',
    enabled: true,
    busy: true,
  })
})

test('a seek message is text even when it arrives as a buffer', () => {
  const seek = Buffer.from(JSON.stringify({ op: 'seek', seconds: 12 }))
  assert.equal(createPlugin.isAudioFrame(seek, false), false)
  assert.equal(createPlugin.isAudioFrame(seek, undefined), false)
  assert.equal(createPlugin.isAudioFrame(Buffer.from([0, 1, 2, 3]), true), true)
})

test('audio client address drops the IPv4 prefix', () => {
  assert.equal(createPlugin.clientAddress({ socket: { remoteAddress: '::ffff:192.168.2.20' } }), '192.168.2.20')
  assert.equal(createPlugin.clientAddress({ headers: { 'x-forwarded-for': '100.75.1.2, 172.17.0.1' }, socket: { remoteAddress: '172.17.0.1' } }), '100.75.1.2')
})

test('a captured GNRMC sentence parses to a position', () => {
  const parser = new NmeaParser()
  const delta = parser.parse('$GNRMC,201446.00,V,5227.2261,N,00502.0203,E,,,120223,,,N*5E')
  const paths = delta.updates.flatMap((update) => update.values.map((value) => value.path))
  assert.ok(paths.includes('navigation.position'))
})
