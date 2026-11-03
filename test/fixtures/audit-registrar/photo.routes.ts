export function registerChildPhotoRoutes(router, service) {
  router.post("/photos/authorize", handler);
}
