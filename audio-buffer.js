const RATE = 8000
const MAX_SECONDS = 300

function createAudioBuffer (seconds) {
  const limit = Number(seconds)
  const max = RATE * (Number.isFinite(limit) && limit > 0 ? limit : MAX_SECONDS)
  const ring = Buffer.alloc(max * 2)
  const spans = []
  let write = 0

  function start () {
    return Math.max(0, write - max)
  }

  function channelNumber (channel) {
    if (channel == null || channel === '') return null
    const nr = Number(channel)
    return Number.isFinite(nr) ? nr : null
  }

  function trimSpans () {
    const from = start()
    while (spans.length > 1 && spans[1].at <= from) spans.shift()
  }

  function append (pcm, channel) {
    const samples = Math.floor(pcm.length / 2)
    if (samples <= 0) return
    const nr = channelNumber(channel)
    const last = spans[spans.length - 1]
    if (!last || last.channel !== nr) spans.push({ at: write, channel: nr })
    for (let i = 0; i < samples; i++) {
      pcm.copy(ring, ((write + i) % max) * 2, i * 2, i * 2 + 2)
    }
    write += samples
    trimSpans()
  }

  function channelAt (sample) {
    const at = clamp(sample)
    let channel = null
    for (const span of spans) {
      if (span.at > at) break
      channel = span.channel
    }
    return channel
  }

  function marks () {
    const from = start()
    trimSpans()
    return spans.map((span) => ({
      at: Math.max(0, (span.at - from) / RATE),
      channel: span.channel,
    }))
  }

  function clamp (sample) {
    const from = start()
    if (sample < from) return from
    if (sample > write) return write
    return sample
  }

  function read (sample, count) {
    const at = clamp(sample)
    const n = Math.max(0, Math.min(count, write - at))
    const pcm = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) {
      ring.copy(pcm, i * 2, ((at + i) % max) * 2, ((at + i) % max) * 2 + 2)
    }
    return { sample: at, pcm }
  }

  function sampleAt (seconds) {
    const from = start()
    const dur = (write - from) / RATE
    const sec = Math.max(0, Math.min(dur, Number(seconds) || 0))
    return from + Math.floor(sec * RATE)
  }

  function info (cursor) {
    const from = start()
    const at = clamp(cursor)
    return {
      duration: (write - from) / RATE,
      at: (at - from) / RATE,
      channel: channelAt(at),
      marks: marks(),
    }
  }

  return { append, read, clamp, sampleAt, info, start, end: () => write, pcm: () => read(start(), write - start()).pcm }
}

module.exports = { createAudioBuffer, RATE, MAX_SECONDS }
