const protocol = require('./protocol')

const ROLES = ['discovery', 'keepalive', 'control', 'data', 'extra', 'voice']

function later (fn, ms) {
  const timer = setTimeout(fn, ms)
  if (timer.unref) timer.unref()
  return timer
}

function every (fn, ms) {
  const timer = setInterval(fn, ms)
  if (timer.unref) timer.unref()
  return timer
}

class RadioSession {
  constructor (options) {
    this.localIp = options.localIp
    this.udp = options.udp
    this.debug = options.debug || (() => {})
    this.onUpdate = options.onUpdate || (() => {})
    this.onNmea = options.onNmea || (() => {})
    this.discoverIntervalMs = options.discoverIntervalMs || 1000
    this.keepaliveMs = options.keepaliveMs || 5000
    this.silenceIntervalMs = options.silenceIntervalMs || 1000
    this.namesReadyDelayMs = options.namesReadyDelayMs == null ? 8000 : options.namesReadyDelayMs
    this.heardTimeoutMs = options.heardTimeoutMs || 10000
    this.scanIntervalMs = options.scanIntervalMs || 200
    this.tablePart2Ms = options.tablePart2Ms == null ? 2000 : options.tablePart2Ms
    this.askChannelMs = options.askChannelMs == null ? 4000 : options.askChannelMs
    this.sockets = {}
    this.ports = {}
    this.timers = {}
    this.closed = true
    this.discovering = false
    this.tableRequested = false
    this.namesComplete = false
    this.channels = Object.create(null)
    this.nameNr = 0
    this.nameMode = 0
    this.propertyBytes = Buffer.alloc(0)
    this.lastHeard = 0
    this.quietSince = null
    this.keepaliveTarget = null
    this.radio = {
      ip: null,
      port: null,
      status: 'offline',
      busy: false,
      squelch: null,
      horn: null,
    }
    this.channel = null
  }

  start () {
    this.closed = false
    let pending = ROLES.length
    for (const role of ROLES) {
      const socket = this.udp.createSocket('udp4')
      this.sockets[role] = socket
      socket.on('error', (err) => this.debug(`${role} socket error: ${err.message}`))
      socket.on('message', (msg, rinfo) => this.handleIncoming(role, msg, rinfo))
      socket.bind(() => {
        if (this.closed) return
        if (role === 'discovery') socket.setBroadcast(true)
        this.ports[role] = socket.address().port
        pending -= 1
        if (pending === 0) this.startDiscovery()
      })
    }
  }

  stop () {
    this.closed = true
    this.discovering = false
    this.clearTimers()
    for (const socket of Object.values(this.sockets)) {
      try {
        socket.close()
      } catch (err) {
        this.debug(`socket close failed: ${err.message}`)
      }
    }
    this.sockets = {}
  }

  inject (role, msg, rinfo) {
    this.handleIncoming(role, msg, rinfo)
  }

  getState () {
    return this.snapshot()
  }

  broadcast () {
    if (this.closed || !this.ports.discovery) return
    const frame = protocol.encodeDiscover(this.localIp, this.ports.discovery)
    this.send(this.sockets.discovery, frame, protocol.PORT.DISCOVER, '255.255.255.255')
  }

  sendKeepAlive () {
    if (!this.keepaliveTarget || !this.sockets.keepalive) return
    this.send(
      this.sockets.keepalive,
      protocol.encodeKeepAlive(),
      this.keepaliveTarget.port,
      this.keepaliveTarget.address
    )
  }

  setChannel (index) {
    const part = protocol.splitIndex(index)
    const entry = this.entry(part.nr, part.mode)
    if (!this.radio.ip || !entry || entry.enabled !== true) {
      this.quietSince = Date.now()
      this.debug(`setChannel refused index ${index}`)
      return false
    }
    const frame = protocol.encodeSetChannel(this.localIp, this.radio.ip, index)
    this.send(this.sockets.control, frame, protocol.PORT.CONTROL, this.radio.ip)
    this.channel = this.channelFrom(part.nr, part.mode, entry)
    this.onUpdate(this.snapshot())
    return true
  }

  step (direction, favOnly) {
    if (!this.channel || this.channel.nr == null) return false
    const from = protocol.channelIndex(this.channel.nr, this.channel.mode)
    const index = protocol.nextChannelIndex(from, direction, (candidate) => {
      const part = protocol.splitIndex(candidate)
      const entry = this.entry(part.nr, part.mode)
      if (!entry || entry.enabled !== true) return false
      if (favOnly && entry.fav !== true) return false
      return true
    })
    if (index == null) return false
    return this.setChannel(index)
  }

  scan (favOnly) {
    this.stopScan()
    const tick = () => {
      if (this.closed || this.radio.busy) return
      if (this.channel) this.step(1, Boolean(favOnly))
      this.timers.scan = later(tick, this.scanIntervalMs)
    }
    this.timers.scan = later(tick, Math.min(10, this.scanIntervalMs))
  }

  stopScan () {
    this.clearTimer('scan')
  }

  startDiscovery () {
    if (this.closed) return
    this.discovering = true
    this.broadcast()
    this.clearTimer('discover')
    this.timers.discover = every(() => this.broadcast(), this.discoverIntervalMs)
  }

  handleIncoming (role, msg, rinfo) {
    if (this.closed) return
    const buffer = Buffer.from(msg)
    if (rinfo && rinfo.address && rinfo.address !== this.localIp) this.lastHeard = Date.now()
    if (role === 'discovery' && this.discovering) this.acceptDiscovery(buffer, rinfo)
    if (role === 'keepalive' && rinfo && rinfo.address !== this.localIp && !this.timers.keepalive) {
      this.keepaliveTarget = { address: rinfo.address, port: rinfo.port }
      this.timers.keepalive = every(() => this.sendKeepAlive(), this.keepaliveMs)
      this.requestChannelTable()
    }
    const message = protocol.classify(buffer)
    switch (message.type) {
      case 'nmea':
        message.sentences.forEach((sentence) => this.onNmea(sentence))
        break
      case 'status':
        this.applyStatus(message)
        break
      case 'names':
        this.applyNames(message)
        break
      case 'properties':
        this.applyProperties(message)
        break
      case 'favourite':
        this.applyFavourite(message)
        break
      case 'horn':
        this.radio.horn = message.on
        this.onUpdate(this.snapshot())
        break
      case 'ack':
      case 'keepalive':
      case 'rtp':
        break
      default:
        if (message.frame) {
          this.debug(`icom command 0x${message.frame.command.toString(16)} length ${message.frame.body.length}`)
        }
    }
  }

  acceptDiscovery (buffer, rinfo) {
    if (!rinfo || !rinfo.address || rinfo.address === this.localIp) return false
    if (!protocol.decodeFrame(buffer)) return false
    this.discovering = false
    this.clearTimer('discover')
    this.radio.ip = rinfo.address
    this.radio.port = rinfo.port
    this.radio.status = 'Initializing RS-M500'
    this.sendSignIn()
    this.onUpdate(this.snapshot())
    return true
  }

  sendSignIn () {
    const frame = protocol.encodeSignIn(this.localIp, this.radio.ip, {
      data: this.ports.data,
      voice: this.ports.voice,
      keepalive: this.ports.keepalive,
      control: this.ports.control,
      extra: this.ports.extra,
    })
    this.send(this.sockets.discovery, frame, this.radio.port, this.radio.ip)
  }

  requestChannelTable () {
    if (this.tableRequested || !this.radio.ip) return
    this.tableRequested = true
    const first = protocol.encodeChannelTableRequest(this.localIp, this.radio.ip, 1)
    this.send(this.sockets.discovery, first, this.radio.port, this.radio.ip)
    this.timers.tablePart2 = later(() => {
      if (this.closed || !this.radio.ip) return
      const second = protocol.encodeChannelTableRequest(this.localIp, this.radio.ip, 2)
      this.send(this.sockets.discovery, second, this.radio.port, this.radio.ip)
    }, this.tablePart2Ms)
    this.timers.askChannel = later(() => {
      if (this.closed || !this.radio.ip) return
      const ask = protocol.encodeAskChannel(this.localIp, this.radio.ip)
      this.send(this.sockets.control, ask, protocol.PORT.CONTROL, this.radio.ip)
    }, this.askChannelMs)
  }

  applyStatus (status) {
    const part = protocol.splitIndex(status.index)
    const entry = this.entry(part.nr, part.mode)
    const wasBusy = this.radio.busy
    this.radio.squelch = status.squelch
    this.radio.busy = status.busy
    if (wasBusy && !status.busy) this.quietSince = Date.now()
    const watt = status.watt == null ? entry && entry.watt : status.watt
    const hilo = status.hilo == null ? entry && entry.hilo : status.hilo
    if (entry && status.watt != null) {
      entry.watt = status.watt
      entry.hilo = status.hilo
    }
    this.channel = {
      nr: part.nr,
      mode: part.mode,
      label: protocol.formatChannel(part.nr, part.mode),
      name: entry && entry.name,
      fav: entry && entry.fav,
      enabled: entry && entry.enabled,
      duplex: entry && entry.duplex,
      watt,
      hilo,
    }
    this.onUpdate(this.snapshot())
  }

  applyNames (block) {
    for (const name of block.names) this.addName(name)
    if (!block.done || this.namesComplete) return
    this.namesComplete = true
    this.radio.status = 'Initializing RS-M500'
    this.quietSince = Date.now()
    this.timers.silenceArm = later(() => {
      this.clearTimer('silence')
      this.timers.silence = every(() => this.publishClock(), this.silenceIntervalMs)
    }, this.namesReadyDelayMs)
  }

  addName (name) {
    const mode = protocol.MODES[this.nameMode]
    const entry = this.ensure(this.nameNr, mode)
    entry.name = name
    if (this.channel && this.channel.nr === this.nameNr && this.channel.mode === mode) {
      this.channel.name = name
      this.onUpdate(this.snapshot())
    }
    this.nameMode += 1
    if (this.nameMode === 3) {
      this.nameMode = 0
      this.nameNr += 1
    }
  }

  applyProperties (message) {
    if (message.offset === 0) {
      this.propertyBytes = Buffer.from(message.payload)
    } else if (message.offset === this.propertyBytes.length || message.offset === 200) {
      this.propertyBytes = Buffer.concat([this.propertyBytes, message.payload])
    } else {
      this.debug(`property block at offset ${message.offset} does not follow ${this.propertyBytes.length}`)
      return
    }
    const records = protocol.propertyRecords(this.propertyBytes)
    records.forEach((fields, index) => {
      const part = protocol.splitIndex(index)
      const entry = this.ensure(part.nr, part.mode)
      entry.fav = fields.fav
      entry.enabled = fields.enabled
      entry.watt = fields.watt
      entry.duplex = fields.duplex
    })
  }

  applyFavourite (message) {
    const part = protocol.splitIndex(message.index)
    const entry = this.entry(part.nr, part.mode)
    if (!entry) return
    entry.fav = message.favourite
    if (this.channel && this.channel.nr === part.nr && this.channel.mode === part.mode) {
      this.channel.fav = message.favourite
      this.onUpdate(this.snapshot())
    }
  }

  publishClock () {
    if (this.closed) return
    const heardAgo = Date.now() - this.lastHeard
    if (heardAgo < this.heardTimeoutMs) {
      if (this.radio.status === 'Initializing RS-M500') {
        this.radio.status = 'online'
        if (this.channel) {
          const entry = this.entry(this.channel.nr, this.channel.mode)
          if (entry && entry.name) this.channel.name = entry.name
        }
        this.onUpdate(this.snapshot(0))
        return
      }
    } else if (this.radio.status === 'online') {
      this.radio.status = 'offline'
      this.radio.busy = false
      this.channel = null
      this.resetTable()
      this.clearTimer('silence')
      this.clearTimer('keepalive')
      this.keepaliveTarget = null
      this.onUpdate(this.snapshot(null))
      this.startDiscovery()
      return
    }
    if (this.radio.status === 'online') {
      const silence = Math.floor((Date.now() - (this.quietSince || Date.now())) / 1000)
      this.onUpdate(this.snapshot(silence))
    }
  }

  resetTable () {
    this.channels = Object.create(null)
    this.nameNr = 0
    this.nameMode = 0
    this.propertyBytes = Buffer.alloc(0)
    this.tableRequested = false
    this.namesComplete = false
    this.clearTimer('silenceArm')
    this.clearTimer('tablePart2')
    this.clearTimer('askChannel')
  }

  entry (nr, mode) {
    const row = this.channels[nr]
    return row && row[mode]
  }

  ensure (nr, mode) {
    if (!this.channels[nr]) this.channels[nr] = Object.create(null)
    if (!this.channels[nr][mode]) this.channels[nr][mode] = {}
    return this.channels[nr][mode]
  }

  channelFrom (nr, mode, entry) {
    return {
      nr,
      mode,
      label: protocol.formatChannel(nr, mode),
      name: entry.name,
      fav: entry.fav,
      enabled: entry.enabled,
      duplex: entry.duplex,
      watt: entry.watt,
      hilo: entry.hilo,
    }
  }

  snapshot (silence) {
    return {
      radio: { ...this.radio },
      channel: this.channel ? { ...this.channel } : null,
      quietSince: this.quietSince,
      silence: silence === undefined ? null : silence,
    }
  }

  send (socket, frame, port, address) {
    if (this.closed || !socket) return
    try {
      socket.send(frame, 0, frame.length, port, address, (err) => {
        if (err) this.debug(`send failed: ${err.message}`)
      })
    } catch (err) {
      this.debug(`send failed: ${err.message}`)
    }
  }

  clearTimer (name) {
    if (!this.timers[name]) return
    clearInterval(this.timers[name])
    clearTimeout(this.timers[name])
    delete this.timers[name]
  }

  clearTimers () {
    for (const name of Object.keys(this.timers)) this.clearTimer(name)
  }
}

module.exports = { RadioSession }
