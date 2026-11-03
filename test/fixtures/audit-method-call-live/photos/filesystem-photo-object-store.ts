export class PhotoObjectStore {
  router(): Router {
    const router = Router();
    router.put(
      "/:token",
      express.raw({ type: ["image/jpeg", "image/png"] }),
      handler,
    );
    router.get("/:token", handler);
    router.delete("/undocumented", handler);
    return router;
  }
}
