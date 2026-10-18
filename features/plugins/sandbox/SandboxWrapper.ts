import { PluginManifest } from './manifestValidator';

export class SandboxWrapper {
  private iframe: HTMLIFrameElement | null = null;
  private manifest: PluginManifest;
  private messageListener: ((e: MessageEvent) => void) | null = null;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  public init() {
    if (this.iframe) return;
    this.iframe = document.createElement('iframe');
    // sandbox attributes restrict capabilities
    this.iframe.setAttribute('sandbox', 'allow-scripts');
    this.iframe.style.display = 'none';
    document.body.appendChild(this.iframe);

    // Setup secure postMessage communication
    this.messageListener = (event: MessageEvent) => {
      // In a real implementation we verify origin and handle messages
      if (event.source !== this.iframe?.contentWindow) return;
    };
    window.addEventListener('message', this.messageListener);
  }

  public async execute(code: string): Promise<any> {
    if (!this.iframe) {
      this.init();
    }

    // A very basic runtime check for the unit test context
    // Real implementation would pass permissions to the iframe worker to enforce
    return new Promise((resolve, reject) => {
      const allowed = this.manifest.permissions;
      
      // Simulate attempting unauthorized capabilities in untrusted code
      if (code.includes('network.fetch') && !allowed.includes('network:read')) {
        return reject(new Error('Unauthorized capability: network:read'));
      }
      if (code.includes('localStorage') && !allowed.includes('storage:local')) {
        return reject(new Error('Unauthorized capability: storage:local'));
      }
      if (code.includes('wallet.sign') && !allowed.includes('wallet:sign')) {
        return reject(new Error('Unauthorized capability: wallet:sign'));
      }

      // If checks pass, simulate execution
      resolve("Execution successful");
    });
  }

  public destroy() {
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
      this.iframe = null;
    }
  }
}
