import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'util';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock Freighter wallet
// Guarded because route-handler suites opt into `@jest-environment node` and have
// no `window`. Accessing it unconditionally threw before any test in the suite ran.
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'freighterApi', {
    value: {
      isConnected: jest.fn().mockResolvedValue(true),
      getPublicKey: jest.fn().mockResolvedValue('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5V6ST'),
    },
    writable: true,
  });
}

// Mock ResizeObserver
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Ensure clipboard API is mocked only once
// `navigator` is absent under the node environment used by route-handler suites.
if (typeof navigator !== 'undefined') {
  global.navigator.clipboard = {
    writeText: jest.fn(),
    readText: jest.fn(),
  };
}

// Mock URL.revokeObjectURL
global.URL.revokeObjectURL = jest.fn();

// Mock URL.createObjectURL
global.URL.createObjectURL = jest.fn(() => 'mocked-object-url');
