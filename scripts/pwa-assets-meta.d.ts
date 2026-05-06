export const iconSizes: readonly number[];
export const manifestIconSizes: readonly number[];
export const maskableIconSizes: readonly number[];
export const appleTouchIconSizes: readonly number[];
export interface AppleSplashScreen {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly orientation: 'portrait' | 'landscape';
  readonly media: string;
}
export const appleSplashScreens: readonly AppleSplashScreen[];
export const splashSizes: readonly (readonly [number, number])[];
