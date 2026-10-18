import { getAppConfig, auditEnvironment, sanitizeEnvironment } from '../lib/config/env';

try {
  const config = getAppConfig();
  console.info(`Environment configuration valid (${config.environment}, Stellar ${config.stellarNetwork}).`);

  const audit = auditEnvironment();
  if (audit.weak.length > 0) {
    console.warn(`Environment audit flagged ${audit.weak.length} weak or default secret(s):`);
    for (const issue of audit.weak) {
      console.warn(`  - ${issue.variable}: ${issue.reason}`);
    }
  } else {
    console.info('Environment audit passed: no weak or default secrets detected.');
  }

  const sanitized = sanitizeEnvironment();
  console.info('Sanitized environment snippet:', sanitized);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid application configuration.');
  process.exitCode = 1;
}
