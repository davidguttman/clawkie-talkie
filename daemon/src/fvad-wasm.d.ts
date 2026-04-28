declare module '@echogarden/fvad-wasm' {
  export interface FvadWasmModule {
    HEAP16: Int16Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
    _fvad_new(): number;
    _fvad_free(handle: number): void;
    _fvad_set_mode(handle: number, mode: number): number;
    _fvad_set_sample_rate(handle: number, sampleRate: number): number;
    _fvad_process(handle: number, framePtr: number, sampleCount: number): number;
  }

  const createFvadModule: () => Promise<FvadWasmModule>;
  export default createFvadModule;
}
