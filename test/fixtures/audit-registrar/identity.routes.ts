import { registerChildPhotoRoutes } from "./photo.routes.ts";
export function createChildIdentityRouter(deps) {
  const router = Router();
  registerChildPhotoRoutes(router, deps.photos);
  router.get("/undocumented", handler);
  return router;
}
