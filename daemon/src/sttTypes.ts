export interface SttSessionCallbacks {
  onReady: () => void;
  onPartial: (text: string, isFinal: boolean) => void;
  onDone: (text: string) => void;
  onError: (message: string) => void;
  onClosed: () => void;
}
