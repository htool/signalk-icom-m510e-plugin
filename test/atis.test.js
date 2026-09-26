const test = require('node:test')
const assert = require('node:assert/strict')
const { createAtisDecoder, RATE } = require('../atis')

function synthesize (bits, start) {
  const samples = Math.ceil(bits.length * RATE / 1200) + (start || 200) + 40
  const pcm = Buffer.alloc(samples * 2)
  let phase = 0
  let at = start == null ? 200 : start
  const samplesPerBit = RATE / 1200
  for (const bit of bits) {
    const freq = bit ? 1300 : 2100
    const end = at + samplesPerBit
    while (at < end) {
      const i = Math.floor(at)
      const sample = Math.round(14000 * Math.sin(phase))
      pcm.writeInt16LE(sample, i * 2)
      phase += 2 * Math.PI * freq / RATE
      at += 1
    }
    at = end
  }
  return pcm
}

test('filters recover an ATIS code from 1300 and 2100 Hz', () => {
  const decoder = createAtisDecoder(() => {})
  const symbols = [125, 111, 92, 44, 20, 12, 34, 117]
  const bits = []
  for (let i = 0; i < 32; i++) bits.push(i % 2)
  for (const symbol of symbols) bits.push(...decoder.symbolBits(symbol))
  let found = ''
  const live = createAtisDecoder((code) => { found = code })
  live.push(synthesize(bits))
  assert.equal(found, '9244201234')
  found = ''
  live.push(Buffer.alloc(RATE))
  live.push(synthesize(bits, 203))
  assert.equal(found, '9244201234')
})
