import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.adonaithrift.pos',
  appName: 'Adonai POS',
  webDir: 'pos-dist',
  server: {
    androidScheme: 'https',
    cleartext: true
  },
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: true
  },
  plugins: {
    Browser: {
      presentationStyle: 'popover'
    }
  }
};

export default config;
