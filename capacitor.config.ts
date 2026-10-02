import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.adonaithrift.pos',
  appName: 'Adonai POS',
  webDir: 'pos-dist',
  server: {
    androidScheme: 'https',
    cleartext: false
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false
  },
  plugins: {
    Browser: {
      presentationStyle: 'popover'
    }
  }
};

export default config;
