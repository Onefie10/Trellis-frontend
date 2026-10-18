import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import * as fs from 'fs';
import * as path from 'path';
import { API_CONTRACTS } from '../lib/api-contracts/schemas';
import { z } from 'zod';

const registry = new OpenAPIRegistry();

// Register Bearer Auth if needed
const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
});

// Register endpoints
for (const [key, contract] of Object.entries(API_CONTRACTS)) {
  const method = contract.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
  
  const parameters: any[] = [];
  
  if (contract.queryParams) {
    for (const [qKey, qDef] of Object.entries(contract.queryParams)) {
      parameters.push({
        name: qKey,
        in: 'query',
        required: qDef.required,
        schema: { type: qDef.type === 'string' ? 'string' : 'number' },
        description: qDef.description,
      });
    }
  }

  const requestBody = contract.requestSchema
    ? {
        content: {
          'application/json': {
            schema: contract.requestSchema,
          },
        },
      }
    : undefined;

  const responses: any = {
    200: {
      description: 'Successful response',
      content: {
        'application/json': {
          schema: contract.responseSchema,
        },
      },
    },
  };

  if (contract.errorResponses) {
    for (const [status, errDef] of Object.entries(contract.errorResponses)) {
      responses[status] = {
        description: errDef.message,
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              code: z.string(),
              details: z.array(z.any()).optional(),
            }),
          },
        },
      };
    }
  }

  registry.registerPath({
    method,
    path: contract.path,
    description: contract.description,
    summary: contract.description.split('.')[0],
    security: contract.authRequired ? [{ [bearerAuth.name]: [] }] : [],
    request: {
      query: parameters.length > 0 ? z.object(
        Object.fromEntries(
          parameters.map((p) => [
            p.name,
            p.required ? z.string() : z.string().optional(),
          ])
        )
      ) : undefined,
      body: requestBody,
    },
    responses,
  });
}

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: '3.0.0',
  info: {
    version: '0.1.0',
    title: 'Trellis Frontend API',
    description: 'API documentation for Trellis Frontend',
  },
  servers: [{ url: '/' }],
});

const outputPath = path.resolve(process.cwd(), 'public', 'openapi.json');

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(document, null, 2));

console.log(`OpenAPI specification generated at ${outputPath}`);
