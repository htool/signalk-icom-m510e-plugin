const dgram = require('dgram')
const fs = require('fs')
const os = require('os')
const path = require('path')
const NmeaParser = require('@signalk/nmea0183-signalk')
const { RadioSession } = require('./radio')
const { channelsFromFollowValue, parseChannelCommand, rtpPayload, mulawToPcm, pcmToMulaw } = require('./protocol')
const { createAudioBuffer, RATE: AUDIO_RATE } = require('./audio-buffer')

module.exports = function (app) {
  const plugin = {}
  let unsubscribes = []
  let session = null
  let options = {}
  let autoFollow = false
  let marked = []
  let desiredChannels = []
  let putRegistered = false
  let nmeaParser = null
  const audioClients = new Map()
  let operator = null
  let audioListener = ''
  let audioBuffer = createAudioBuffer()

  plugin.id = 'signalk-icom-m510e-plugin'
  plugin.name = 'ICOM M510E plugin'
  plugin.description = 'Get active channel information and change channel over wlan.'

  plugin.schema = function () {
    return {
      properties: {
        autoFollowPath: {
          type: 'string',
          title: 'Path to check for auto-follow mode',
          default: 'communication.vhf.autofollow',
        },
        followPath: {
          title: 'Signal K path of the nearest VHF station',
          description: 'VHFinfo JSON object, for example resources.vhfdata.nearest.0. The channel is read from that value.',
          default: 'resources.vhfdata.nearest.0',
          type: 'string',
        },
        silence: {
          title: 'Auto follow: seconds of silence before changing channel',
          default: 30,
          type: 'number',
        },
        scanResume: {
          title: 'Scan: seconds of silence before resuming',
          default: 30,
          type: 'number',
        },
        IP: {
          title: "Specify Icom M510e ip address in case it's not auto-detected",
          type: 'string',
        },
        audioBufferMinutes: {
          title: 'Audio buffer length in minutes',
          description: 'How much received audio is kept for rewind.',
          default: 5,
          type: 'number',
        },
      },
    }
  }

  let resume = null

  plugin.start = function (opts) {
    const saved = resume
    resume = null
    shutdown()
    options = opts || {}
    audioBuffer = createAudioBuffer(audioBufferSeconds())
    autoFollow = false
    marked = loadMarked()
    desiredChannels = []
    if (!nmeaParser) nmeaParser = new NmeaParser()
    subscribe()
    ensurePut()
    startAudio()
    session = new RadioSession({
      localIp: localIpv4(),
      udp: dgram,
      debug: (message) => app.debug(message),
      onNmea: handleNmea,
      onUpdate: publish,
      onRtp: forwardAudio,
      scanResumeSeconds: scanResumeSeconds(),
      discoverAddress: options.IP || '255.255.255.255',
    })
    session.marked = marked
    session.favOverride = loadFavourites()
    session.start(saved)
    app.debug('Plugin started')
  }

  plugin.stop = function () {
    const closing = shutdown()
    app.debug('Plugin stopped')
    return Promise.resolve(closing).then((saved) => {
      resume = saved
    })
  }

  function startAudio () {
    if (typeof app.registerWebSocket !== 'function') return
    const socket = app.registerWebSocket('/audio')
    socket.on('connection', (ws, req) => {
      const client = { cursor: audioBuffer.end(), live: true, statusAt: 0, ip: clientAddress(req, ws), talk: '' }
      audioClients.set(ws, client)
      const timer = setInterval(() => pumpAudio(ws), 100)
      ws.on('message', (data, isBinary) => {
        if (isAudioFrame(data, isBinary)) {
          if (ws !== operator || !client.talk || !session) return
          session.sendVoice(pcmToMulaw(Buffer.from(data)))
          return
        }
        let msg = null
        try { msg = JSON.parse(String(data)) } catch (err) { return }
        if (!msg) return
        if (msg.op === 'claim') {
          const free = !operator || operator.readyState !== 1
          if (free || msg.takeover === true || operator === ws) setOperator(ws)
          else {
            try { ws.send(JSON.stringify({ role: 'following', audio: audioListener })) } catch (err) {}
          }
          return
        }
        if (msg.op === 'talk') {
          if (ws !== operator) return
          if (!msg.down) {
            client.talk = ''
            if (session) session.endTalk()
            return
          }
          const mode = msg.mode === 'intercom' ? 'intercom' : 'ptt'
          if (mode === 'ptt' && session) {
            const result = session.pressPtt()
            if (result === 'stopped') {
              try { ws.send(JSON.stringify({ talk: 'stopped' })) } catch (err) {}
              return
            }
            client.talk = result === 'talk' ? 'ptt' : ''
            return
          }
          client.talk = mode
          if (session) session.beginTalk(mode)
          return
        }
        if (msg.op !== 'seek') return
        if (Number.isFinite(msg.sample)) client.cursor = audioBuffer.clamp(msg.sample)
        else if (Number.isFinite(msg.seconds)) client.cursor = audioBuffer.sampleAt(msg.seconds)
        client.live = audioBuffer.end() - client.cursor < AUDIO_RATE * 0.4
        client.statusAt = 0
      })
      ws.on('close', () => {
        clearInterval(timer)
        if (client.talk && session) session.endTalk()
        if (operator === ws) {
          operator = null
          publishAudio(null)
        }
        audioClients.delete(ws)
      })
    })
    publishAudio('')
  }

  function setOperator (ws) {
    const previous = operator && operator !== ws ? operator : null
    const client = audioClients.get(ws)
    operator = ws
    publishAudio(client ? client.ip : '')
    if (previous && previous.readyState === 1) {
      const previousClient = audioClients.get(previous)
      if (previousClient && previousClient.talk && session) session.endTalk()
      if (previousClient) previousClient.talk = ''
      try { previous.send(JSON.stringify({ role: 'following', audio: client ? client.ip : '' })) } catch (err) {}
    }
    try { ws.send(JSON.stringify({ role: 'player', audio: client ? client.ip : '' })) } catch (err) {}
  }

  function publishAudio (ip) {
    audioListener = ip || ''
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: 'communication.vhf.audio', value: audioListener }] }],
    })
  }

  function pumpAudio (ws) {
    const client = audioClients.get(ws)
    if (!client || ws.readyState !== 1) return
    const behind = audioBuffer.end() - client.cursor
    const samples = client.live ? Math.min(behind, AUDIO_RATE * 0.2) : Math.min(behind, AUDIO_RATE * 0.1)
    if (samples > 0) {
      const chunk = audioBuffer.read(client.cursor, samples)
      const frame = Buffer.alloc(6 + chunk.pcm.length)
      frame.writeUInt32LE(chunk.sample >>> 0, 0)
      frame.writeUInt16LE(chunk.pcm.length / 2, 4)
      chunk.pcm.copy(frame, 6)
      ws.send(frame)
      client.cursor = chunk.sample + chunk.pcm.length / 2
      if (!client.live && audioBuffer.end() - client.cursor < AUDIO_RATE * 0.3) client.live = true
    }
    const now = Date.now()
    if (now - client.statusAt > 200) {
      client.statusAt = now
      const place = audioBuffer.info(client.cursor)
      ws.send(JSON.stringify({
        duration: place.duration,
        at: place.at,
        sample: client.cursor,
        channel: place.channel,
        marks: place.marks,
      }))
    }
  }

  function forwardAudio (packet) {
    const payload = rtpPayload(packet)
    if (!payload) return
    const pcm = mulawToPcm(payload)
    const state = session ? session.getState() : null
    const nr = state && state.channel ? state.channel.nr : null
    audioBuffer.append(pcm, nr)
  }

  function shutdown () {
    unsubscribes.forEach((unsubscribe) => unsubscribe())
    unsubscribes = []
    if (!session) return null
    const closing = session.stop()
    session = null
    return closing
  }

  function autoFollowPath () {
    return options.autoFollowPath || 'communication.vhf.autofollow'
  }

  function followPath () {
    return options.followPath || 'resources.vhfdata.nearest.0'
  }

  function pathValue (node) {
    if (node == null) return undefined
    if (typeof node !== 'object' || Array.isArray(node)) return node
    if (Object.prototype.hasOwnProperty.call(node, 'value')) return node.value
    return node
  }

  function readFollowChannels () {
    if (typeof app.getSelfPath !== 'function') return desiredChannels.slice()
    try {
      return channelsFromFollowValue(pathValue(app.getSelfPath(followPath())))
    } catch (err) {
      app.debug(`follow path read failed: ${err.message}`)
      return desiredChannels.slice()
    }
  }

  function silenceSeconds () {
    return Number.isFinite(options.silence) ? options.silence : 30
  }

  function scanResumeSeconds () {
    return Number.isFinite(options.scanResume) ? options.scanResume : 30
  }

  function audioBufferSeconds () {
    const minutes = Number(options.audioBufferMinutes)
    const chosen = Number.isFinite(minutes) && minutes > 0 ? minutes : 5
    return Math.min(chosen, 120) * 60
  }

  function subscribe () {
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
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
    if (!values) return
    for (const sample of values) {
      if (!sample) continue
      if (sample.path === autoFollowPath()) {
        const text = String(sample.value).toLowerCase()
        autoFollow = text === '1' || text === 'true' || text === 'on'
        app.debug(`autoFollow set to: ${autoFollow}`)
        continue
      }
      if (sample.path !== followPath()) continue
      desiredChannels = channelsFromFollowValue(sample.value)
      app.debug(`follow channels from ${followPath()}: ${desiredChannels.join(',')}`)
    }
    if (session) maybeFollow(session.getState())
  }

  function maybeFollow (state, options = {}) {
    if (!session) return
    // Always re-read the live path; subscription deltas alone can lag or
    // miss the current nearest station after a restart / toggle.
    desiredChannels = readFollowChannels()
    const userScan = session.scanMode === 'marked' || session.scanMode === 'favourites' || session.scanMode === 'all'
    session.followList = desiredChannels
    session.includeFollow = autoFollow && desiredChannels.length > 0 && userScan
    const following = session.scanMode === 'follow'
    if (!autoFollow || state.radio.status !== 'online' || desiredChannels.length < 2 || userScan) {
      if (following) session.stopScan()
    }
    if (!autoFollow || state.radio.status !== 'online' || userScan) return
    if (desiredChannels.length > 1) {
      if (!session.scanMode) session.scan('follow')
      return
    }
    if (desiredChannels.length !== 1) return
    const wanted = parseChannelCommand(String(desiredChannels[0]))
    if (!wanted || wanted.op !== 'set') return
    if (state.channel) {
      const current = parseChannelCommand(state.channel.label)
      if (current && current.index === wanted.index) return
    }
    if (session.pending && session.pending.index === wanted.index && Date.now() < session.pending.until) {
      return
    }
    if (!options.immediate) {
      if (!state.quietSince || (Date.now() - state.quietSince) / 1000 <= silenceSeconds()) return
    }
    session.setChannel(wanted.index, { force: true })
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

  function publish (state, options) {
    const values = []
    const base = 'communication.vhf'
    const radio = state.radio
    const channel = state.channel
    if (radio.ip) {
      values.push({ path: base + '.ip', value: radio.ip })
      values.push({ path: base + '.port', value: radio.port })
    }
    if (radio.status) values.push({ path: base + '.status', value: radio.status })
    if (typeof radio.squelch === 'number') values.push({ path: base + '.squelch', value: radio.squelch })
    if (typeof radio.horn === 'boolean') values.push({ path: base + '.horn', value: radio.horn })
    if (typeof radio.scanning === 'boolean') values.push({ path: base + '.scanning', value: radio.scanning })
    if (typeof radio.dualwatch === 'boolean') values.push({ path: base + '.dualwatch', value: radio.dualwatch })
    if (typeof radio.intercom === 'boolean') values.push({ path: base + '.intercom', value: radio.intercom })
    values.push({ path: base + '.channelGroup', value: radio.status === 'online' ? (radio.channelGroup || '') : '' })
    values.push({ path: base + '.bank', value: '' })
    if (radio.status === 'online' && state.silence != null) {
      values.push({ path: base + '.silence', value: state.silence })
    }
    const document = channelDocument(channel)
    if (document) values.push({ path: base + '.channel', value: document })
    values.push({ path: base + '.audio', value: audioListener })
    values.push({ path: base + '.marked', value: marked.slice() })
    values.push({ path: base + '.scanMode', value: state.scanMode || '' })
    values.push({ path: base + '.autofollow', value: autoFollow === true })
    app.handleMessage(plugin.id, { updates: [{ values }] })
    maybeFollow(state, options)
  }

  function ensurePut () {
    if (putRegistered) return
    putRegistered = true
    app.registerPutHandler('vessels.self', 'communication.vhf.channel', apiChangeChannel, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.squelch', apiSquelch, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.watt', apiPower, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.scanning', apiScan, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.dualwatch', apiDualwatch, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.ptt', apiPtt, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.intercom', apiIntercom, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.autofollow', apiAutoFollow, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.marked', apiMarked, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.scanMode', apiScanMode, 'somesource.1')
    app.registerPutHandler('vessels.self', 'communication.vhf.fav', apiFavourite, 'somesource.1')
  }

  function apiFavourite (context, path, value, callback) {
    const finish = (statusCode) => {
      const reply = { state: 'COMPLETED', statusCode }
      callback(reply)
      return reply
    }
    if (String(value) !== 'toggle') return finish(400)
    if (!session || !session.toggleFavourite()) return finish(400)
    saveFavourites(session.favOverride)
    return finish(200)
  }

  function apiAutoFollow (context, path, value, callback) {
    const previous = autoFollow
    const text = String(value).toLowerCase()
    if (text === 'toggle') autoFollow = !autoFollow
    else autoFollow = text === '1' || text === 'true' || text === 'on'
    const turningOn = autoFollow && !previous
    if (autoFollow) {
      desiredChannels = readFollowChannels()
      app.debug(`autoFollow on, channels ${desiredChannels.join(',')}`)
    }
    const reply = { state: 'COMPLETED', statusCode: 200 }
    callback(reply)
    if (session) publish(session.getState(), turningOn ? { immediate: true } : undefined)
    return reply
  }

  function apiMarked (context, path, value, callback) {
    const finish = (statusCode) => {
      const reply = { state: 'COMPLETED', statusCode }
      callback(reply)
      return reply
    }
    if (!session || session.channel == null || session.channel.nr == null) return finish(400)
    const nr = Number(session.channel.nr)
    if (String(value) !== 'toggle') return finish(400)
    marked = marked.indexOf(nr) >= 0 ? marked.filter((item) => item !== nr) : marked.concat(nr).sort((a, b) => a - b)
    session.marked = marked
    saveMarked()
    publish(session.getState())
    return finish(200)
  }

  function apiScanMode (context, path, value, callback) {
    const finish = (statusCode) => {
      const reply = { state: 'COMPLETED', statusCode }
      callback(reply)
      return reply
    }
    if (!session || session.getState().radio.status !== 'online') return finish(400)
    const mode = String(value)
    if (mode !== 'marked' && mode !== 'favourites' && mode !== 'all' && mode !== 'off') return finish(400)
    if (mode === 'off') {
      session.stopScan()
      return finish(200)
    }
    if (session.scanMode === mode) return finish(200)
    if (mode === 'marked' && !marked.length) return finish(400)
    session.marked = marked
    session.scan(mode === 'marked' ? 'marked' : mode === 'favourites')
    return finish(200)
  }

  function apiWhenOnline (action, callback) {
    const finish = (statusCode) => {
      const reply = { state: 'COMPLETED', statusCode }
      callback(reply)
      return reply
    }
    if (!session || session.getState().radio.status !== 'online') return finish(400)
    if (!action()) return finish(400)
    return finish(200)
  }

  function apiSquelch (context, path, value, callback) {
    apiWhenOnline(() => session.setSquelch(value), callback)
  }

  function apiPower (context, path, value, callback) {
    apiWhenOnline(() => session.togglePower(), callback)
  }

  function apiScan (context, path, value, callback) {
    apiWhenOnline(() => session.toggleRadioScan(), callback)
  }

  function apiDualwatch (context, path, value, callback) {
    apiWhenOnline(() => session.toggleDualwatch(), callback)
  }

  function apiPtt (context, path, value, callback) {
    const down = value === true || value === 1 || value === '1' || value === 'down'
    apiWhenOnline(() => session.setPtt(down), callback)
  }

  function apiIntercom (context, path, value, callback) {
    const talking = value === true || value === 'talk' || value === 'begin'
    apiWhenOnline(() => session.setIntercom(talking), callback)
  }

  function apiChangeChannel (context, path, value, callback) {
    const online = session && session.getState().radio.status === 'online'
    const command = online ? parseChannelCommand(value) : null
    if (!command) {
      const reply = { state: 'COMPLETED', statusCode: 400 }
      callback(reply)
      return reply
    }
    let ok = false
    if (command.op === 'scanStop') {
      session.stopScan()
      ok = true
    } else if (command.op === 'scanAll') {
      session.scan(false)
      ok = true
    } else if (command.op === 'scanFav') {
      session.scan(true)
      ok = true
    } else if (command.op === '+1') ok = session.scanMode ? session.nudgeScan() : session.step(1, false)
    else if (command.op === '-1') ok = session.step(-1, false)
    else ok = session.setChannel(command.index)
    const reply = { state: 'COMPLETED', statusCode: ok ? 200 : 400 }
    callback(reply)
    return reply
  }

  function favouritesFile () {
    if (typeof app.getDataDirPath !== 'function') return ''
    return path.join(app.getDataDirPath(), 'favourites.json')
  }

  function loadFavourites () {
    try {
      const file = favouritesFile()
      if (!file) return Object.create(null)
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const overrides = Object.create(null)
      if (!data || typeof data !== 'object') return overrides
      for (const [key, value] of Object.entries(data)) overrides[key] = value === true
      return overrides
    } catch (err) {
      return Object.create(null)
    }
  }

  function saveFavourites (overrides) {
    try {
      const file = favouritesFile()
      if (!file) return
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(overrides))
    } catch (err) {
      app.debug(`favourites save failed: ${err.message}`)
    }
  }

  function markedFile () {
    if (typeof app.getDataDirPath !== 'function') return ''
    return path.join(app.getDataDirPath(), 'marked.json')
  }

  function loadMarked () {
    try {
      const file = markedFile()
      if (!file) return []
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(data)) return []
      return data.map(Number).filter((nr) => nr >= 1 && nr <= 88)
    } catch (err) {
      return []
    }
  }

  function saveMarked () {
    try {
      const file = markedFile()
      if (!file) return
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(marked))
    } catch (err) {
      app.debug(`marked save failed: ${err.message}`)
    }
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

function isAudioFrame (data, isBinary) {
  if (isBinary === true) return true
  if (isBinary === false) return false
  return Buffer.isBuffer(data) && (data.length === 0 || data[0] !== 0x7b)
}

function channelDocument (channel) {
  if (!channel || channel.nr == null) return null
  return {
    nr: channel.nr,
    duplex: channel.duplex === true,
    hilo: channel.hilo === true,
    fav: channel.fav === true,
    name: channel.name || '',
    watt: channel.watt == null ? null : channel.watt,
    mode: channel.mode || '00',
    enabled: channel.enabled !== false,
    busy: channel.busy === true,
  }
}

module.exports.channelDocument = channelDocument
module.exports.isAudioFrame = isAudioFrame

function clientAddress (req, ws) {
  const forwarded = req && req.headers && req.headers['x-forwarded-for']
  const sock = (ws && ws._socket) || (req && req.socket) || {}
  const raw = forwarded
    ? String(forwarded).split(',')[0].trim()
    : sock.remoteAddress || ''
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

module.exports.clientAddress = clientAddress
