const RATE = 8000
const BAUD = 1200

function symbolBits (symbol) {
  const bits = []
  let zeros = 0
  for (let i = 0; i < 7; i++) {
    const bit = (symbol >> i) & 1
    bits.push(bit)
    if (!bit) zeros += 1
  }
  bits.push(zeros & 1, (zeros >> 1) & 1, (zeros >> 2) & 1)
  return bits
}

function symbolFromBits (bits) {
  let value = 0
  let zeros = 0
  for (let i = 0; i < 7; i++) {
    if (bits[i]) value |= 1 << i
    else zeros += 1
  }
  const check = bits[7] | (bits[8] << 1) | (bits[9] << 2)
  if (check !== zeros) return null
  return value
}

function codeFromSymbols (symbols) {
  const digits = []
  let pending = ''
  for (const symbol of symbols) {
    if (symbol === 117 || symbol === 122 || symbol === 127) {
      if (pending) return pending
      digits.length = 0
      pending = ''
      continue
    }
    if (symbol == null || symbol > 99) {
      digits.length = 0
      pending = ''
      continue
    }
    const text = String(symbol).padStart(2, '0')
    if (digits.length && digits[digits.length - 1] === text) continue
    digits.push(text)
    if (digits.length > 5) digits.shift()
    const code = digits.join('')
    pending = digits.length === 5 && code[0] === '9' ? code : ''
  }
  return ''
}

function dotPattern (bits) {
  if (bits.length < 8) return false
  for (let i = 1; i < bits.length; i++) if (bits[i] === bits[i - 1]) return false
  return true
}

function createAtisDecoder (onCode) {
  let sampleIndex = 0
  const phases = [0, 1 / 3, 2 / 3].map((acc) => ({
    acc,
    s1: 0,
    c1: 0,
    s2: 0,
    c2: 0,
    bits: [],
    symbols: [],
    align: -1,
    count: 0,
    peak: 0,
    quiet: 0,
  }))

  function takeBit (phase, bit) {
    phase.bits.push(bit)
    phase.count += 1
    if (phase.bits.length > 30) phase.bits.shift()
    if (phase.align < 0) {
      if (phase.bits.length < 18) return
      if (symbolFromBits(phase.bits.slice(-10)) === 125 && dotPattern(phase.bits.slice(-18, -10))) {
        phase.align = phase.count
      }
      return
    }
    if ((phase.count - phase.align) % 10 !== 0) return
    const symbol = symbolFromBits(phase.bits.slice(-10))
    if (symbol == null) {
      phase.align = -1
      phase.symbols.length = 0
      return
    }
    phase.symbols.push(symbol)
    if (phase.symbols.length > 48) phase.symbols.shift()
    const code = codeFromSymbols(phase.symbols)
    if (!code) return
    phase.symbols.length = 0
    onCode(code)
  }

  function push (pcm) {
    const count = Math.floor(pcm.length / 2)
    for (let i = 0; i < count; i++) {
      const sample = pcm.readInt16LE(i * 2) / 32768
      const a1 = 2 * Math.PI * 1300 * sampleIndex / RATE
      const a2 = 2 * Math.PI * 2100 * sampleIndex / RATE
      sampleIndex += 1
      for (const phase of phases) {
        phase.s1 += sample * Math.sin(a1)
        phase.c1 += sample * Math.cos(a1)
        phase.s2 += sample * Math.sin(a2)
        phase.c2 += sample * Math.cos(a2)
        phase.acc += BAUD / RATE
        if (phase.acc < 1) continue
        phase.acc -= 1
        const hi = phase.s1 * phase.s1 + phase.c1 * phase.c1
        const lo = phase.s2 * phase.s2 + phase.c2 * phase.c2
        phase.s1 = phase.c1 = phase.s2 = phase.c2 = 0
        const level = hi + lo
        phase.peak = Math.max(level, phase.peak * 0.995)
        if (level < Math.max(1e-4, phase.peak * 0.08)) {
          phase.quiet += 1
          if (phase.quiet === 8) {
            phase.bits.length = 0
            phase.symbols.length = 0
            phase.align = -1
            phase.count = 0
          }
          continue
        }
        phase.quiet = 0
        takeBit(phase, hi >= lo ? 1 : 0)
      }
    }
  }

  return { push, symbolBits, codeFromSymbols }
}

module.exports = { createAtisDecoder, RATE }
