const dgram = require('dgram')
const os = require('os')
const NmeaParser = require('@signalk/nmea0183-signalk')
const { RadioSession } = require('./radio')
const { parseChannelCommand } = require('./protocol')

module.exports = function (app) {
  const plugin = {}
  let unsubscribes = []
  let session = null
  let options = {}
  let autoFollow = false
  let desiredChannel = ''
  let putRegistered = false
  let nmeaParser = null

  plugin.id = 'signalk-icom-m510e-plugin'
  plugin.name = 'ICOM M510E plugin'
  plugin.description = 'Send and receive NMEA0183 data to and from Icom M510E. Including AIS data to enable AIS functionalily on a non-AIS model.'

  plugin.schema = function () {
    return {
      properties: {
        autoFollowPath: {
          type: 'string',
          title: 'Path to check for auto-follow mode',
          default: 'communication.vhf.autofollow',
        },
        followPath: {
          title: 'Follow the channel published on this path',
          default: 'resources.vhfdata.nearest.0',
          type: 'string',
        },
        silence: {
          title: 'Silence time in seconds before changing channel',
          default: 30,
          type: 'number',
        },
      },
    }
  }

  plugin.start = function (opts) {
    shutdown()
    options = opts || {}
    autoFollow = false
    desiredChannel = ''
    if (!nmeaParser) nmeaParser = new NmeaParser()
    subscribe()
    ensurePut()
    session = new RadioSession({
      localIp: localIpv4(),
      udp: dgram,
      debug: (message) => app.debug(message),
      onNmea: handleNmea,
      onUpdate: publish,
    })
    session.start()
    app.debug('Plugin started')
  }

  plugin.stop = function () {
    shutdown()
    app.debug('Plugin stopped')
  }

  function shutdown () {
    unsubscribes.forEach((unsubscribe) => unsubscribe())
    unsubscribes = []
    if (session) {
      session.stop()
      session = null
    }
  }

  function autoFollowPath () {
    return options.autoFollowPath || 'communication.vhf.autofollow'
  }

  function followPath () {
    return options.followPath || 'resources.vhfdata.nearest.0'
  }

  function silenceSeconds () {
    return Number.isFinite(options.silence) ? options.silence : 30
  }

  function subscribe () {
    app.subscriptionmanager.subscribe(
      {
        context: '*',
        subscribe: [
          { path: followPath(), period: 1000 },
          { path: autoFollowPath() },
        ],
      },
      unsubscribes,
      (err) => app.error('Error:' + err),
      (delta) => {
        delta.updates.forEach((update) => handleData(update.values))
      }
    )
  }

  function handleData (values) {
    if (!values || !values[0]) return
    const sample = values[0]
    if (sample.path === autoFollowPath()) {
      const text = String(sample.value).toLowerCase()
      autoFollow = text === '1' || text === 'true' || text === 'on'
      app.debug(`autoFollow set to: ${autoFollow}`)
      return
    }
    if (sample.path !== followPath()) return
    let payload = sample.value
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload)
      } catch (err) {
        app.debug(`follow path is not JSON: ${err.message}`)
        return
      }
    }
    desiredChannel = payload && payload.channel != null ? String(payload.channel) : ''
    if (session) maybeFollow(session.getState())
  }

  function maybeFollow (state) {
    if (!autoFollow || !session || state.radio.status !== 'online' || !desiredChannel) return
    const wanted = parseChannelCommand(desiredChannel)
    if (!wanted || wanted.op !== 'set') return
    if (state.channel) {
      const current = parseChannelCommand(state.channel.label)
      if (current && current.index === wanted.index) return
    }
    if (!state.quietSince || (Date.now() - state.quietSince) / 1000 <= silenceSeconds()) return
    session.setChannel(wanted.index)
  }

  function handleNmea (sentence) {
    app.emit('nmea0183', sentence)
    try {
      const delta = nmeaParser.parse(sentence)
      if (delta && delta.updates) app.handleMessage(plugin.id, delta)
    } catch (err) {
      app.debug(`NMEA parse failed: ${err.message}`)
    }
  }

  function publish (state) {
    const values = []
    const base = 'communication.vhf'
    const radio = state.radio
    const channel = state.channel
    if (radio.ip) {
      values.push({ path: base + '.ip', value: radio.ip })
      values.push({ path: base + '.port', value: radio.port })
    }
    if (radio.status) values.push({ path: base + '.status', value: radio.status })
    if (typeof radio.busy === 'boolean') values.push({ path: base + '.busy', value: radio.busy })
    if (typeof radio.squelch === 'number') values.push({ path: base + '.squelch', value: radio.squelch })
    if (typeof radio.horn === 'boolean') values.push({ path: base + '.horn', value: radio.horn })
    if (radio.status === 'online' && state.silence != null) {
      values.push({ path: base + '.silence', value: state.silence })
    }
    values.push({ path: base + '.channel', value: channel ? channel.label : '' })
    if (channel) {
      pushDefined(values, base + '.watt', channel.watt)
      pushDefined(values, base + '.duplex', channel.duplex)
      pushDefined(values, base + '.hilo', channel.hilo)
      pushDefined(values, base + '.name', channel.name)
      pushDefined(values, base + '.fav', channel.fav)
      pushDefined(values, base + '.enabled', channel.enabled)
    }
    app.handleMessage(plugin.id, { updates: [{ values }] })
    maybeFollow(state)
  }

  function ensurePut () {
    if (putRegistered) return
    putRegistered = true
    app.registerPutHandler('vessels.self', 'communication.vhf.channel', apiChangeChannel, 'somesource.1')
  }

  function apiChangeChannel (context, path, value, callback) {
    const online = session && session.getState().radio.status === 'online'
    const command = online ? parseChannelCommand(value) : null
    if (!command) {
      callback({ state: 'COMPLETED', statusCode: 400 })
      return
    }
    if (command.op === 'scanStop') session.stopScan()
    else if (command.op === 'scanAll') session.scan(false)
    else if (command.op === 'scanFav') session.scan(true)
    else if (command.op === '+1') session.step(1, false)
    else if (command.op === '-1') session.step(-1, false)
    else session.setChannel(command.index)
    callback({ state: 'COMPLETED', statusCode: 200 })
  }

  return plugin
}

function localIpv4 () {
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      const ipv4 = entry.family === 'IPv4' || entry.family === 4
      if (ipv4 && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

function pushDefined (values, path, value) {
  if (value !== undefined && value !== null) values.push({ path, value })
}
