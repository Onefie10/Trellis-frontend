# Permission-Aware Export Pipeline

A production-ready streaming export system with built-in security, memory safety, and cancellation support.

## Features

- **Permission Enforcement**: Integrates with the centralized permission matrix (`lib/permissions.ts`)
- **Field-Level Redaction**: Redacts sensitive fields based on caller's role
- **Bounded Memory**: Processes data in configurable batches to prevent memory exhaustion
- **Cancellation Support**: Supports client-side cancellation via AbortController
- **Streaming Response**: Streams data incrementally for low latency and memory efficiency
- **Format Support**: JSON and CSV output with formula injection protection
- **Comprehensive Testing**: Full test coverage including large datasets and forbidden fields

## Quick Start

```typescript
import { streamingExport } from '@/lib/export/streaming-export';
import { requirePermission } from '@/lib/auth/guard';

// In your API route handler
export async function POST(request: NextRequest) {
  // 1. Authorize the request
  const authResult = await requirePermission(request, {
    action: 'export_data',
    resourceOwnerId: wallet,
    resourceScope: 'own',
  });

  if (!authResult.ok) {
    return authResult.response;
  }

  // 2. Set up cancellation support
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort());

  // 3. Create a stream
  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const writer = async (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };

      try {
        await streamingExport(
          {
            wallet: 'GABC...XYZ',
            type: 'simulations',
            format: 'json',
            role: authResult.actor.role,
            actorId: authResult.actor.id,
          },
          fetcher,
          writer,
          controller.signal,
          { batchSize: 1000 },
        );
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new NextResponse(readable, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="export.json"',
    },
  });
}
```

## Architecture

The pipeline follows a three-phase flow:

1. **Authorization Phase**: Validates identity and permissions using the permission matrix
2. **Streaming Phase**: Fetches and processes data in batches with cancellation checks
3. **Completion Phase**: Writes metadata and closes the stream

See [OPERATIONAL_GUIDE.md](./OPERATIONAL_GUIDE.md) for detailed operational documentation.

## API Reference

### `streamingExport(request, fetcher, writer, signal, config)`

Main export pipeline function.

**Parameters:**

- `request: ExportRequest` - Export parameters including wallet, type, format, role
- `fetcher: RecordFetcher` - Function to fetch records in batches
- `writer: StreamWriter` - Function to write chunks to output stream
- `signal: AbortSignal` - Cancellation signal
- `config: Partial<ExportConfig>` - Optional configuration (batchSize, maxMemoryBytes, etc.)

**Returns:** `Promise<ExportMetadata>` - Export statistics and status

### `redactRecord(record, role)`

Redacts a record based on the caller's role.

**Parameters:**

- `record: PermissionRecord` - Record with permission metadata
- `role: Role` - Caller's role

**Returns:** `{ redacted: Record<string, unknown>, redactedFieldCount: number }`

### `canViewField(role, requiredLevel)`

Checks if a role can view a field with the given permission level.

**Parameters:**

- `role: Role` - Caller's role
- `requiredLevel: FieldPermissionLevel` - Required permission level

**Returns:** `boolean`

## Field Permissions

Fields are tagged with required permission levels:

- `public`: Accessible to all roles
- `viewer`: Requires viewer role or higher
- `contributor`: Requires contributor role or higher
- `maintainer`: Requires maintainer role or higher
- `admin`: Admin-only access

Example field permissions for `simulations`:

```typescript
{
  name: 'wallet',
  requiredLevel: 'contributor',
  isPii: true,
  description: 'Owner wallet address'
}
```

## Configuration

Default configuration:

```typescript
{
  batchSize: 1000,              // Records per batch
  maxMemoryBytes: 100 * 1024 * 1024,  // 100MB soft limit
  batchTimeoutMs: 30000,        // 30 seconds per batch
  debug: false,                 // Debug telemetry
}
```

## Testing

Run the test suite:

```bash
npm test -- lib/export/__tests__/streaming-export.test.ts
```

Test coverage includes:

- Permission enforcement logic
- Field redaction by role
- Batch processing with various sizes
- Cancellation signal propagation
- Large dataset handling (10K+ records)
- Forbidden field access prevention
- CSV formula injection protection
- Validation schemas

## Security

- **Permission Enforcement**: Uses centralized permission matrix
- **Field-Level Redaction**: Sensitive fields never sent to unauthorized roles
- **Formula Injection**: CSV output neutralizes spreadsheet formula attacks
- **Audit Trail**: All exports logged with metadata including redaction statistics

## Migration from Legacy Export

The new export pipeline introduces breaking changes:

1. **Permission Required**: Export now requires `export_data` permission
2. **Field Redaction**: Fields are redacted based on role
3. **Streaming Response**: Response is streamed, not buffered
4. **Cancellation**: Supports client-side cancellation

See [OPERATIONAL_GUIDE.md](./OPERATIONAL_GUIDE.md) for detailed migration steps.

## License

Part of the Trellis Frontend project.
