export const iconSizes = [16, 32, 72, 96, 128, 144, 152, 167, 180, 192, 384, 512];
export const manifestIconSizes = [72, 96, 128, 144, 152, 192, 384, 512];
export const maskableIconSizes = [192, 512];
export const appleTouchIconSizes = [152, 167, 180];

const appleDevices = [
  { label: 'iPhone 15 Pro Max, 15 Plus, 14 Pro Max', deviceWidth: 430, deviceHeight: 932, pixelRatio: 3, width: 1290, height: 2796 },
  { label: 'iPhone 15 Pro, 15, 14 Pro', deviceWidth: 393, deviceHeight: 852, pixelRatio: 3, width: 1179, height: 2556 },
  { label: 'iPhone 14 Plus, 13 Pro Max, 12 Pro Max', deviceWidth: 428, deviceHeight: 926, pixelRatio: 3, width: 1284, height: 2778 },
  { label: 'iPhone 14, 13/13 Pro, 12/12 Pro', deviceWidth: 390, deviceHeight: 844, pixelRatio: 3, width: 1170, height: 2532 },
  { label: 'iPhone 13 mini, 12 mini', deviceWidth: 360, deviceHeight: 780, pixelRatio: 3, width: 1080, height: 2340 },
  { label: 'iPhone 11 Pro Max, XS Max', deviceWidth: 414, deviceHeight: 896, pixelRatio: 3, width: 1242, height: 2688 },
  { label: 'iPhone 11, XR', deviceWidth: 414, deviceHeight: 896, pixelRatio: 2, width: 828, height: 1792 },
  { label: 'iPhone 11 Pro, XS, X', deviceWidth: 375, deviceHeight: 812, pixelRatio: 3, width: 1125, height: 2436 },
  { label: 'iPhone 8 Plus, 7 Plus, 6s Plus', deviceWidth: 414, deviceHeight: 736, pixelRatio: 3, width: 1242, height: 2208 },
  { label: 'iPhone 8, 7, 6s, SE 2nd/3rd gen', deviceWidth: 375, deviceHeight: 667, pixelRatio: 2, width: 750, height: 1334 },
  { label: 'iPhone SE 1st gen, 5s', deviceWidth: 320, deviceHeight: 568, pixelRatio: 2, width: 640, height: 1136 },
  { label: 'iPad Pro 12.9"', deviceWidth: 1024, deviceHeight: 1366, pixelRatio: 2, width: 2048, height: 2732 },
  { label: 'iPad Pro 11"', deviceWidth: 834, deviceHeight: 1194, pixelRatio: 2, width: 1668, height: 2388 },
  { label: 'iPad Pro 10.5"', deviceWidth: 834, deviceHeight: 1112, pixelRatio: 2, width: 1668, height: 2224 },
  { label: 'iPad Air 10.9", iPad 10th gen', deviceWidth: 820, deviceHeight: 1180, pixelRatio: 2, width: 1640, height: 2360 },
  { label: 'iPad 9th gen, Air 3, Pro 9.7"', deviceWidth: 768, deviceHeight: 1024, pixelRatio: 2, width: 1536, height: 2048 },
  { label: 'iPad Mini 6th gen', deviceWidth: 744, deviceHeight: 1133, pixelRatio: 2, width: 1488, height: 2266 },
];

function splashMedia({ deviceWidth, deviceHeight, pixelRatio }, orientation) {
  return `(device-width: ${deviceWidth}px) and (device-height: ${deviceHeight}px) and (-webkit-device-pixel-ratio: ${pixelRatio}) and (orientation: ${orientation})`;
}

export const appleSplashScreens = appleDevices.flatMap((device) => [
  {
    label: device.label,
    width: device.width,
    height: device.height,
    orientation: 'portrait',
    media: splashMedia(device, 'portrait'),
  },
  {
    label: device.label,
    width: device.height,
    height: device.width,
    orientation: 'landscape',
    media: splashMedia(device, 'landscape'),
  },
]);

export const splashSizes = appleSplashScreens.map(({ width, height }) => [width, height]);
