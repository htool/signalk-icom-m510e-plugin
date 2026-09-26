const state = {
  channel: '--',
  nr: null,
  name: '',
  mode: '00',
  watt: null,
  fav: false,
  hilo: false,
  squelch: 0,
  status: 'offline',
  busy: false,
  scanning: false,
  scanMode: '',
  marked: [],
  autofollow: false,
  dualwatch: false,
  intercom: false,
  ip: '',
  locked: false,
  audio: '',
  channelGroup: '',
}

const TOKEN_KEY = 'skDeviceToken'
const CLIENT_KEY = 'skDeviceClientId'
const HREF_KEY = 'skDeviceHref'
let authNote = ''
let deviceToken = ''
try { deviceToken = localStorage.getItem(TOKEN_KEY) || '' } catch (e) {}

const $ = (id) => document.getElementById(id)

function bankLabel () {
  return state.status === 'online' ? state.channelGroup : ''
}

function render () {
  const number = state.nr == null || state.nr === '' ? state.channel : String(state.nr)
  if (number) $('channel').textContent = number
  $('name').textContent = state.name || ''
  $('power').textContent = state.watt == null ? '1W' : `${state.watt}W`
  $('bank').textContent = bankLabel()
  $('fav').textContent = state.fav ? '★' : '☆'
  $('fav').classList.toggle('on', state.fav)
  const online = state.status === 'online'
  const following = online && !hearing
  const statusText = authNote || (online ? '' : (state.status || 'offline'))
  $('status').textContent = statusText
  $('status').hidden = !statusText
  const follower = state.audio ? `Following ${state.audio}` : 'Following'
  $('link').textContent = !online ? 'Disconnected' : (hearing ? 'Connected' : follower)
  $('link').classList.toggle('on', online && hearing)
  $('link').classList.toggle('follow', online && !hearing)
  $('link').classList.toggle('off', !online)
  document.querySelector('.live-row').classList.toggle('off', !hearing)
  $('auto').classList.toggle('on', !following && state.autofollow)
  $('scan-all').classList.toggle('on', !following && state.scanMode === 'all')
  $('scan-marked').classList.toggle('on', !following && state.scanMode === 'marked')
  $('scan-fav').classList.toggle('on', !following && state.scanMode === 'favourites')
  const current = Number(state.nr)
  const markedNow = state.marked.indexOf(current) >= 0
  if ($('mark').checked !== markedNow) $('mark').checked = markedNow
  $('marked').textContent = state.marked.length ? `Marked: ${state.marked.join(', ')}` : 'Marked: none'
  $('sql').value = state.squelch
  $('sql-out').textContent = String(state.squelch)
  $('ptt').classList.toggle('busy', state.busy && !state.locked)
  $('icom-state').textContent = state.intercom ? 'In a call' : 'Not in a call'
  $('icom').classList.toggle('hot', !following && state.intercom)
  document.querySelectorAll('.ptt.hot').forEach((button) => {
    if (following) button.classList.remove('hot')
  })
  document.querySelector('.phone').classList.toggle('locked', state.locked)
  document.querySelector('.phone').classList.toggle('following', following)
  $('take').hidden = !following
  $('lock').setAttribute('aria-pressed', state.locked ? 'true' : 'false')
  $('lock').setAttribute('aria-label', state.locked ? 'Unlock' : 'Lock')
}

function applyValue (path, value) {
  const key = path.split('.').pop()
  if (key === 'channel') applyChannel(value)
  else if (key === 'nr' || key === 'name' || key === 'mode' || key === 'watt' || key === 'fav' || key === 'hilo' || key === 'duplex' || key === 'enabled') return
  else if (key === 'squelch') state.squelch = Number(value) || 0
  else if (key === 'status') {
    state.status = value || 'offline'
    if (state.status !== 'online') {
      state.busy = false
      state.channelGroup = ''
    }
  }
  else if (key === 'busy') return
  else if (key === 'scanning') state.scanning = value === true
  else if (key === 'scanMode') {
    const mode = value || ''
    if (expectScan != null && mode !== expectScan) return
    expectScan = null
    state.scanMode = mode
  }
  else if (key === 'marked') {
    const list = Array.isArray(value) ? value.map(Number) : []
    if (expectMark && !sameNumbers(list, expectMark)) return
    expectMark = null
    state.marked = list
  }
  else if (key === 'autofollow') {
    const on = value === true || value === 'true' || value === 1 || value === '1' || value === 'on'
    if (expectFollow != null && on !== expectFollow) return
    expectFollow = null
    state.autofollow = on
  }
  else if (key === 'dualwatch') state.dualwatch = value === true
  else if (key === 'intercom') state.intercom = value === true
  else if (key === 'ip') state.ip = value || ''
  else if (key === 'audio') state.audio = value || ''
  else if (key === 'channelGroup') state.channelGroup = value || ''
}

function applyChannel (value) {
  if (!value || typeof value !== 'object') {
    if (value) state.channel = String(value)
    return
  }
  if (value.nr != null) {
    state.nr = value.nr
    state.channel = String(value.nr)
  }
  state.name = value.name || ''
  state.mode = value.mode || '00'
  state.watt = value.watt
  state.fav = value.fav === true
  state.hilo = value.hilo === true
  state.busy = value.busy === true
}

function authHeaders () {
  const headers = {}
  const admin = window.localStorage && localStorage.getItem('token')
  const token = deviceToken || admin
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function put (path, value) {
  const response = await fetch(`/signalk/v1/api/vessels/self/${path}`, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ value }),
  })
  if (response.status === 401) requestDeviceAccess()
  if (!response.ok) throw new Error(`${path} ${response.status}`)
}

function clientId () {
  let id = ''
  try { id = localStorage.getItem(CLIENT_KEY) || '' } catch (e) {}
  if (!id) {
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
    try { localStorage.setItem(CLIENT_KEY, id) } catch (e) {}
  }
  return id
}

function saveDeviceToken (token) {
  deviceToken = token || ''
  authNote = ''
  try {
    if (deviceToken) localStorage.setItem(TOKEN_KEY, deviceToken)
    localStorage.removeItem(HREF_KEY)
  } catch (e) {}
  render()
}

async function pollAccess (href) {
  const response = await fetch(href)
  if (response.status === 404) return
  const body = await response.json().catch(() => ({}))
  const request = body.accessRequest
  if (request && request.permission === 'APPROVED' && request.token) {
    saveDeviceToken(request.token)
    return
  }
  if (request && request.permission === 'DENIED') {
    authNote = 'Toegang geweigerd'
    render()
    return
  }
  setTimeout(() => pollAccess(href).catch(() => {}), 3000)
}

async function requestDeviceAccess () {
  if (deviceToken) return
  authNote = 'Toegang gevraagd'
  render()
  const response = await fetch('/signalk/v1/access/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: clientId(),
      description: 'ICOM M510',
      permissions: 'readwrite',
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (body.token) {
    saveDeviceToken(body.token)
    return
  }
  if (body.accessRequest && body.accessRequest.token) {
    saveDeviceToken(body.accessRequest.token)
    return
  }
  const href = body.href || localStorage.getItem(HREF_KEY)
  if (href) {
    try { localStorage.setItem(HREF_KEY, href) } catch (e) {}
    pollAccess(href).catch(() => {})
  }
}

function handsOff () {
  return state.locked || (state.status === 'online' && !hearing)
}

function guard (event, action) {
  if (handsOff()) {
    event.preventDefault()
    return
  }
  action()
}

function show (panel) {
  const intercom = panel === 'intercom'
  $('panel-radio').classList.toggle('hidden', intercom)
  $('panel-intercom').classList.toggle('hidden', !intercom)
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('on', button.dataset.panel === (intercom ? 'intercom' : 'radio'))
  })
}

async function loadRest () {
  const response = await fetch('/signalk/v1/api/vessels/self/communication/vhf')
  if (!response.ok) return
  const body = await response.json()
  Object.entries(body || {}).forEach(([key, entry]) => {
    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry
    applyValue(`communication.vhf.${key}`, value)
  })
  render()
}

function subscribe () {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signalk/v1/stream?subscribe=none`
  const socket = new WebSocket(url)
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      context: 'vessels.self',
      subscribe: [{ path: 'communication.vhf.*', period: 500 }],
    }))
  })
  socket.addEventListener('message', (event) => {
    const delta = JSON.parse(event.data)
    ;(delta.updates || []).forEach((update) => {
      ;(update.values || []).forEach((item) => {
        if (String(item.path).startsWith('communication.vhf')) applyValue(item.path, item.value)
      })
    })
    render()
  })
}

const noSleep = new NoSleep()
let wakeLockEnabled = false
function setWake (on) {
  if (on) {
    if (wakeLockEnabled) return
    noSleep.enable()
    wakeLockEnabled = true
    return
  }
  if (!wakeLockEnabled) return
  noSleep.disable()
  wakeLockEnabled = false
}
$('lock').addEventListener('click', () => {
  state.locked = !state.locked
  setWake(!state.locked)
  render()
})
document.querySelectorAll('.tab').forEach((button) => {
  button.addEventListener('click', () => show(button.dataset.panel))
})
function holdStep (button, value) {
  let timer = null
  let delay = 360
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
    delay = 360
  }
  const tick = () => {
    if (handsOff()) return stop()
    put('communication.vhf.channel', value).catch(() => {})
    delay = Math.max(55, Math.round(delay * 0.72))
    timer = setTimeout(tick, delay)
  }
  button.addEventListener('pointerdown', (event) => {
    if (handsOff()) return
    event.preventDefault()
    try { button.setPointerCapture(event.pointerId) } catch (err) {}
    tick()
  })
  button.addEventListener('pointerup', stop)
  button.addEventListener('pointercancel', stop)
}
holdStep($('ch-down'), '-1')
holdStep($('ch-up'), '+1')
$('auto').addEventListener('click', () => {
  if (handsOff()) return
  const previous = state.autofollow
  const next = !previous
  expectFollow = next
  state.autofollow = next
  render()
  put('communication.vhf.autofollow', 'toggle').catch(() => {
    if (expectFollow !== next) return
    expectFollow = null
    state.autofollow = previous
    render()
  })
})
$('fav').addEventListener('click', () => {
  if (handsOff()) return
  put('communication.vhf.fav', 'toggle').catch(() => {})
})
$('power').addEventListener('click', () => {
  if (handsOff()) return
  put('communication.vhf.watt', 'toggle').catch(() => {})
})
function chooseScan (mode) {
  if (handsOff()) return
  const previous = state.scanMode
  const next = previous === mode ? '' : mode
  expectScan = next
  state.scanMode = next
  render()
  put('communication.vhf.scanMode', next || 'off').catch(() => {
    if (expectScan !== next) return
    expectScan = null
    state.scanMode = previous
    render()
  })
}
$('scan-all').addEventListener('click', () => chooseScan('all'))
$('scan-marked').addEventListener('click', () => chooseScan('marked'))
$('scan-fav').addEventListener('click', () => chooseScan('favourites'))
$('mark').addEventListener('change', () => {
  if (handsOff()) return
  const nr = Number(state.nr)
  const previous = state.marked.slice()
  const next = previous.indexOf(nr) >= 0
    ? previous.filter((item) => item !== nr)
    : previous.concat(nr).sort((a, b) => a - b)
  expectMark = next
  state.marked = next
  render()
  put('communication.vhf.marked', 'toggle').catch(() => {
    if (!expectMark || !sameNumbers(state.marked, next)) return
    expectMark = null
    state.marked = previous
    render()
  })
})

function sameNumbers (left, right) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
  return true
}

let expectMark = null
let expectFollow = null
let expectScan = null
$('sql').addEventListener('change', () => {
  if (handsOff()) return
  state.squelch = Number($('sql').value)
  render()
  put('communication.vhf.squelch', state.squelch).catch(() => {})
})

function hold (button, mode) {
  button.addEventListener('selectstart', (event) => event.preventDefault())
  button.addEventListener('pointerdown', (event) => {
    if (handsOff()) return
    event.preventDefault()
    window.getSelection().removeAllRanges()
    button.classList.add('hot')
    beginTalk(mode)
  })
  const release = () => {
    if (!button.classList.contains('hot')) return
    button.classList.remove('hot')
    endTalk()
  }
  button.addEventListener('pointerup', release)
  button.addEventListener('pointercancel', release)
  button.addEventListener('pointerleave', release)
}
hold($('ptt'), 'ptt')
hold($('icom'), 'intercom')

let talkStream = null
let talkSource = null
let talkNode = null
let talkSilent = null
let talkQueue = []

function beginTalk (mode) {
  unlockAudio()
  yielded = false
  pageClaim = true
  const ctx = ensureAudio()
  if (ctx) ctx.resume()
  startSpeaker(true)
  const sendDown = () => {
    if (speaker && speaker.readyState === 1) speaker.send(JSON.stringify({ op: 'talk', mode, down: true }))
  }
  if (speaker && speaker.readyState === 1) sendDown()
  else if (speaker) speaker.addEventListener('open', sendDown, { once: true })
  if (!navigator.mediaDevices || talkStream) return
  navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } }).then((stream) => {
    if (!document.querySelector('.ptt.hot, #icom.hot')) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    talkStream = stream
    talkQueue = []
    const audio = ensureAudio()
    talkSource = audio.createMediaStreamSource(stream)
    talkNode = audio.createScriptProcessor(2048, 1, 1)
    talkSilent = audio.createGain()
    talkSilent.gain.value = 0
    talkNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      const step = audio.sampleRate / 8000
      for (let i = 0; i < input.length; i += step) {
        talkQueue.push(Math.max(-1, Math.min(1, input[Math.floor(i)])))
      }
      while (talkQueue.length >= 320 && speaker && speaker.readyState === 1) {
        const pcm = new Int16Array(320)
        for (let n = 0; n < 320; n++) pcm[n] = Math.round(talkQueue.shift() * 32767)
        speaker.send(pcm.buffer)
      }
    }
    talkSource.connect(talkNode)
    talkNode.connect(talkSilent)
    talkSilent.connect(audio.destination)
  }).catch(() => {})
}

function endTalk () {
  if (speaker && speaker.readyState === 1) speaker.send(JSON.stringify({ op: 'talk', down: false }))
  talkQueue = []
  if (talkNode) talkNode.onaudioprocess = null
  try { talkSource && talkSource.disconnect() } catch (err) {}
  try { talkNode && talkNode.disconnect() } catch (err) {}
  try { talkSilent && talkSilent.disconnect() } catch (err) {}
  if (talkStream) talkStream.getTracks().forEach((track) => track.stop())
  talkStream = null
  talkSource = null
  talkNode = null
  talkSilent = null
}

let muted = false
try { muted = localStorage.getItem('skRadioMuted') === '1' } catch (e) {}
let audioCtx = null
let audioGain = null
let audioNext = 0

let audioArmed = false

function setMuted (value) {
  muted = value
  try { localStorage.setItem('skRadioMuted', muted ? '1' : '0') } catch (e) {}
  $('mute').setAttribute('aria-pressed', muted ? 'true' : 'false')
  $('mute').setAttribute('aria-label', muted ? 'Sound on' : 'Sound off')
  if (muted || document.hidden) stopSpeaker()
  else if (audioArmed) startSpeaker()
}

function ensureAudio () {
  const Ctx = window.AudioContext || window.webkitAudioContext
  if (!Ctx) return null
  if (!audioCtx) {
    audioCtx = new Ctx()
    audioGain = audioCtx.createGain()
    audioGain.gain.value = 1
    audioGain.connect(audioCtx.destination)
  }
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

let bufferDuration = 0
let bufferAt = 0
let lastSample = null
let draggingLive = false
let seekHold = null
const queued = []

function formatClock (seconds) {
  const sec = Math.max(0, Math.round(seconds))
  return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

function livePercent () {
  if (bufferDuration < 0.1) return 100
  const at = Math.max(0, Math.min(bufferDuration, bufferAt))
  if (bufferDuration - at < 0.4) return 100
  return (at / bufferDuration) * 100
}

function secondsFromLivePercent (percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0))
  return (p / 100) * Math.max(0, bufferDuration)
}

function showLive () {
  const shown = draggingLive ? secondsFromLivePercent($('live').value) : bufferAt
  $('live-label').textContent = `${formatClock(shown)} / ${formatClock(bufferDuration)}`
  if (!draggingLive) $('live').value = String(livePercent())
}

function cutPlayback () {
  while (queued.length) {
    try { queued.pop().stop() } catch (err) {}
  }
  audioNext = 0
}

function playPcm (buffer) {
  const ctx = audioCtx
  if (!ctx || !buffer.byteLength) return
  if (ctx.state === 'suspended') ctx.resume()
  if (ctx.state === 'suspended') return
  const samples = new Int16Array(buffer)
  const rate = ctx.sampleRate || 48000
  const outLength = Math.max(1, Math.round(samples.length * rate / 8000))
  const audioBuffer = ctx.createBuffer(1, outLength, rate)
  const channel = audioBuffer.getChannelData(0)
  const step = 8000 / rate
  for (let i = 0; i < outLength; i++) {
    const pos = Math.min(samples.length - 1, i * step)
    const i0 = Math.floor(pos)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const frac = pos - i0
    const s0 = samples[i0] / 32768
    const s1 = samples[i1] / 32768
    channel[i] = s0 + (s1 - s0) * frac
  }
  const source = ctx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(audioGain)
  const now = ctx.currentTime
  if (audioNext < now + 0.02) audioNext = now + 0.04
  source.start(audioNext)
  audioNext += audioBuffer.duration
  queued.push(source)
  source.onended = () => {
    const at = queued.indexOf(source)
    if (at >= 0) queued.splice(at, 1)
  }
}

function askSeek (seconds) {
  const at = Math.max(0, Math.min(Math.max(0, bufferDuration), Number(seconds) || 0))
  bufferAt = at
  seekHold = at
  lastSample = null
  showLive()
  cutPlayback()
  if (!hearing || !speaker || speaker.readyState !== 1) return
  speaker.send(JSON.stringify({ op: 'seek', seconds: at }))
}

let speaker = null
let hearing = false
let yielded = false
let pageClaim = true

function stopSpeaker () {
  const socket = speaker
  speaker = null
  if (!socket) return
  socket.close()
  audioNext = 0
}

function startSpeaker (force) {
  if ((muted && !force) || (speaker && speaker.readyState < 2)) return
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/plugins/signalk-icom-m510e-plugin/audio`
  const socket = new WebSocket(url)
  speaker = socket
  socket.binaryType = 'arraybuffer'
  socket.addEventListener('open', () => {
    if (yielded || speaker !== socket) {
      socket.close()
      return
    }
    socket.send(JSON.stringify({ op: 'claim', refresh: pageClaim }))
    if (lastSample != null) socket.send(JSON.stringify({ op: 'seek', sample: lastSample }))
  })
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const info = JSON.parse(event.data)
      if (info.role === 'following') {
        if (speaker !== socket) return
        const wasHearing = hearing
        hearing = false
        yielded = true
        pageClaim = false
        if (info.audio) state.audio = info.audio
        if (wasHearing) releaseControls()
        render()
        stopSpeaker()
        return
      }
      if (info.talk === 'stopped') {
        document.querySelectorAll('.ptt.hot').forEach((button) => button.classList.remove('hot'))
        endTalk()
        return
      }
      if (info.role === 'player') {
        hearing = true
        yielded = false
        pageClaim = false
        if (info.audio) state.audio = info.audio
        render()
      }
      if (Number.isFinite(info.duration)) {
        bufferDuration = Number(info.duration) || 0
        const at = Number(info.at) || 0
        if (seekHold != null && Math.abs(at - seekHold) > 1.5) return
        seekHold = null
        bufferAt = at
        showLive()
      }
      return
    }
    const raw = event.data
    const playRaw = (data) => {
    if (!hearing) return
    if (!(data instanceof ArrayBuffer) || data.byteLength < 6) return
    const view = new DataView(data)
    const sample = view.getUint32(0, true)
    const count = view.getUint16(4, true)
    if (lastSample != null && sample + 400 < lastSample) cutPlayback()
    else if (lastSample != null && sample > lastSample + 1600) {
      socket.send(JSON.stringify({ op: 'seek', sample: lastSample }))
      return
    } else if (lastSample != null && sample + count <= lastSample) return
    lastSample = sample + count
    if (!muted && !document.querySelector('.ptt.hot, #icom.hot')) playPcm(data.slice(6, 6 + count * 2))
    }
    if (raw instanceof Blob) raw.arrayBuffer().then(playRaw)
    else playRaw(raw)
  })
  socket.addEventListener('close', () => {
    if (speaker !== socket) return
    speaker = null
    if (!muted && !yielded && !document.hidden) setTimeout(startSpeaker, 2000)
  })
}

$('back10').addEventListener('click', () => { if (!handsOff()) askSeek(bufferAt - 10) })
$('fwd10').addEventListener('click', () => { if (!handsOff()) askSeek(bufferAt + 10) })
$('live').addEventListener('pointerdown', () => { draggingLive = true })
$('live').addEventListener('input', () => {
  const at = secondsFromLivePercent($('live').value)
  $('live-label').textContent = `${formatClock(at)} / ${formatClock(bufferDuration)}`
})
const finishSeek = () => {
  if (!draggingLive || handsOff()) {
    draggingLive = false
    return
  }
  draggingLive = false
  askSeek(secondsFromLivePercent($('live').value))
}
$('live').addEventListener('pointerup', finishSeek)
$('live').addEventListener('pointercancel', finishSeek)
$('live').addEventListener('change', finishSeek)
$('mute').addEventListener('click', () => {
  setMuted(!muted)
  if (!muted) ensureAudio()
})
function unlockAudio () {
  audioArmed = true
  const ctx = ensureAudio()
  if (!ctx) return
  const silence = ctx.createBuffer(1, 1, ctx.sampleRate || 8000)
  const source = ctx.createBufferSource()
  source.buffer = silence
  source.connect(ctx.destination)
  try { source.start() } catch (err) {}
  ctx.resume()
}

document.querySelector('.phone').addEventListener('click', () => {
  if (!state.locked) setWake(true)
})
document.querySelector('.phone').addEventListener('pointerdown', () => {
  unlockAudio()
  if (muted || document.hidden || yielded) return
  if (!speaker) startSpeaker()
}, true)
let hideTimer = null
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (!document.hidden || pageClaim) return
      const wasHearing = hearing
      yielded = true
      hearing = false
      if (wasHearing) releaseControls()
      render()
      stopSpeaker()
    }, 700)
    return
  }
  clearTimeout(hideTimer)
  if (yielded || muted) return
  startSpeaker()
})
$('take').addEventListener('click', () => {
  yielded = false
  pageClaim = true
  lastSample = null
  seekHold = null
  ensureAudio()
  startSpeaker(true)
})
function releaseControls () {
  document.querySelectorAll('.ptt.hot').forEach((button) => button.classList.remove('hot'))
  endTalk()
  if (state.scanMode) {
    expectScan = ''
    state.scanMode = ''
    put('communication.vhf.scanMode', 'off').catch(() => {})
  }
  if (state.autofollow) {
    expectFollow = false
    state.autofollow = false
    put('communication.vhf.autofollow', 'false').catch(() => {})
  }
}
function claimOnLoad () {
  yielded = false
  pageClaim = true
  if (muted) return
  startSpeaker(true)
}
window.addEventListener('pageshow', claimOnLoad)
setMuted(muted)
claimOnLoad()
document.addEventListener('gesturestart', (event) => event.preventDefault())
document.addEventListener('touchmove', (event) => {
  if (event.target.closest && event.target.closest('input[type="range"]')) return
  event.preventDefault()
}, { passive: false })

render()
loadRest().catch(() => {})
subscribe()
if (!deviceToken) {
  const pending = localStorage.getItem(HREF_KEY)
  if (pending) pollAccess(pending).catch(() => requestDeviceAccess())
  else requestDeviceAccess().catch(() => {})
}
