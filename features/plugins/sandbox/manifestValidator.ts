export type PluginScope = 'network:read' | 'storage:local' | 'wallet:sign' | string;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  permissions: PluginScope[];
  [key: string]: any;
}

export function validateManifest(manifest: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be a valid JSON object'] };
  }
  
  if (typeof manifest.id !== 'string') errors.push("Missing or invalid 'id'");
  if (typeof manifest.name !== 'string') errors.push("Missing or invalid 'name'");
  if (typeof manifest.version !== 'string') errors.push("Missing or invalid 'version'");
  
  if (!Array.isArray(manifest.permissions)) {
    errors.push("Missing or invalid 'permissions'");
  } else {
    for (const p of manifest.permissions) {
      if (typeof p !== 'string') {
        errors.push("Permissions must be an array of strings");
        break;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
