export async function getStorageKey(): Promise<CryptoKey> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('TrellisSecurity', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('keys');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const transaction = db.transaction('keys', 'readwrite');
  const store = transaction.objectStore('keys');

  return new Promise<CryptoKey>((resolve, reject) => {
    const getRequest = store.get('storageKey');
    getRequest.onsuccess = async () => {
      if (getRequest.result) {
        resolve(getRequest.result as CryptoKey);
      } else {
        const key = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
        store.put(key, 'storageKey').onsuccess = () => resolve(key);
      }
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return typeof window !== 'undefined' ? window.btoa(binary) : Buffer.from(buffer).toString('base64');
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (typeof window !== 'undefined') {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } else {
    return Buffer.from(base64, 'base64').buffer;
  }
}

export async function secureStore(key: string, value: string): Promise<void> {
  try {
    const storageKey = await getStorageKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = encoder.encode(value);

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      storageKey,
      data
    );

    const payload = {
      iv: arrayBufferToBase64(iv.buffer),
      ciphertext: arrayBufferToBase64(encrypted)
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    console.error('Failed to securely store data', error);
  }
}

export async function secureLoad(key: string): Promise<string | null> {
  try {
    const item = localStorage.getItem(key);
    if (!item) return null;

    const payload = JSON.parse(item);
    const iv = new Uint8Array(base64ToArrayBuffer(payload.iv));
    const ciphertext = base64ToArrayBuffer(payload.ciphertext);

    const storageKey = await getStorageKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      storageKey,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    console.error('Failed to securely load data', error);
    return null;
  }
}
