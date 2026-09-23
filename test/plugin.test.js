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
  assert.equal(schema.properties.followPath.default, 'resources.vhfdata.nearest.0')
  assert.equal(schema.properties.autoFollowPath.default, 'communication.vhf.autofollow')
})

test('a captured GNRMC sentence parses to a position', () => {
  const parser = new NmeaParser()
  const delta = parser.parse('$GNRMC,201446.00,V,5227.2261,N,00502.0203,E,,,120223,,,N*5E')
  const paths = delta.updates.flatMap((update) => update.values.map((value) => value.path))
  assert.ok(paths.includes('navigation.position'))
})
