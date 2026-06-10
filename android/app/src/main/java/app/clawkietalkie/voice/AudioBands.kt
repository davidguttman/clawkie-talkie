package app.clawkietalkie.voice

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln1p
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

// Waveform band intensity math. Mirror of the web client's
// `src/voice/audioBands.ts` (FFT, log-banding, dynamic normalization and
// attack/release smoothing).

const val MIN_DISPLAY_INTENSITY = 0.08
private const val DEFAULT_MIN_FREQUENCY = 80.0
private const val PCM_RMS_FLOOR = 0.0025
private const val PCM_PEAK_FLOOR = 0.006
private const val PCM_REFERENCE_RMS = 0.09
private const val PCM_REFERENCE_PEAK = 0.22
private const val ANALYSER_DYNAMIC_FLOOR = 0.025
private const val ANALYSER_DYNAMIC_RANGE = 0.16

data class SmoothBandOptions(
    val attack: Double = 0.6,
    val release: Double = 0.24,
    val floor: Double = MIN_DISPLAY_INTENSITY,
)

val LIGHT_SMOOTHING = SmoothBandOptions(attack = 0.85, release = 0.6)

class BandNormalizer {
    private var floor = ANALYSER_DYNAMIC_FLOOR
    private var peak = ANALYSER_DYNAMIC_RANGE

    fun reset() {
        floor = ANALYSER_DYNAMIC_FLOOR
        peak = ANALYSER_DYNAMIC_RANGE
    }

    fun normalize(bands: DoubleArray): DoubleArray {
        val count = bands.size
        if (count == 0) return DoubleArray(0)

        var rawPeak = 0.0
        var sum = 0.0
        for (band in bands) {
            val value = max(0.0, band - MIN_DISPLAY_INTENSITY)
            if (value > rawPeak) rawPeak = value
            sum += value
        }

        if (rawPeak <= 0.004) {
            floor += (ANALYSER_DYNAMIC_FLOOR - floor) * 0.04
            peak += (ANALYSER_DYNAMIC_RANGE - peak) * 0.02
            return DoubleArray(count) { MIN_DISPLAY_INTENSITY }
        }

        val mean = sum / count
        val targetFloor = min(0.11, mean * 0.55)
        val floorK = if (targetFloor > floor) 0.015 else 0.06
        floor += (targetFloor - floor) * floorK

        val targetPeak = max(rawPeak, floor + 0.035)
        val peakK = if (targetPeak > peak) 0.38 else 0.018
        peak += (targetPeak - peak) * peakK

        val range = max(0.035, peak - floor)
        return DoubleArray(count) { index ->
            val raw = max(0.0, bands[index] - MIN_DISPLAY_INTENSITY)
            val normalized = max(0.0, (raw - floor) / range)
            if (normalized <= 0.0) MIN_DISPLAY_INTENSITY
            else {
                val shaped = min(1.0, normalized).pow(0.72)
                clampIntensity(MIN_DISPLAY_INTENSITY + shaped * 0.92)
            }
        }
    }
}

/** PCM16LE frame → band intensities (used for the mic waveform). */
fun pcm16ToBandIntensities(pcm: ByteArray, bandCount: Int, sampleRate: Int = 16000): DoubleArray {
    val count = max(0, bandCount)
    if (count == 0) return DoubleArray(0)
    if (pcm.size < 4) return DoubleArray(count) { MIN_DISPLAY_INTENSITY }

    val sampleCount = pcm.size shr 1
    val fftSize = previousPowerOfTwo(sampleCount)
    if (fftSize < 4) return DoubleArray(count) { MIN_DISPLAY_INTENSITY }

    val real = DoubleArray(fftSize)
    val imag = DoubleArray(fftSize)
    val offsetSamples = sampleCount - fftSize
    var sumSquares = 0.0
    var peak = 0.0
    for (i in 0 until fftSize) {
        val byteIndex = (offsetSamples + i) * 2
        val s = ((pcm[byteIndex].toInt() and 0xff) or (pcm[byteIndex + 1].toInt() shl 8)).toShort().toInt()
        val normalized = if (s < 0) s / 32768.0 else s / 32767.0
        val absValue = abs(normalized)
        sumSquares += normalized * normalized
        if (absValue > peak) peak = absValue
        real[i] = normalized * hann(i, fftSize)
    }

    val rms = sqrt(sumSquares / fftSize)
    val envelope = envelopeToIntensity(
        rms,
        peak,
        rmsFloor = PCM_RMS_FLOOR,
        peakFloor = PCM_PEAK_FLOOR,
        rmsReference = PCM_REFERENCE_RMS,
        peakReference = PCM_REFERENCE_PEAK,
    )
    if (envelope <= MIN_DISPLAY_INTENSITY) return DoubleArray(count) { MIN_DISPLAY_INTENSITY }

    fft(real, imag)
    val bins = fftSize shr 1
    val magnitudes = DoubleArray(bins)
    var spectralPeak = 0.0
    for (i in 1 until bins) {
        val magnitude = hypot(real[i], imag[i]) / (fftSize / 4.0)
        magnitudes[i] = magnitude
        if (magnitude > spectralPeak) spectralPeak = magnitude
    }

    if (spectralPeak <= 0.0) return DoubleArray(count) { envelope }
    val normalizedMagnitudes = DoubleArray(bins)
    for (i in 1 until bins) normalizedMagnitudes[i] = magnitudes[i] / spectralPeak

    val spectralShape = frequencyMagnitudesToBands(
        normalizedMagnitudes,
        count,
        minFrequency = DEFAULT_MIN_FREQUENCY,
        maxFrequency = sampleRate / 2.0,
        sampleRate = sampleRate.toDouble(),
    )
    return DoubleArray(count) { envelopeScaledBand(spectralShape[it], envelope) }
}

fun mergeBandIntensities(
    sources: List<DoubleArray>,
    bandCount: Int,
    floor: Double = MIN_DISPLAY_INTENSITY,
): DoubleArray {
    val out = DoubleArray(max(0, bandCount)) { floor }
    for (source in sources) {
        for (i in 0 until min(out.size, source.size)) {
            if (source[i] > out[i]) out[i] = source[i]
        }
    }
    return out
}

fun smoothBandIntensities(
    previous: DoubleArray,
    target: DoubleArray,
    opts: SmoothBandOptions = SmoothBandOptions(),
): DoubleArray {
    val count = max(previous.size, target.size)
    return DoubleArray(count) { i ->
        val prev = previous.getOrElse(i) { opts.floor }
        val goal = target.getOrElse(i) { opts.floor }
        val k = if (goal > prev) opts.attack else opts.release
        clampIntensity(prev + (goal - prev) * k, opts.floor)
    }
}

/**
 * Mirrors low-to-high `uniqueBands` so the highest frequencies render on the
 * outside edges and the lowest frequencies render at the center.
 * e.g. [low, mid, high] => [high, mid, low, low, mid, high].
 */
fun mirrorCenterOutBands(uniqueBands: DoubleArray): DoubleArray {
    val out = DoubleArray(uniqueBands.size * 2)
    for (i in uniqueBands.indices) {
        out[i] = uniqueBands[uniqueBands.size - 1 - i]
        out[uniqueBands.size + i] = uniqueBands[i]
    }
    return out
}

private fun frequencyMagnitudesToBands(
    magnitudes: DoubleArray,
    bandCount: Int,
    minFrequency: Double,
    maxFrequency: Double,
    sampleRate: Double,
): DoubleArray {
    val out = DoubleArray(bandCount)
    val fftSize = magnitudes.size * 2
    val minBin = max(1, ((minFrequency / sampleRate) * fftSize).toInt())
    val maxBin = min(magnitudes.size - 1, max(minBin + 1, ((maxFrequency / sampleRate) * fftSize).toInt()))

    for (band in 0 until bandCount) {
        val (start, end) = logBandRange(band, bandCount, minBin, maxBin)
        var sum = 0.0
        var peak = 0.0
        var n = 0
        for (i in start..end) {
            val mag = magnitudes.getOrElse(i) { 0.0 }
            sum += mag * mag
            if (mag > peak) peak = mag
            n++
        }
        val rms = if (n > 0) sqrt(sum / n) else 0.0
        val shaped = ln1p((rms * 0.75 + peak * 0.35) * 18) / ln1p(18.0)
        out[band] = clampIntensity(shaped)
    }
    return out
}

private fun envelopeScaledBand(band: Double, envelope: Double): Double {
    val shape = max(0.0, (band - MIN_DISPLAY_INTENSITY) / (1 - MIN_DISPLAY_INTENSITY))
    return clampIntensity(MIN_DISPLAY_INTENSITY + shape.pow(0.65) * (envelope - MIN_DISPLAY_INTENSITY))
}

private fun envelopeToIntensity(
    rms: Double,
    peak: Double,
    rmsFloor: Double,
    peakFloor: Double,
    rmsReference: Double,
    peakReference: Double,
): Double {
    val rmsAmount = normalizedAboveFloor(rms, rmsFloor, rmsReference)
    val peakAmount = normalizedAboveFloor(peak, peakFloor, peakReference)
    val compressed = max(sqrt(rmsAmount), sqrt(peakAmount) * 0.75)
    if (compressed <= 0.0) return MIN_DISPLAY_INTENSITY
    return clampIntensity(MIN_DISPLAY_INTENSITY + compressed * 0.82)
}

private fun normalizedAboveFloor(value: Double, floor: Double, reference: Double): Double {
    if (!value.isFinite() || value <= floor) return 0.0
    return min(1.0, (value - floor) / max(reference - floor, Double.MIN_VALUE))
}

private fun fft(real: DoubleArray, imag: DoubleArray) {
    val n = real.size
    var j = 0
    for (i in 1 until n) {
        var bit = n shr 1
        while (j and bit != 0) {
            j = j xor bit
            bit = bit shr 1
        }
        j = j or bit
        if (i < j) {
            val tr = real[i]; real[i] = real[j]; real[j] = tr
            val ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
        }
    }

    var len = 2
    while (len <= n) {
        val angle = -2 * PI / len
        val wLenR = cos(angle)
        val wLenI = sin(angle)
        var i = 0
        while (i < n) {
            var wr = 1.0
            var wi = 0.0
            for (k in 0 until len / 2) {
                val uR = real[i + k]
                val uI = imag[i + k]
                val vR = real[i + k + len / 2] * wr - imag[i + k + len / 2] * wi
                val vI = real[i + k + len / 2] * wi + imag[i + k + len / 2] * wr
                real[i + k] = uR + vR
                imag[i + k] = uI + vI
                real[i + k + len / 2] = uR - vR
                imag[i + k + len / 2] = uI - vI
                val nextWr = wr * wLenR - wi * wLenI
                wi = wr * wLenI + wi * wLenR
                wr = nextWr
            }
            i += len
        }
        len = len shl 1
    }
}

private fun previousPowerOfTwo(n: Int): Int {
    var p = 1
    while (p * 2 <= n) p *= 2
    return p
}

private fun hann(i: Int, size: Int): Double {
    if (size <= 1) return 1.0
    return 0.5 * (1 - cos(2 * PI * i / (size - 1)))
}

private fun logBandRange(band: Int, bandCount: Int, minBin: Int, maxBin: Int): Pair<Int, Int> {
    val minValue = max(1, minBin)
    val maxValue = max(minValue + 1, maxBin)
    val lo = band.toDouble() / bandCount
    val hi = (band + 1).toDouble() / bandCount
    val ratio = maxValue.toDouble() / minValue
    val start = (minValue * ratio.pow(lo)).toInt()
    val end = max(start, Math.ceil(minValue * ratio.pow(hi)).toInt() - 1)
    return Pair(min(start, maxValue), min(end, maxValue))
}

fun clampIntensity(value: Double, floor: Double = MIN_DISPLAY_INTENSITY): Double {
    if (!value.isFinite()) return floor
    if (value < floor) return floor
    if (value > 1.0) return 1.0
    return value
}
