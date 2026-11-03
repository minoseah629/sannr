import { registerChildPhotoRoutes, registerChildPlannerRoutes, registerChildHomeworkRoutes, registerChildTutorRoutes, registerParentPhotoRoutes } from "../photos/photo.routes.js";
export function createParentIdentityRouter(
  options: { parentIdentityProvider: unknown; service: unknown; photoService?: unknown },
): Router {
  const router = Router();
  router.get("/profile", handler);
  if (options.photoService) {
    registerParentPhotoRoutes(router, options.photoService);
  }
  return router;
}
export function createPublicIdentityRouter(service: unknown, rateLimiterA: unknown, rateLimiterB: unknown): Router {
  const router = Router();
  router.get("/public", handler);
  return router;
}
export function createChildIdentityRouter(
  service: IdentityService, eventAppender: EventAppender, achievementEngine: AchievementEnginePort,
  deliveryGate: DeliveryGatePort, photoService?: PhotoService, plannerParseService?: PlannerParseService,
  homeworkCheckService?: HomeworkCheckService, tutorService?: TutorService,
): Router {
  const router = Router();
  router.get("/profile", handler);
  if (photoService) {
    registerChildPhotoRoutes(router, photoService);
  }
  if (plannerParseService) {
    registerChildPlannerRoutes(router, plannerParseService);
  }
  if (homeworkCheckService) {
    registerChildHomeworkRoutes(router, homeworkCheckService);
  }
  if (tutorService) {
    registerChildTutorRoutes(router, tutorService);
  }
  return router;
}
