import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.whatsappsystem.mobile',
  appName: 'WhatsApp System',
  webDir: 'frontend',
  server: {
    // Permite backend HTTP em ambiente local (ex.: http://10.0.2.2:3001 no emulador).
    cleartext: true,
    // Evita mixed content no Android quando a API está em HTTP na rede local.
    androidScheme: 'http'
  }
};

export default config;
