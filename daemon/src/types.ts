export interface ChatOptions {
  apiKey: string;
  signal?: AbortSignal;
  deliver?: boolean;
}

export interface ChatResult {
  text: string;
  source: 'xai_via_openclaw';
}
