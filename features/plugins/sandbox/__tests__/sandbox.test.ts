import { validateManifest } from '../manifestValidator';
import { SandboxWrapper } from '../SandboxWrapper';

describe('Plugin Sandbox and Manifest', () => {
  describe('validateManifest', () => {
    it('validates a correct manifest', () => {
      const manifest = {
        id: 'plg_test',
        name: 'Test Plugin',
        version: '1.0.0',
        permissions: ['network:read', 'storage:local']
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects manifest without required fields', () => {
      const manifest = {
        name: 'Test Plugin'
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing or invalid 'id'");
      expect(result.errors).toContain("Missing or invalid 'version'");
      expect(result.errors).toContain("Missing or invalid 'permissions'");
    });

    it('rejects non-array permissions', () => {
      const manifest = {
        id: '1', name: 'A', version: '1', permissions: 'all'
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Missing or invalid 'permissions'");
    });
  });

  describe('SandboxWrapper', () => {
    let sandbox: SandboxWrapper;

    afterEach(() => {
      if (sandbox) sandbox.destroy();
    });

    it('blocks unauthorized network access', async () => {
      sandbox = new SandboxWrapper({
        id: 'plg_1',
        name: 'No Network Plugin',
        version: '1.0.0',
        permissions: ['storage:local']
      });

      await expect(sandbox.execute('network.fetch("https://evil.com")')).rejects.toThrow('Unauthorized capability: network:read');
    });

    it('allows authorized network access', async () => {
      sandbox = new SandboxWrapper({
        id: 'plg_2',
        name: 'Network Plugin',
        version: '1.0.0',
        permissions: ['network:read']
      });

      const result = await sandbox.execute('network.fetch("https://api.com")');
      expect(result).toBe("Execution successful");
    });

    it('blocks unauthorized wallet signing', async () => {
      sandbox = new SandboxWrapper({
        id: 'plg_3',
        name: 'No Wallet Plugin',
        version: '1.0.0',
        permissions: ['network:read']
      });

      await expect(sandbox.execute('wallet.sign(tx)')).rejects.toThrow('Unauthorized capability: wallet:sign');
    });
  });
});
