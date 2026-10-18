import { encryptConfig, decryptConfig } from '../../../lib/security/encryption';

describe('Encryption Utility', () => {
  const config = JSON.stringify({ algoliaKey: 'xyz123', customRpc: 'https://rpc.example.com' });
  const passphrase = 'secure-password';

  it('should encrypt and decrypt a configuration successfully', async () => {
    const encrypted = await encryptConfig(config, passphrase);
    expect(encrypted).not.toBe(config);
    expect(encrypted).toContain('salt');
    expect(encrypted).toContain('iv');
    expect(encrypted).toContain('ciphertext');

    const decrypted = await decryptConfig(encrypted, passphrase);
    expect(decrypted).toBe(config);
  });

  it('should reject decryption with a wrong password', async () => {
    const encrypted = await encryptConfig(config, passphrase);
    
    await expect(decryptConfig(encrypted, 'wrong-password')).rejects.toThrow(
      'Decryption failed. Incorrect passphrase or corrupted data.'
    );
  });
  
  it('should fail to decrypt invalid payload', async () => {
    await expect(decryptConfig('invalid-json', passphrase)).rejects.toThrow(
      'Decryption failed. Incorrect passphrase or corrupted data.'
    );
  });
});
