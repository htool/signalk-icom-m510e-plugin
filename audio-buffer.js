const RATE = 8000
const MAX_SECONDS = 300

function createAudioBuffer () {
  const max = RATE * MAX_SECONDS
  const ring = Buffer.alloc(max * 2)
  let write = 0

  function start () {
    return Math.max(0, write - max)
  }

  function append (pcm) {
    const samples = Math.floor(pcm.length / 2)
    for (let i = 0; i < samples; i++) {
      pcm.copy(ring, ((write + i) % max) * 2, i * 2, i * 2 + 2)
    }
    write += samples
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
    }
  }

  return { append, read, clamp, sampleAt, info, start, end: () => write, pcm: () => read(start(), write - start()).pcm }
}

module.exports = { createAudioBuffer, RATE, MAX_SECONDS }
