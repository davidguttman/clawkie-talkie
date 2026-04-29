export interface ChatOptions {
  signal?: AbortSignal;
  deliver?: boolean;
}

export interface ChatResult {
  text: string;
  source: 'openclaw';
}
