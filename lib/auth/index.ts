export {
  issueActorToken,
  resolveActor,
  verifyActorToken,
  ACTOR_TOKEN_SECRET_ENV,
  type Actor,
  type ActorResolution,
  type ActorResolutionFailure,
} from '@/lib/auth/actor';

export {
  deniedResponse,
  requireActor,
  requirePermission,
  parseActionParam,
  parseScopeParam,
  type AuthorizationResult,
  type RequirePermissionRequest,
} from '@/lib/auth/guard';
