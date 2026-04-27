class HoldMusicBitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'bits',
        defaultValue: 6,
        minValue: 1,
        maxValue: 16,
        automationRate: 'k-rate',
      },
      {
        name: 'normFreq',
        defaultValue: 0.25,
        minValue: 0.01,
        maxValue: 1,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this.phase = [];
    this.held = [];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const bits = clampParam(parameters.bits[0], 1, 16);
    const normFreq = clampParam(parameters.normFreq[0], 0.01, 1);
    const steps = Math.max(2, 2 ** bits);

    for (let channel = 0; channel < output.length; channel += 1) {
      const inputChannel = input[channel] || input[0];
      const outputChannel = output[channel];
      if (!inputChannel) {
        outputChannel.fill(0);
        continue;
      }

      let held = this.held[channel] || 0;
      let phase = this.phase[channel] || 0;

      for (let i = 0; i < outputChannel.length; i += 1) {
        phase += normFreq;
        if (phase >= 1) {
          phase %= 1;
          held = quantize(inputChannel[i], steps);
        }
        outputChannel[i] = held;
      }

      this.held[channel] = held;
      this.phase[channel] = phase;
    }

    return true;
  }
}

function quantize(value, steps) {
  return Math.round(Math.max(-1, Math.min(1, value)) * (steps / 2)) / (steps / 2);
}

function clampParam(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

registerProcessor('hold-music-bitcrusher', HoldMusicBitcrusherProcessor);
